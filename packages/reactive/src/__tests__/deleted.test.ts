import { deleted, isDeleted, remove, Schema } from "@kyneta/schema"
import { batch, createDoc } from "@kyneta/schema/basic"
import { describe, expect, it } from "vitest"
import { reactive, track } from "../reactive.js"

const TodoDoc = Schema.product({
  todos: Schema.sequence(
    Schema.product({
      id: Schema.text(),
      text: Schema.text(),
      done: Schema.boolean(),
    }),
  ),
})

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))

describe("deleted ref tracking", () => {
  it("reactive(thunk) with isDeleted(ref) re-runs on remove", async () => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: typeof doc) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    const ref = doc.todos.at(0)
    if (!ref) throw new Error("ref not found")

    const r = reactive(() => {
      return isDeleted(ref)
    })

    let recomputed = 0
    r.subscribe(() => {
      recomputed++
    })

    expect(r()).toBe(false)

    batch(doc, () => {
      remove(ref)
    })
    await tick()

    expect(r()).toBe(true)
    expect(recomputed).toBe(1)
  })

  it("reactive(thunk) with deleted(ref)() re-runs on remove", async () => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: typeof doc) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    const ref = doc.todos.at(0)
    if (!ref) throw new Error("ref not found")

    const r = reactive(() => {
      return deleted(ref)!()
    })

    let recomputed = 0
    r.subscribe(() => {
      recomputed++
    })

    expect(r()).toBe(false)

    batch(doc, () => {
      remove(ref)
    })
    await tick()

    expect(r()).toBe(true)
    expect(recomputed).toBe(1)
  })

  it("reactive(thunk) with track(deleted(ref)) re-runs on remove", async () => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: typeof doc) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    const ref = doc.todos.at(0)
    if (!ref) throw new Error("ref not found")

    const r = reactive(() => {
      return track(deleted(ref)!)
    })

    let recomputed = 0
    r.subscribe(() => {
      recomputed++
    })

    expect(r()).toBe(false)

    batch(doc, () => {
      remove(ref)
    })
    await tick()

    expect(r()).toBe(true)
    expect(recomputed).toBe(1)
  })
})
