import { describe, expect, test } from "bun:test"
import { AIError, ProviderInternalError, QuotaExceededError, TransportError } from "@opencode/ai/effect"
import { ModelRetry } from "@opencode/core/model-retry"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Clock, Duration, Effect } from "effect"
import { TestClock } from "effect/testing"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const dnsFailure = new AIError({
  reason: new TransportError({
    message: "getaddrinfo ENOTFOUND opencode.ai",
    transport: "http",
    operation: "request",
    code: "ENOTFOUND",
    url: "https://opencode.ai/zen/v1/responses",
  }),
})
const refused = new AIError({
  reason: new TransportError({
    message: "Unable to connect",
    transport: "http",
    operation: "request",
    code: "ECONNREFUSED",
  }),
})

const quota = new AIError({
  reason: new QuotaExceededError({ message: "OpenCode Go usage limit reached", retryAfterMs: 1_000 }),
})
const neverResets = new AIError({ reason: new QuotaExceededError({ message: "OpenCode Go usage limit reached" }) })
const monthly = new AIError({
  reason: new QuotaExceededError({ message: "Monthly budget reached", retryAfterMs: 45 * 86_400_000 + 1 }),
})

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("keeps retrying an unreachable host for an hour with gaps of at most 30 seconds", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      const started = yield* Clock.currentTimeMillis
      const delays: number[] = []
      while (true) {
        const decision = yield* policy(input(dnsFailure))
        if (!decision.retry) break
        delays.push(decision.delay)
        yield* TestClock.adjust(Duration.millis(decision.delay))
      }
      const waited = (yield* Clock.currentTimeMillis) - started
      expect(delays.length).toBeGreaterThan(100)
      expect(Math.max(...delays)).toBeLessThanOrEqual(30_000)
      expect(waited).toBeGreaterThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW))
      expect(waited).toBeLessThanOrEqual(Duration.toMillis(ModelRetry.UNREACHABLE_WINDOW) + 30_000)
    }),
  )

  it.effect("keeps a refused connection on the general allowance", () =>
    Effect.gen(function* () {
      expect(ModelRetry.isUnreachable(refused)).toBe(false)
      expect(yield* decisions(refused, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("keeps retrying past the general allowance when infinite is enabled", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { infinite: true })
      const results: boolean[] = []
      for (let i = 0; i < 15; i++) results.push((yield* policy(input(internal))).retry)
      expect(results).toEqual(Array(15).fill(true))
    }),
  )

  it.effect("settles the gap at a steady 30 seconds after the backoff window when infinite is enabled", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { infinite: true })
      const delays: number[] = []
      for (let i = 0; i < 14; i++) {
        const decision = yield* policy(input(internal))
        if (!decision.retry) break
        delays.push(decision.delay)
        yield* TestClock.adjust(Duration.millis(decision.delay))
      }
      expect(delays.length).toBe(14)
      // The first ten gaps are the jittered backoff capped at 10 seconds; the rest are exactly 30 seconds.
      expect(delays.slice(0, 10).every((delay) => delay < 30_000)).toBe(true)
      expect(delays.slice(10)).toEqual(Array(4).fill(30_000))
    }),
  )

  it.effect("gives up on quota refusals by default", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      expect((yield* policy(input(quota))).retry).toBe(false)
    }),
  )

  it.effect("doesn't schedule a reset retry without limit_reset_retry", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { infinite: true })
      expect((yield* policy(input(quota))).retry).toBe(false)
    }),
  )

  it.effect("schedules exactly one retry at the reset when limit_reset_retry is enabled", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { limitResetRetry: true })
      const first = yield* policy(input(quota))
      expect(first).toEqual({ retry: true, attempt: 2, delay: 1_000 })
      expect((yield* policy(input(quota))).retry).toBe(false)
    }),
  )

  it.effect("joins the general retry state machine once the reset time passes", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), {
        limitResetRetry: true,
        infinite: true,
      })
      const first = yield* policy(input(quota))
      expect(first).toEqual({ retry: true, attempt: 2, delay: 1_000 })
      yield* TestClock.adjust("1500 millis")
      const second = yield* policy(input(quota))
      expect(second.retry).toBe(true)
      if (second.retry) expect(second.delay).toBeLessThanOrEqual(30_000)
      const third = yield* policy(input(quota))
      expect(third.retry).toBe(true)
    }),
  )

  it.effect("doesn't schedule a reset retry without a reset the provider computed", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { limitResetRetry: true })
      expect((yield* policy(input(neverResets))).retry).toBe(false)
    }),
  )

  it.effect("doesn't schedule a reset retry when the reset is beyond the cap", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"), { limitResetRetry: true })
      expect((yield* policy(input(monthly))).retry).toBe(false)
    }),
  )

  it.effect("doesn't spend the general allowance on an unreachable host", () =>
    Effect.gen(function* () {
      const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
      for (let i = 0; i < 20; i++) expect((yield* policy(input(dnsFailure))).retry).toBe(true)
      const results: boolean[] = []
      for (let i = 0; i < 11; i++) results.push((yield* policy(input(internal))).retry)
      expect(results).toEqual([...Array(10).fill(true), false])
    }),
  )
})

describe("ModelRetry.retryOneShot", () => {
  it.effect("doesn't replay a call whose response was cut off by the network going down", () =>
    Effect.gen(function* () {
      let calls = 0
      const cutOff = new AIError({
        reason: new TransportError({
          message: "Network is down",
          transport: "http",
          operation: "read",
          code: "ENETDOWN",
        }),
      })
      yield* ModelRetry.retryOneShot(Effect.suspend(() => (calls++, Effect.fail(cutOff)))).pipe(Effect.flip)
      expect(calls).toBe(1)
    }),
  )
})

describe("toSessionError", () => {
  test("names the network when the provider's host can't be reached", () => {
    expect(toSessionError(dnsFailure)).toEqual({
      type: "provider.transport",
      message: "Can't reach opencode.ai. Check the network connection. (getaddrinfo ENOTFOUND opencode.ai)",
    })
    expect(toSessionError(refused)).toEqual({ type: "provider.transport", message: "Unable to connect" })
  })
})
