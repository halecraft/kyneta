// use-value.test.tsx — Tier 2 React integration tests.
//
// Proves the useValue hook wires createChangefeedStore to React's
// rendering cycle via useSyncExternalStore. Thin tests — the core
// logic is already covered by store.test.ts (Tier 1).

import { createReactiveMap } from "@kyneta/changefeed"
import { change, createDoc, Schema } from "@kyneta/schema/basic"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useValue } from "../use-value.js"

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TestSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

// ---------------------------------------------------------------------------
// useValue
// ---------------------------------------------------------------------------

describe("useValue", () => {
  it("renders initial value from a scalar ref", () => {
    const doc = createDoc(TestSchema)
    const { result } = renderHook(() => useValue(doc.title))
    expect(result.current).toBe("")
  })

  it("renders initial value from a composite ref", () => {
    const doc = createDoc(TestSchema)
    const { result } = renderHook(() => useValue(doc))
    expect(result.current).toEqual({ title: "", count: 0 })
  })

  it("re-renders on change", () => {
    const doc = createDoc(TestSchema)
    const { result } = renderHook(() => useValue(doc.title))

    expect(result.current).toBe("")

    act(() => {
      change(doc, d => {
        d.title.set("hello")
      })
    })

    expect(result.current).toBe("hello")
  })

  it("re-renders composite on nested field change", () => {
    const doc = createDoc(TestSchema)
    const { result } = renderHook(() => useValue(doc))

    act(() => {
      change(doc, d => {
        d.title.set("updated")
      })
    })

    expect(result.current.title).toBe("updated")
  })

  it("returns undefined for undefined input", () => {
    const { result } = renderHook(() => useValue(undefined))
    expect(result.current).toBe(undefined)
  })

  it("returns null for null input", () => {
    const { result } = renderHook(() => useValue(null))
    expect(result.current).toBe(null)
  })

  it("does not warn on unmount followed by mutation", () => {
    const doc = createDoc(TestSchema)
    const { unmount } = renderHook(() => useValue(doc.title))

    unmount()

    // Mutate after unmount — should not cause errors
    change(doc, d => {
      d.title.set("after unmount")
    })
  })

  it("transitions from null to a ref and back", () => {
    const doc = createDoc(TestSchema)

    const { result, rerender } = renderHook(({ ref }) => useValue(ref), {
      initialProps: { ref: null as any },
    })

    expect(result.current).toBe(null)

    // Transition: null → ref
    rerender({ ref: doc.title })
    expect(result.current).toBe("")

    // Mutation should cause re-render
    act(() => {
      change(doc, d => {
        d.title.set("alive")
      })
    })
    expect(result.current).toBe("alive")

    // Transition: ref → null (should not throw, should unsubscribe)
    rerender({ ref: null as any })
    expect(result.current).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// useValue with ReactiveMap
// ---------------------------------------------------------------------------

describe("useValue with ReactiveMap", () => {
  it("renders initial empty map", () => {
    const [map] = createReactiveMap<string, number>()
    const { result } = renderHook(() => useValue(map))
    expect(result.current).toBeInstanceOf(Map)
    expect(result.current.size).toBe(0)
  })

  it("re-renders after mutation + emit", () => {
    const [map, handle] = createReactiveMap<string, number>()
    const { result } = renderHook(() => useValue(map))

    expect(result.current.size).toBe(0)

    act(() => {
      handle.set("a", 1)
      handle.emit({ changes: [{ type: "set" }] })
    })

    expect(result.current.size).toBe(1)
    expect(result.current.get("a")).toBe(1)
  })
})
