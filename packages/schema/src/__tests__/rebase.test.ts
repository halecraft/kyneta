import { describe, expect, it } from "vitest"
import type { TextInstruction } from "../change.js"
import {
  replaceChange,
  richTextChange,
  sequenceChange,
  textChange,
  trustAsOwned,
} from "../change.js"
import { changeUnits, rebaseChange } from "../rebase.js"
import { step } from "../step.js"

// ---------------------------------------------------------------------------
// An identity model of two concurrent text edits
// ---------------------------------------------------------------------------
//
// Characters carry identities. Each edit deletes some base characters and
// inserts runs into the gaps between them. Applying both, with `change`'s
// inserts before `over`'s in the same gap, is what rebasing must reproduce:
// `step(step(base, over), rebaseChange(change, over))`.

interface Edit {
  readonly deletes: ReadonlySet<number>
  readonly inserts: ReadonlyMap<number, string>
}

function editOf(base: string, instructions: readonly TextInstruction[]): Edit {
  const deletes = new Set<number>()
  const inserts = new Map<number, string>()
  let cursor = 0
  for (const op of instructions) {
    if ("retain" in op) cursor += op.retain
    else if ("delete" in op) {
      for (let i = 0; i < op.delete; i++) deletes.add(cursor + i)
      cursor += op.delete
    } else {
      inserts.set(cursor, (inserts.get(cursor) ?? "") + op.insert)
    }
  }
  expect(cursor).toBeLessThanOrEqual(base.length)
  return { deletes, inserts }
}

function both(base: string, change: Edit, over: Edit): string {
  let out = ""
  for (let gap = 0; gap <= base.length; gap++) {
    out += (change.inserts.get(gap) ?? "") + (over.inserts.get(gap) ?? "")
    if (gap < base.length && !change.deletes.has(gap) && !over.deletes.has(gap))
      out += base[gap]
  }
  return out
}

/** A deterministic PRNG, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function randomEdit(base: string, next: () => number, tag: string) {
  const instructions: TextInstruction[] = []
  let cursor = 0
  while (cursor < base.length) {
    const r = next()
    const n = 1 + Math.floor(next() * 3)
    const room = Math.min(n, base.length - cursor)
    if (r < 0.45) {
      instructions.push({ retain: room })
      cursor += room
    } else if (r < 0.7) {
      instructions.push({ delete: room })
      cursor += room
    } else {
      instructions.push({ insert: tag.repeat(n) })
    }
  }
  if (next() < 0.3) instructions.push({ insert: tag })
  return instructions
}

describe("rebaseChange: text", () => {
  it("agrees with the identity model on random concurrent edits", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const next = rng(seed)
      const base = "abcdefghij".slice(0, 3 + Math.floor(next() * 8))
      const a = randomEdit(base, next, "X")
      const b = randomEdit(base, next, "y")
      const rebased = rebaseChange(textChange(a), textChange(b))
      expect(rebased, `seed ${seed}`).not.toBeNull()
      if (rebased === null) continue
      const actual = step(step(base, textChange(b)), rebased)
      expect(actual, `seed ${seed}`).toBe(
        both(base, editOf(base, a), editOf(base, b)),
      )
    }
  })

  it("puts restored content before a peer's insert at the same place", () => {
    // Undo restores "b" at 1 in "ac"; a peer inserted "X" there meanwhile.
    const rebased = rebaseChange(
      textChange([{ retain: 1 }, { insert: "b" }]),
      textChange([{ retain: 1 }, { insert: "X" }]),
    )
    expect(rebased === null ? null : step("aXc", rebased)).toBe("abXc")
  })

  it("drops a delete of content the other change already deleted", () => {
    const rebased = rebaseChange(
      textChange([{ retain: 2 }, { delete: 3 }]),
      textChange([{ retain: 1 }, { delete: 3 }]),
    )
    // Base "abcdef": over leaves "aef"; only "e" is left of what change deleted.
    expect(rebased === null ? null : step("aef", rebased)).toBe("af")
  })
})

describe("rebaseChange: sequences and rich text", () => {
  it("rebases a sequence restore past a peer's insert", () => {
    const rebased = rebaseChange(
      sequenceChange(trustAsOwned([{ retain: 1 }, { insert: ["b"] }])),
      sequenceChange(trustAsOwned([{ insert: ["z"] }])),
    )
    expect(rebased === null ? null : step(["z", "a", "c"], rebased)).toEqual([
      "z",
      "a",
      "b",
      "c",
    ])
  })

  it("shifts a format with its range and leaves a peer's insert inside it alone", () => {
    const base = [{ text: "hello", marks: { bold: true } }, { text: " world" }]
    const unbold = richTextChange([
      { format: 5, marks: trustAsOwned({ bold: null }) },
    ])
    const peer = richTextChange([
      { insert: "YY" },
      { retain: 2 },
      { insert: "XX", marks: trustAsOwned({ bold: true }) },
    ])
    const rebased = rebaseChange(unbold, peer)
    expect(rebased).not.toBeNull()
    if (rebased === null) return
    expect(step(step(base, peer), rebased)).toEqual([
      { text: "YYhe" },
      { text: "XX", marks: { bold: true } },
      { text: "llo world" },
    ])
  })
})

describe("rebaseChange: across kinds", () => {
  it("is null when the other change replaced the coordinate", () => {
    expect(
      rebaseChange(
        textChange([{ insert: "a" }]),
        replaceChange(trustAsOwned("new")),
      ),
    ).toBeNull()
  })
})

describe("changeUnits", () => {
  it("counts what a change inserts, deletes and formats, and nothing it retains", () => {
    expect(
      changeUnits(textChange([{ retain: 2 }, { delete: 3 }, { insert: "ab" }])),
    ).toBe(5)
    expect(
      changeUnits(
        richTextChange([
          { retain: 1 },
          { format: 4, marks: trustAsOwned({ bold: true }) },
        ]),
      ),
    ).toBe(4)
    expect(changeUnits(replaceChange(trustAsOwned(1)))).toBe(0)
  })

  it("never grows under a rebase, and keeps every insert", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const next = rng(seed)
      const base = "abcdefghij".slice(0, 3 + Math.floor(next() * 8))
      const a = randomEdit(base, next, "X")
      const b = randomEdit(base, next, "y")
      const change = textChange(a)
      const rebased = rebaseChange(change, textChange(b))
      if (rebased === null) throw new Error(`seed ${seed}: no rebase`)
      const inserted = (c: typeof change) =>
        c.instructions.reduce(
          (n, i) => n + ("insert" in i ? i.insert.length : 0),
          0,
        )
      expect(changeUnits(rebased), `seed ${seed}`).toBeLessThanOrEqual(
        changeUnits(change),
      )
      expect(inserted(rebased as typeof change), `seed ${seed}`).toBe(
        inserted(change),
      )
    }
  })
})
