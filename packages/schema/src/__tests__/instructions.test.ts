import { describe, expect, it, beforeEach } from "vitest"
import {
  type Instruction,
  foldInstructions,
  advanceIndex,
  advanceAddresses,
} from "../change.js"
import { type IndexAddress, indexAddress, resetAddressIdCounter } from "../path.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAddress(index: number): IndexAddress {
  return indexAddress(index) as IndexAddress
}

// ===========================================================================
// foldInstructions
// ===========================================================================

describe("foldInstructions", () => {
  it("tracks dual source/target positions across mixed ops", () => {
    const instructions: Instruction[] = [
      { retain: 2 },
      { insert: { length: 1 } },
      { delete: 1 },
      { retain: 3 },
    ]
    const seen: Array<{
      op: string
      count: number
      source: number
      target: number
    }> = []

    foldInstructions(instructions, null, {
      onRetain(_acc, count, source, target) {
        seen.push({ op: "retain", count, source, target })
        return null
      },
      onInsert(_acc, length, source, target) {
        seen.push({ op: "insert", count: length, source, target })
        return null
      },
      onDelete(_acc, count, source, target) {
        seen.push({ op: "delete", count, source, target })
        return null
      },
    })

    expect(seen).toEqual([
      { op: "retain", count: 2, source: 0, target: 0 },
      { op: "insert", count: 1, source: 2, target: 2 },
      { op: "delete", count: 1, source: 2, target: 3 },
      { op: "retain", count: 3, source: 3, target: 3 },
    ])
  })

  it("early exit via { done } stops processing", () => {
    const instructions: Instruction[] = [
      { retain: 5 },
      { insert: { length: 10 } },
      { retain: 5 },
    ]

    const result = foldInstructions<number>(instructions, 0, {
      onRetain(acc, count) {
        return acc + count
      },
      onInsert(acc, length) {
        // Early exit when we see the insert
        return { done: acc + length }
      },
      onDelete(acc) {
        return acc
      },
    })

    // Should have accumulated retain(5) + insert(10) and stopped
    expect(result).toBe(15)
  })

  it("empty instructions returns initial", () => {
    const result = foldInstructions<string>([], "hello", {
      onRetain: acc => acc,
      onInsert: acc => acc,
      onDelete: acc => acc,
    })

    expect(result).toBe("hello")
  })
})

// ===========================================================================
// advanceIndex
// ===========================================================================

