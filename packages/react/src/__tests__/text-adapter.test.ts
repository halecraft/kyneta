import { textChange } from "@kyneta/schema"
import { change, createDoc, Schema } from "@kyneta/schema/basic"
import { describe, expect, it, vi } from "vitest"
import {
  attach,
  diffText,
  type TextRefLike,
  transformSelection,
} from "../text-adapter.js"

// ===========================================================================
// Functional Core: diffText
// ===========================================================================

describe("diffText", () => {
  it("insert at beginning", () => {
    expect(diffText("abc", "Xabc", 1)).toEqual(textChange([{ insert: "X" }]))
  })

  it("insert in middle", () => {
    expect(diffText("abc", "aXbc", 2)).toEqual(
      textChange([{ retain: 1 }, { insert: "X" }]),
    )
  })

  it("insert at end", () => {
    expect(diffText("abc", "abcX", 4)).toEqual(
      textChange([{ retain: 3 }, { insert: "X" }]),
    )
  })

  it("delete at beginning", () => {
    expect(diffText("abc", "bc", 0)).toEqual(textChange([{ delete: 1 }]))
  })

  it("delete in middle", () => {
    expect(diffText("abc", "ac", 1)).toEqual(
      textChange([{ retain: 1 }, { delete: 1 }]),
    )
  })

  it("delete at end", () => {
    expect(diffText("abc", "ab", 2)).toEqual(
      textChange([{ retain: 2 }, { delete: 1 }]),
    )
  })

  it("replace", () => {
    expect(diffText("abc", "aXYc", 3)).toEqual(
      textChange([{ retain: 1 }, { delete: 1 }, { insert: "XY" }]),
    )
  })

  it("no-op (identical strings)", () => {
    expect(diffText("abc", "abc", 2)).toEqual(textChange([]))
  })

  it("empty to non-empty", () => {
    expect(diffText("", "hello", 5)).toEqual(textChange([{ insert: "hello" }]))
  })

  it("non-empty to empty", () => {
    expect(diffText("hello", "", 0)).toEqual(textChange([{ delete: 5 }]))
  })

  it("multi-char insert", () => {
    expect(diffText("ab", "aXYZb", 4)).toEqual(
      textChange([{ retain: 1 }, { insert: "XYZ" }]),
    )
  })

  it("cursor hint disambiguation within identical characters", () => {
    // "aaa" → "aaaa" with cursor at 2 means the insert happened at position 2
    const result = diffText("aaa", "aaaa", 2)
    expect(result).toEqual(textChange([{ retain: 2 }, { insert: "a" }]))
  })

  it("handles repeated character runs with cursor hint at different positions", () => {
    // Typing 'b' into "bbb" — the diff is ambiguous (insert could be at 0,1,2,3).
    // Cursor at 1 → insert at position 1
    expect(diffText("bbb", "bbbb", 1)).toEqual(
      textChange([{ retain: 1 }, { insert: "b" }]),
    )
    // Cursor at 3 → insert at position 3
    expect(diffText("bbb", "bbbb", 3)).toEqual(
      textChange([{ retain: 3 }, { insert: "b" }]),
    )
    // Cursor at 0 → insert at position 0
    expect(diffText("bbb", "bbbb", 0)).toEqual(textChange([{ insert: "b" }]))
  })

  it("handles deletion within repeated characters with cursor hint", () => {
    // Deleting one 'a' from "aaaa" — ambiguous which was deleted.
    // Cursor at 2 → delete at position 2
    expect(diffText("aaaa", "aaa", 2)).toEqual(
      textChange([{ retain: 2 }, { delete: 1 }]),
    )
  })
})

// ===========================================================================
// Functional Core: transformSelection
// ===========================================================================

describe("transformSelection", () => {
  it("rebase through insert before selection", () => {
    // Insert "XX" (length 2) at position 0, then retain 10.
    // Selection [3,5] → [5,7] because both endpoints shift right by 2.
    const result = transformSelection(3, 5, [{ insert: "XX" }, { retain: 10 }])
    expect(result).toEqual({ start: 5, end: 7 })
  })

  it("rebase through delete before selection", () => {
    // Delete 2 characters at position 0, then retain 8.
    // Selection [5,7] → [3,5] because both endpoints shift left by 2.
    const result = transformSelection(5, 7, [{ delete: 2 }, { retain: 8 }])
    expect(result).toEqual({ start: 3, end: 5 })
  })

  it("no change on retain-only", () => {
    const result = transformSelection(3, 5, [{ retain: 10 }])
    expect(result).toEqual({ start: 3, end: 5 })
  })

  it("insert at selection start shifts both endpoints (right affinity)", () => {
    // Insert at position 3, selection is [3,5].
    // Right affinity means cursor at position 3 shifts past the insert.
    const result = transformSelection(3, 5, [{ retain: 3 }, { insert: "X" }])
    expect(result).toEqual({ start: 4, end: 6 })
  })

  it("insert after selection does not affect it", () => {
    const result = transformSelection(1, 3, [{ retain: 5 }, { insert: "ZZ" }])
    expect(result).toEqual({ start: 1, end: 3 })
  })

  it("delete spanning selection collapses endpoints", () => {
    // Delete range [1, 4) — selection [2, 3] falls within.
    const result = transformSelection(2, 3, [{ retain: 1 }, { delete: 3 }])
    expect(result).toEqual({ start: 1, end: 1 })
  })

  it("collapsed cursor (start === end) transforms as a single point", () => {
    const result = transformSelection(3, 3, [{ insert: "AB" }, { retain: 10 }])
    expect(result).toEqual({ start: 5, end: 5 })
  })
})

