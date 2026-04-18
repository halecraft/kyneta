// position-conformance — shared, re-exportable conformance suite for Position implementations.
//
// Any substrate that implements PositionCapable can run this suite by providing
// a PositionConformanceFactory. The factory creates a PositionTestEnv with:
//   - positions: PositionCapable (create/decode positions)
//   - insert/delete: mutate text and return the TextInstruction[] delta
//   - currentText: read the current string value
//
// The suite tests:
//   1. Stability — positions track correctly through edits elsewhere
//   2. Sticky-side — left vs right bias at insertion boundaries
//   3. Deletion resolution — positions within deleted ranges collapse to boundary
//   4. Encode/decode round-trip — serialization preserves resolve() and side
//   5. Sequential agreement — transform() agrees with transformIndex over chains
//
// Cursor models:
//   - "transform" (default): gap-based positions updated via transform(instructions).
//     Left-sticky stays before same-peer insertions at the gap. PlainPosition uses this.
//   - "identity": character-ID-based cursors (e.g. Loro Cursor). resolve() queries
//     the live document state; transform() is a no-op. Same-peer inserts at the
//     cursor's position always push the cursor forward regardless of side, because
//     the cursor is bound to an existing character, not an abstract gap. Left-sticky
//     vs right-sticky only diverges for *concurrent* inserts from different peers.
//     Tests that assert left-sticky same-peer divergence are skipped for this model.

import { describe, expect, it } from "vitest"
import { transformIndex } from "../change.js"
import type { Instruction } from "../change.js"
import type { PositionCapable, Side } from "../position.js"

// ---------------------------------------------------------------------------
// Factory interface
// ---------------------------------------------------------------------------

export interface PositionTestEnv {
  /** The PositionCapable capability for creating/decoding positions. */
  readonly positions: PositionCapable
  /** Insert text at index, return the change instructions (as Instruction[]). */
  insert(index: number, text: string): readonly Instruction[]
  /** Delete count chars at index, return the change instructions (as Instruction[]). */
  delete(index: number, count: number): readonly Instruction[]
  /** Read current text value. */
  currentText(): string
}

export type PositionConformanceFactory = (initialText: string) => PositionTestEnv

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * "transform" — gap-based positions, updated via transform(). Default.
 * "identity" — character-ID-based cursors (Loro). resolve() is stateless
 *   against the live doc; same-peer left-sticky divergence is not observable.
 */
export type CursorModel = "transform" | "identity"

export interface PositionConformanceOptions {
  readonly cursorModel?: CursorModel
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

export function positionConformance(
  factory: PositionConformanceFactory,
  options?: PositionConformanceOptions,
): void {
  const cursorModel = options?.cursorModel ?? "transform"

  // Identity-based cursors cannot distinguish left- from right-sticky for
  // same-peer inserts at the cursor's exact position — the cursor is bound
  // to a character ID, so it always shifts past same-peer insertions.
  const isIdentity = cursorModel === "identity"

  // Helper: use it.skip for tests that are not applicable to this cursor model.
  const itLeftSticky = isIdentity ? it.skip : it

  describe("position conformance", () => {
    // =========================================================================
    // 1. Stability — positions track correctly through edits before and after
    // =========================================================================

    it("stability: insert before position shifts index right", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(2, "right")

      const ins = env.insert(0, "XX")
      pos.transform(ins)

      expect(pos.resolve()).toBe(4) // shifted right by 2
      expect(env.currentText()).toBe("XXabcde")
    })

    it("stability: insert after position leaves index unchanged", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(2, "right")

      const ins = env.insert(4, "YY")
      pos.transform(ins)

      expect(pos.resolve()).toBe(2) // unchanged
      expect(env.currentText()).toBe("abcdYYe")
    })

    it("stability: delete before position shifts index left", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(3, "right")

      const del = env.delete(0, 2)
      pos.transform(del)

      expect(pos.resolve()).toBe(1) // shifted left by 2
      expect(env.currentText()).toBe("cde")
    })

