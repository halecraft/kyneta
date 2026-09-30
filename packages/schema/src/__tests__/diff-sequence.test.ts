import { describe, expect, it } from "vitest"
import { textChange } from "../change.js"
import { diffSequence, diffString } from "../diff-sequence.js"
import { step } from "../step.js"

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe("diffString", () => {
  it("turns one string into the other", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const next = rng(seed)
      const word = () =>
        Array.from(
          { length: Math.floor(next() * 12) },
          () => "abc"[Math.floor(next() * 3)],
        ).join("")
      const a = word()
      const b = word()
      expect(step(a, textChange(diffString(a, b))), `seed ${seed}`).toBe(b)
    }
  })

  it("keeps what both share", () => {
    expect(diffString("hello world", "hello brave world")).toEqual([
      { retain: 6 },
      { insert: "brave " },
    ])
    expect(diffString("same", "same")).toEqual([])
  })
})

describe("diffSequence", () => {
  it("compares items with the given equality", () => {
    const a = [{ n: 1 }, { n: 2 }, { n: 3 }]
    const b = [{ n: 1 }, { n: 3 }, { n: 4 }]
    expect(diffSequence(a, b, (x, y) => x.n === y.n)).toEqual([
      { retain: 1 },
      { delete: 1 },
      { retain: 1 },
      { insert: [{ n: 4 }] },
    ])
  })
})
