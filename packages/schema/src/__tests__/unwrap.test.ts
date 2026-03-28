// unwrap — unit tests for the general escape hatch.

import { describe, expect, it } from "vitest"
import { Schema } from "../schema.js"
import { createPlainSubstrate } from "../substrates/plain.js"
import { registerSubstrate, unwrap } from "../unwrap.js"

describe("unwrap()", () => {
  it("returns the registered substrate", () => {
    const store = { title: "Hello" }
    const substrate = createPlainSubstrate(store)
    const fakeRef = { _fake: true }

    registerSubstrate(fakeRef, substrate)

    expect(unwrap(fakeRef)).toBe(substrate)
  })

  it("throws for unregistered refs", () => {
    expect(() => unwrap({})).toThrow("unwrap()")
  })

  it("overwrites previous registration for the same ref", () => {
    const storeA = { title: "A" }
    const storeB = { title: "B" }
    const substrateA = createPlainSubstrate(storeA)
    const substrateB = createPlainSubstrate(storeB)
    const ref = { _fake: true }

    registerSubstrate(ref, substrateA)
    expect(unwrap(ref)).toBe(substrateA)

    registerSubstrate(ref, substrateB)
    expect(unwrap(ref)).toBe(substrateB)
  })
})