describe("advanceIndex", () => {
  it("retain-only: identity (index stays the same)", () => {
    expect(advanceIndex(3, [{ retain: 10 }])).toBe(3)
  })

  it("insert-before: shifts right", () => {
    // Insert 2 items at position 0 in a list of 5
    // Old index 3 → new index 5
    expect(advanceIndex(3, [{ insert: { length: 2 } }, { retain: 5 }])).toBe(5)
  })

  it("insert-after: no shift", () => {
    // Retain 5, then insert 2 at the end
    // Old index 3 is in the retain range → stays at 3
    expect(advanceIndex(3, [{ retain: 5 }, { insert: { length: 2 } }])).toBe(3)
  })

  it("insert at exact index: shifts right", () => {
    // Retain 3, insert 1 at position 3
    // Old index 3 is NOT in the retain range [0,3) → it's in the trailing retain
    // After: source=3, target=4, trailing retain maps 3 → 4
    expect(advanceIndex(3, [{ retain: 3 }, { insert: { length: 1 } }])).toBe(4)
  })

  it("delete-before: shifts left", () => {
    // Delete 1 item at position 0, retain 4
    // Old index 3 → source 1..5 maps to target 0..4
    // Index 3 in source maps to target 0 + (3 - 1) = 2
    expect(advanceIndex(3, [{ delete: 1 }, { retain: 4 }])).toBe(2)
  })

  it("delete-at: returns null (dead)", () => {
    // Retain 3, delete 1 at position 3
    // Old index 3 falls in the delete range [3, 4)
    expect(advanceIndex(3, [{ retain: 3 }, { delete: 1 }])).toBeNull()
  })

  it("delete-after: no shift", () => {
    // Retain 5, delete 2
    // Old index 3 is in the retain range [0, 5) → stays at 3
    expect(advanceIndex(3, [{ retain: 5 }, { delete: 2 }])).toBe(3)
  })

  it("delete multiple including the target", () => {
    // Retain 1, delete 3
    // Old index 2 falls in delete range [1, 4) → dead
    expect(advanceIndex(2, [{ retain: 1 }, { delete: 3 }])).toBeNull()
  })

  it("mixed ops: insert + delete", () => {
    // [retain 2, insert 3, delete 1, retain 4]
    // Source: [0,1] retained, [2] deleted, [3,4,5,6] retained
    // Target: [0,1, new,new,new, 3,4,5,6]
    // Old index 0 → retained at target 0
    expect(advanceIndex(0, [
      { retain: 2 },
      { insert: { length: 3 } },
      { delete: 1 },
      { retain: 4 },
    ])).toBe(0)

    // Old index 2 → deleted
    expect(advanceIndex(2, [
      { retain: 2 },
      { insert: { length: 3 } },
      { delete: 1 },
      { retain: 4 },
    ])).toBeNull()

    // Old index 3 → after insert+delete, source=3 target=5, in retain(4) range
    // target + (3 - source) = 5 + (3 - 3) = 5
    expect(advanceIndex(3, [
      { retain: 2 },
      { insert: { length: 3 } },
      { delete: 1 },
      { retain: 4 },
    ])).toBe(5)
  })

  it("implicit trailing retain", () => {
    // [retain 2] on a list of 5 — indices 2,3,4 are in trailing retain
    // After: source=2, target=2, trailing: target + (oldIndex - source)
    expect(advanceIndex(4, [{ retain: 2 }])).toBe(4)
  })

  it("implicit trailing retain after insert", () => {
    // [insert 2] on a list of 5 — all original indices are in trailing retain
    // After: source=0, target=2, trailing: 2 + (3 - 0) = 5
    expect(advanceIndex(3, [{ insert: { length: 2 } }])).toBe(5)
  })

  it("empty instructions: identity", () => {
    expect(advanceIndex(5, [])).toBe(5)
  })

  it("index 0 with delete at 0", () => {
    expect(advanceIndex(0, [{ delete: 1 }])).toBeNull()
  })

  it("delete all items", () => {
    expect(advanceIndex(2, [{ delete: 5 }])).toBeNull()
  })
})

// ===========================================================================
// advanceAddresses
// ===========================================================================

describe("advanceAddresses", () => {
  beforeEach(() => {
    resetAddressIdCounter()
  })

  it("matches advanceIndex independently per address (correctness oracle)", () => {
    const instructions: Instruction[] = [
      { retain: 2 },
      { insert: { length: 3 } },
      { delete: 1 },
      { retain: 4 },
    ]

    const indices = [0, 1, 2, 3, 4, 5, 6]
    const addresses = indices.map(i => makeAddress(i))

    advanceAddresses(addresses, instructions)

    for (let i = 0; i < indices.length; i++) {
      const expected = advanceIndex(indices[i]!, instructions)
      const addr = addresses[i]!
      if (expected === null) {
        expect(addr.dead).toBe(true)
      } else {
        expect(addr.dead).toBe(false)
        expect(addr.index).toBe(expected)
      }
    }
  })

  it("handles unsorted input correctly", () => {
    const c5 = makeAddress(5)
    const c1 = makeAddress(1)
    const c3 = makeAddress(3)

    advanceAddresses(
      [c5, c1, c3], // intentionally out of order
      [{ insert: { length: 1 } }, { retain: 6 }],
    )

    expect(c1.index).toBe(2)
    expect(c3.index).toBe(4)
    expect(c5.index).toBe(6)
  })

  it("empty input: no addresses → empty dead list, no instructions → unchanged", () => {
    expect(advanceAddresses([], [{ retain: 5 }])).toEqual([])

    const c = makeAddress(5)
    advanceAddresses([c], [])
    expect(c.index).toBe(5)
    expect(c.dead).toBe(false)
  })
})