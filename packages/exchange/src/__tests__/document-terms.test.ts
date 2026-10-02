// document-terms — what a closed document's terms say, and how a term the
// Exchange attaches later is followed. Closing never invents an answer: each
// term keeps the one it had, and a pending one fails with the close error.

import { CHANGEFEED, settableFeed } from "@kyneta/changefeed"
import {
  batch,
  createRef,
  createSubstrate,
  DocumentClosedError,
  plainSubstrateFactory,
  Schema,
  SYNC_AUTHORITATIVE,
  WriteRefusal,
} from "@kyneta/schema"
import type { PeerIdentityDetails } from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import {
  buildLocalTerms,
  closedHydration,
  closedTerms,
  closeTerms,
  type DocumentTerms,
  type Hydration,
  type NetworkTerms,
  networkTermFeed,
  type Peer,
  type Persistence,
  registerNetworkTerms,
  registerTerms,
  type Sync,
  type TermsSnapshot,
  termsOf,
} from "../document-terms.js"
import type { Authority } from "../governance.js"

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

describe("closedHydration", () => {
  it("fails a pending load with the close error, and keeps an answer given", () => {
    const failure: Hydration = { status: "failed", error: "disk on fire" }
    expect(closedHydration({ status: "pending" }, error)).toEqual({
      status: "failed",
      error,
    })
    expect(closedHydration(loaded, error)).toBe(loaded)
    expect(closedHydration(failure, error)).toBe(failure)
  })

  it("is what closedTerms closes hydration with", () => {
    const failure: Hydration = { status: "failed", error: "disk on fire" }
    const closed = closedTerms(
      { hydration: failure, persistence: confirmed },
      error,
    )
    expect(closed.local.hydration).toBe(closedHydration(failure, error))
  })
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

describe("closedTerms: the network refusal", () => {
  it("closes to none: the closed substrate refuses first", () => {
    const closed = closedTerms(
      { hydration: loaded, persistence: confirmed, network: network() },
      error,
    )
    expect(closed.network?.refusal).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Following a network term from before it is attached
// ---------------------------------------------------------------------------

const refused = new WriteRefusal("not a writer")

function localTerms(): DocumentTerms {
  return buildLocalTerms({
    syncMode: SYNC_AUTHORITATIVE,
    hydration: settableFeed<Hydration>(loaded),
    persistence: settableFeed<Persistence>(confirmed),
  })
}

function networkTerms(): NetworkTerms {
  return {
    peer: settableFeed<Peer>({ settled: true, resolve: () => true }),
    authority: settableFeed<Authority>("any"),
    sync: settableFeed<Sync>({
      ref: {
        peerId: "me",
        docId: "doc",
        peerStates: [],
        ready: true,
        readyFor: () => false,
        connectivity: "offline",
        onPeerSyncChange: () => () => {},
      },
      source: {
        connectivity: () => "offline",
        reconciled: () => [],
        awaitReconciliation: async () => "ready",
      },
    }),
    refusal: settableFeed<WriteRefusal | undefined>(undefined),
  }
}

describe("networkTermFeed", () => {
  it("answers absent before the network terms attach, then follows the picked term", () => {
    const terms = localTerms()
    const feed = networkTermFeed(terms, n => n.refusal, undefined)
    let heard = 0
    const stop = feed[CHANGEFEED].subscribe(() => heard++)
    expect(feed()).toBeUndefined()

    const network = networkTerms()
    terms.network.set(network)
    expect(heard).toBe(1)
    expect(feed()).toBeUndefined()

    network.refusal.set(refused)
    expect(heard).toBe(2)
    expect(feed()).toBe(refused)

    stop()
    network.refusal.set(undefined)
    expect(heard).toBe(2)
  })

  it("follows the new network terms when they are replaced, and lets go of the old", () => {
    const terms = localTerms()
    const first = networkTerms()
    terms.network.set(first)
    const feed = networkTermFeed(terms, n => n.refusal, undefined)
    let heard = 0
    feed[CHANGEFEED].subscribe(() => heard++)

    const second = networkTerms()
    terms.network.set(second)
    expect(heard).toBe(1)
    first.refusal.set(refused)
    expect(heard).toBe(1)
    second.refusal.set(refused)
    expect(heard).toBe(2)
    expect(feed()).toBe(refused)
  })
})

describe("a terms record built before its ref", () => {
  const schema = Schema.struct({ title: Schema.string() })

  it("is the record termsOf finds once registered, and its network refusal reaches the owner feed composed before", () => {
    const terms = localTerms()
    const doc = createRef(
      schema,
      createSubstrate(plainSubstrateFactory, schema),
      { refusal: networkTermFeed(terms, n => n.refusal, undefined) },
    )
    registerTerms(doc, terms)
    expect(termsOf(doc)).toBe(terms)
    expect(termsOf(doc.title)).toBe(terms)

    batch(doc, d => d.title.set("before"))
    const network = networkTerms()
    registerNetworkTerms(doc, network)
    network.refusal.set(refused)
    expect(() => batch(doc, d => d.title.set("after"))).toThrow(refused)
    expect(doc.title()).toBe("before")

    // Closing sets the refusal to none, letting go of what it followed.
    closeTerms(terms, error, loaded)
    expect(network.refusal()).toBeUndefined()
  })
})
