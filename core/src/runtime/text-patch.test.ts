/**
 * Tests for text-patch.ts
 *
 * Phase 1 of text patching: pure functions with zero DOM or subscription dependencies.
 */

import { JSDOM } from "jsdom"
import { describe, expect, it } from "vitest"
import { patchText, planTextPatch, type TextPatchOp } from "./text-patch.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Text = dom.window.Text

// =============================================================================
// planTextPatch Tests
// =============================================================================

describe("planTextPatch", () => {
  it("converts retain + insert to offset-based insert op", () => {
    const ops = [{ retain: 5 }, { insert: "X" }]
    const result = planTextPatch(ops)

    expect(result).toEqual([{ kind: "insert", offset: 5, text: "X" }])
  })

  it("converts retain + delete to offset-based delete op", () => {
    const ops = [{ retain: 3 }, { delete: 2 }]
    const result = planTextPatch(ops)

    expect(result).toEqual([{ kind: "delete", offset: 3, count: 2 }])
  })

  it("handles insert at start (no retain)", () => {
    const ops = [{ insert: "Hello" }]
    const result = planTextPatch(ops)

    expect(result).toEqual([{ kind: "insert", offset: 0, text: "Hello" }])
  })

  it("handles complex sequence", () => {
    // retain 2, delete 3, insert "abc"
    const ops = [{ retain: 2 }, { delete: 3 }, { insert: "abc" }]
    const result = planTextPatch(ops)

    // delete at offset 2, then insert at same position (cursor doesn't move on delete)
    expect(result).toEqual([
      { kind: "delete", offset: 2, count: 3 },
      { kind: "insert", offset: 2, text: "abc" },
    ])
  })

  it("handles empty ops", () => {
    const ops: { retain?: number; insert?: string; delete?: number }[] = []
    const result = planTextPatch(ops)

    expect(result).toEqual([])
  })

  it("handles multiple retains", () => {
    const ops = [{ retain: 5 }, { retain: 3 }, { insert: "!" }]
    const result = planTextPatch(ops)

    expect(result).toEqual([{ kind: "insert", offset: 8, text: "!" }])
  })

  it("handles consecutive inserts", () => {
    const ops = [{ insert: "A" }, { insert: "B" }]
    const result = planTextPatch(ops)

    // First insert at 0, cursor moves to 1; second insert at 1
    expect(result).toEqual([
      { kind: "insert", offset: 0, text: "A" },
      { kind: "insert", offset: 1, text: "B" },
    ])
  })

  it("handles delete followed by insert at same position", () => {
    // This is the "replace" pattern
    const ops = [{ retain: 2 }, { delete: 4 }, { insert: "new" }]
    const result = planTextPatch(ops)

    // Both operations at offset 2
    expect(result).toEqual([
      { kind: "delete", offset: 2, count: 4 },
      { kind: "insert", offset: 2, text: "new" },
    ])
  })

  it("handles retain-only ops (no-op)", () => {
    const ops = [{ retain: 10 }]
    const result = planTextPatch(ops)

    expect(result).toEqual([])
  })
})

// =============================================================================
// patchText Tests
// =============================================================================

describe("patchText", () => {
  it("applies insert delta", () => {
    const text = document.createTextNode("Hello")
    patchText(text, [{ retain: 5 }, { insert: " World" }])

    expect(text.textContent).toBe("Hello World")
  })

  it("applies delete delta", () => {
    const text = document.createTextNode("Hello World")
    patchText(text, [{ retain: 5 }, { delete: 6 }])

    expect(text.textContent).toBe("Hello")
  })

  it("applies complex delta sequence", () => {
    // "abcdef" → delete "cd" at position 2, insert "XY" → "abXYef"
    const text = document.createTextNode("abcdef")
    patchText(text, [{ retain: 2 }, { delete: 2 }, { insert: "XY" }])

    expect(text.textContent).toBe("abXYef")
  })

  it("applies insert at start", () => {
    const text = document.createTextNode("World")
    patchText(text, [{ insert: "Hello " }])

    expect(text.textContent).toBe("Hello World")
  })

  it("applies delete at start", () => {
    const text = document.createTextNode("Hello World")
    patchText(text, [{ delete: 6 }])

    expect(text.textContent).toBe("World")
  })

  it("handles empty ops (no change)", () => {
    const text = document.createTextNode("unchanged")
    patchText(text, [])

    expect(text.textContent).toBe("unchanged")
  })

  it("handles multiple operations in sequence", () => {
    // "Hello World" → insert "!" at end
    const text = document.createTextNode("Hello World")
    patchText(text, [{ retain: 11 }, { insert: "!" }])

    expect(text.textContent).toBe("Hello World!")
  })

  it("handles complete replacement", () => {
    // "old" → delete all, insert "new"
    const text = document.createTextNode("old")
    patchText(text, [{ delete: 3 }, { insert: "new" }])

    expect(text.textContent).toBe("new")
  })
})
