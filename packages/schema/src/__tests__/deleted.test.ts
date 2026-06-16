import { describe, expect, it } from "vitest"
import { deleted } from "../interpreters/with-addressing.js"

describe("deleted()", () => {
  it("returns undefined for null/undefined", () => {
    expect(deleted(null)).toBeUndefined()
    expect(deleted(undefined)).toBeUndefined()
  })
})
