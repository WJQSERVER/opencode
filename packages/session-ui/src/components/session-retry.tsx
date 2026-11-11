import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { SessionStatus } from "@opencode/client/promise"
import { useI18n } from "@opencode/ui/context/i18n"
import { Card } from "@opencode/ui/card"
import { Icon } from "@opencode/ui/icon"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { Tooltip } from "@opencode/ui/tooltip"
import { SessionErrorMessage } from "./session-error"

export function SessionRetry(props: { status: SessionStatus; show?: boolean; kind?: "free-limit" | "go-limit" }) {
  const i18n = useI18n()

  const retry = createMemo(() => {
    if (props.status.type !== "retry") return

    return props.status
  })

  // A step waiting for a subscription limit to reset is not a transient hiccup: show the reset time
  // instead of a countdown measured in seconds, so a five-hour wait does not read like "in 18000s".
  const limit = createMemo(() => {
    if (props.kind !== "go-limit" && props.kind !== "free-limit") return
    const at = retry()?.next
    if (at === undefined || !Number.isFinite(at) || Number.isNaN(new Date(at).getTime()))
      return i18n.t(props.kind === "go-limit" ? "ui.sessionTurn.goLimit.title" : "ui.sessionTurn.freeLimit.title")
    const now = Date.now()
    const sameDay = new Date(at).toDateString() === new Date(now).toDateString() && at - now < 86_400_000
    const time = new Intl.DateTimeFormat(
      i18n.locale(),
      sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" },
    ).format(at)
    return i18n.t(
      props.kind === "go-limit" ? "ui.sessionTurn.goLimit.lineReset" : "ui.sessionTurn.freeLimit.lineReset",
      { time },
    )
  })

  const [seconds, setSeconds] = createSignal(0)
  createEffect(
    on(retry, (current) => {
      if (!current || limit()) return

      const update = () => {
        const next = retry()?.next

        if (!next) return
        setSeconds(Math.round((next - Date.now()) / 1000))
      }

      update()
      const timer = setInterval(update, 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )

  const message = createMemo(() => {
    const current = retry()

    if (!current) return ""

    const limited = limit()
    if (limited) return limited

    if (current.message.includes("exceeded your current quota") && current.message.includes("gemini")) {
      return i18n.t("ui.sessionTurn.retry.geminiHot")
    }

    if (current.message.length > 80) return current.message.slice(0, 80) + "…"

    return current.message
  })

  const info = createMemo(() => {
    const current = retry()

    if (!current) return ""

    if (limit()) return i18n.t("ui.sessionTurn.retry.attemptLabel", { attempt: current.attempt })

    const count = Math.max(0, seconds())

    if (count > 0) return i18n.plural("ui.sessionTurn.retry.attemptWaiting", count, { attempt: current.attempt })

    return i18n.t("ui.sessionTurn.retry.attemptRetryingNow", { attempt: current.attempt })
  })

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry" class="w-full min-w-0">
        <Card variant="error" class="error-card" data-kind="session-retry-card">
          <div class="flex w-full items-start gap-2">
            <Icon name="outline-hexagonal-warning" class="shrink-0 text-v2-state-fg-danger" />
            <div class="min-w-0 flex-1">
              <Tooltip
                appearance="large"
                contentClass="max-w-80 break-words"
                value={retry()?.message ?? ""}
                placement="top"
              >
                <div data-slot="session-turn-retry-message" class="cursor-help truncate">
                  <SessionErrorMessage message={message()} />
                </div>
              </Tooltip>
              <Show when={info()}>
                {(line) => (
                  <div data-slot="session-turn-retry-info">
                    <TextShimmer text={line()} active />
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
