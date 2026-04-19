// position.test.ts — YjsPosition conformance suite + concurrent-edit tests.
//
// Part 1 (Task 4.4): Runs the shared positionConformance suite against a
//         Yjs-backed factory, proving YjsPosition satisfies the Position contract.
//
// Part 2 (Task 4.6): Yjs-specific concurrent-edit tests — two Y.Doc instances
//         make independent edits, sync via Y.applyUpdate, and verify positions
//         resolve correctly on the converged state.

import {
  change,
  createRef,
  hasPosition,
  type Instruction,
  isTextChange,
  POSITION,
  type PositionCapable,
  Schema,
} from "@kyneta/schema"
import {
  type PositionTestEnv,
  positionConformance,
} from "@kyneta/schema/src/__tests__/position-conformance.js"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { ensureContainers } from "../populate.js"
import { createYjsSubstrate } from "../substrate.js"

// ===========================================================================
// Shared test schema
// ===========================================================================

const TextSchema = Schema.struct({
  title: Schema.text(),
})

// ===========================================================================
// Part 1: Conformance suite — YjsPosition
// ===========================================================================

// ---------------------------------------------------------------------------
// Factory: creates a Y.Doc-backed PositionTestEnv for the conformance suite.
//
// YjsPosition.transform() is a no-op — Yjs RelativePositions resolve
// statelessly against the document's item graph. The conformance suite calls
// transform() then resolve(); since resolve() queries the live Y.Doc, the
// tests pass because the underlying Yjs state already reflects the mutations.
// ---------------------------------------------------------------------------

function createYjsEnv(initialText: string): PositionTestEnv {
  const doc = new Y.Doc()
  ensureContainers(doc, TextSchema)
  const substrate = createYjsSubstrate(doc, TextSchema)
  const ref = createRef(TextSchema, substrate) as any

  // Seed the initial text content
  if (initialText.length > 0) {
    change(ref, (d: any) => {
      d.title.insert(0, initialText)
    })
  }

  // Extract the PositionCapable from the text ref
  const textRef = ref.title
  if (!hasPosition(textRef)) {
    throw new Error("Yjs text ref missing [POSITION] capability")
  }
  const positions: PositionCapable = textRef[POSITION]

  return {
    positions,

    insert(index: number, text: string): readonly Instruction[] {
      const ops = change(ref, (d: any) => {
        d.title.insert(index, text)
      })
      const textOp = ops.find(op => isTextChange(op.change))
      if (!textOp || !isTextChange(textOp.change)) {
        throw new Error("insert did not produce a TextChange op")
      }
      return textOp.change.instructions
    },

    delete(index: number, count: number): readonly Instruction[] {
      const ops = change(ref, (d: any) => {
        d.title.delete(index, count)
      })
      const textOp = ops.find(op => isTextChange(op.change))
      if (!textOp || !isTextChange(textOp.change)) {
        throw new Error("delete did not produce a TextChange op")
      }
      return textOp.change.instructions
    },

    currentText(): string {
      return ref.title()
    },
  }
}

positionConformance(createYjsEnv, { cursorModel: "identity" })

// ===========================================================================
// Part 2: Yjs-specific concurrent-edit tests
// ===========================================================================

