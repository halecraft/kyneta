// store.test.ts — Tier 1 pure store tests (no React, no jsdom).
//
// Tests createNullishStore / createSyncStore / createDerivedSyncStore
// independently of React. (createChangefeedStore was removed in jj:smkurmok;
// its CHANGEFEED→ExternalStore logic — a degenerate single-dependency reactive —
// is now generalized inside @kyneta/reactive; see that package's reactive.test.ts.)

import type { PeerIdentityDetails, SyncRef } from "@kyneta/exchange"
import { describe, expect, it, vi } from "vitest"
import {
  createDerivedSyncStore,
  createNullishStore,
  createSyncStore,
} from "../store.js"

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

// Stateful mock SyncRef: `_emit` mutates the surface (peerStates / ready /
// reconciled identities) and notifies subscribers, mirroring how the real
// SyncRef updates on a peer-sync change.
type MockSyncRef = SyncRef & {
  _emit: (next: {
    peerStates?: any[]
    ready?: boolean
    reconciled?: PeerIdentityDetails[]
  }) => void
}

function createMockSyncRef(): MockSyncRef {
  const listeners = new Set<(peerStates: any[]) => void>()
  let peerStates: any[] = []
  let ready = false
  let reconciled: PeerIdentityDetails[] = []

  return {
    peerId: "test-peer",
    docId: "test-doc",
    get peerStates() {
      return peerStates
    },
    get ready() {
      return ready
    },
    readyFor(pred: (p: PeerIdentityDetails) => boolean) {
      return reconciled.some(pred)
    },
    connectivity: "connecting",
    waitForSync: () => Promise.resolve(),
    settled: () => Promise.resolve({ via: "peer" as const }),
    onPeerSyncChange(cb: (peerStates: any[]) => void) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    _emit(next) {
      if (next.peerStates !== undefined) peerStates = next.peerStates
      if (next.ready !== undefined) ready = next.ready
      if (next.reconciled !== undefined) reconciled = next.reconciled
      for (const cb of listeners) cb(peerStates)
    },
  }
}

describe("createSyncStore", () => {
  it("returns initial peerStates", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)
    expect(store.getSnapshot()).toEqual([])
  })

  it("updates snapshot on peer-sync change", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)

    const onStoreChange = vi.fn()
    store.subscribe(onStoreChange)

    const newStates = [
      { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
    ]
    syncRef._emit({ peerStates: newStates })

    expect(onStoreChange).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot()).toBe(newStates)
  })

  it("unsubscribe stops updates", () => {
    const syncRef = createMockSyncRef()
    const store = createSyncStore(syncRef)

    const onStoreChange = vi.fn()
    const unsub = store.subscribe(onStoreChange)

    unsub()

    syncRef._emit({
      peerStates: [
        { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
      ],
    })

    expect(onStoreChange).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toEqual([]) // still initial
  })
})

describe("createDerivedSyncStore", () => {
  it("array select returns peerStates", () => {
    const syncRef = createMockSyncRef()
    const store = createDerivedSyncStore(syncRef, ref => ref.peerStates)
    store.subscribe(() => {})
    const states = [
      { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
    ]
    syncRef._emit({ peerStates: states })
    expect(store.getSnapshot()).toBe(states)
  })

  it("boolean (ready) select latches true and does NOT regress on a flip back to pending", () => {
    const syncRef = createMockSyncRef()
    const store = createDerivedSyncStore(syncRef, ref => ref.ready)
    store.subscribe(() => {})
    expect(store.getSnapshot()).toBe(false)

    // First reconciliation: ready latches true.
    syncRef._emit({
      ready: true,
      peerStates: [
        { docId: "test-doc", peer: { peerId: "peer-1" }, state: "synced" },
      ],
    })
    expect(store.getSnapshot()).toBe(true)

    // Reconnect re-handshake: the live per-peer state flips back to pending,
    // but `ready` stays latched (the mock keeps ready=true).
    syncRef._emit({
      peerStates: [
        { docId: "test-doc", peer: { peerId: "peer-1" }, state: "pending" },
      ],
    })
    expect(store.getSnapshot()).toBe(true)
  })

  it("predicate select matches latched identities", () => {
    const syncRef = createMockSyncRef()
    const store = createDerivedSyncStore(syncRef, ref =>
      ref.readyFor(p => p.type === "service"),
    )
    store.subscribe(() => {})
    expect(store.getSnapshot()).toBe(false)

    syncRef._emit({
      reconciled: [{ peerId: "server-1", type: "service" }],
    })
    expect(store.getSnapshot()).toBe(true)
  })
})
