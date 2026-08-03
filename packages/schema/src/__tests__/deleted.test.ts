import { describe, expect, it } from "vitest"
import { deletedFeed } from "../interpreters/with-addressing.js"

describe("deletedFeed()", () => {
  it("returns undefined for null/undefined", () => {
    expect(deletedFeed(null)).toBeUndefined()
    expect(deletedFeed(undefined)).toBeUndefined()
  })
})
