// position.test.ts — Position algebra unit tests and PlainPosition conformance.
//
// Tests transformIndex (sticky-side-aware gap transform), textInstructionsToPatches
// (cursor → offset conversion), PlainPosition (encode/decode/transform), and runs
// the shared positionConformance suite against a plain-substrate factory.
//
// Also tests hasPosition on real interpreter-stack refs (createRef + plainSubstrateFactory).

import { describe, expect, it } from "vitest"
import {
  type Instruction,
  type TextInstruction,
  textInstructionsToPatches,
  transformIndex,
} from "../change.js"
import { createRef } from "../create-doc.js"
import { change } from "../facade/change.js"
import {
  decodePlainPosition,
  hasPosition,
  PlainPosition,
  POSITION,
  type PositionCapable,
  type Side,
} from "../position.js"
import { Schema } from "../schema.js"
import { plainSubstrateFactory } from "../substrates/plain.js"
import {
  type PositionTestEnv,
  positionConformance,
} from "./position-conformance.js"

// ===========================================================================
// transformIndex unit tests
// ===========================================================================

describe("transformIndex", () => {
  it("retain-only: identity (index stays the same)", () => {
    expect(transformIndex(3, "right", [{ retain: 10 }])).toBe(3)
  })

  it("insert before: shifts right", () => {
    expect(
      transformIndex(3, "right", [{ insert: { length: 2 } }, { retain: 5 }]),
    ).toBe(5)
  })

  it("insert after: no shift", () => {
    expect(
      transformIndex(3, "right", [{ retain: 5 }, { insert: { length: 2 } }]),
    ).toBe(3)
  })

  it("insert at gap, left-sticky: stays before insertion", () => {
    // Position 3, left-sticky. Insert at position 3.
    // Instructions: retain 3, insert 2
    // Left-sticky → stays at 3 (before the insert)
    expect(
      transformIndex(3, "left", [{ retain: 3 }, { insert: { length: 2 } }]),
    ).toBe(3)
  })

  it("insert at gap, right-sticky: shifts past insertion", () => {
    // Position 3, right-sticky. Insert at position 3.
    // Instructions: retain 3, insert 2
    // Right-sticky → shifts to 5 (after the insert)
    expect(
      transformIndex(3, "right", [{ retain: 3 }, { insert: { length: 2 } }]),
    ).toBe(5)
  })

  it("delete spanning gap: collapses to boundary", () => {
    // Position 3. Delete range [1, 4) = retain 1, delete 3.
    expect(transformIndex(3, "right", [{ retain: 1 }, { delete: 3 }])).toBe(1)
  })

  it("delete before gap: shifts left", () => {
    expect(transformIndex(3, "right", [{ delete: 2 }, { retain: 3 }])).toBe(1)
  })

  it("delete after gap: no shift", () => {
    expect(transformIndex(3, "right", [{ retain: 5 }, { delete: 2 }])).toBe(3)
  })

  it("empty instructions: identity", () => {
    expect(transformIndex(5, "right", [])).toBe(5)
    expect(transformIndex(5, "left", [])).toBe(5)
  })

  it("trailing retain: index past explicit ops", () => {
    // [retain 2] on text of length 5 — index 4 is in trailing retain
    expect(transformIndex(4, "right", [{ retain: 2 }])).toBe(4)
  })

  it("trailing retain after insert: shifts by insert length", () => {
    // [insert 2] — all positions are in trailing retain
    expect(transformIndex(3, "right", [{ insert: { length: 2 } }])).toBe(5)
  })

  it("mixed ops: insert + delete", () => {
    const ops: Instruction[] = [
      { retain: 2 },
      { insert: { length: 3 } },
      { delete: 1 },
      { retain: 4 },
    ]
    // Index 0, right: in first retain [0,2) → target 0
    expect(transformIndex(0, "right", ops)).toBe(0)

    // Index 2, left: source=2 after retain. Insert at source=2.
    // Left-sticky → stays at target=2 (before insert)
    expect(transformIndex(2, "left", ops)).toBe(2)

    // Index 2, right: source=2 after retain. Insert at source=2.
    // Right-sticky → target becomes 2+3=5. Then delete(1) at source=2.
    // Index 2 is in [2,3) delete range → collapses to target=5.
    expect(transformIndex(2, "right", ops)).toBe(5)

    // Index 3, right:
    // - retain(2): not in [0,2). Acc: src=2, tgt=2.
    // - insert(3): source=2 ≠ 3. Acc: src=2, tgt=5.
    // - delete(1): index 3 not in [2,3). Acc: src=3, tgt=5.
    // - retain(4): index 3 in [3,7). Result = 5 + (3-3) = 5.
    expect(transformIndex(3, "right", ops)).toBe(5)
  })

  it("never returns null (gaps survive deletion)", () => {
    // Delete all content
    expect(transformIndex(2, "right", [{ delete: 5 }])).toBe(0)
    expect(transformIndex(0, "left", [{ delete: 5 }])).toBe(0)
  })

  it("multiple inserts at the same position accumulate for right-sticky", () => {
    // Two inserts at position 0 — gap at 0 should end up after both inserts
    const ops: Instruction[] = [
      { insert: { length: 3 } },
      { insert: { length: 2 } },
    ]
    // Right-sticky: shifts past all inserts at source=0
    expect(transformIndex(0, "right", ops)).toBe(5)
    // Left-sticky: exits on first insert, stays at 0
    expect(transformIndex(0, "left", ops)).toBe(0)
  })

  it("index 0 with various sides", () => {
    // Insert at 0, left-sticky: stays at 0
    expect(transformIndex(0, "left", [{ insert: { length: 3 } }])).toBe(0)
    // Insert at 0, right-sticky: shifts to 3
    expect(transformIndex(0, "right", [{ insert: { length: 3 } }])).toBe(3)
  })
})

