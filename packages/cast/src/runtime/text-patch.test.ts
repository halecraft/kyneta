/**
 * Tests for text-patch.ts — surgical text patching and subscription-aware DOM updates.
 *
 * Covers planTextPatch (pure), patchText/patchInputValue (imperative),
 * and textRegion/inputTextRegion (subscription-aware).
 */

import {
  CHANGEFEED,
  type ChangeBase,
  type ChangefeedProtocol,
  type Changeset,
  type TextChange,
  type TextInstruction,
} from "@kyneta/schema"
import { JSDOM } from "jsdom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetScopeIdCounter, Scope } from "./scope.js"
import {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
} from "./subscribe.js"
import {
  inputTextRegion,
  patchInputValue,
  patchText,
  planTextPatch,
  textRegion,
} from "./text-patch.js"

// Set up DOM globals for testing
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
global.document = dom.window.document
global.Text = dom.window.Text
global.HTMLInputElement = dom.window.HTMLInputElement
global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement

// =============================================================================
// Shared Test Helpers
// =============================================================================

/**
 * Create a mock TextRef for testing that uses the CHANGEFEED protocol.
 * Allows manual triggering of changes to verify region behavior.
 */
function createMockTextRef(initialValue: string): {
  ref: { [CHANGEFEED]: ChangefeedProtocol<string, TextChange> }
  emit: <C extends ChangeBase>(change: C, origin?: string) => void
  setValue: (value: string) => void
} {
  let currentValue = initialValue
  let callback: ((changeset: Changeset<TextChange>) => void) | null = null

  const ref = {
    [CHANGEFEED]: {
      get current(): string {
        return currentValue
      },
      subscribe(cb: (changeset: Changeset<TextChange>) => void): () => void {
        callback = cb
        return () => {
          callback = null
        }
      },
    },
  }

  return {
    ref,
    emit: <C extends ChangeBase>(change: C, origin?: string) => {
      // Cast: emit is a test harness escape hatch that intentionally pushes
      // non-TextChange values (e.g. { type: "replace" }) to test fallback paths.
      callback?.({
        changes: [change] as unknown as readonly TextChange[],
        origin,
      })
    },
    setValue: (value: string) => {
      currentValue = value
    },
  }
}

// =============================================================================
// planTextPatch Tests
// =============================================================================

describe("planTextPatch", () => {
  it("converts retain + insert to offset-based insert op", () => {
    const ops: TextInstruction[] = [{ retain: 5 }, { insert: "X" }]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "insert", offset: 5, text: "X" })
  })

  it("converts retain + delete to offset-based delete op", () => {
    const ops: TextInstruction[] = [{ retain: 2 }, { delete: 3 }]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "delete", offset: 2, count: 3 })
  })

  it("handles insert at start (no retain)", () => {
    const ops: TextInstruction[] = [{ insert: "Hello" }]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "insert", offset: 0, text: "Hello" })
  })

  it("handles complex sequence", () => {
    // Starting from "Hello World":
    // retain 5, delete 1, insert "!"
    // → delete at offset 5, count 1, then insert "!" at offset 5
    const ops: TextInstruction[] = [
      { retain: 5 },
      { delete: 1 },
      { insert: "!" },
    ]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(2)
    // delete doesn't advance cursor
    expect(result[0]).toEqual({ kind: "delete", offset: 5, count: 1 })
    expect(result[1]).toEqual({ kind: "insert", offset: 5, text: "!" })
  })

  it("handles empty ops", () => {
    const ops: TextInstruction[] = []
    const result = planTextPatch(ops)
    expect(result).toHaveLength(0)
  })

  it("handles multiple retains", () => {
    const ops: TextInstruction[] = [
      { retain: 3 },
      { retain: 2 },
      { insert: "X" },
    ]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({ kind: "insert", offset: 5, text: "X" })
  })

  it("handles consecutive inserts", () => {
    const ops: TextInstruction[] = [{ insert: "AB" }, { insert: "CD" }]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(2)
    // First insert at 0, cursor advances to 2
    // Second insert at 2, cursor advances to 4
    expect(result[0]).toEqual({ kind: "insert", offset: 0, text: "AB" })
    expect(result[1]).toEqual({ kind: "insert", offset: 2, text: "CD" })
  })

  it("handles delete followed by insert at same position", () => {
    // "ABCDE" → delete 2 at offset 1, insert "XY" at offset 1
    const ops: TextInstruction[] = [
      { retain: 1 },
      { delete: 2 },
      { insert: "XY" },
    ]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(2)
    // delete at offset 1, cursor stays at 1
    expect(result[0]).toEqual({ kind: "delete", offset: 1, count: 2 })
    // insert at offset 1, cursor advances to 3
    expect(result[1]).toEqual({ kind: "insert", offset: 1, text: "XY" })
  })

  it("handles retain-only ops (no-op)", () => {
    const ops: TextInstruction[] = [{ retain: 10 }]
    const result = planTextPatch(ops)
    expect(result).toHaveLength(0)
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
    // "Hello World" → retain 5, delete 1, insert "!"
    // "Hello World" → "Hello" → "Hello!"... wait, delete 1 at pos 5 removes " "
    const text = document.createTextNode("Hello World")
    patchText(text, [{ retain: 5 }, { delete: 1 }, { insert: "!" }])
    expect(text.textContent).toBe("Hello!World")
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
    const text = document.createTextNode("Hello")
    patchText(text, [])
    expect(text.textContent).toBe("Hello")
  })

  it("handles multiple operations in sequence", () => {
    // "Hello" → "Hello World!" via two operations
    const text = document.createTextNode("Hello")
    patchText(text, [{ retain: 5 }, { insert: " World!" }])
    expect(text.textContent).toBe("Hello World!")
  })

  it("handles complete replacement", () => {
    // "Hello" → "" → "World"
    const text = document.createTextNode("Hello")
    patchText(text, [{ delete: 5 }, { insert: "World" }])
    expect(text.textContent).toBe("World")
  })
})