    it("stability: delete after position leaves index unchanged", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(1, "right")

      const del = env.delete(3, 2)
      pos.transform(del)

      expect(pos.resolve()).toBe(1) // unchanged
      expect(env.currentText()).toBe("abc")
    })

    it("stability: sequential inserts before and after", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(2, "right")

      // Insert before position
      const ins1 = env.insert(0, "XX")
      pos.transform(ins1)
      expect(pos.resolve()).toBe(4)
      expect(env.currentText()).toBe("XXabcde")

      // Insert after position
      const ins2 = env.insert(6, "YY")
      pos.transform(ins2)
      expect(pos.resolve()).toBe(4) // unchanged
      expect(env.currentText()).toBe("XXabcdYYe")
    })

    // =========================================================================
    // 2. Sticky-side — left vs right bias at insertion boundary
    //
    // Tests marked with itLeftSticky are skipped for identity-based cursors
    // (cursorModel: "identity") because same-peer inserts at the cursor
    // position always push the cursor forward — sticky-side only manifests
    // across concurrent peers in that model.
    // =========================================================================

    itLeftSticky("sticky-side: left-sticky stays before insertion at gap", () => {
      const env = factory("abc")
      const pos = env.positions.createPosition(1, "left")

      // Insert at exactly index 1
      const ins = env.insert(1, "X")
      pos.transform(ins)

      // Left-sticky: stays at 1 (before the insertion)
      expect(pos.resolve()).toBe(1)
      expect(env.currentText()).toBe("aXbc")
    })

    it("sticky-side: right-sticky shifts past insertion at gap", () => {
      const env = factory("abc")
      const pos = env.positions.createPosition(1, "right")

      // Insert at exactly index 1
      const ins = env.insert(1, "X")
      pos.transform(ins)

      // Right-sticky: shifts to 2 (after the insertion)
      expect(pos.resolve()).toBe(2)
      expect(env.currentText()).toBe("aXbc")
    })

    itLeftSticky("sticky-side: left-sticky at position 0", () => {
      const env = factory("abc")
      const pos = env.positions.createPosition(0, "left")

      const ins = env.insert(0, "X")
      pos.transform(ins)

      // Left-sticky at 0: stays at 0
      expect(pos.resolve()).toBe(0)
    })

    it("sticky-side: right-sticky at position 0", () => {
      const env = factory("abc")
      const pos = env.positions.createPosition(0, "right")

      const ins = env.insert(0, "X")
      pos.transform(ins)

      // Right-sticky at 0: shifts past insertion
      expect(pos.resolve()).toBe(1)
    })

    itLeftSticky("sticky-side: insert of multiple characters at gap", () => {
      const env = factory("abc")
      const left = env.positions.createPosition(1, "left")
      const right = env.positions.createPosition(1, "right")

      const ins = env.insert(1, "XYZ")
      left.transform(ins)
      right.transform(ins)

      expect(left.resolve()).toBe(1) // before "XYZ"
      expect(right.resolve()).toBe(4) // after "XYZ"
      expect(env.currentText()).toBe("aXYZbc")
    })

    // =========================================================================
    // 3. Deletion resolution — position within deleted range collapses
    // =========================================================================

    it("deletion: position within deleted range resolves to boundary", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(2, "right")

      // Delete range [1, 4) — covers index 2
      const del = env.delete(1, 3)
      pos.transform(del)

      // Position collapses to deletion boundary
      expect(pos.resolve()).toBe(1)
      expect(env.currentText()).toBe("ae")
    })

    it("deletion: position at start of deleted range collapses", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(1, "right")

      const del = env.delete(1, 3)
      pos.transform(del)

      expect(pos.resolve()).toBe(1)
    })

    it("deletion: position at end of deleted range collapses", () => {
      const env = factory("abcde")
      // Position at index 3, which is the last char in delete [1, 4)
      const pos = env.positions.createPosition(3, "right")

      const del = env.delete(1, 3)
      pos.transform(del)

      expect(pos.resolve()).toBe(1)
    })

    it("deletion: delete all content collapses to 0", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(3, "right")

      const del = env.delete(0, 5)
      pos.transform(del)

      expect(pos.resolve()).toBe(0)
      expect(env.currentText()).toBe("")
    })

    // =========================================================================
    // 4. Encode/decode round-trip
    // =========================================================================

    it("encode/decode: round-trip preserves resolve() and side", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(3, "left")

      const encoded = pos.encode()
      const decoded = env.positions.decodePosition(encoded)

      expect(decoded.resolve()).toBe(pos.resolve())
      expect(decoded.side).toBe(pos.side)
    })

    it("encode/decode: round-trip with right side", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(3, "right")

      const encoded = pos.encode()
      const decoded = env.positions.decodePosition(encoded)

      expect(decoded.resolve()).toBe(pos.resolve())
      expect(decoded.side).toBe("right")
    })

    it("encode/decode: round-trip after mutations", () => {
      const env = factory("abcde")
      const pos = env.positions.createPosition(2, "right")

      const ins = env.insert(0, "XX")
      pos.transform(ins)

      // Encode after transform captures the updated index
      const encoded = pos.encode()
      const decoded = env.positions.decodePosition(encoded)

      expect(decoded.resolve()).toBe(pos.resolve())
      expect(decoded.side).toBe(pos.side)
    })

    it("encode/decode: position at 0", () => {
      const env = factory("abc")
      const pos = env.positions.createPosition(0, "left")

      const decoded = env.positions.decodePosition(pos.encode())
      expect(decoded.resolve()).toBe(0)
      expect(decoded.side).toBe("left")
    })

    // =========================================================================
    // 5. Sequential agreement — transform() agrees with transformIndex
    //
    // For identity-based cursors, transform() is a no-op and resolve()
    // queries the live doc. The right-sticky tests still pass because the
    // cursor tracks the character that was at the original index, and
    // right-sticky inserts elsewhere agree with transformIndex. The
    // left-sticky test that inserts at the exact cursor position is
    // skipped because identity cursors always shift past same-peer inserts.
    // =========================================================================

    it("sequential agreement: right-sticky multi-edit chain", () => {
      const env = factory("hello world")
      const index = 5
      const side: Side = "right"
      const pos = env.positions.createPosition(index, side)

      // Multiple sequential edits
      const ins1 = env.insert(0, "AAA")
      pos.transform(ins1)

      const del1 = env.delete(8, 3) // delete in the middle
      pos.transform(del1)

      const ins2 = env.insert(5, "BB")
      pos.transform(ins2)

      // Compute expected via transformIndex chain
      let expected = index
      expected = transformIndex(expected, side, ins1)
      expected = transformIndex(expected, side, del1)
      expected = transformIndex(expected, side, ins2)

      expect(pos.resolve()).toBe(expected)
    })

    itLeftSticky("sequential agreement: left-sticky multi-edit chain", () => {
      const env = factory("abcdefgh")
      const index = 4
      const side: Side = "left"
      const pos = env.positions.createPosition(index, side)

      const ins1 = env.insert(4, "XX") // insert at position
      pos.transform(ins1)

      const del1 = env.delete(2, 2) // delete before position
      pos.transform(del1)

      let expected = index
      expected = transformIndex(expected, side, ins1)
      expected = transformIndex(expected, side, del1)

      expect(pos.resolve()).toBe(expected)
    })

    it("sequential agreement: insert-delete-insert chain", () => {
      const env = factory("0123456789")
      const index = 5
      const side: Side = "right"
      const pos = env.positions.createPosition(index, side)

      const ins1 = env.insert(2, "AA")
      pos.transform(ins1)

      const del1 = env.delete(0, 3)
      pos.transform(del1)

      const ins2 = env.insert(4, "B")
      pos.transform(ins2)

      const del2 = env.delete(6, 2)
      pos.transform(del2)

      let expected = index
      expected = transformIndex(expected, side, ins1)
      expected = transformIndex(expected, side, del1)
      expected = transformIndex(expected, side, ins2)
      expected = transformIndex(expected, side, del2)

      expect(pos.resolve()).toBe(expected)
    })

    it("sequential agreement: multiple positions track independently", () => {
      const env = factory("abcdef")
      const posA = env.positions.createPosition(1, "left")
      const posB = env.positions.createPosition(4, "right")

      const ins = env.insert(2, "XX")
      posA.transform(ins)
      posB.transform(ins)

      let expectedA = transformIndex(1, "left", ins)
      let expectedB = transformIndex(4, "right", ins)

      expect(posA.resolve()).toBe(expectedA)
      expect(posB.resolve()).toBe(expectedB)

      const del = env.delete(0, 3)
      posA.transform(del)
      posB.transform(del)

      expectedA = transformIndex(expectedA, "left", del)
      expectedB = transformIndex(expectedB, "right", del)

      expect(posA.resolve()).toBe(expectedA)
      expect(posB.resolve()).toBe(expectedB)
    })
  })
}