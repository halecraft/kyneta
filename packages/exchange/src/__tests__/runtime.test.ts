// runtime.test.ts — verifies the Runtime can manage documents standalone
// (no Exchange, no network transports) with stores and the tick clock.

import { type DocRef, json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Runtime } from "../runtime.js"
import { createInMemoryStore } from "../store/in-memory-store.js"

const TodoSchema = Schema.struct({
  title: Schema.string(),
  done: Schema.boolean(),
})

const TodoDoc = json.bind(TodoSchema)

describe("Runtime (standalone, no Exchange)", () => {
  it("creates and retrieves documents", () => {
    const runtime = new Runtime({ peerId: "alice" })
    const doc = runtime.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>

    expect(doc).toBeDefined()
    expect(runtime.has("todo-1")).toBe(true)
    expect(runtime.documentIds()).toEqual(new Set(["todo-1"]))
    runtime.shutdown()
  })

  it("returns the same ref for repeated get() calls", () => {
    const runtime = new Runtime({ peerId: "alice" })
    const doc1 = runtime.get("todo-1", TodoDoc)
    const doc2 = runtime.get("todo-1", TodoDoc)

    expect(doc1).toBe(doc2)
    runtime.shutdown()
  })

  it("destroys documents", () => {
    const runtime = new Runtime({ peerId: "alice" })
    runtime.get("todo-1", TodoDoc)
    expect(runtime.has("todo-1")).toBe(true)

    runtime.destroy("todo-1")
    expect(runtime.has("todo-1")).toBe(false)
    runtime.shutdown()
  })

  it("hydrates from stores on subsequent runs", async () => {
    const store = createInMemoryStore()

    // First runtime: create and persist
    const runtime1 = new Runtime({ peerId: "alice", stores: [store] })
    const doc1 = runtime1.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    doc1.title.set("Buy milk")
    await runtime1.flush()
    await runtime1.shutdown()

    // Second runtime: hydrate from the same store
    const runtime2 = new Runtime({ peerId: "bob", stores: [store] })
    const doc2 = runtime2.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>

    // Hydration is async — drain
    await runtime2.flush()

    expect(doc2.title()).toBe("Buy milk")
    await runtime2.shutdown()
  })

  it("fires lifecycle hooks", () => {
    const runtime = new Runtime({ peerId: "alice" })

    const readyCalls: string[] = []
    const destroyedCalls: string[] = []

    runtime.setHooks({
      onDocReady: info => readyCalls.push(info.docId),
      onDocDestroyed: docId => destroyedCalls.push(docId),
    })

    runtime.get("todo-1", TodoDoc)
    expect(readyCalls).toEqual(["todo-1"])

    runtime.destroy("todo-1")
    expect(destroyedCalls).toEqual(["todo-1"])

    runtime.shutdown()
  })

  it("fires onDocReady with correct mode for replicate docs", () => {
    const runtime = new Runtime({ peerId: "alice" })

    const readyCalls: { docId: string; mode: string }[] = []
    runtime.setHooks({
      onDocReady: info =>
        readyCalls.push({ docId: info.docId, mode: info.mode }),
    })

    runtime.get("todo-1", TodoDoc)
    const boundReplica = json.replica()
    runtime.replicate(
      "todo-2",
      boundReplica.factory,
      boundReplica.syncMode,
      TodoDoc.schemaHash,
    )

    expect(readyCalls).toContainEqual({ docId: "todo-1", mode: "interpret" })
    expect(readyCalls).toContainEqual({ docId: "todo-2", mode: "replicate" })

    runtime.shutdown()
  })

  it("suspend and resume are idempotent and throw correctly", () => {
    const runtime = new Runtime({ peerId: "alice" })
    runtime.get("todo-1", TodoDoc)

    // Suspend
    runtime.suspend("todo-1")
    // Double-suspend is a no-op
    runtime.suspend("todo-1")

    // Resume
    runtime.resume("todo-1")
    expect(() => runtime.resume("todo-1")).toThrow("not suspended")

    // Cannot suspend non-existent doc
    expect(() => runtime.suspend("nope")).toThrow("does not exist")

    runtime.shutdown()
  })

  it("tick clock starts and stops without errors", () => {
    // The tick is a no-op for substrates without tick(), but the interval
    // must not throw or leak.
    const runtime = new Runtime({ peerId: "alice", tickInterval: 100 })
    runtime.get("todo-1", TodoDoc)

    // Just verify it doesn't throw; substrates don't implement tick yet.
    expect(() => runtime.shutdown()).not.toThrow()
  })

  it("tickInterval: 0 disables the tick", () => {
    const runtime = new Runtime({ peerId: "alice", tickInterval: 0 })
    runtime.get("todo-1", TodoDoc)
    expect(() => runtime.shutdown()).not.toThrow()
  })

  it("does not fire onDocChangeset when no hooks are set", () => {
    const runtime = new Runtime({ peerId: "alice" })

    // Should not throw even though no hooks are wired
    const doc = runtime.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    expect(() => doc.title.set("hello")).not.toThrow()

    runtime.shutdown()
  })

  it("lease is accessible for sharing across components", () => {
    const runtime = new Runtime({ peerId: "alice" })
    expect(runtime.lease).toBeDefined()
    expect(runtime.peerId).toBe("alice")
    runtime.shutdown()
  })
})

describe("Exchange with pre-constructed Runtime (rare overload)", () => {
  it("wraps a pre-constructed Runtime via constructor overload", async () => {
    const { Exchange } = await import("../exchange.js")
    const store = createInMemoryStore()

    // Create a standalone Runtime with a store
    const runtime = new Runtime({ peerId: "alice", stores: [store] })

    // Write data via the Runtime directly
    const doc1 = runtime.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    doc1.title.set("Hello")
    await runtime.flush()

    // Wrap the Runtime in an Exchange for networking
    const exchange = new Exchange(runtime, {})

    // The same document is accessible via the Exchange
    const doc2 = exchange.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    expect(doc2.title()).toBe("Hello")

    // peerId is derived from the Runtime
    expect(exchange.peerId).toBe("alice")

    await exchange.shutdown()
  })

  it("derives peerId from the Runtime, not from params", async () => {
    const { Exchange } = await import("../exchange.js")
    const runtime = new Runtime({ peerId: "bob" })
    const exchange = new Exchange(runtime, {})

    expect(exchange.peerId).toBe("bob")
    expect(exchange.runtime.peerId).toBe("bob")

    await exchange.shutdown()
  })
})
