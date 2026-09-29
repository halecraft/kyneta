// store.test.ts — Tier 1 pure store tests (no React, no jsdom).
//
// Tests createSyncStore independently of React.

import type { PeerIdentityDetails, SyncRef } from "@kyneta/exchange"
import { describe, expect, it, vi } from "vitest"
import { createSyncStore } from "../store.js"

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
