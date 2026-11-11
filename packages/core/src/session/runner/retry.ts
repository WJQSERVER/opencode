export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai/effect"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect } from "effect"
import { Bus } from "../../bus.js"
import { ModelRetry } from "../../model-retry.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

// A subscription usage limit is a deterministic refusal, not a throttle, so the general policy would
// give up on it. With the experimental limit-reset retry on, the first refusal of a step is given a
// single reset-delayed attempt at the moment the provider said the limit resets; once that time has
// passed, quota refusals join the general retry state machine like any transient failure.
const ONE_OFF_ATTEMPT = 2
const MAX_RESET_DELAY_MS = 45 * 86_400_000

const quotaReset = (input: Input) => {
  if (input.retry !== false || input.cause.reason._tag !== "QuotaExceeded") return undefined
  const retryAfterMs =
    typeof input.error === "object" && "retryAfterMs" in input.error && typeof input.error.retryAfterMs === "number"
      ? input.error.retryAfterMs
      : undefined
  if (
    retryAfterMs === undefined ||
    !Number.isFinite(retryAfterMs) ||
    retryAfterMs < 0 ||
    retryAfterMs > MAX_RESET_DELAY_MS
  )
    return undefined
  return retryAfterMs
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

export const policy = (
  sessionID: SessionSchema.ID,
  opts?: { readonly infinite?: boolean; readonly limitResetRetry?: boolean },
) =>
  Effect.gen(function* () {
    const decide = yield* ModelRetry.policy(opts)
    // At most one reset-delayed attempt per step, however often the provider refuses again before the
    // reset. After the estimated reset time passes, quota refusals behave like transient failures and
    // hand off to the general retry state machine instead.
    let resetRetries = 0
    let resetEstimate: number | undefined
    return (input: Input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const reset = quotaReset(input)
        const quota = input.cause.reason._tag === "QuotaExceeded"
        if (resetEstimate === undefined && reset !== undefined) resetEstimate = now + reset
        const atReset = quota && resetEstimate !== undefined && now >= resetEstimate
        const next = yield* decide({ ...input, retry: input.retry || (opts?.limitResetRetry === true && atReset) })
        // Before the reset the general policy declines quota refusals; the reset retry is the one escape hatch.
        // After the reset moment passes, quota refusals have already joined the general state machine above.
        if (reset !== undefined && opts?.limitResetRetry && resetRetries === 0 && !atReset) {
          resetRetries++
          const event: PluginHooks.Domains["session"]["retry"] = {
            sessionID,
            agent: input.agent,
            model: input.model,
            error: input.error,
            attempt: ONE_OFF_ATTEMPT,
            decision: { retry: true, delay: reset },
          }
          yield* input.hook(event)
          if (!event.decision.retry) return event.decision
          const delay =
            Number.isFinite(event.decision.delay) && event.decision.delay >= 0
              ? Math.ceil(event.decision.delay)
              : reset
          return { retry: true as const, attempt: ONE_OFF_ATTEMPT, delay }
        }
        if (!next) return { retry: false as const }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt: next.attempt,
          decision: next.retry ? { retry: true, delay: next.delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0
            ? Math.ceil(event.decision.delay)
            : next.delay
        return { retry: true as const, attempt: next.attempt, delay: normalized }
      })
  })

export const make = (
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  opts?: { readonly infinite?: boolean; readonly limitResetRetry?: boolean },
) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID, opts)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
