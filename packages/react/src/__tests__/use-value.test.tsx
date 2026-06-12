// use-value.test.tsx — Tier 2 React integration tests.
//
// Proves the useValue hook (now a derivation of useTracked over @kyneta/reactive,
// jj:smkurmok) wires into React's rendering cycle via useSyncExternalStore.
//
// Timing note: useValue is now microtask-COALESCED (the reactive scheduler),
// so a mutation re-renders on the next microtask rather than synchronously.
// Mutation assertions therefore use `await act(async () => …)`. The value
// contract (Plain<S>, deep reactivity, nullish passthrough) is unchanged.

import { createReactiveMap } from "@kyneta/changefeed"
import { batch, createDoc, Schema } from "@kyneta/schema/basic"
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

  it("re-renders on change", async () => {
    const doc = createDoc(TestSchema)
    const { result } = renderHook(() => useValue(doc.title))

    expect(result.current).toBe("")

    await act(async () => {
      batch(doc, d => {
        d.title.set("hello")
      })
    })

    expect(result.current).toBe("hello")
  })

  it("re-renders composite on nested field change", async () => {
    const doc = createDoc(TestSchema)
    const { result } = renderHook(() => useValue(doc))

    await act(async () => {
      batch(doc, d => {
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
    batch(doc, d => {
      d.title.set("after unmount")
    })
  })

  it("transitions from null to a ref and back", async () => {
    const doc = createDoc(TestSchema)

    const { result, rerender } = renderHook(({ ref }) => useValue(ref), {
      initialProps: { ref: null as any },
    })

    expect(result.current).toBe(null)

    // Transition: null → ref
    rerender({ ref: doc.title })
    expect(result.current).toBe("")

    // Mutation should cause re-render
    await act(async () => {
      batch(doc, d => {
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

  it("re-renders after mutation + emit", async () => {
    const [map, handle] = createReactiveMap<string, number>()
    const { result } = renderHook(() => useValue(map))

    expect(result.current.size).toBe(0)

    await act(async () => {
      handle.set("a", 1)
      handle.emit({ changes: [{ type: "set" }] })
    })

    expect(result.current.size).toBe(1)
    expect(result.current.get("a")).toBe(1)
  })
})
