/**
 * Unit tests for editText — operation-aware write direction.
 *
 * These tests verify that editText() returns a beforeinput handler that
 * correctly translates DOM editing operations into TextRef CRDT operations.
 *
 * Uses the same JSDOM + Loro test setup pattern as binding.test.ts.
 */

import { createTypedDoc, loro, Shape } from "@loro-extended/change"
import { JSDOM } from "jsdom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  activeSubscriptions,
  resetSubscriptionIdCounter,
} from "../runtime/subscribe.js"
import { resetScopeIdCounter, Scope } from "../runtime/scope.js"
import { inputTextRegion } from "../runtime/text-patch.js"
import { editText } from "./edit-text.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLInputElement = dom.window.HTMLInputElement
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
global.Event = dom.window.Event

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Create a mock InputEvent with the given properties.
 * JSDOM doesn't fully support InputEvent, so we construct a minimal mock.
 */
function createInputEvent(opts: {
  inputType: string
  data?: string | null
  isComposing?: boolean
  target?: HTMLInputElement | HTMLTextAreaElement
  targetRanges?: StaticRange[]
}): InputEvent {
  const event = new Event("beforeinput", {
    cancelable: true,
  }) as unknown as InputEvent

  Object.defineProperty(event, "inputType", { value: opts.inputType })
  Object.defineProperty(event, "data", { value: opts.data ?? null })
  Object.defineProperty(event, "isComposing", {
    value: opts.isComposing ?? false,
  })
  Object.defineProperty(event, "target", {
    value: opts.target,
    writable: false,
  })
  Object.defineProperty(event, "getTargetRanges", {
    value: () => opts.targetRanges ?? [],
  })

  // Make preventDefault trackable
  const preventDefaultSpy = vi.fn()
  Object.defineProperty(event, "preventDefault", { value: preventDefaultSpy })
  ;(event as any).__preventDefaultSpy = preventDefaultSpy

  return event
}

/**
 * Create an input element with value and selection set.
 */
function createInput(
  value: string,
  selectionStart: number,
  selectionEnd?: number,
): HTMLInputElement {
  const input = document.createElement("input") as HTMLInputElement
  input.value = value
  input.selectionStart = selectionStart
  input.selectionEnd = selectionEnd ?? selectionStart
  return input
}

/**
 * Create a typed doc with a single text field, pre-populated and committed.
 */
function createDoc(initialText: string) {
  const schema = Shape.doc({ text: Shape.text() })
  const doc = createTypedDoc(schema)
  if (initialText.length > 0) {
    doc.text.insert(0, initialText)
  }
  loro(doc).commit()
  return doc
}

// =============================================================================
// editText Tests
// =============================================================================

