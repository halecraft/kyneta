// store.test.ts — Tier 1 pure store tests (no React, no jsdom).
//
// Tests createChangefeedStore and createSyncStore independently of React.
// Uses createDoc + change() from @kyneta/schema/basic — no renderHook,
// no jsdom, fast execution.

import type { SyncRef } from "@kyneta/exchange"
import { change, createDoc, Schema } from "@kyneta/schema/basic"
import { describe, expect, it, vi } from "vitest"
import {
  createChangefeedStore,
  createNullishStore,
  createSyncStore,
} from "../store.js"

// ---------------------------------------------------------------------------
// Test schema
// ---------------------------------------------------------------------------

const TestSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
    }),
  ),
})

// ---------------------------------------------------------------------------
// createChangefeedStore
// ---------------------------------------------------------------------------

describe("createChangefeedStore", () => {
  it("returns initial snapshot from a scalar ref", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)
    expect(store.getSnapshot()).toBe("")
  })

  it("returns initial snapshot from a composite ref", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)
    expect(store.getSnapshot()).toEqual({
      title: "",
      count: 0,
      items: [],
    })
  })

  it("updates snapshot when changefeed fires on a scalar", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    change(doc, d => {
      d.title.set("hello")
    })

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe("hello")
  })

  it("snapshot is referentially stable between getSnapshot calls", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    const snap1 = store.getSnapshot()
    const snap2 = store.getSnapshot()
    expect(snap1).toBe(snap2) // same reference
  })

  it("snapshot identity changes after a mutation", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    const before = store.getSnapshot()

    store.subscribe(() => {})
    change(doc, d => {
      d.title.set("changed")
    })

    const after = store.getSnapshot()
    expect(before).not.toBe(after)
    expect(after.title).toBe("changed")
  })

  it("deep subscription on composite ref fires on nested field change", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    change(doc, d => {
      d.title.set("nested change")
    })

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().title).toBe("nested change")
  })

  it("deep subscription fires on sequence push", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc)

    store.subscribe(() => {})

    change(doc, d => {
      d.items.push({ name: "first" })
    })

    expect(store.getSnapshot().items).toEqual([{ name: "first" }])
  })

  it("leaf subscription does not fire when a sibling field changes", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    // Mutate a sibling field — title's changefeed should NOT fire
    change(doc, d => {
      d.count.set(42)
    })

    expect(onStoreChange).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe("") // unchanged
  })

  it("unsubscribe stops snapshot updates", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onStoreChange = vi.fn()
    const unsub = store.subscribe(onStoreChange)

    change(doc, d => {
      d.title.set("first")
    })
    expect(store.getSnapshot()).toBe("first")

    unsub()

    change(doc, d => {
      d.title.set("second")
    })

    // After unsubscribe, the store's cached snapshot is stale
    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe("first")
  })

  it("works with sequence ref", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.items)

    store.subscribe(() => {})

    expect(store.getSnapshot()).toEqual([])

    change(doc, d => {
      d.items.push({ name: "a" })
    })

    change(doc, d => {
      d.items.push({ name: "b" })
    })

    const snapshot = store.getSnapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.map((i: any) => i.name)).toContain("a")
    expect(snapshot.map((i: any) => i.name)).toContain("b")
  })

  it("supports multiple independent subscribers", () => {
    const doc = createDoc(TestSchema)
    const store = createChangefeedStore(doc.title)

    const onA = vi.fn()
    const onB = vi.fn()
    const unsubA = store.subscribe(onA)
    const unsubB = store.subscribe(onB)

    change(doc, d => {
      d.title.set("both")
    })

    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe("both")

    // Unsubscribe A — B should still fire independently
    unsubA()

    change(doc, d => {
      d.title.set("only-b")
    })

    expect(onA).toHaveBeenCalledTimes(1) // no new call
    expect(onB).toHaveBeenCalledTimes(2)
    expect(store.getSnapshot()).toBe("only-b")

    unsubB()
  })
})

// ---------------------------------------------------------------------------
// createNullishStore
// ---------------------------------------------------------------------------

describe("createNullishStore", () => {
  it("returns the nullish value and subscribe is a safe no-op", () => {
    const nullStore = createNullishStore(null)
    expect(nullStore.getSnapshot()).toBe(null)

    const undefStore = createNullishStore(undefined)
    expect(undefStore.getSnapshot()).toBe(undefined)

    // subscribe returns a callable unsubscribe, never throws
    nullStore.subscribe(() => {})()
  })
})

// ---------------------------------------------------------------------------
// createSyncStore
// ---------------------------------------------------------------------------

describe("createSyncStore", () => {
  function createMockSyncRef(): SyncRef & {
    _fire: (states: any[]) => void
  } {
    const listeners = new Set<(readyStates: any[]) => void>()
    return {
      peerId: "test-peer",
      docId: "test-doc",
      readyStates: [],
      waitForSync: () => Promise.resolve(),
      onReadyStateChange(cb: (readyStates: any[]) => void) {
        listeners.add(cb)
        return () => {
          listeners.delete(cb)
        }
      },
      _fire(states: any[]) {
        for (const cb of listeners) {
          cb(states)
        }
      },
    }
  }

  it("returns initial readyStates", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)
    expect(store.getSnapshot()).toEqual([])
  })

  it("updates snapshot on ready state change", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    const newStates = [{ peerId: "peer-1", state: "ready" }]
    syncRef._fire(newStates)

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe(newStates)
  })

  it("unsubscribe stops updates", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)

    const onStoreChange = vi.fn()
    const unsub = store.subscribe(onStoreChange)

    unsub()

    syncRef._fire([{ peerId: "peer-1", state: "ready" }])

    expect(onStoreChange).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toEqual([]) // still initial
  })
})
