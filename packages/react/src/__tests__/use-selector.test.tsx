// use-selector.test.tsx — the motivating scenario: a parent filtering a list
// by each todo's `done`. useSelector must re-render only when the visible set
// changes — not on text edits — and follow a `filter` prop with no deps array.

import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useSelector } from "../use-selector.js"

const TodoApp = Schema.struct({
  todos: Schema.list(
    Schema.struct({
      id: Schema.string(),
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

describe("useSelector", () => {
  it("throws a descriptive error if the selector returns a Kyneta Ref (reactivity footgun)", () => {
    const doc = createDoc(TodoApp)

    // Suppress React error boundary logging for this expected throw
    const originalConsoleError = console.error
    console.error = () => {}

    expect(() => {
      renderHook(() => useSelector(doc.todos, (todos: any) => todos))
    }).toThrow(/useSelector must return a projected value/)

    console.error = originalConsoleError
  })

  it("PARSIMONY: re-renders on done flip + structural change, not on text edits", async () => {
    const doc = createDoc(TodoApp)
    batch(doc, (d: any) => {
      d.todos.push({ id: "a", text: "x", done: true })
      d.todos.push({ id: "b", text: "y", done: false })
    })

    let renders = 0
    const { result } = renderHook(() => {
      renders++
      return useSelector(doc.todos, (todos: any) =>
        [...todos].filter((t: any) => t.done()).map((t: any) => t.id()),
      )
    })
    expect(result.current).toEqual(["a"])
    const afterMount = renders

    // A text edit touches neither structure(todos) nor any value(done): no re-render.
    await act(async () => {
      batch(doc, (d: any) => d.todos.at(0).text.set("edited"))
    })
    expect(renders).toBe(afterMount)
    expect(result.current).toEqual(["a"])

    // A done flip crosses the filter → re-render, new visible set.
    await act(async () => {
      batch(doc, (d: any) => d.todos.at(1).done.set(true))
    })
    expect(renders).toBeGreaterThan(afterMount)
    expect(result.current).toEqual(["a", "b"])

    // A structural add → re-render.
    const afterFlip = renders
    await act(async () => {
      batch(doc, (d: any) => d.todos.push({ id: "c", text: "z", done: true }))
    })
    expect(renders).toBeGreaterThan(afterFlip)
    expect(result.current).toEqual(["a", "b", "c"])
  })

  it("NO DEPS ARRAY: the projection follows a filter prop with no deps array", () => {
    const doc = createDoc(TodoApp)
    batch(doc, (d: any) => {
      d.todos.push({ id: "a", text: "", done: true })
      d.todos.push({ id: "b", text: "", done: false })
    })

    const { result, rerender } = renderHook(
      ({ filter }: { filter: "all" | "done" }) =>
        useSelector(doc.todos, (todos: any) =>
          [...todos]
            .filter((t: any) => (filter === "all" ? true : t.done()))
            .map((t: any) => t.id()),
        ),
      { initialProps: { filter: "all" as "all" | "done" } },
    )
    expect(result.current).toEqual(["a", "b"])

    // Changing the filter prop (React state) re-renders; the selector follows
    // the new closure with no deps array.
    rerender({ filter: "done" })
    expect(result.current).toEqual(["a"])
  })

  it("disposes on unmount (no re-render after a later change)", async () => {
    const doc = createDoc(TodoApp)
    batch(doc, (d: any) => d.todos.push({ id: "a", text: "", done: true }))

    let renders = 0
    const { unmount } = renderHook(() => {
      renders++
      return useSelector(doc.todos, (todos: any) => todos.length)
    })
    const afterMount = renders
    unmount()
    await act(async () => {
      batch(doc, (d: any) => d.todos.push({ id: "b", text: "", done: false }))
    })
    expect(renders).toBe(afterMount) // no re-render after unmount
  })
})
