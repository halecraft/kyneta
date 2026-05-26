import { describe, expect, it } from "vitest"
import {
  change,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"

describe("dead ref", () => {
  it("throws when reading a dead ref", () => {
    const s = Schema.struct({
      items: Schema.list(Schema.string()),
    })
    const store = { items: ["a", "b"] }
    const ctx = plainContext(store)
    const doc = interpret(s, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any

    const item = doc.items.at(0)
    expect(item()).toBe("a")

    change(doc, (d: any) => d.items.delete(0, 1))

    try {
      item()
      console.log("Did not throw!")
    } catch (e: any) {
      console.log("Threw:", e.message)
    }
  })
})
