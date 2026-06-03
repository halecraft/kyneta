// use-text.test.tsx — Tier 2 React integration tests.
//
// Proves useText wires the text-adapter's attach/detach lifecycle to
// React's ref callback mechanism. Thin tests — the core attach() logic
// is already covered exhaustively by text-adapter.test.ts (Tier 1).

import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { TextRefLike } from "../text-adapter.js"
import { useText } from "../use-text.js"

// ---------------------------------------------------------------------------
// Test schema
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

// ---------------------------------------------------------------------------
// Type-level regression lock — TextRefLike accepts a Ref<TextSchema> with no cast
// ---------------------------------------------------------------------------

describe("TextRefLike", () => {
  it("accepts a text Ref<TextSchema> without a cast, and rejects non-text refs", () => {
    const doc = createTestDoc("x")
    // Positive — locks the widening: a real text ref is structurally a
    // TextRefLike, no `as unknown as` cast. A compile error here (caught by
    // tsc, which includes this file) means the gap reopened.
    const ok: TextRefLike = doc.title
    expect(typeof ok).toBe("function")

    // Negative — locks narrowness: a number scalar ref must NOT be a TextRefLike.
    const numbers = createDoc(Schema.struct({ count: Schema.number() }))
    // @ts-expect-error a number scalar ref is not assignable to TextRefLike
    const bad: TextRefLike = numbers.count
    void bad
  })
})

// ---------------------------------------------------------------------------
// useText
// ---------------------------------------------------------------------------

describe("useText", () => {
  it("returns a stable ref callback", () => {
    const doc = createTestDoc("hello")
    const { result, rerender } = renderHook(() =>
      useText(doc.title),
    )

    const first = result.current
    rerender()
    const second = result.current

    // Same textRef + same options → same callback identity (useCallback)
    expect(first).toBe(second)
  })

  describe("mount: ref callback receives element", () => {
    it("calls attach and sets textarea value from text ref", () => {
      const doc = createTestDoc("initial text")
      const textarea = document.createElement("textarea")

      const { result } = renderHook(() =>
        useText(doc.title),
      )

      // Simulate React calling the ref callback with the element
      act(() => {
        result.current(textarea)
      })

      expect(textarea.value).toBe("initial text")
    })

    it("sets empty string for empty text ref", () => {
      const doc = createTestDoc()
      const textarea = document.createElement("textarea")
      textarea.value = "stale"

      const { result } = renderHook(() =>
        useText(doc.title),
      )

      act(() => {
        result.current(textarea)
      })

      expect(textarea.value).toBe("")
    })
  })

  describe("unmount: detach is called", () => {
    it("cleans up on null callback — no more local event processing", () => {
      const doc = createTestDoc("abc")
      const textarea = document.createElement("textarea")

      const { result } = renderHook(() =>
        useText(doc.title),
      )

      // Attach
      act(() => {
        result.current(textarea)
      })
      expect(textarea.value).toBe("abc")

      // Simulate React calling the ref callback with null (unmount)
      act(() => {
        result.current(null)
      })

      // After cleanup, local input events should NOT flow to the CRDT
      textarea.value = "changed"
      textarea.selectionStart = 7
      textarea.dispatchEvent(new Event("input"))

      expect(doc.title()).toBe("abc") // unchanged
    })

    it("cleans up on null callback — no more remote change application", () => {
      const doc = createTestDoc("abc")
      const textarea = document.createElement("textarea")

      const { result } = renderHook(() =>
        useText(doc.title),
      )

      act(() => {
        result.current(textarea)
      })

      // Simulate React calling the ref callback with null (unmount)
      act(() => {
        result.current(null)
      })

      // Remote changes should NOT flow to the element after detach
      batch(doc, d => {
        d.title.insert(0, "Z")
      })

      expect(textarea.value).toBe("abc") // unchanged by remote
    })
  })

  describe("basic render with initial value", () => {
    it("textarea shows the text ref's current value after mutation", () => {
      const doc = createTestDoc()
      const textarea = document.createElement("textarea")

      // Mutate before attaching
      batch(doc, d => {
        d.title.insert(0, "pre-populated")
      })

      const { result } = renderHook(() =>
        useText(doc.title),
      )

      act(() => {
        result.current(textarea)
      })

      expect(textarea.value).toBe("pre-populated")
    })

    it("remote changes after attach are reflected in the element", () => {
      const doc = createTestDoc("hello")
      const textarea = document.createElement("textarea")

      const { result } = renderHook(() =>
        useText(doc.title),
      )

      act(() => {
        result.current(textarea)
      })
      expect(textarea.value).toBe("hello")

      // Simulate remote change
      batch(doc, d => {
        d.title.insert(5, " world")
      })

      expect(textarea.value).toBe("hello world")
    })
  })

  describe("ref identity change triggers re-attach", () => {
    it("detaches old and attaches new when textRef changes", () => {
      const doc1 = createTestDoc("doc1")
      const doc2 = createTestDoc("doc2")
      const textarea = document.createElement("textarea")

      const { result, rerender } = renderHook(
        ({ textRef }) => useText(textRef),
        { initialProps: { textRef: doc1.title } },
      )

      // Attach to first doc
      act(() => {
        result.current(textarea)
      })
      expect(textarea.value).toBe("doc1")

      // Switch to a different textRef — returns a new callback
      rerender({ textRef: doc2.title })

      // Simulate React calling old ref with null, then new ref with element
      act(() => {
        result.current(textarea)
      })
      expect(textarea.value).toBe("doc2")

      // Verify the new binding is live: remote change on doc2 flows through
      batch(doc2, d => {
        d.title.insert(4, "!")
      })
      expect(textarea.value).toBe("doc2!")

      // And old binding is dead: remote change on doc1 does NOT flow
      batch(doc1, d => {
        d.title.insert(0, "Z")
      })
      expect(textarea.value).toBe("doc2!") // unchanged
    })
  })
})
