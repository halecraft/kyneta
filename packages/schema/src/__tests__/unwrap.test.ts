// unwrap — unit tests for the [NATIVE]-based escape hatch.

import { describe, expect, it } from "vitest"
import { NATIVE } from "../native.js"
import { unwrap } from "../unwrap.js"

describe("unwrap()", () => {
  it("returns the [NATIVE] value from a ref", () => {
    const nativeContainer = { _loroText: true }
    const ref = { [NATIVE]: nativeContainer }

    expect(unwrap(ref)).toBe(nativeContainer)
  })

  it("returns undefined when [NATIVE] is undefined (scalar)", () => {
    const ref = { [NATIVE]: undefined }

    expect(unwrap(ref)).toBeUndefined()
  })

  it("throws for null", () => {
    expect(() => unwrap(null as any)).toThrow("unwrap() requires a ref object.")
  })

  it("throws for undefined", () => {
    expect(() => unwrap(undefined as any)).toThrow(
      "unwrap() requires a ref object.",
    )
  })

  it("throws for primitives", () => {
    expect(() => unwrap(42 as any)).toThrow("unwrap() requires a ref object.")
    expect(() => unwrap("hello" as any)).toThrow(
      "unwrap() requires a ref object.",
    )
  })
})