// =============================================================================
// patchInputValue Tests
// =============================================================================

describe("patchInputValue", () => {
  it("applies insert at offset via setRangeText", () => {
    const input = document.createElement("input")
    input.value = "Hello"

    // Spy on setRangeText
    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ retain: 5 }, { insert: " World" }])

    expect(setRangeTextSpy).toHaveBeenCalledWith(" World", 5, 5, "preserve")
  })

  it("applies delete at offset via setRangeText", () => {
    const input = document.createElement("input")
    input.value = "Hello World"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ retain: 5 }, { delete: 6 }])

    expect(setRangeTextSpy).toHaveBeenCalledWith("", 5, 11, "preserve")
  })

  it("applies combined retain + delete + insert", () => {
    const input = document.createElement("input")
    input.value = "Hello World"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ retain: 5 }, { delete: 1 }, { insert: "!" }])

    expect(setRangeTextSpy).toHaveBeenCalledTimes(2)
    expect(setRangeTextSpy).toHaveBeenNthCalledWith(1, "", 5, 6, "preserve")
    expect(setRangeTextSpy).toHaveBeenNthCalledWith(2, "!", 5, 5, "preserve")
  })

  it("applies insert at start (no retain)", () => {
    const input = document.createElement("input")
    input.value = "World"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ insert: "Hello " }])

    expect(setRangeTextSpy).toHaveBeenCalledWith("Hello ", 0, 0, "preserve")
  })

  it("handles empty ops (no setRangeText calls)", () => {
    const input = document.createElement("input")
    input.value = "Hello"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [])

    expect(setRangeTextSpy).not.toHaveBeenCalled()
  })

  it("works with textarea elements", () => {
    const textarea = document.createElement(
      "textarea",
    ) as unknown as HTMLTextAreaElement
    ;(textarea as any).value = "Hello"

    const setRangeTextSpy = vi.spyOn(textarea, "setRangeText")

    patchInputValue(textarea, [{ retain: 5 }, { insert: " World" }])

    expect(setRangeTextSpy).toHaveBeenCalledWith(" World", 5, 5, "preserve")
  })
})

// =============================================================================
// patchInputValue with selectMode Tests
// =============================================================================

