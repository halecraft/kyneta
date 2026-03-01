/**
 * Tests for text-patch.ts
 *
 * Phase 1: Pure functions with zero DOM or subscription dependencies.
 * Phase 3: textRegion subscription-aware DOM updates.
 */

import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import {
  REACTIVE,
  type ReactiveDelta,
  type ReactiveSubscribe,
  type TextDeltaOp,
} from "@loro-extended/reactive"
import { JSDOM } from "jsdom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetScopeIdCounter, Scope } from "./scope.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
} from "./subscribe.js"
import {
  patchText,
  planTextPatch,
  textRegion,
  type TextPatchOp,
  type TextRefLike,
} from "./text-patch.js"

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
    const ops: TextDeltaOp[] = []
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

// =============================================================================
// textRegion Tests
// =============================================================================

describe("textRegion", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
  })

  afterEach(() => {
    activeSubscriptions.clear()
  })

  describe("with mock TextRef", () => {
    /**
     * Create a mock TextRef for testing.
     * Allows manual triggering of deltas to verify textRegion behavior.
     */
    function createMockTextRef(initialValue: string): {
      ref: TextRefLike & { [REACTIVE]: ReactiveSubscribe }
      emit: (delta: ReactiveDelta) => void
      setValue: (value: string) => void
    } {
      let currentValue = initialValue
      let callback: ((delta: ReactiveDelta) => void) | null = null

      const ref = {
        get: () => currentValue,
        [REACTIVE]: ((_self: unknown, cb: (delta: ReactiveDelta) => void) => {
          callback = cb
          return () => {
            callback = null
          }
        }) as ReactiveSubscribe,
      }

      return {
        ref,
        emit: (delta: ReactiveDelta) => {
          callback?.(delta)
        },
        setValue: (value: string) => {
          currentValue = value
        },
      }
    }

    it("sets initial text content from ref.get()", () => {
      const { ref } = createMockTextRef("Hello")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)

      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("applies text delta via insertData", () => {
      const { ref, emit, setValue } = createMockTextRef("Hello")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("Hello")

      // Simulate text insert: "Hello" → "Hello World"
      setValue("Hello World")
      emit({ type: "text", ops: [{ retain: 5 }, { insert: " World" }] })

      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("applies text delta via deleteData", () => {
      const { ref, emit, setValue } = createMockTextRef("Hello World")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("Hello World")

      // Simulate text delete: "Hello World" → "Hello"
      setValue("Hello")
      emit({ type: "text", ops: [{ retain: 5 }, { delete: 6 }] })

      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("falls back to full replacement for non-text delta", () => {
      const { ref, emit, setValue } = createMockTextRef("old value")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("old value")

      // Simulate a "replace" delta (e.g., from a LocalRef or full replacement)
      setValue("new value")
      emit({ type: "replace" })

      expect(textNode.textContent).toBe("new value")

      scope.dispose()
    })

    it("registers cleanup with scope", () => {
      const { ref } = createMockTextRef("test")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      expect(getActiveSubscriptionCount()).toBe(0)

      textRegion(textNode, ref, scope)

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("handles multiple text deltas in sequence", () => {
      const { ref, emit, setValue } = createMockTextRef("abc")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("abc")

      // First edit: "abc" → "abXc"
      setValue("abXc")
      emit({ type: "text", ops: [{ retain: 2 }, { insert: "X" }] })
      expect(textNode.textContent).toBe("abXc")

      // Second edit: "abXc" → "abXYc"
      setValue("abXYc")
      emit({ type: "text", ops: [{ retain: 3 }, { insert: "Y" }] })
      expect(textNode.textContent).toBe("abXYc")

      // Third edit: "abXYc" → "aXYc" (delete 'b')
      setValue("aXYc")
      emit({ type: "text", ops: [{ retain: 1 }, { delete: 1 }] })
      expect(textNode.textContent).toBe("aXYc")

      scope.dispose()
    })
  })

  describe("with real Loro TextRef", () => {
    it("renders initial value from TextRef", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Set initial value
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      textRegion(textNode, doc.title, scope)

      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("applies insert delta from Loro TextRef", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Set initial value
      doc.title.insert(0, "Hello")
      loro(doc).commit()

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello")

      // Insert " World" at end
      doc.title.insert(5, " World")
      loro(doc).commit()

      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("applies delete delta from Loro TextRef", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const textNode = document.createTextNode("")

      // Set initial value
      doc.title.insert(0, "Hello World")
      loro(doc).commit()

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello World")

      // Delete " World"
      doc.title.delete(5, 6)
      loro(doc).commit()

      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("unsubscribes when scope is disposed", () => {
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      const scope = new Scope()
      const textNode = document.createTextNode("")

      doc.title.insert(0, "Hello")
      loro(doc).commit()

      textRegion(textNode, doc.title, scope)
      expect(textNode.textContent).toBe("Hello")

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)

      // Changes after dispose should not affect the text node
      doc.title.insert(5, " World")
      loro(doc).commit()

      // Text node should still have old value
      expect(textNode.textContent).toBe("Hello")
    })
  })
})
