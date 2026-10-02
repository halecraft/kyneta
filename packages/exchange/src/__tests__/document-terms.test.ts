// document-terms — what a closed document's terms say. Closing never invents
// an answer: each term keeps the one it had, and a pending one fails with the
// close error.

import { DocumentClosedError } from "@kyneta/schema"
import type { PeerIdentityDetails } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import {
  closedTerms,
  type Hydration,
  type Persistence,
  type TermsSnapshot,
} from "../document-terms.js"

const error = new DocumentClosedError("destroyed")
const loaded: Hydration = { status: "loaded" }
const confirmed: Persistence = { persisted: true }

const server: PeerIdentityDetails = {
  peerId: "server",
  principal: "server",
  type: "service",
}

function network(
  over: Partial<NonNullable<TermsSnapshot["network"]>> = {},
): NonNullable<TermsSnapshot["network"]> {
  return {
    peerId: "me",
    docId: "doc",
    authority: "any",
    connectivity: "online",
    peerStates: [],
    reconciled: [],
    ...over,
  }
}

describe("closedTerms: hydration", () => {
  const cases: readonly [string, Hydration, Hydration][] = [
    [
      "pending fails with the close error",
      { status: "pending" },
      { status: "failed", error },
    ],
    ["loaded stays loaded", loaded, loaded],
    [
      "failed keeps its own error",
      { status: "failed", error: "disk on fire" },
      { status: "failed", error: "disk on fire" },
    ],
  ]
  for (const [name, hydration, expected] of cases) {
    it(name, () => {
      const closed = closedTerms({ hydration, persistence: confirmed }, error)
      expect(closed.local.hydration).toEqual(expected)
    })
  }
})

describe("closedTerms: persistence", () => {
  const cases: readonly [string, Persistence, Persistence][] = [
    ["confirmed stays confirmed", confirmed, confirmed],
    [
      "confirmed keeps a failed write's error",
      { persisted: true, error: "flaky" },
      { persisted: true, error: "flaky" },
    ],
    [
      "unconfirmed fails with the close error",
      { persisted: false },
      { persisted: false, error },
    ],
    [
      "unconfirmed with a failed write fails with the close error",
      { persisted: false, error: "flaky" },
      { persisted: false, error },
    ],
  ]
  for (const [name, persistence, expected] of cases) {
    it(name, () => {
      const closed = closedTerms({ hydration: loaded, persistence }, error)
      expect(closed.local.persistence).toEqual(expected)
    })
  }
})

describe("closedTerms: peers", () => {
  it("a document with no network part closes its local terms alone", () => {
    const closed = closedTerms(
      { hydration: loaded, persistence: confirmed },
      error,
    )
    expect(closed.network).toBeUndefined()
  })

  it("a peer that had answered stays settled, and the sync source resolves", async () => {
    const closed = closedTerms(
      {
        hydration: loaded,
        persistence: confirmed,
        network: network({ reconciled: [server] }),
      },
      error,
    )
    const peer = closed.network?.peer
    expect(peer?.settled).toBe(true)
    expect(peer?.resolve(p => p.peerId === "server")).toBe(true)
    expect(peer?.resolve(p => p.peerId === "other")).toBe(false)
    const sync = closed.network?.sync
    expect(sync?.ref.ready).toBe(true)
    expect(sync?.ref.readyFor(p => p.peerId === "server")).toBe(true)
    await expect(
      sync?.source.awaitReconciliation(
        () => true,
        0,
        new AbortController().signal,
      ),
    ).resolves.toBe("ready")
  })

  it("a peer that had not answered stays unsettled, and the sync source rejects with the close error", async () => {
    const closed = closedTerms(
      { hydration: loaded, persistence: confirmed, network: network() },
      error,
    )
    expect(closed.network?.peer.settled).toBe(false)
    expect(closed.network?.sync.ref.ready).toBe(false)
    await expect(
      closed.network?.sync.source.awaitReconciliation(
        () => false,
        0,
        new AbortController().signal,
      ),
    ).rejects.toBe(error)
  })

  it("the authority, connectivity and peer states are kept as they were", () => {
    const peerStates = [
      { docId: "doc", peer: server, state: "synced" as const },
    ]
    const closed = closedTerms(
      {
        hydration: loaded,
        persistence: confirmed,
        network: network({
          authority: "self",
          connectivity: "offline",
          peerStates,
        }),
      },
      error,
    )
    expect(closed.network?.authority).toBe("self")
    expect(closed.network?.peer.settled).toBe(true)
    expect(closed.network?.sync.ref.connectivity).toBe("offline")
    expect(closed.network?.sync.source.connectivity()).toBe("offline")
    expect(closed.network?.sync.ref.peerStates).toEqual(peerStates)
  })
})

describe("closedTerms: syncMode", () => {
  it("is not a term, so closing leaves it as it was", () => {
    const closed = closedTerms(
      { hydration: loaded, persistence: confirmed },
      error,
    )
    expect(Object.keys(closed.local).sort()).toEqual([
      "hydration",
      "persistence",
    ])
  })
})
