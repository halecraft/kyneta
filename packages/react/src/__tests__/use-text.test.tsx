// use-text.test.tsx — Tier 2 React integration tests.
//
// Proves useText wires the text-adapter's attach/detach lifecycle to
// React's ref callback mechanism. Thin tests — the core attach() logic
// is already covered exhaustively by text-adapter.test.ts (Tier 1).

import {
  createInMemoryStore,
  createInMemoryStoreData,
  Exchange,
  type InMemoryStoreData,
  WriterRefusedError,
  whenHydrated,
} from "@kyneta/exchange"
import { json } from "@kyneta/schema"
import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { TextRefLike } from "../text-adapter.js"
import { useText } from "../use-text.js"
import { useWriteRefusal } from "../use-write-refusal.js"

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
    const { result, rerender } = renderHook(() => useText(doc.title))

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

      const { result } = renderHook(() => useText(doc.title))

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

      const { result } = renderHook(() => useText(doc.title))

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

      const { result } = renderHook(() => useText(doc.title))

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

      const { result } = renderHook(() => useText(doc.title))

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

      const { result } = renderHook(() => useText(doc.title))

      act(() => {
        result.current(textarea)
      })

      expect(textarea.value).toBe("pre-populated")
    })

    it("remote changes after attach are reflected in the element", () => {
      const doc = createTestDoc("hello")
      const textarea = document.createElement("textarea")

      const { result } = renderHook(() => useText(doc.title))

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

// ---------------------------------------------------------------------------
// useText with a document that loads from a store
// ---------------------------------------------------------------------------

describe("useText on a document still loading", () => {
  const StoredDoc = json.bind(TextDocSchema)

  /** A storage holding `doc` with `title` set, written by an earlier session. */
  async function storeWithTitle(title: string): Promise<InMemoryStoreData> {
    const sharedData = createInMemoryStoreData()
    const exchange = new Exchange({
      principal: "writer",
      store: createInMemoryStore({ sharedData }),
    })
    const doc = exchange.get("doc", StoredDoc)
    await whenHydrated(doc)
    batch(doc, d => d.title.insert(0, title))
    await exchange.flush()
    await exchange.shutdown()
    return sharedData
  }

  it("is read-only until loaded, then shows the stored text and takes edits", async () => {
    const sharedData = await storeWithTitle("stored")
    const exchange = new Exchange({
      principal: "reader",
      store: createInMemoryStore({ sharedData }),
    })
    const doc = exchange.get("doc", StoredDoc)
    const textarea = document.createElement("textarea")
    const { result } = renderHook(() => useText(doc.title))

    act(() => {
      result.current(textarea)
    })
    expect(textarea.readOnly).toBe(true)
    // A plain document refuses writes while loading; the element must not
    // try to make one.
    textarea.value = "typed"
    expect(() => textarea.dispatchEvent(new Event("input"))).not.toThrow()

    await act(async () => {
      await whenHydrated(doc)
    })
    expect(textarea.readOnly).toBe(false)
    expect(textarea.value).toBe("stored")

    textarea.value = "stored!"
    textarea.selectionStart = textarea.selectionEnd = 7
    textarea.dispatchEvent(new Event("input"))
    expect(doc.title()).toBe("stored!")
    await exchange.shutdown()
  })

  it("binds a document that has already loaded on the first call", async () => {
    const sharedData = await storeWithTitle("ready")
    const exchange = new Exchange({
      principal: "reader",
      store: createInMemoryStore({ sharedData }),
    })
    const doc = exchange.get("doc", StoredDoc)
    await whenHydrated(doc)
    const textarea = document.createElement("textarea")
    const { result } = renderHook(() => useText(doc.title))

    act(() => {
      result.current(textarea)
    })
    expect(textarea.readOnly).toBe(false)
    expect(textarea.value).toBe("ready")
    await exchange.shutdown()
  })
})

// ---------------------------------------------------------------------------
// useText on a document another tab writes
// ---------------------------------------------------------------------------

describe("useText on a document another tab of the store writes", () => {
  const StoredDoc = json.bind(TextDocSchema)

  /** Two live Exchanges over one storage: two tabs, two seats. */
  function twoTabs(): { writer: Exchange; reader: Exchange } {
    const sharedData = createInMemoryStoreData()
    const tab = (principal: string) =>
      new Exchange({
        principal,
        store: createInMemoryStore({ sharedData }),
        onStoreError: () => {},
      })
    return { writer: tab("writer"), reader: tab("reader") }
  }

  it("is read-only once loaded, showing the writer's text", async () => {
    const { writer, reader } = twoTabs()
    const written = writer.get("doc", StoredDoc)
    await whenHydrated(written)
    batch(written, d => d.title.insert(0, "the writer's"))
    await writer.flush()

    const doc = reader.get("doc", StoredDoc)
    const textarea = document.createElement("textarea")
    const { result } = renderHook(() => useText(doc.title))
    act(() => {
      result.current(textarea)
    })
    await act(async () => {
      await whenHydrated(doc)
    })
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe("the writer's")

    // An input that reaches it anyway changes nothing, and throws nothing.
    textarea.value = "typed"
    expect(() => textarea.dispatchEvent(new Event("input"))).not.toThrow()
    expect(textarea.value).toBe("the writer's")

    act(() => {
      result.current(null)
    })
    expect(textarea.readOnly).toBe(false)
    await reader.shutdown()
    await writer.shutdown()
  })

  it("becomes read-only, with its typing rolled back, when it loses the race to write first", async () => {
    const { writer, reader } = twoTabs()
    const written = writer.get("doc", StoredDoc)
    const doc = reader.get("doc", StoredDoc)
    await whenHydrated(written)
    await whenHydrated(doc)
    const textarea = document.createElement("textarea")
    const { result } = renderHook(() => useText(doc.title))
    act(() => {
      result.current(textarea)
    })
    expect(textarea.readOnly).toBe(false)

    batch(written, d => d.title.insert(0, "first"))
    await writer.flush()
    // Both loaded before either claimed, so this tab's typing is taken, and
    // refused by the store.
    textarea.value = "second"
    textarea.selectionStart = textarea.selectionEnd = 6
    textarea.dispatchEvent(new Event("input"))
    expect(doc.title()).toBe("second")
    await act(async () => {
      await reader.flush()
    })

    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe("first")
    await reader.shutdown()
    await writer.shutdown()
  })
})

describe("useWriteRefusal", () => {
  const StoredDoc = json.bind(TextDocSchema)

  it("is undefined until the document loads refused, then names the writer", async () => {
    const sharedData = createInMemoryStoreData()
    const writer = new Exchange({
      principal: "writer",
      store: createInMemoryStore({ sharedData }),
    })
    const written = writer.get("doc", StoredDoc)
    await whenHydrated(written)
    batch(written, d => d.title.insert(0, "mine"))
    await writer.flush()

    const reader = new Exchange({
      principal: "reader",
      store: createInMemoryStore({ sharedData }),
    })
    const doc = reader.get("doc", StoredDoc)
    const { result } = renderHook(() => useWriteRefusal(doc))
    expect(result.current).toBeUndefined()
    await act(async () => {
      await whenHydrated(doc)
    })
    expect(result.current).toBeInstanceOf(WriterRefusedError)
    expect(result.current?.writer).toBe(writer.peerId)
    await reader.shutdown()
    await writer.shutdown()
  })
})
