import { deleted, remove, Schema } from "@kyneta/schema"
import { batch, createDoc } from "@kyneta/schema/basic"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useValue } from "../use-value.js"

const TodoDoc = Schema.product({
  todos: Schema.sequence(
    Schema.product({
      id: Schema.text(),
      text: Schema.text(),
      done: Schema.scalar("boolean"),
    }),
  ),
})

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe("useValue(deleted(ref))", () => {
  it("re-renders when ref is removed", async () => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: typeof doc) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    const ref = doc.todos.at(0)
    if (!ref) throw new Error("expected one todo after push")

    let renderCount = 0
    const { result } = renderHook(() => {
      renderCount++
      return useValue(deleted(ref))
    })

    expect(result.current).toBe(false)
    expect(renderCount).toBe(1)

    act(() => {
      batch(doc, () => {
        remove(ref)
      })
    })
    await tick()

    expect(result.current).toBe(true)
    expect(renderCount).toBe(2)
  })
})
