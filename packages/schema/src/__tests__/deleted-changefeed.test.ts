import { describe, expect, it } from "vitest"
import { batch, createDoc } from "../basic/index.js"
import { hasRecursiveChangefeed } from "../changefeed.js"
import { deleted } from "../interpreters/with-addressing.js"
import { Schema } from "../schema.js"

const TodoDoc = Schema.product({
  todos: Schema.sequence(
    Schema.product({
      id: Schema.text(),
      text: Schema.text(),
      done: Schema.boolean(),
    }),
  ),
})

describe("deleted() changefeed", () => {
  it("should NOT have a recursive changefeed", () => {
    const doc = createDoc(TodoDoc)
    batch(doc, (d: typeof doc) => {
      d.todos.push({ id: "t1", text: "", done: false })
    })
    const ref = doc.todos.at(0)!

    const d = deleted(ref)

    expect(hasRecursiveChangefeed(d)).toBe(false)
  })
})
