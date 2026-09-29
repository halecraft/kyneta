import { CHANGEFEED, type HasChangefeed } from "@kyneta/changefeed"
import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { describe, expect, it, vi } from "vitest"
import {
  attach,
  attachWhenLoaded,
  transformSelection,
} from "../text-adapter.js"

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
    batch(doc, d => {
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

      const detach = attach(input, doc.title)
      expect(input.value).toBe("Hello")
      detach()
    })

    it("sets empty string for empty text ref", () => {
      const doc = createTestDoc()
      const input = createMockInput("stale")

      const detach = attach(input, doc.title)
      expect(input.value).toBe("")
      detach()
    })

    it("works with textarea elements", () => {
      const doc = createTestDoc("Textarea content")
      const textarea = createMockTextarea()

      const detach = attach(textarea, doc.title)
      expect(textarea.value).toBe("Textarea content")
      detach()
    })
  })

  describe("local edit capture", () => {
    it("captures insert via input event and applies to text ref", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title)
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

      const detach = attach(input, doc.title)

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

      const detach = attach(input, doc.title)

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

      const detach = attach(input, doc.title)

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

      const detach = attach(input, doc.title)
      expect(input.value).toBe("abc")

      // Position cursor at end to verify it's preserved
      input.selectionStart = 3
      input.selectionEnd = 3

      // Simulate a remote change (no "local" origin)
      batch(doc, d => {
        d.title.insert(0, "X")
      })

      expect(input.value).toBe("Xabc")
      detach()
    })

    it("applies remote delete surgically", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title)

      batch(doc, d => {
        d.title.delete(1, 1)
      })

      expect(input.value).toBe("ac")
      detach()
    })

    it("rebases selection through remote insert before cursor", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title)

      // Place cursor at position 2
      input.selectionStart = 2
      input.selectionEnd = 2

      // Remote inserts "XX" at position 0 → cursor should shift to 4
      batch(doc, d => {
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

      const detach = attach(input, doc.title)
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

      const detach = attach(input, doc.title)

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
      const detach = attach(input, doc.title)

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

      const detach = attach(input, doc.title)

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

      const detach = attach(input, doc.title, {
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
      const detach = attach(input, doc.title)

      // Select "world" (positions 6-11)
      input.selectionStart = 6
      input.selectionEnd = 11

      // Remote inserts "XX" at position 0
      batch(doc, d => {
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

      const detach = attach(input, doc.title)
      detach()

      // After detach, input events should not flow to the CRDT
      input.value = "changed"
      input.selectionStart = 7
      input.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("abc") // unchanged

      // Remote changes should not flow to the element
      batch(doc, d => {
        d.title.insert(0, "Z")
      })

      expect(input.value).toBe("changed") // unchanged by remote
    })

    it("is idempotent (calling detach twice does not throw)", () => {
      const doc = createTestDoc("abc")
      const input = createMockInput()

      const detach = attach(input, doc.title)
      detach()
      expect(() => detach()).not.toThrow()
    })
  })
})

// ---------------------------------------------------------------------------
// attachWhenLoaded
// ---------------------------------------------------------------------------

