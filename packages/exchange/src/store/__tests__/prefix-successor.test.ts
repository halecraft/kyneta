import { describe, expect, it } from "vitest"
import { prefixSuccessor } from "../store.js"

describe("prefixSuccessor", () => {
  it("increments the last symbol", () => {
    expect(prefixSuccessor("users/", "code-point")).toBe("users0")
    expect(prefixSuccessor("users/", "code-unit")).toBe("users0")
  })

  it("is null for an empty prefix: the scan has no upper bound", () => {
    expect(prefixSuccessor("", "code-point")).toBeNull()
    expect(prefixSuccessor("", "code-unit")).toBeNull()
  })

  it("drops trailing maximal symbols", () => {
    expect(prefixSuccessor("a\u{10ffff}", "code-point")).toBe("b")
    expect(prefixSuccessor("\u{10ffff}", "code-point")).toBeNull()
    expect(prefixSuccessor("a\uffff", "code-unit")).toBe("b")
  })

  it("skips the surrogates in code-point order", () => {
    expect(prefixSuccessor("\ud7ff", "code-point")).toBe("\ue000")
  })

  it("increments an astral character whole in code-point order, and its low surrogate in code-unit order", () => {
    // U+1F600 is D83D DE00 in UTF-16.
    expect(prefixSuccessor("\u{1f600}", "code-point")).toBe("\u{1f601}")
    expect(prefixSuccessor("\u{1f600}", "code-unit")).toBe("\ud83d\ude01")
  })

  it("bounds exactly the strings with the prefix, in each order", () => {
    const strings = [
      "users/",
      "users/a",
      "users/\u0101",
      "users/\u{1f600}",
      "users/\uffff",
      "users0",
      "users.",
      "user",
      "Users/a",
      "users/\uffff\uffff",
    ]
    const byPoint = (a: string, b: string): number => {
      const x = Array.from(a).map(c => c.codePointAt(0) ?? 0)
      const y = Array.from(b).map(c => c.codePointAt(0) ?? 0)
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0)
        if (d !== 0) return d
      }
      return x.length - y.length
    }
    const byUnit = (a: string, b: string): number =>
      a < b ? -1 : a > b ? 1 : 0
    for (const [order, compare] of [
      ["code-point", byPoint],
      ["code-unit", byUnit],
    ] as const) {
      const upper = prefixSuccessor("users/", order)
      const inRange = strings.filter(
        s =>
          compare(s, "users/") >= 0 &&
          (upper === null || compare(s, upper) < 0),
      )
      expect(inRange.sort(), order).toEqual(
        strings.filter(s => s.startsWith("users/")).sort(),
      )
    }
  })
})