describe("YjsPosition: concurrent edits", () => {
  it("positions resolve correctly after sync", () => {
    // --- Doc 1: create and seed ---
    const doc1 = new Y.Doc()
    ensureContainers(doc1, TextSchema)
    const substrate1 = createYjsSubstrate(doc1, TextSchema)
    const ref1 = createRef(TextSchema, substrate1) as any
    change(ref1, (d: any) => {
      d.title.insert(0, "hello")
    })

    // --- Doc 2: fork from doc1's state ---
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    ensureContainers(doc2, TextSchema, true)
    const substrate2 = createYjsSubstrate(doc2, TextSchema)
    const ref2 = createRef(TextSchema, substrate2) as any

    // Sanity: both docs agree on initial text
    expect(ref1.title()).toBe("hello")
    expect(ref2.title()).toBe("hello")

    // --- Create positions before concurrent edits ---
    const textRef1 = ref1.title
    if (!hasPosition(textRef1)) throw new Error("missing [POSITION] on ref1")
    const pos1 = textRef1[POSITION].createPosition(2, "right") // after "he"

    const textRef2 = ref2.title
    if (!hasPosition(textRef2)) throw new Error("missing [POSITION] on ref2")
    const pos2 = textRef2[POSITION].createPosition(4, "left") // before "o"

    // --- Concurrent edits ---
    change(ref1, (d: any) => {
      d.title.insert(0, "AA") // doc1: "AAhello"
    })
    change(ref2, (d: any) => {
      d.title.insert(5, "BB") // doc2: "helloBBo"
    })

    // --- Sync ---
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))

    // Both docs should converge to the same text
    const finalText = ref1.title()
    expect(ref2.title()).toBe(finalText)

    // Positions should resolve to valid indices on the converged doc
    const idx1 = pos1.resolve()
    const idx2 = pos2.resolve()
    expect(idx1).not.toBeNull()
    expect(idx2).not.toBeNull()
    expect(idx1!).toBeGreaterThanOrEqual(0)
    expect(idx2!).toBeGreaterThanOrEqual(0)
    expect(idx1!).toBeLessThanOrEqual(finalText.length)
    expect(idx2!).toBeLessThanOrEqual(finalText.length)
  })

  it("sticky side preserved through concurrent inserts at same position", () => {
    // --- Doc 1: create and seed ---
    const doc1 = new Y.Doc()
    ensureContainers(doc1, TextSchema)
    const substrate1 = createYjsSubstrate(doc1, TextSchema)
    const ref1 = createRef(TextSchema, substrate1) as any
    change(ref1, (d: any) => {
      d.title.insert(0, "abc")
    })

    // --- Doc 2: fork ---
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    ensureContainers(doc2, TextSchema, true)
    const substrate2 = createYjsSubstrate(doc2, TextSchema)
    const ref2 = createRef(TextSchema, substrate2) as any

    // Left-sticky position at index 1 on doc1
    const textRef1 = ref1.title
    if (!hasPosition(textRef1)) throw new Error("missing [POSITION]")
    const leftPos = textRef1[POSITION].createPosition(1, "left")

    // Right-sticky position at index 1 on doc2
    const textRef2 = ref2.title
    if (!hasPosition(textRef2)) throw new Error("missing [POSITION]")
    const rightPos = textRef2[POSITION].createPosition(1, "right")

    // --- Both insert at index 1 concurrently ---
    change(ref1, (d: any) => {
      d.title.insert(1, "X")
    })
    change(ref2, (d: any) => {
      d.title.insert(1, "Y")
    })

    // --- Sync ---
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))

    // Both docs should converge
    const finalText = ref1.title()
    expect(ref2.title()).toBe(finalText)

    // Both positions should resolve to valid indices
    const leftIdx = leftPos.resolve()
    const rightIdx = rightPos.resolve()
    expect(leftIdx).not.toBeNull()
    expect(rightIdx).not.toBeNull()

    // Left-sticky should be ≤ right-sticky: the left-sticky cursor
    // stays before insertions at its gap, while right-sticky shifts past.
    expect(leftIdx!).toBeLessThanOrEqual(rightIdx!)
  })

  it("position survives deletion on remote peer and re-insertion", () => {
    // --- Doc 1: create and seed ---
    const doc1 = new Y.Doc()
    ensureContainers(doc1, TextSchema)
    const substrate1 = createYjsSubstrate(doc1, TextSchema)
    const ref1 = createRef(TextSchema, substrate1) as any
    change(ref1, (d: any) => {
      d.title.insert(0, "abcde")
    })

    // --- Doc 2: fork ---
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    ensureContainers(doc2, TextSchema, true)
    const substrate2 = createYjsSubstrate(doc2, TextSchema)
    const ref2 = createRef(TextSchema, substrate2) as any

    // Position at index 3 on doc1
    const textRef1 = ref1.title
    if (!hasPosition(textRef1)) throw new Error("missing [POSITION]")
    const pos = textRef1[POSITION].createPosition(3, "right")
    expect(pos.resolve()).toBe(3)

    // Doc2 deletes the range covering position 3
    change(ref2, (d: any) => {
      d.title.delete(1, 3) // "ae"
    })

    // Sync doc2's deletion into doc1
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))

    // Position should still resolve (Yjs RelativePositions survive deletion
    // — they bind to item IDs, and deleted items remain in the CRDT graph)
    const afterDelete = pos.resolve()
    expect(afterDelete).not.toBeNull()
    expect(afterDelete!).toBeGreaterThanOrEqual(0)
    expect(afterDelete!).toBeLessThanOrEqual(ref1.title().length)

    // Now insert new content near the collapsed position
    change(ref1, (d: any) => {
      d.title.insert(1, "XYZ")
    })

    // Position should still resolve to a valid index
    const afterInsert = pos.resolve()
    expect(afterInsert).not.toBeNull()
    expect(afterInsert!).toBeGreaterThanOrEqual(0)
    expect(afterInsert!).toBeLessThanOrEqual(ref1.title().length)
  })

  it("encode/decode round-trip works across synced documents", () => {
    // --- Doc 1: create and seed ---
    const doc1 = new Y.Doc()
    ensureContainers(doc1, TextSchema)
    const substrate1 = createYjsSubstrate(doc1, TextSchema)
    const ref1 = createRef(TextSchema, substrate1) as any
    change(ref1, (d: any) => {
      d.title.insert(0, "hello world")
    })

    // Create a position and encode it
    const textRef1 = ref1.title
    if (!hasPosition(textRef1)) throw new Error("missing [POSITION]")
    const pos = textRef1[POSITION].createPosition(5, "left")
    const encoded = pos.encode()

    // Decode on a different doc that has the same state
    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    ensureContainers(doc2, TextSchema, true)
    const substrate2 = createYjsSubstrate(doc2, TextSchema)
    const ref2 = createRef(TextSchema, substrate2) as any

    const textRef2 = ref2.title
    if (!hasPosition(textRef2)) throw new Error("missing [POSITION]")
    const decoded = textRef2[POSITION].decodePosition(encoded)

    // Both should resolve to the same index
    expect(decoded.resolve()).toBe(pos.resolve())
    expect(decoded.side).toBe(pos.side)
  })

  it("multiple positions from three peers all resolve after full mesh sync", () => {
    // --- Create 3 peers ---
    const doc1 = new Y.Doc()
    ensureContainers(doc1, TextSchema)
    const substrate1 = createYjsSubstrate(doc1, TextSchema)
    const ref1 = createRef(TextSchema, substrate1) as any
    change(ref1, (d: any) => {
      d.title.insert(0, "0123456789")
    })

    const doc2 = new Y.Doc()
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))
    ensureContainers(doc2, TextSchema, true)
    const substrate2 = createYjsSubstrate(doc2, TextSchema)
    const ref2 = createRef(TextSchema, substrate2) as any

    const doc3 = new Y.Doc()
    Y.applyUpdate(doc3, Y.encodeStateAsUpdate(doc1))
    ensureContainers(doc3, TextSchema, true)
    const substrate3 = createYjsSubstrate(doc3, TextSchema)
    const ref3 = createRef(TextSchema, substrate3) as any

    // Each peer creates a position
    const t1 = ref1.title
    if (!hasPosition(t1)) throw new Error("missing [POSITION]")
    const posA = t1[POSITION].createPosition(2, "right")

    const t2 = ref2.title
    if (!hasPosition(t2)) throw new Error("missing [POSITION]")
    const posB = t2[POSITION].createPosition(5, "left")

    const t3 = ref3.title
    if (!hasPosition(t3)) throw new Error("missing [POSITION]")
    const posC = t3[POSITION].createPosition(8, "right")

    // Concurrent edits from all three peers
    change(ref1, (d: any) => {
      d.title.insert(0, "AA")
    })
    change(ref2, (d: any) => {
      d.title.insert(5, "BB")
    })
    change(ref3, (d: any) => {
      d.title.delete(7, 2)
    })

    // Full mesh sync: every peer gets every other peer's changes
    const update1 = Y.encodeStateAsUpdate(doc1)
    const update2 = Y.encodeStateAsUpdate(doc2)
    const update3 = Y.encodeStateAsUpdate(doc3)

    Y.applyUpdate(doc1, update2)
    Y.applyUpdate(doc1, update3)
    Y.applyUpdate(doc2, update1)
    Y.applyUpdate(doc2, update3)
    Y.applyUpdate(doc3, update1)
    Y.applyUpdate(doc3, update2)

    // All three docs should converge
    const finalText = ref1.title()
    expect(ref2.title()).toBe(finalText)
    expect(ref3.title()).toBe(finalText)

    // All positions should resolve to valid indices
    for (const [label, pos] of [
      ["posA", posA],
      ["posB", posB],
      ["posC", posC],
    ] as const) {
      const idx = pos.resolve()
      expect(idx, `${label} should resolve`).not.toBeNull()
      expect(idx!, `${label} >= 0`).toBeGreaterThanOrEqual(0)
      expect(idx!, `${label} <= length`).toBeLessThanOrEqual(finalText.length)
    }
  })
})