function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: unknown) => void
} {
  let resolve: () => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("attachWhenLoaded", () => {
  const TitleDoc = Schema.struct({ title: Schema.text() })

  it("is read-only and unbound until loaded, then binds", async () => {
    const doc = createDoc(TitleDoc)
    batch(doc, d => d.title.insert(0, "loaded"))
    const textarea = document.createElement("textarea")
    const load = deferred()

    const detach = attachWhenLoaded(textarea, doc.title, load.promise)
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe("")

    load.resolve()
    await load.promise
    expect(textarea.readOnly).toBe(false)
    expect(textarea.value).toBe("loaded")
    detach()
  })

  it("stays read-only and unbound when the load fails", async () => {
    const doc = createDoc(TitleDoc)
    const textarea = document.createElement("textarea")
    const load = deferred()

    attachWhenLoaded(textarea, doc.title, load.promise)
    load.reject(new Error("unreadable"))
    await load.promise.catch(() => {})

    expect(textarea.readOnly).toBe(true)
    batch(doc, d => d.title.insert(0, "later"))
    expect(textarea.value).toBe("")
  })

  it("binds nothing when disposed before the load completes", async () => {
    const doc = createDoc(TitleDoc)
    const textarea = document.createElement("textarea")
    const load = deferred()

    const detach = attachWhenLoaded(textarea, doc.title, load.promise)
    detach()
    expect(textarea.readOnly).toBe(false)

    load.resolve()
    await load.promise
    batch(doc, d => d.title.insert(0, "after"))
    expect(textarea.value).toBe("")
  })

  it("keeps an element the application made read-only", async () => {
    const doc = createDoc(TitleDoc)
    const textarea = document.createElement("textarea")
    textarea.readOnly = true
    const load = deferred()

    attachWhenLoaded(textarea, doc.title, load.promise)
    load.resolve()
    await load.promise
    expect(textarea.readOnly).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// attach with a refusal
// ---------------------------------------------------------------------------

/** A refusal whose value the test sets. */
function refusalSource(initial: unknown = undefined): {
  feed: HasChangefeed<unknown>
  set: (value: unknown) => void
} {
  let value = initial
  const listeners = new Set<() => void>()
  const feed: HasChangefeed<unknown> = {
    [CHANGEFEED]: {
      get current() {
        return value
      },
      subscribe(callback) {
        const listener = () => callback({ changes: [] })
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
  return {
    feed,
    set: next => {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe("attach with a refusal", () => {
  const TitleDoc = Schema.struct({ title: Schema.text() })

  it("is read-only while refused, and still shows remote edits", () => {
    const doc = createDoc(TitleDoc)
    batch(doc, d => d.title.insert(0, "shared"))
    const textarea = document.createElement("textarea")
    const refusal = refusalSource("another seat writes it")

    const detach = attach(textarea, doc.title, { refusal: refusal.feed })
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe("shared")

    batch(doc, d => d.title.insert(6, "!"))
    expect(textarea.value).toBe("shared!")
    detach()
  })

  it("becomes read-only when a refusal arrives, and editable when it lifts", () => {
    const doc = createDoc(TitleDoc)
    const textarea = document.createElement("textarea")
    const refusal = refusalSource()

    const detach = attach(textarea, doc.title, { refusal: refusal.feed })
    expect(textarea.readOnly).toBe(false)
    refusal.set("another seat writes it")
    expect(textarea.readOnly).toBe(true)
    refusal.set(undefined)
    expect(textarea.readOnly).toBe(false)
    detach()
  })

  it("puts the model's text back on an edit that reaches a refused element", () => {
    const doc = createDoc(TitleDoc)
    batch(doc, d => d.title.insert(0, "model"))
    const textarea = document.createElement("textarea")
    const refusal = refusalSource("another seat writes it")
    attach(textarea, doc.title, { refusal: refusal.feed })

    textarea.value = "typed"
    textarea.dispatchEvent(new Event("input"))
    expect(textarea.value).toBe("model")
    expect(doc.title()).toBe("model")
  })

  it("keeps an element the application made read-only, and restores it on detach", () => {
    const doc = createDoc(TitleDoc)
    const textarea = document.createElement("textarea")
    textarea.readOnly = true
    const refusal = refusalSource()

    const detach = attach(textarea, doc.title, { refusal: refusal.feed })
    expect(textarea.readOnly).toBe(true)
    refusal.set("refused")
    detach()
    expect(textarea.readOnly).toBe(true)

    const other = document.createElement("textarea")
    const again = attach(other, doc.title, { refusal: refusal.feed })
    expect(other.readOnly).toBe(true)
    again()
    expect(other.readOnly).toBe(false)
    refusal.set(undefined)
    expect(other.readOnly).toBe(false)
  })
})
