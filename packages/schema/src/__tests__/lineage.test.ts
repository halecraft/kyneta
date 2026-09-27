// lineage — a plain document's lineages are ordered by when they were minted,
// so peers that meet two of them all settle on the same one.

import { describe, expect, it } from "vitest"
import { mintLineage, supersedes } from "../substrates/plain.js"

describe("mintLineage", () => {
  it("is fixed-width, so string order is mint order", () => {
    const early = mintLineage(Date.UTC(2020, 0, 1))
    const late = mintLineage(Date.UTC(2026, 8, 27))
    expect(early).toHaveLength(late.length)
    expect(supersedes(late, early)).toBe(true)
    expect(supersedes(early, late)).toBe(false)
  })

  it("orders the first millisecond before the last one it can write", () => {
    const first = mintLineage(0)
    const last = mintLineage(36 ** 9 - 1)
    expect(first).toHaveLength(last.length)
    expect(supersedes(last, first)).toBe(true)
  })

  it("breaks a tie within one millisecond one way", () => {
    const a = mintLineage(1_000)
    const b = mintLineage(1_000)
    expect(a).not.toBe(b)
    expect(supersedes(a, b)).toBe(!supersedes(b, a))
  })
})

describe("supersedes", () => {
  it("is a strict order: irreflexive and transitive", () => {
    const [x, y, z] = [1, 2, 3].map(t => mintLineage(t * 1_000))
    if (x === undefined || y === undefined || z === undefined) {
      throw new Error("expected three lineages")
    }
    expect(supersedes(x, x)).toBe(false)
    expect(supersedes(y, x) && supersedes(z, y)).toBe(true)
    expect(supersedes(z, x)).toBe(true)
  })
})