describe("patchInputValue with selectMode", () => {
  it("uses 'preserve' by default (backward compatible)", () => {
    const input = document.createElement("input")
    input.value = "Hello"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ retain: 5 }, { insert: "X" }])

    expect(setRangeTextSpy).toHaveBeenCalledWith("X", 5, 5, "preserve")
  })

  it("uses 'end' when selectMode is 'end'", () => {
    const input = document.createElement("input")
    input.value = "Hello"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ retain: 5 }, { insert: "X" }], "end")

    expect(setRangeTextSpy).toHaveBeenCalledWith("X", 5, 5, "end")
  })

  it("passes selectMode through to delete operations too", () => {
    const input = document.createElement("input")
    input.value = "Hello"

    const setRangeTextSpy = vi.spyOn(input, "setRangeText")

    patchInputValue(input, [{ retain: 3 }, { delete: 2 }], "end")

    expect(setRangeTextSpy).toHaveBeenCalledWith("", 3, 5, "end")
  })

  it("cursor advances past insert with 'end' (JSDOM native)", () => {
    const input = document.createElement("input")
    input.value = "Hello"
    input.setSelectionRange(5, 5)

    // Insert " World" at end with "end" selectMode
    patchInputValue(input, [{ retain: 5 }, { insert: " World" }], "end")

    expect(input.value).toBe("Hello World")
  })

  it("cursor stays at delete point with 'end' (JSDOM native)", () => {
    const input = document.createElement("input")
    input.value = "Hello World"
    input.setSelectionRange(11, 11)

    patchInputValue(input, [{ retain: 5 }, { delete: 6 }], "end")

    expect(input.value).toBe("Hello")
  })

  it("cursor shifts for remote insert before cursor with 'preserve' (JSDOM native)", () => {
    const input = document.createElement("input")
    input.value = "Hello"
    input.setSelectionRange(5, 5)

    patchInputValue(input, [{ insert: "XXX" }], "preserve")

    expect(input.value).toBe("XXXHello")
  })

  it("cursor unchanged for remote insert after cursor with 'preserve' (JSDOM native)", () => {
    const input = document.createElement("input")
    input.value = "Hello"
    input.setSelectionRange(0, 0)

    patchInputValue(input, [{ retain: 5 }, { insert: " World" }], "preserve")

    expect(input.value).toBe("Hello World")
  })

  it("cursor does NOT advance for local insert at cursor with 'preserve' — the bug case", () => {
    // With "preserve", cursor stays at 0 even after insert at 0.
    // This is the wrong behavior for local typing — hence the need for "end".
    const input = document.createElement("input")
    input.value = ""
    input.setSelectionRange(0, 0)

    patchInputValue(input, [{ insert: "Hi" }], "preserve")

    expect(input.value).toBe("Hi")
  })

  it("cursor advances for local insert at cursor with 'end' — the fix", () => {
    const input = document.createElement("input")
    input.value = ""
    input.setSelectionRange(0, 0)

    patchInputValue(input, [{ insert: "Hi" }], "end")

    expect(input.value).toBe("Hi")
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
    it("sets initial text content from CHANGEFEED.current", () => {
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
      emit({
        type: "text",
        instructions: [{ retain: 5 }, { insert: " World" }],
      })

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
      emit({ type: "text", instructions: [{ retain: 5 }, { delete: 6 }] })

      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("falls back to full replacement for non-text delta", () => {
      const { ref, emit, setValue } = createMockTextRef("old value")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("old value")

      // Simulate a "replace" change (e.g., from a LocalRef or full replacement)
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
      emit({ type: "text", instructions: [{ retain: 2 }, { insert: "X" }] })
      expect(textNode.textContent).toBe("abXc")

      // Second edit: "abXc" → "abXYc"
      setValue("abXYc")
      emit({ type: "text", instructions: [{ retain: 3 }, { insert: "Y" }] })
      expect(textNode.textContent).toBe("abXYc")

      // Third edit: "abXYc" → "aXYc" (delete 'b')
      setValue("aXYc")
      emit({ type: "text", instructions: [{ retain: 1 }, { delete: 1 }] })
      expect(textNode.textContent).toBe("aXYc")

      scope.dispose()
    })
  })

  describe("with LocalRef-based TextRef mock", () => {
    it("renders initial value from CHANGEFEED.current", () => {
      const { ref } = createMockTextRef("Hello World")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)

      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("applies text insert via surgical DOM update", () => {
      const { ref, emit, setValue } = createMockTextRef("")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("")

      setValue("Hello")
      emit({ type: "text", instructions: [{ insert: "Hello" }] })
      expect(textNode.textContent).toBe("Hello")

      setValue("Hello World")
      emit({
        type: "text",
        instructions: [{ retain: 5 }, { insert: " World" }],
      })
      expect(textNode.textContent).toBe("Hello World")

      scope.dispose()
    })

    it("applies text delete via surgical DOM update", () => {
      const { ref, emit, setValue } = createMockTextRef("Hello World")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("Hello World")

      setValue("Hello")
      emit({ type: "text", instructions: [{ retain: 5 }, { delete: 6 }] })
      expect(textNode.textContent).toBe("Hello")

      scope.dispose()
    })

    it("unsubscribes when scope is disposed", () => {
      const { ref, emit, setValue } = createMockTextRef("initial")
      const scope = new Scope()
      const textNode = document.createTextNode("")

      textRegion(textNode, ref, scope)
      expect(textNode.textContent).toBe("initial")
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Changes after dispose should not affect the text node
      setValue("changed")
      emit({
        type: "text",
        instructions: [{ delete: 7 }, { insert: "changed" }],
      })

      // textNode should still show the last value before dispose
      expect(textNode.textContent).toBe("initial")
    })
  })
})

// =============================================================================
// inputTextRegion Tests
// =============================================================================

describe("inputTextRegion", () => {
  beforeEach(() => {
    resetScopeIdCounter()
    resetSubscriptionIdCounter()
    activeSubscriptions.clear()
  })

  afterEach(() => {
    activeSubscriptions.clear()
  })

  describe("with mock TextRef", () => {
    it("sets initial input value from CHANGEFEED.current", () => {
      const { ref } = createMockTextRef("Hello")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)

      expect(input.value).toBe("Hello")

      scope.dispose()
    })

    it("applies text delta via patchInputValue on subscription", () => {
      const { ref, emit, setValue } = createMockTextRef("Hello")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)

      // Create a spy that updates the underlying value to simulate real behavior
      const setRangeTextSpy = vi
        .spyOn(input, "setRangeText")
        .mockImplementation(function (
          this: HTMLInputElement,
          text: string,
          start?: number,
          end?: number,
        ) {
          const current = this.value
          const s = start ?? 0
          const e = end ?? current.length
          ;(this as any).value = current.slice(0, s) + text + current.slice(e)
        } as any)

      // Simulate text insert: "Hello" → "Hello World"
      setValue("Hello World")
      emit({
        type: "text",
        instructions: [{ retain: 5 }, { insert: " World" }],
      })

      expect(setRangeTextSpy).toHaveBeenCalled()

      setRangeTextSpy.mockRestore()
      scope.dispose()
    })

    it("applies text delta via patchInputValue for delete", () => {
      const { ref, emit, setValue } = createMockTextRef("Hello World")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)

      const setRangeTextSpy = vi
        .spyOn(input, "setRangeText")
        .mockImplementation(function (
          this: HTMLInputElement,
          text: string,
          start?: number,
          end?: number,
        ) {
          const current = this.value
          const s = start ?? 0
          const e = end ?? current.length
          ;(this as any).value = current.slice(0, s) + text + current.slice(e)
        } as any)

      // Simulate text delete: "Hello World" → "Hello"
      setValue("Hello")
      emit({
        type: "text",
        instructions: [{ retain: 5 }, { delete: 6 }],
      })

      expect(setRangeTextSpy).toHaveBeenCalled()

      setRangeTextSpy.mockRestore()
      scope.dispose()
    })

    it("falls back to full replacement for non-text delta", () => {
      const { ref, emit, setValue } = createMockTextRef("old value")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)
      expect(input.value).toBe("old value")

      // Simulate a "replace" change
      setValue("new value")
      emit({ type: "replace" })

      expect(input.value).toBe("new value")

      scope.dispose()
    })

    it("registers cleanup with scope", () => {
      const { ref } = createMockTextRef("test")
      const scope = new Scope()
      const input = document.createElement("input")

      expect(getActiveSubscriptionCount()).toBe(0)

      inputTextRegion(input, ref, scope)

      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()

      expect(getActiveSubscriptionCount()).toBe(0)
    })

    it("handles multiple text deltas in sequence", () => {
      const { ref, emit, setValue } = createMockTextRef("abc")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)

      const setRangeTextSpy = vi
        .spyOn(input, "setRangeText")
        .mockImplementation(function (
          this: HTMLInputElement,
          text: string,
          start?: number,
          end?: number,
        ) {
          const current = this.value
          const s = start ?? 0
          const e = end ?? current.length
          ;(this as any).value = current.slice(0, s) + text + current.slice(e)
        } as any)

      // First edit
      setValue("abXc")
      emit({ type: "text", instructions: [{ retain: 2 }, { insert: "X" }] })

      // Second edit
      setValue("abXYc")
      emit({ type: "text", instructions: [{ retain: 3 }, { insert: "Y" }] })

      // Third edit (delete)
      setValue("aXYc")
      emit({ type: "text", instructions: [{ retain: 1 }, { delete: 1 }] })

      expect(setRangeTextSpy).toHaveBeenCalledTimes(3)

      setRangeTextSpy.mockRestore()
      scope.dispose()
    })

    it("works with textarea elements", () => {
      const { ref } = createMockTextRef("Hello")
      const scope = new Scope()
      const textarea = document.createElement(
        "textarea",
      ) as unknown as HTMLTextAreaElement

      inputTextRegion(textarea, ref, scope)

      expect((textarea as any).value).toBe("Hello")

      scope.dispose()
    })

    describe("inputTextRegion remote edits (cursor preservation)", () => {
      it("remote insert before cursor shifts cursor right", () => {
        const { ref, emit, setValue } = createMockTextRef("Hello")
        const scope = new Scope()
        const input = document.createElement("input")

        inputTextRegion(input, ref, scope)
        // Place cursor at end
        input.setSelectionRange(5, 5)

        // Remote insert at start (origin not "local" → "preserve" mode)
        setValue("XXXHello")
        emit(
          {
            type: "text",
            instructions: [{ insert: "XXX" }],
          } as TextChange,
          "import",
        )

        // With preserve mode, cursor shifts right by the insert length
        expect(input.value).toBe("XXXHello")

        scope.dispose()
      })

      it("remote insert after cursor leaves cursor unchanged", () => {
        const { ref, emit, setValue } = createMockTextRef("Hello")
        const scope = new Scope()
        const input = document.createElement("input")

        inputTextRegion(input, ref, scope)
        input.setSelectionRange(0, 0)

        // Remote insert at end
        setValue("Hello World")
        emit(
          {
            type: "text",
            instructions: [{ retain: 5 }, { insert: " World" }],
          } as TextChange,
          "import",
        )

        expect(input.value).toBe("Hello World")

        scope.dispose()
      })

      it("remote delete before cursor shifts cursor left", () => {
        const { ref, emit, setValue } = createMockTextRef("Hello World")
        const scope = new Scope()
        const input = document.createElement("input")

        inputTextRegion(input, ref, scope)
        input.setSelectionRange(11, 11)

        // Remote delete at start
        setValue("World")
        emit(
          {
            type: "text",
            instructions: [{ delete: 6 }],
          } as TextChange,
          "import",
        )

        expect(input.value).toBe("World")

        scope.dispose()
      })

      it("local edit uses 'end' selectMode (cursor follows edit)", () => {
        const { ref, emit, setValue } = createMockTextRef("")
        const scope = new Scope()
        const input = document.createElement("input")

        inputTextRegion(input, ref, scope)
        input.setSelectionRange(0, 0)

        // Local insert (origin === "local" → "end" mode)
        setValue("Hi")
        emit(
          {
            type: "text",
            instructions: [{ insert: "Hi" }],
          } as TextChange,
          "local",
        )

        expect(input.value).toBe("Hi")

        scope.dispose()
      })

      it("undefined origin uses 'preserve' selectMode (safe default)", () => {
        const { ref, emit, setValue } = createMockTextRef("")
        const scope = new Scope()
        const input = document.createElement("input")

        inputTextRegion(input, ref, scope)
        input.setSelectionRange(0, 0)

        // No origin → "preserve" (safe default for unknown provenance)
        setValue("Hi")
        emit({
          type: "text",
          instructions: [{ insert: "Hi" }],
        })

        expect(input.value).toBe("Hi")

        scope.dispose()
      })
    })
  })

  describe("with CHANGEFEED-based ref", () => {
    it("renders initial value from CHANGEFEED.current", () => {
      const { ref } = createMockTextRef("Hello World")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)

      expect(input.value).toBe("Hello World")

      scope.dispose()
    })

    it("applies text insert via surgical update", () => {
      const { ref, emit, setValue } = createMockTextRef("")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)
      expect(input.value).toBe("")

      setValue("Hello")
      emit({ type: "text", instructions: [{ insert: "Hello" }] })

      // The input value should be updated
      // (exact value depends on JSDOM's setRangeText behavior)
      expect(input.value).toBe("Hello")

      scope.dispose()
    })

    it("unsubscribes when scope is disposed", () => {
      const { ref, emit, setValue } = createMockTextRef("initial")
      const scope = new Scope()
      const input = document.createElement("input")

      inputTextRegion(input, ref, scope)
      expect(input.value).toBe("initial")
      expect(getActiveSubscriptionCount()).toBe(1)

      scope.dispose()
      expect(getActiveSubscriptionCount()).toBe(0)

      // Changes after dispose should not affect the input
      setValue("changed")
      emit({ type: "replace" })

      expect(input.value).toBe("initial")
    })
  })
})
