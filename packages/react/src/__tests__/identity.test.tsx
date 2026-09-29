// identity.test.tsx — a hook's value keeps its identity until a tracked read
// or its thunk changes.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { changefeed } from "@kyneta/changefeed"
import { Exchange } from "@kyneta/exchange"
import { batch, createDoc, Schema } from "@kyneta/schema/basic"
import { act, render, renderHook } from "@testing-library/react"
import { memo, useCallback } from "react"
import { describe, expect, it, vi } from "vitest"
import { useChangefeed } from "../use-changefeed.js"
import { useTracked } from "../use-tracked.js"
import { useValue } from "../use-value.js"

const TodoApp = Schema.struct({
  todos: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
})

function todoDoc() {
  const doc: any = createDoc(TodoApp)
  batch(doc, (d: any) => {
    d.todos.push({ text: "a", done: true })
    d.todos.push({ text: "b", done: false })
  })
  return doc
}

describe("useValue", () => {
  it("keeps its value's identity across a re-render the ref had no part in", () => {
    const doc = todoDoc()
    const { result, rerender } = renderHook(() => useValue(doc))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it("a memo child given one todo does not re-render when another changes", async () => {
    const doc = todoDoc()
    let childRenders = 0
    const Todo = memo(({ todo }: { todo: { text: string } }) => {
      childRenders++
      return <span>{todo.text}</span>
    })
    function List() {
      const value = useValue(doc)
      return <Todo todo={value.todos[1]} />
    }
    render(<List />)
    expect(childRenders).toBe(1)

    await act(async () => {
      batch(doc, (d: any) => d.todos.at(0).text.set("changed"))
    })
    expect(childRenders).toBe(1)

    await act(async () => {
      batch(doc, (d: any) => d.todos.at(1).text.set("B"))
    })
    expect(childRenders).toBe(2)
  })
})

describe("useTracked", () => {
  it("with a useCallback thunk, keeps identity across an unrelated render and follows the capture", () => {
    const doc = todoDoc()
    const { result, rerender } = renderHook(
      ({ filter, unrelated }: { filter: boolean; unrelated: number }) => {
        void unrelated
        const thunk = useCallback(
          () => [...doc.todos].filter((t: any) => t.done() === filter),
          [filter],
        )
        return useTracked(thunk)
      },
      { initialProps: { filter: true, unrelated: 0 } },
    )
    const first = result.current
    expect(first).toHaveLength(1)

    rerender({ filter: true, unrelated: 1 })
    expect(result.current).toBe(first)

    rerender({ filter: false, unrelated: 1 })
    expect(result.current).not.toBe(first)
    expect(result.current).toHaveLength(1)
  })
})

describe("useChangefeed", () => {
  it("over a schema composite, re-renders on a descendant edit, without looping", async () => {
    const doc = todoDoc()
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    let renders = 0
    const feed = changefeed(doc.todos)
    const { result } = renderHook(() => {
      renders++
      return useChangefeed(feed)
    })
    const first = result.current
    const afterMount = renders

    await act(async () => {
      batch(doc, (d: any) => d.todos.at(0).text.set("edited"))
    })
    expect(renders).toBe(afterMount + 1)
    expect(result.current).not.toBe(first)
    expect((result.current as any)[0].text).toBe("edited")
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it("over exchange.peers, re-renders when a peer joins", async () => {
    const bridge = new Bridge()
    const a = new Exchange({
      principal: "a",
      transports: [createBridgeTransport({ transportId: "a", bridge })],
    })
    const { result } = renderHook(() => useChangefeed(a.peers))
    expect(result.current.size).toBe(0)

    const b = new Exchange({
      principal: "b",
      transports: [createBridgeTransport({ transportId: "b", bridge })],
    })
    await act(async () => {
      for (let i = 0; i < 30; i++) {
        await new Promise<void>(r => setTimeout(r, 0))
      }
    })
    expect(result.current.size).toBe(1)

    await a.shutdown()
    await b.shutdown()
  })
})
