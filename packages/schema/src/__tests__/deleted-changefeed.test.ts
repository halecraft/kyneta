import { describe, expect, it } from "vitest"
import {
  change,
  deleted,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  subscribeNode,
  writable,
} from "../index.js"

describe("deleted changefeed", () => {
  it("fires when the ref's parent container is mutated", () => {
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

    let fired = 0
    subscribeNode(deleted(item), () => {
      fired++
    })

    change(doc, (d: any) => d.items.delete(0, 1))

    expect(fired).toBe(1)
    expect(deleted(item)()).toBe(true)
  })

  it("fires when a map entry is deleted", () => {
    const s = Schema.struct({
      metadata: Schema.record(Schema.string()),
    })
    const store = { metadata: { version: "1.0" } }
    const ctx = plainContext(store)
    const doc = interpret(s, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any

    const entry = doc.metadata.at("version")

    let fired = 0
    subscribeNode(deleted(entry), () => {
      fired++
    })

    change(doc, (d: any) => d.metadata.delete("version"))

    expect(fired).toBe(1)
    expect(deleted(entry)()).toBe(true)
  })

  it("cleans up listeners on unsubscribe", () => {
    const s = Schema.struct({
      items: Schema.list(Schema.string()),
    })
    const store = { items: ["a"] }
    const ctx = plainContext(store)
    const doc = interpret(s, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any

    const item = doc.items.at(0)

    let fired = 0
    const unsub = subscribeNode(deleted(item), () => {
      fired++
    })

    // Unsubscribe before deletion
    unsub()

    change(doc, (d: any) => d.items.delete(0, 1))

    // Should not have fired
    expect(fired).toBe(0)
    expect(deleted(item)()).toBe(true)
  })
})
