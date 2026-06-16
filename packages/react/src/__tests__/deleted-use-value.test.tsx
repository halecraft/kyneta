import { describe, expect, it, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { createDoc, batch } from "@kyneta/schema/basic"
import { Schema, deleted, remove } from "@kyneta/schema"
import { useValue } from "../use-value.js"

const TodoDoc = Schema.product({
  todos: Schema.sequence(Schema.product({
    id: Schema.text(),
    text: Schema.text(),
    done: Schema.scalar<boolean>(false)
  }))
})

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe("useValue(deleted(ref))", () => {
  it("re-renders when ref is removed", async () => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: typeof doc) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    const ref = doc.todos.at(0)!

    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount++
      return useValue(deleted(ref))
    })

    expect(result.current).toBe(false)
    expect(renderCount).toBe(1)

    act(() => {
      batch(doc, () => { remove(ref) })
    })
    await tick()

    expect(result.current).toBe(true)
    expect(renderCount).toBe(2)
  })
})
