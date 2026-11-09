import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { raceAbandon } from "../src/cross-spawn-spawner.js"

const run = <A, E, R, E2>(body: Effect.Effect<A, E, R | Scope.Scope>, layer: Layer.Layer<R, E2>) =>
  body.pipe(Effect.scoped, Effect.provide(layer), Effect.runPromise)

describe("raceAbandon", () => {
  test("succeeds with void once the wait resolves and never runs abandon", async () => {
    const abandoned = await run(
      Effect.gen(function* () {
        const waited = yield* Deferred.make<void>()
        const abandoned = yield* Deferred.make<void>()
        const fiber = yield* Effect.forkChild(
          raceAbandon(Deferred.await(waited), "5 seconds", Deferred.succeed(abandoned, undefined)),
          { startImmediately: true },
        )
        yield* Deferred.succeed(waited, undefined)
        yield* Fiber.join(fiber)
        // The grace is not a hidden deadline for fast children.
        yield* TestClock.adjust("10 seconds")
        return yield* Deferred.isDone(abandoned)
      }),
      TestClock.layer(),
    )
    expect(abandoned).toBe(false)
  })

  test("expires the grace, interrupts the wait and runs abandon", async () => {
    const result = await run(
      Effect.gen(function* () {
        const waited = yield* Deferred.make<void>()
        const abandoned = yield* Deferred.make<void>()
        let interrupted = false
        const hanging = Deferred.await(waited).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            }),
          ),
        )
        const fiber = yield* Effect.forkChild(
          raceAbandon(hanging, "5 seconds", Deferred.succeed(abandoned, undefined)),
          { startImmediately: true },
        )
        yield* TestClock.adjust("5 seconds")
        yield* Fiber.join(fiber)
        return {
          abandoned: yield* Deferred.isDone(abandoned),
          interrupted,
          waitedResolved: yield* Deferred.isDone(waited),
        }
      }),
      TestClock.layer(),
    )
    expect(result.abandoned).toBe(true)
    expect(result.interrupted).toBe(true)
    expect(result.waitedResolved).toBe(false)
  })
})