// ===========================================================================
// textInstructionsToPatches unit tests
// ===========================================================================

describe("textInstructionsToPatches", () => {
  it("converts retain + insert", () => {
    const ops: TextInstruction[] = [{ retain: 5 }, { insert: "X" }]
    const result = textInstructionsToPatches(ops)
    expect(result).toEqual([{ kind: "insert", offset: 5, text: "X" }])
  })

  it("converts retain + delete", () => {
    const ops: TextInstruction[] = [{ retain: 2 }, { delete: 3 }]
    const result = textInstructionsToPatches(ops)
    expect(result).toEqual([{ kind: "delete", offset: 2, count: 3 }])
  })

  it("delete does not advance cursor", () => {
    const ops: TextInstruction[] = [
      { retain: 5 },
      { delete: 1 },
      { insert: "!" },
    ]
    const result = textInstructionsToPatches(ops)
    expect(result).toEqual([
      { kind: "delete", offset: 5, count: 1 },
      { kind: "insert", offset: 5, text: "!" },
    ])
  })

  it("empty ops → empty patches", () => {
    expect(textInstructionsToPatches([])).toEqual([])
  })

  it("retain-only → no patches", () => {
    expect(textInstructionsToPatches([{ retain: 10 }])).toEqual([])
  })

  it("consecutive inserts advance cursor", () => {
    const ops: TextInstruction[] = [{ insert: "AB" }, { insert: "CD" }]
    const result = textInstructionsToPatches(ops)
    expect(result).toEqual([
      { kind: "insert", offset: 0, text: "AB" },
      { kind: "insert", offset: 2, text: "CD" },
    ])
  })
})

// ===========================================================================
// PlainPosition unit tests
// ===========================================================================

describe("PlainPosition", () => {
  it("resolve returns current index", () => {
    const pos = new PlainPosition(3, "right")
    expect(pos.resolve()).toBe(3)
  })

  it("side is readonly", () => {
    expect(new PlainPosition(0, "left").side).toBe("left")
    expect(new PlainPosition(0, "right").side).toBe("right")
  })

  it("encode/decode round-trip (left)", () => {
    const pos = new PlainPosition(42, "left")
    const bytes = pos.encode()
    expect(bytes.length).toBe(5)
    const decoded = decodePlainPosition(bytes)
    expect(decoded.resolve()).toBe(42)
    expect(decoded.side).toBe("left")
  })

  it("encode/decode round-trip (right)", () => {
    const pos = new PlainPosition(1000, "right")
    const decoded = decodePlainPosition(pos.encode())
    expect(decoded.resolve()).toBe(1000)
    expect(decoded.side).toBe("right")
  })

  it("encode/decode round-trip (zero)", () => {
    const pos = new PlainPosition(0, "left")
    const decoded = decodePlainPosition(pos.encode())
    expect(decoded.resolve()).toBe(0)
    expect(decoded.side).toBe("left")
  })

  it("transform updates internal index", () => {
    const pos = new PlainPosition(3, "right")
    pos.transform([{ retain: 3 }, { insert: { length: 2 } }])
    expect(pos.resolve()).toBe(5)
  })

  it("transform with delete collapses index", () => {
    const pos = new PlainPosition(3, "right")
    pos.transform([{ retain: 1 }, { delete: 3 }])
    expect(pos.resolve()).toBe(1)
  })

  it("transform is no-op for empty instructions", () => {
    const pos = new PlainPosition(7, "left")
    pos.transform([])
    expect(pos.resolve()).toBe(7)
  })

  it("decodePlainPosition rejects wrong byte length", () => {
    expect(() => decodePlainPosition(new Uint8Array(3))).toThrow()
    expect(() => decodePlainPosition(new Uint8Array(0))).toThrow()
    expect(() => decodePlainPosition(new Uint8Array(6))).toThrow()
  })
})

