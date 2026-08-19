import { describe, expect, test } from "bun:test"
import { SessionID } from "../src/session-id"

describe("SessionID", () => {
  test("create generates a ses_ prefixed id of the expected length", () => {
    const id = SessionID.create()
    expect(id).toStartWith("ses_")
    expect(id.length).toBe("ses_".length + 26)
  })

  test("create with a suffix fixes the trailing characters", () => {
    const id = SessionID.create("uwtb")
    expect(id.endsWith("uwtb")).toBe(true)
    expect(id.length).toBe("ses_".length + 26)
  })

  test("descending without an id honors the suffix", () => {
    const id = SessionID.descending(undefined, "uwtb")
    expect(id.endsWith("uwtb")).toBe(true)
  })

  test("descending with an existing id ignores the suffix", () => {
    const existing = SessionID.create()
    expect(SessionID.descending(existing, "uwtb")).toBe(existing)
  })
})