// ===========================================================================
// Imperative Shell: attach
// ===========================================================================

// ---------------------------------------------------------------------------
// Test schema and helpers
// ---------------------------------------------------------------------------

const TextDocSchema = Schema.struct({
  title: Schema.text(),
})

function createTestDoc(initialText: string = "") {
  const doc = createDoc(TextDocSchema)
  if (initialText) {
    change(doc, d => {
      d.title.insert(0, initialText)
    })
  }
  return doc
}

/**
 * Create a minimal mock HTMLInputElement with the properties attach() needs.
 * jsdom is configured in vitest.config.ts so we get real DOM elements,
 * but we construct them manually to control state precisely.
 */
function createMockInput(initialValue: string = ""): HTMLInputElement {
  const input = document.createElement("input")
  input.value = initialValue
  return input
}

function createMockTextarea(initialValue: string = ""): HTMLTextAreaElement {
  const textarea = document.createElement("textarea")
  textarea.value = initialValue
  return textarea
}

// ---------------------------------------------------------------------------
// attach() tests
// ---------------------------------------------------------------------------

describe("attach", () => {
  describe("initial state projection", () => {
    it("sets element value from text ref on attach", () => {
      const doc = createTestDoc("Hello")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)
      expect(input.value).toBe("Hello")
      detach()
    })

    it("sets empty string for empty text ref", () => {
      const doc = createTestDoc()
      const input = createMockInput("stale")

      const detach = attach(input, doc.title as unknown as TextRefLike)
      expect(input.value).toBe("")
      detach()
    })

    it("works with textarea elements", () => {
      const doc = createTestDoc("Textarea content")
      const textarea = createMockTextarea()

      const detach = attach(textarea, doc.title as unknown as TextRefLike)
      expect(textarea.value).toBe("Textarea content")
      detach()
    })
  })

  describe("local edit capture", () => {
    it("captures insert via input event and applies to text ref", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)
      expect(input.value).toBe("abc")

      // Simulate user typing "X" at position 1: "abc" → "aXbc"
      input.value = "aXbc"
      input.selectionStart = 2
      input.selectionEnd = 2
      input.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("aXbc")
      detach()
    })

    it("captures delete via input event", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Simulate user deleting "b": "abc" → "ac"
      input.value = "ac"
      input.selectionStart = 1
      input.selectionEnd = 1
      input.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("ac")
      detach()
    })

    it("captures replace via input event", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Simulate replacing "b" with "XY": "abc" → "aXYc"
      input.value = "aXYc"
      input.selectionStart = 3
      input.selectionEnd = 3
      input.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("aXYc")
      detach()
    })

    it("no-op input event when value unchanged", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Dispatch input without changing value — should be a no-op
      input.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("abc")
      detach()
    })
  })

  describe("remote change application", () => {
    it("applies remote insert surgically via setRangeText", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)
      expect(input.value).toBe("abc")

      // Position cursor at end to verify it's preserved
      input.selectionStart = 3
      input.selectionEnd = 3

      // Simulate a remote change (no "local" origin)
      change(doc, d => {
        d.title.insert(0, "X")
      })

      expect(input.value).toBe("Xabc")
      detach()
    })

    it("applies remote delete surgically", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      change(doc, d => {
        d.title.delete(1, 1)
      })

      expect(input.value).toBe("ac")
      detach()
    })

    it("rebases selection through remote insert before cursor", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Place cursor at position 2
      input.selectionStart = 2
      input.selectionEnd = 2

      // Remote inserts "XX" at position 0 → cursor should shift to 4
      change(doc, d => {
        d.title.insert(0, "XX")
      })

      expect(input.value).toBe("XXabc")
      expect(input.selectionStart).toBe(4)
      expect(input.selectionEnd).toBe(4)
      detach()
    })
  })

  describe("echo suppression", () => {
    it("does not apply local changes back to the element", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()
      const setRangeTextSpy = vi.spyOn(input, "setRangeText")

      const detach = attach(input, doc.title as unknown as TextRefLike)
      // Reset spy after initial attach (which doesn't call setRangeText)
      setRangeTextSpy.mockClear()

      // Simulate a local edit — this goes through the input event path
      input.value = "aXbc"
      input.selectionStart = 2
      input.selectionEnd = 2
      input.dispatchEvent(new Event("input"))

      // The change should NOT trigger setRangeText (echo suppression),
      // because the changeset has origin "local" and the subscriber skips it.
      expect(setRangeTextSpy).not.toHaveBeenCalled()

      // But the CRDT should still have the new value
      expect(doc.title()).toBe("aXbc")

      setRangeTextSpy.mockRestore()
      detach()
    })
  })

  describe("IME composition handling", () => {
    it("suppresses input events during composition", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Start composition
      input.dispatchEvent(new Event("compositionstart"))

      // Simulate intermediate IME input — should be suppressed
      input.value = "a候bc"
      input.selectionStart = 3
      input.dispatchEvent(new Event("input"))

      // CRDT should NOT have the intermediate value
      expect(doc.title()).toBe("abc")

      // End composition with final committed text
      input.value = "a好bc"
      input.selectionStart = 2
      input.dispatchEvent(new Event("compositionend"))

      // Now the CRDT should have the final value
      expect(doc.title()).toBe("a好bc")

      detach()
    })
  })

  describe("undo interception", () => {
    it("prevents undo (Cmd+Z) and redo (Shift+Cmd+Z) keystrokes by default", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()
      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Cmd+Z (undo — lowercase z)
      const cmdZ = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        cancelable: true,
      })
      input.dispatchEvent(cmdZ)
      expect(cmdZ.defaultPrevented).toBe(true)

      // Ctrl+Z (undo — Windows/Linux)
      const ctrlZ = new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        cancelable: true,
      })
      input.dispatchEvent(ctrlZ)
      expect(ctrlZ.defaultPrevented).toBe(true)

      // Shift+Cmd+Z (redo — uppercase Z from Shift)
      const shiftCmdZ = new KeyboardEvent("keydown", {
        key: "Z",
        metaKey: true,
        shiftKey: true,
        cancelable: true,
      })
      input.dispatchEvent(shiftCmdZ)
      expect(shiftCmdZ.defaultPrevented).toBe(true)

      detach()
    })

    it("prevents historyUndo/historyRedo beforeinput events", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)

      const undoEvent = new InputEvent("beforeinput", {
        inputType: "historyUndo",
        cancelable: true,
      })
      input.dispatchEvent(undoEvent)
      expect(undoEvent.defaultPrevented).toBe(true)

      const redoEvent = new InputEvent("beforeinput", {
        inputType: "historyRedo",
        cancelable: true,
      })
      input.dispatchEvent(redoEvent)
      expect(redoEvent.defaultPrevented).toBe(true)

      detach()
    })

    it("allows native undo when undo option is 'browser'", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike, {
        undo: "browser",
      })

      const keydownEvent = new KeyboardEvent("keydown", {
        key: "z",
        metaKey: true,
        cancelable: true,
      })
      input.dispatchEvent(keydownEvent)

      expect(keydownEvent.defaultPrevented).toBe(false)

      const undoEvent = new InputEvent("beforeinput", {
        inputType: "historyUndo",
        cancelable: true,
      })
      input.dispatchEvent(undoEvent)
      expect(undoEvent.defaultPrevented).toBe(false)

      detach()
    })
  })

  describe("selection range rebase with non-collapsed selection", () => {
    it("preserves selection range through remote insert before selection", () => {
      const doc = createTestDoc("hello world")
      const input = createMockInput()
      const detach = attach(input, doc.title as unknown as TextRefLike)

      // Select "world" (positions 6-11)
      input.selectionStart = 6
      input.selectionEnd = 11

      // Remote inserts "XX" at position 0
      change(doc, d => {
        d.title.insert(0, "XX")
      })

      // Selection should shift right by 2, preserving the range
      expect(input.selectionStart).toBe(8)
      expect(input.selectionEnd).toBe(13)
      detach()
    })
  })

  describe("detach", () => {
    it("removes all event listeners and unsubscribes", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)
      detach()

      // After detach, input events should not flow to the CRDT
      input.value = "changed"
      input.selectionStart = 7
      input.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("abc") // unchanged

      // Remote changes should not flow to the element
      change(doc, d => {
        d.title.insert(0, "Z")
      })

      expect(input.value).toBe("changed") // unchanged by remote
    })

    it("is idempotent (calling detach twice does not throw)", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title as unknown as TextRefLike)
      detach()
      expect(() => detach()).not.toThrow()
    })
  })
})