// ===========================================================================
// PlainPosition conformance suite
// ===========================================================================

// ---------------------------------------------------------------------------
// Factory: simulates text mutations at the string level and produces
// Instruction[] deltas that describe each edit. No interpreter stack
// needed — PlainPosition operates purely on instruction streams.
// ---------------------------------------------------------------------------

function textInsertInstructions(
  textLength: number,
  index: number,
  content: string,
): Instruction[] {
  const ops: Instruction[] = []
  if (index > 0) ops.push({ retain: index })
  ops.push({ insert: { length: content.length } })
  // Trailing retain is implicit — omitted per convention.
  return ops
}

function textDeleteInstructions(
  textLength: number,
  index: number,
  count: number,
): Instruction[] {
  const ops: Instruction[] = []
  if (index > 0) ops.push({ retain: index })
  ops.push({ delete: count })
  // Trailing retain is implicit.
  return ops
}

/** PositionCapable backed by PlainPosition + decodePlainPosition. */
const plainPositionCapable: PositionCapable = {
  createPosition(index: number, side: Side) {
    return new PlainPosition(index, side)
  },
  decodePosition(bytes: Uint8Array) {
    return decodePlainPosition(bytes)
  },
}

function createPlainEnv(initialText: string): PositionTestEnv {
  let text = initialText

  return {
    positions: plainPositionCapable,

    insert(index: number, content: string): readonly Instruction[] {
      const instructions = textInsertInstructions(text.length, index, content)
      text = text.slice(0, index) + content + text.slice(index)
      return instructions
    },

    delete(index: number, count: number): readonly Instruction[] {
      const instructions = textDeleteInstructions(text.length, index, count)
      text = text.slice(0, index) + text.slice(index + count)
      return instructions
    },

    currentText() {
      return text
    },
  }
}

positionConformance(createPlainEnv)

// ===========================================================================
// hasPosition on real refs (full interpreter stack)
// ===========================================================================

describe("hasPosition on real refs", () => {
  const DocSchema = Schema.struct({
    title: Schema.text(),
    count: Schema.counter(),
  })

  it("text ref from plain substrate has [POSITION] capability", () => {
    const doc = createRef(DocSchema, plainSubstrateFactory.create(DocSchema))
    expect(hasPosition(doc.title)).toBe(true)
  })

  it("non-text ref does not have [POSITION]", () => {
    const doc = createRef(DocSchema, plainSubstrateFactory.create(DocSchema))
    expect(hasPosition(doc.count)).toBe(false)
  })

  it("hasPosition returns false for primitives and null", () => {
    expect(hasPosition(null)).toBe(false)
    expect(hasPosition(undefined)).toBe(false)
    expect(hasPosition(42)).toBe(false)
    expect(hasPosition("string")).toBe(false)
  })

  it("[POSITION].createPosition produces a working PlainPosition", () => {
    const doc = createRef(DocSchema, plainSubstrateFactory.create(DocSchema))
    change(doc, (d: any) => {
      d.title.insert(0, "hello")
    })

    const textRef = doc.title as any
    const cap = textRef[POSITION] as PositionCapable
    const pos = cap.createPosition(2, "right")

    expect(pos.resolve()).toBe(2)
    expect(pos.side).toBe("right")

    // Encode/decode round-trip through the capability
    const decoded = cap.decodePosition(pos.encode())
    expect(decoded.resolve()).toBe(2)
    expect(decoded.side).toBe("right")
  })
})
