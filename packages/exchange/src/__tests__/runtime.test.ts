// runtime.test.ts — verifies the Runtime can manage documents standalone
// (no Exchange, no network transports) with stores and the tick clock.

import { type DocRef, json, Schema } from "@kyneta/schema"
import { describe, expect, it, vi } from "vitest"
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

  it("persists a mutation made after the initial flush (not just before it)", async () => {
    const store = createInMemoryStore()

    const runtime1 = new Runtime({ peerId: "alice", stores: [store] })
    const doc1 = runtime1.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>

    // Let initial registration/hydration fully settle FIRST — this is the
    // case the pre-fix code silently dropped, because no code path ever
    // converted a post-ready local changeset into a persistence write for
    // a standalone Runtime.
    await runtime1.flush()

    doc1.title.set("Buy milk")
    await runtime1.flush()
    await runtime1.shutdown()

    const runtime2 = new Runtime({ peerId: "bob", stores: [store] })
    const doc2 = runtime2.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    await runtime2.flush()

    expect(doc2.title()).toBe("Buy milk")
    await runtime2.shutdown()
  })

  it("persists a mutation on a doc with genuine prior stored data (the 'hydrated' branch)", async () => {
    const store = createInMemoryStore()

    // Generation 1: create + mutate + persist.
    const runtime1 = new Runtime({ peerId: "alice", stores: [store] })
    const doc1 = runtime1.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    doc1.title.set("Buy milk")
    await runtime1.flush()
    await runtime1.shutdown()

    // Generation 2: reopen (hydrates via the "hydrated" branch, since prior
    // stored data exists), mutate again, persist.
    const runtime2 = new Runtime({ peerId: "alice", stores: [store] })
    const doc2 = runtime2.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    await runtime2.flush() // let hydration settle before mutating
    doc2.title.set("Buy milk and eggs")
    await runtime2.flush()
    await runtime2.shutdown()

    // Generation 3: reopen and assert both mutations survived.
    const runtime3 = new Runtime({ peerId: "alice", stores: [store] })
    const doc3 = runtime3.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    await runtime3.flush()

    expect(doc3.title()).toBe("Buy milk and eggs")
    await runtime3.shutdown()
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

  it("setHooks backfills onDocReady for pre-existing docs, exactly once", () => {
    const runtime = new Runtime({ peerId: "alice" })

    // Docs created BEFORE any hooks exist.
    runtime.get("todo-1", TodoDoc)
    const boundReplica = json.replica()
    runtime.replicate(
      "todo-2",
      boundReplica.factory,
      boundReplica.syncMode,
      TodoDoc.schemaHash,
    )

    const readyCalls: { docId: string; mode: string }[] = []
    runtime.setHooks({
      onDocReady: info =>
        readyCalls.push({ docId: info.docId, mode: info.mode }),
    })

    expect(readyCalls).toContainEqual({ docId: "todo-1", mode: "interpret" })
    expect(readyCalls).toContainEqual({ docId: "todo-2", mode: "replicate" })
    expect(readyCalls).toHaveLength(2)

    // Calling setHooks again must not double-announce.
    runtime.setHooks({
      onDocReady: info =>
        readyCalls.push({ docId: info.docId, mode: info.mode }),
    })
    expect(readyCalls).toHaveLength(2)

    runtime.shutdown()
  })

  it("setHooks backfill never re-reads the Store (no hydration replay)", async () => {
    const store = createInMemoryStore()
    const loadAllSpy = vi.spyOn(store, "loadAll")
    const currentMetaSpy = vi.spyOn(store, "currentMeta")

    const runtime = new Runtime({ peerId: "alice", stores: [store] })
    runtime.get("todo-1", TodoDoc)
    await runtime.flush() // hydration settles before any hooks exist

    const callsBeforeBackfill = {
      loadAll: loadAllSpy.mock.calls.length,
      currentMeta: currentMetaSpy.mock.calls.length,
    }

    const readyCalls: string[] = []
    runtime.setHooks({ onDocReady: info => readyCalls.push(info.docId) })

    expect(readyCalls).toEqual(["todo-1"])
    // Backfilling an already-hydrated doc must not trigger any additional
    // Store reads — #register has no reference to Store at all.
    expect(loadAllSpy.mock.calls.length).toBe(callsBeforeBackfill.loadAll)
    expect(currentMetaSpy.mock.calls.length).toBe(
      callsBeforeBackfill.currentMeta,
    )

    await runtime.shutdown()
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

  it("backfills sync-graph registration for docs created on the Runtime before the Exchange existed", async () => {
    const { Exchange } = await import("../exchange.js")
    const store = createInMemoryStore()

    const runtime = new Runtime({ peerId: "alice", stores: [store] })

    // An interpret-mode doc and a replicate-mode doc, both created BEFORE
    // any Exchange (and therefore any hooks) existed.
    const doc1 = runtime.get("todo-1", TodoDoc) as DocRef<typeof TodoSchema>
    doc1.title.set("Hello")

    const boundReplica = json.replica()
    runtime.replicate(
      "todo-2",
      boundReplica.factory,
      boundReplica.syncMode,
      TodoDoc.schemaHash,
    )

    await runtime.flush()

    // Before wrapping: neither doc is known to any sync graph (none exists
    // yet), so there's nothing to assert here — the interesting assertion
    // is what happens immediately AFTER wrapping.
    const exchange = new Exchange(runtime, {})

    // Both pre-existing docs must now be visible to the Exchange's sync
    // graph — this is the registration the pre-fix code silently skipped.
    expect(exchange.documents.has("todo-1")).toBe(true)
    expect(exchange.documents.has("todo-2")).toBe(true)

    await exchange.shutdown()
  })
})

describe("Runtime.get and replicate-mode documents", () => {
  it("refuses rather than clobbering a replicate entry", () => {
    const runtime = new Runtime({ peerId: "alice" })
    const boundReplica = json.replica()
    runtime.replicate(
      "todo-1",
      boundReplica.factory,
      boundReplica.syncMode,
      TodoDoc.schemaHash,
    )

    expect(() => runtime.get("todo-1", TodoDoc)).toThrow(/replicate mode/)

    // The throw alone is not the point — a version that clobbered first and
    // threw afterwards would pass that assertion. What matters is that the
    // replicate entry, and the accumulated Replica it holds, survived.
    const entry = runtime.getEntry("todo-1")
    expect(entry?.mode).toBe("replicate")
    expect(entry?.mode === "replicate" && entry.readyInfo.replica).toBeDefined()

    runtime.shutdown()
  })

  it("throws when the same docId is requested with a different BoundSchema", () => {
    const runtime = new Runtime({ peerId: "alice" })
    const OtherDoc = json.bind(TodoSchema)

    runtime.get("todo-1", TodoDoc)
    expect(() => runtime.get("todo-1", OtherDoc)).toThrow(
      /different BoundSchema/,
    )

    runtime.shutdown()
  })

  it("still returns the identical ref for the same BoundSchema", () => {
    // Guards the check above against over-reaching: it must reject a
    // *different* bound object, not repeat calls with the same one.
    const runtime = new Runtime({ peerId: "alice" })
    expect(runtime.get("todo-1", TodoDoc)).toBe(runtime.get("todo-1", TodoDoc))
    runtime.shutdown()
  })

  it("ignores a state advance for a document it does not hold", async () => {
    // `onStateAdvanced` reports only which document changed, so one the
    // Runtime does not track has nothing to resolve and the call must be a
    // no-op rather than a throw.
    //
    // It should not arise: the Runtime's cache and the Synchronizer's document
    // set are populated together via `onDocReady` and torn down together via
    // `onDocDestroyed`. Pinned anyway, because "should not arise" stops being
    // true quietly, and because the alternative — persisting a document
    // nothing local owns — is worse than skipping it.
    const runtime = new Runtime({
      peerId: "alice",
      stores: [createInMemoryStore()],
    })

    expect(() => runtime.onStateAdvanced("never-seen")).not.toThrow()

    // A destroyed document is the same case reached a different way.
    runtime.get("todo-1", TodoDoc)
    await runtime.flush()
    runtime.destroy("todo-1")
    expect(() => runtime.onStateAdvanced("todo-1")).not.toThrow()

    await runtime.shutdown()
  })
})
