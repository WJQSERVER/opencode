export * as SessionRevert from "./revert.js"

import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Effect } from "effect"
import path from "path"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { EventTable } from "../event/sql.js"
import { Instance } from "../instance/service.js"
import { RelativePath } from "../schema.js"
import { Snapshot } from "../snapshot.js"
import { SessionEvent } from "./event.js"
import { MessageNotFoundError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionHistory } from "./history.js"
import { SessionMessageTable, SessionTable } from "./sql.js"
import { ProjectTable } from "../project/sql.js"

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  session: SessionSchema.Info
  messageID: SessionMessage.ID
  files?: boolean
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const original = input.session.revert?.snapshot ?? (yield* snapshot.capture())
    const next = yield* plan(database.db, { sessionID: input.session.id, messageID: input.messageID })
    const restore = new Map<RelativePath, Snapshot.ID>()
    if (original) {
      for (const file of input.session.revert?.files ?? []) restore.set(RelativePath.make(file.file), original)
    }
    if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
    if (restore.size) yield* snapshot.restore({ files: restore })
    const paths = input.files === false ? [] : Array.from(next.keys())
    const files = original
      ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
      : []
    const revert = {
      messageID: input.messageID,
      snapshot: original,
      files,
    } satisfies SessionSchema.Info["revert"]
    yield* bus.publish(SessionEvent.RevertEvent.Staged, {
      sessionID: input.session.id,
      revert,
    })
    return revert
  }).pipe(instances.provide(input.session))
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  const instances = yield* Instance.Service
  const bus = yield* Bus.Service
  yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    if (!session.revert) return
    const original = session.revert.snapshot
    if (original)
      yield* snapshot.restore({
        files: new Map((session.revert.files ?? []).map((file) => [RelativePath.make(file.file), original])),
      })
    yield* bus.publish(SessionEvent.RevertEvent.Cleared, {
      sessionID: session.id,
    })
  }).pipe(instances.provide(session))
})

export const commit = Effect.fn("SessionRevert.commit")(function* (bus: Bus.Interface, session: SessionSchema.Info) {
  if (!session.revert) return
  yield* bus.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    to: session.revert.messageID,
  })
})

const plan = Effect.fn("SessionRevert.plan")(function* (db: Database.Interface["db"], input: BoundaryInput) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const assistantIDs = new Set<string>(rows.map((row) => String(row.id)))
  const events = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.sessionID),
        inArray(EventTable.type, ["session.tool.input.started.1", "session.tool.called.1"]),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const toolNames = new Map<string, string>()
  const calls: Array<Record<string, unknown>> = []
  for (const event of events) {
    const data = event.data
    if (typeof data.assistantMessageID !== "string" || !assistantIDs.has(data.assistantMessageID)) continue
    if (event.type === "session.tool.input.started.1" && typeof data.name === "string" && typeof data.id === "string")
      toolNames.set(data.id, data.name)
    if (event.type === "session.tool.called.1") calls.push(data)
  }
  const sessionRow = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()
    .pipe(Effect.orDie)
  const projectRow = sessionRow
    ? yield* db
        .select()
        .from(ProjectTable)
        .where(eq(ProjectTable.id, sessionRow.project_id))
        .get()
        .pipe(Effect.orDie)
    : undefined
  const root = projectRow?.worktree ?? sessionRow?.directory
  const patchPaths = (text: string) =>
    text
      .split("\n")
      .flatMap((line) => {
        const match = /^\*\*\* (?:Update|Add|Delete|Move) File: (.+)$/.exec(line.trim())

        return match ? [match[1].split("\t")[0]] : []
      })
      .filter((value): value is string => !!value)
  const edited = new Set<string>()
  for (const call of calls) {
    const name = typeof call.id === "string" ? toolNames.get(call.id) : undefined
    if (!name || !root || !sessionRow?.directory) continue
    const value = call.input
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const fields = value as Record<string, unknown>
    const paths =
      (name === "write" || name === "edit") && typeof fields.path === "string"
        ? [fields.path]
        : name === "patch" || name === "apply_patch"
          ? typeof fields.patchText === "string"
            ? patchPaths(fields.patchText)
            : []
          : []
    for (const candidate of paths) {
      const absolute = path.resolve(sessionRow.directory, candidate)
      if (absolute !== root && !absolute.startsWith(root + path.sep)) continue
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (relative && !relative.startsWith("..")) edited.add(relative)
    }
  }
  // Only narrow the restore when this session actually recorded tool calls. Older sessions and externally driven work
  // have none, and keeping their original full-snapshot behaviour avoids losing undo for those cases.
  const restrict = calls.length > 0
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = SessionHistory.decodeMessageRowSync(row)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if ((!restrict || edited.has(String(file))) && !files.has(file)) files.set(file, message.snapshot.start)
  }
  return files
})
