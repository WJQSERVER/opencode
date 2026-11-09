import { expect, test } from "bun:test"
import { App } from "@opencode/core/app"

test("formats app metadata as a user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe("opencode/beta/1.2.3/sdk")
})

test("hides fork revisions in the user agent", () => {
  expect(App.useragent(App.make({ name: "cli", version: "2.2.6-u2", channel: "latest" }))).toBe(
    "opencode/latest/2.2.6/cli",
  )
  // Official prereleases pass through unchanged; only the fork's uN suffix is stripped.
  expect(App.useragent(App.make({ name: "cli", version: "2.2.7-beta.1", channel: "beta" }))).toBe(
    "opencode/beta/2.2.7-beta.1/cli",
  )
})