describe("editText", () => {
  describe("insertText (typing)", () => {
    it("should insert text at cursor position", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5) // cursor at end

      const event = createInputEvent({
        inputType: "insertText",
        data: " World",
        target: input,
      })

      handler(event)

      expect(doc.text.toString()).toBe("Hello World")
      expect((event as any).__preventDefaultSpy).toHaveBeenCalled()
    })

    it("should insert text at beginning", () => {
      const doc = createDoc("World")
      const handler = editText(doc.text)
      const input = createInput("World", 0)

      handler(
        createInputEvent({
          inputType: "insertText",
          data: "Hello ",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello World")
    })

    it("should insert text in the middle", () => {
      const doc = createDoc("Helo")
      const handler = editText(doc.text)
      const input = createInput("Helo", 3) // cursor after "Hel"

      handler(
        createInputEvent({
          inputType: "insertText",
          data: "l",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })

    it("should replace selected text with insertion", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 6, 11) // "World" selected

      handler(
        createInputEvent({
          inputType: "insertText",
          data: "Earth",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello Earth")
    })

    it("should handle null data gracefully (delete selection only)", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 5, 11) // " World" selected

      handler(
        createInputEvent({
          inputType: "insertText",
          data: null,
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })
  })

  describe("insertFromPaste", () => {
    it("should insert pasted text at cursor", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "insertFromPaste",
          data: " World",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello World")
    })

    it("should replace selection with pasted text", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 0, 11) // all selected

      handler(
        createInputEvent({
          inputType: "insertFromPaste",
          data: "Goodbye",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Goodbye")
    })
  })

  describe("insertFromDrop", () => {
    it("should insert dropped text at cursor", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "insertFromDrop",
          data: " there",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello there")
    })
  })

  describe("insertFromComposition (IME)", () => {
    it("should insert composed text when composition ends", () => {
      const doc = createDoc("")
      const handler = editText(doc.text)
      const input = createInput("", 0)

      handler(
        createInputEvent({
          inputType: "insertFromComposition",
          data: "你好",
          isComposing: false, // composition has ended
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("你好")
    })
  })

  describe("insertLineBreak / insertParagraph", () => {
    it("should insert newline for insertLineBreak", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "insertLineBreak",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello\n")
    })

    it("should insert newline for insertParagraph", () => {
      const doc = createDoc("Line 1")
      const handler = editText(doc.text)
      const input = createInput("Line 1", 6)

      handler(
        createInputEvent({
          inputType: "insertParagraph",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Line 1\n")
    })

    it("should delete selection before inserting newline", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 5, 11) // " World" selected

      handler(
        createInputEvent({
          inputType: "insertLineBreak",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello\n")
    })
  })

  describe("deleteContentBackward (Backspace)", () => {
    it("should delete one character before cursor", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "deleteContentBackward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hell")
    })

    it("should delete selected text", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 0, 6) // "Hello " selected

      handler(
        createInputEvent({
          inputType: "deleteContentBackward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("World")
    })

    it("should do nothing at position 0 with no selection", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 0)

      handler(
        createInputEvent({
          inputType: "deleteContentBackward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })

    it("should delete character in the middle", () => {
      const doc = createDoc("Helllo")
      const handler = editText(doc.text)
      const input = createInput("Helllo", 4) // cursor after second 'l'

      handler(
        createInputEvent({
          inputType: "deleteContentBackward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })
  })

  describe("deleteContentForward (Delete key)", () => {
    it("should delete one character after cursor", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 0)

      handler(
        createInputEvent({
          inputType: "deleteContentForward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("ello")
    })

    it("should delete selected text", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 5, 11)

      handler(
        createInputEvent({
          inputType: "deleteContentForward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })

    it("should do nothing at end of text with no selection", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "deleteContentForward",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })

    it("should use ref.length for bounds check (not input.value.length)", () => {
      // Scenario: ref has "ABC" but input might show stale value
      const doc = createDoc("ABC")
      const handler = editText(doc.text)
      // Input shows the correct value, cursor at position 2
      const input = createInput("ABC", 2)

      handler(
        createInputEvent({
          inputType: "deleteContentForward",
          target: input,
        }),
      )

      // Should delete the 'C'
      expect(doc.text.toString()).toBe("AB")
    })
  })

  describe("deleteByCut", () => {
    it("should delete selected text on cut", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 0, 5) // "Hello" selected

      handler(
        createInputEvent({
          inputType: "deleteByCut",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe(" World")
    })

    it("should do nothing when no selection", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 3)

      handler(
        createInputEvent({
          inputType: "deleteByCut",
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello")
    })
  })

  describe("word/line deletions (getTargetRanges)", () => {
    it("should use getTargetRanges for deleteWordBackward", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 11) // cursor at end

      // Mock StaticRange for word "World" (positions 6-11)
      const mockRange = { startOffset: 6, endOffset: 11 } as StaticRange

      handler(
        createInputEvent({
          inputType: "deleteWordBackward",
          target: input,
          targetRanges: [mockRange],
        }),
      )

      expect(doc.text.toString()).toBe("Hello ")
    })

    it("should use getTargetRanges for deleteWordForward", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 0)

      const mockRange = { startOffset: 0, endOffset: 5 } as StaticRange

      handler(
        createInputEvent({
          inputType: "deleteWordForward",
          target: input,
          targetRanges: [mockRange],
        }),
      )

      expect(doc.text.toString()).toBe(" World")
    })

    it("should fall back to selection when getTargetRanges returns empty", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 6, 11) // "World" selected

      handler(
        createInputEvent({
          inputType: "deleteWordBackward",
          target: input,
          targetRanges: [], // empty — some browsers do this for <input>
        }),
      )

      expect(doc.text.toString()).toBe("Hello ")
    })

    it("should handle deleteSoftLineBackward", () => {
      const doc = createDoc("Hello World")
      const handler = editText(doc.text)
      const input = createInput("Hello World", 11)

      const mockRange = { startOffset: 0, endOffset: 11 } as StaticRange

      handler(
        createInputEvent({
          inputType: "deleteSoftLineBackward",
          target: input,
          targetRanges: [mockRange],
        }),
      )

      expect(doc.text.toString()).toBe("")
    })
  })

  describe("IME composition handling", () => {
    it("should skip events with isComposing === true", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      const event = createInputEvent({
        inputType: "insertText",
        data: "中",
        isComposing: true,
        target: input,
      })

      handler(event)

      // Should NOT modify the ref
      expect(doc.text.toString()).toBe("Hello")
      // Should NOT call preventDefault
      expect((event as any).__preventDefaultSpy).not.toHaveBeenCalled()
    })

    it("should process insertFromComposition with isComposing === false", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "insertFromComposition",
          data: "世界",
          isComposing: false,
          target: input,
        }),
      )

      expect(doc.text.toString()).toBe("Hello世界")
    })
  })

  describe("historyUndo / historyRedo passthrough", () => {
    it("should not preventDefault for historyUndo", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      const event = createInputEvent({
        inputType: "historyUndo",
        target: input,
      })

      handler(event)

      expect(doc.text.toString()).toBe("Hello")
      expect((event as any).__preventDefaultSpy).not.toHaveBeenCalled()
    })

    it("should not preventDefault for historyRedo", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      const event = createInputEvent({
        inputType: "historyRedo",
        target: input,
      })

      handler(event)

      expect(doc.text.toString()).toBe("Hello")
      expect((event as any).__preventDefaultSpy).not.toHaveBeenCalled()
    })
  })

  describe("unknown input types", () => {
    it("should not preventDefault for unknown input types", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      const event = createInputEvent({
        inputType: "formatBold",
        target: input,
      })

      handler(event)

      expect(doc.text.toString()).toBe("Hello")
      expect((event as any).__preventDefaultSpy).not.toHaveBeenCalled()
    })
  })

  describe("auto-commit verification", () => {
    it("should auto-commit so changes are visible immediately", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      handler(
        createInputEvent({
          inputType: "insertText",
          data: "!",
          target: input,
        }),
      )

      // The TextRef uses commitIfAuto internally, so toString()
      // should reflect the change immediately
      expect(doc.text.toString()).toBe("Hello!")
    })

    it("should reflect multiple sequential operations", () => {
      const doc = createDoc("")
      const handler = editText(doc.text)

      // Type "abc" one character at a time
      let input = createInput("", 0)
      handler(
        createInputEvent({
          inputType: "insertText",
          data: "a",
          target: input,
        }),
      )
      expect(doc.text.toString()).toBe("a")

      input = createInput("a", 1)
      handler(
        createInputEvent({
          inputType: "insertText",
          data: "b",
          target: input,
        }),
      )
      expect(doc.text.toString()).toBe("ab")

      input = createInput("ab", 2)
      handler(
        createInputEvent({
          inputType: "insertText",
          data: "c",
          target: input,
        }),
      )
      expect(doc.text.toString()).toBe("abc")
    })
  })

  describe("selection clamping", () => {
    it("should clamp selectionStart to ref.length", () => {
      const doc = createDoc("Hi")
      const handler = editText(doc.text)
      // Simulate stale input that thinks the value is longer
      const input = createInput("Hi there", 8) // selection beyond ref.length

      handler(
        createInputEvent({
          inputType: "insertText",
          data: "!",
          target: input,
        }),
      )

      // Should clamp to ref.length (2) and insert there
      expect(doc.text.toString()).toBe("Hi!")
    })

    it("should clamp selectionEnd to ref.length", () => {
      const doc = createDoc("Hi")
      const handler = editText(doc.text)
      const input = createInput("Hi there", 0, 8) // selection end beyond ref.length

      handler(
        createInputEvent({
          inputType: "deleteContentBackward",
          target: input,
        }),
      )

      // Should clamp end to ref.length (2) and delete [0, 2)
      expect(doc.text.toString()).toBe("")
    })
  })

  describe("textarea support", () => {
    it("should work with textarea elements", () => {
      const doc = createDoc("Line 1")
      const handler = editText(doc.text)

      const textarea = document.createElement(
        "textarea",
      ) as HTMLTextAreaElement
      textarea.value = "Line 1"
      textarea.selectionStart = 6
      textarea.selectionEnd = 6

      handler(
        createInputEvent({
          inputType: "insertLineBreak",
          target: textarea,
        }),
      )

      expect(doc.text.toString()).toBe("Line 1\n")
    })
  })

  describe("preventDefault behavior", () => {
    it("should call preventDefault for insertText", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      const event = createInputEvent({
        inputType: "insertText",
        data: "!",
        target: input,
      })

      handler(event)

      expect((event as any).__preventDefaultSpy).toHaveBeenCalledOnce()
    })

    it("should call preventDefault for deleteContentBackward", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 5)

      const event = createInputEvent({
        inputType: "deleteContentBackward",
        target: input,
      })

      handler(event)

      expect((event as any).__preventDefaultSpy).toHaveBeenCalledOnce()
    })

    it("should call preventDefault for deleteContentForward", () => {
      const doc = createDoc("Hello")
      const handler = editText(doc.text)
      const input = createInput("Hello", 0)

      const event = createInputEvent({
        inputType: "deleteContentForward",
        target: input,
      })

      handler(event)

      expect((event as any).__preventDefaultSpy).toHaveBeenCalledOnce()
    })

    // ===========================================================================
    // Round-Trip Tests: editText → CRDT → subscription → DOM → cursor
    // ===========================================================================

    describe("editText + inputTextRegion round-trip", () => {
      beforeEach(() => {
        resetScopeIdCounter()
        resetSubscriptionIdCounter()
        activeSubscriptions.clear()
      })

      afterEach(() => {
        activeSubscriptions.clear()
      })

      /**
       * Simulate a keystroke through the full round-trip:
       * 1. Create InputEvent with the given properties
       * 2. Call the editText handler (which calls preventDefault, mutates the CRDT,
       *    and commitIfAuto fires the subscription synchronously)
       * 3. The inputTextRegion subscription applies the delta via setRangeText
       * 4. After the handler returns, input.value and input.selectionStart
       *    reflect the final DOM state
       */
      function simulateKeystroke(
        handler: (e: InputEvent) => void,
        input: HTMLInputElement,
        opts: {
          inputType: string
          data?: string | null
          targetRanges?: Array<{ startOffset: number; endOffset: number }>
        },
      ): void {
        const event = createInputEvent({
          inputType: opts.inputType,
          data: opts.data ?? null,
          target: input,
          targetRanges: opts.targetRanges as unknown as StaticRange[],
        })
        handler(event)
      }

      it("typing 'Hello' produces 'Hello' with cursor at position 5", () => {
        const doc = createDoc("")
        const handler = editText(doc.text)
        const scope = new Scope()
        const input = document.createElement("input") as HTMLInputElement
        input.value = ""
        input.selectionStart = 0
        input.selectionEnd = 0

        // Wire inputTextRegion — this subscribes to the TextRef
        inputTextRegion(input, doc.text, scope)

        // Type "H"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "H",
        })
        expect(doc.text.toString()).toBe("H")
        expect(input.value).toBe("H")
        expect(input.selectionStart).toBe(1)

        // Type "e"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "e",
        })
        expect(doc.text.toString()).toBe("He")
        expect(input.value).toBe("He")
        expect(input.selectionStart).toBe(2)

        // Type "l"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "l",
        })
        expect(doc.text.toString()).toBe("Hel")
        expect(input.value).toBe("Hel")
        expect(input.selectionStart).toBe(3)

        // Type "l"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "l",
        })
        expect(doc.text.toString()).toBe("Hell")
        expect(input.value).toBe("Hell")
        expect(input.selectionStart).toBe(4)

        // Type "o"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "o",
        })
        expect(doc.text.toString()).toBe("Hello")
        expect(input.value).toBe("Hello")
        expect(input.selectionStart).toBe(5)

        scope.dispose()
      })

      it("backspace at position 3 in 'Hello' produces 'Helo' with cursor at 2", () => {
        const doc = createDoc("Hello")
        const handler = editText(doc.text)
        const scope = new Scope()
        const input = document.createElement("input") as HTMLInputElement

        // Wire inputTextRegion — sets initial value
        inputTextRegion(input, doc.text, scope)
        expect(input.value).toBe("Hello")

        // Place cursor at position 3
        input.selectionStart = 3
        input.selectionEnd = 3

        // Backspace
        simulateKeystroke(handler, input, {
          inputType: "deleteContentBackward",
        })

        expect(doc.text.toString()).toBe("Helo")
        expect(input.value).toBe("Helo")
        expect(input.selectionStart).toBe(2)

        scope.dispose()
      })

      it("pasting 'World' at position 5 in 'Hello' produces 'HelloWorld' with cursor at 10", () => {
        const doc = createDoc("Hello")
        const handler = editText(doc.text)
        const scope = new Scope()
        const input = document.createElement("input") as HTMLInputElement

        inputTextRegion(input, doc.text, scope)
        expect(input.value).toBe("Hello")

        // Place cursor at end
        input.selectionStart = 5
        input.selectionEnd = 5

        // Paste "World"
        simulateKeystroke(handler, input, {
          inputType: "insertFromPaste",
          data: "World",
        })

        expect(doc.text.toString()).toBe("HelloWorld")
        expect(input.value).toBe("HelloWorld")
        expect(input.selectionStart).toBe(10)

        scope.dispose()
      })

      it("delete forward at position 2 in 'Hello' produces 'Helo' with cursor at 2", () => {
        const doc = createDoc("Hello")
        const handler = editText(doc.text)
        const scope = new Scope()
        const input = document.createElement("input") as HTMLInputElement

        inputTextRegion(input, doc.text, scope)

        input.selectionStart = 2
        input.selectionEnd = 2

        simulateKeystroke(handler, input, {
          inputType: "deleteContentForward",
        })

        expect(doc.text.toString()).toBe("Helo")
        expect(input.value).toBe("Helo")
        expect(input.selectionStart).toBe(2)

        scope.dispose()
      })

      it("replacing selection 'ell' with 'a' in 'Hello' produces 'Hao' with cursor at 2", () => {
        const doc = createDoc("Hello")
        const handler = editText(doc.text)
        const scope = new Scope()
        const input = document.createElement("input") as HTMLInputElement

        inputTextRegion(input, doc.text, scope)

        // Select "ell" (positions 1-4)
        input.selectionStart = 1
        input.selectionEnd = 4

        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "a",
        })

        expect(doc.text.toString()).toBe("Hao")
        expect(input.value).toBe("Hao")
        expect(input.selectionStart).toBe(2)

        scope.dispose()
      })

      it("multiple sequential keystrokes maintain correct cursor throughout", () => {
        const doc = createDoc("")
        const handler = editText(doc.text)
        const scope = new Scope()
        const input = document.createElement("input") as HTMLInputElement
        input.value = ""
        input.selectionStart = 0
        input.selectionEnd = 0

        inputTextRegion(input, doc.text, scope)

        // Type "abc"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "a",
        })
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "b",
        })
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "c",
        })
        expect(input.value).toBe("abc")
        expect(input.selectionStart).toBe(3)

        // Backspace to remove "c"
        simulateKeystroke(handler, input, {
          inputType: "deleteContentBackward",
        })
        expect(input.value).toBe("ab")
        expect(input.selectionStart).toBe(2)

        // Type "xyz"
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "x",
        })
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "y",
        })
        simulateKeystroke(handler, input, {
          inputType: "insertText",
          data: "z",
        })
        expect(input.value).toBe("abxyz")
        expect(input.selectionStart).toBe(5)

        scope.dispose()
      })
    })
  })
})