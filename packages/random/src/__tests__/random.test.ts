import { describe, expect, it } from "vitest"
import { randomHex, randomPeerId } from "../index.js"

describe("randomHex", () => {
  it("returns a string of length 2n", () => {
    for (const n of [1, 4, 8, 16, 32]) {
      expect(randomHex(n).length).toBe(n * 2)
    }
  })

  it("contains only lowercase hex characters", () => {
    for (let i = 0; i < 20; i++) {
      expect(randomHex(16)).toMatch(/^[0-9a-f]+$/)
    }
  })

  it("returns empty string for zero bytes", () => {
    expect(randomHex(0)).toBe("")
  })

  it("produces distinct values across 100 calls", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(randomHex(8))
    }
    expect(ids.size).toBe(100)
  })
})

describe("randomPeerId", () => {
  it("returns a 16-char hex string", () => {
    expect(randomPeerId()).toMatch(/^[0-9a-f]{16}$/)
  })
})
