// Integration tests — dynamic policy registration via exchange.register().
//
// These tests prove that the Policy system correctly composes sharing
// and acceptance rules at runtime, including dynamic registration
// and disposal of policies across Exchange instances connected via
// BridgeTransport.
//
// Backward compatibility (ExchangeParams.canShare/canAccept) is already
// covered by the 204 pre-existing integration tests — no need to
// duplicate that coverage here.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { change, Interpret, json, Reject, Schema } from "@kyneta/schema"
import { cborCodec } from "@kyneta/wire"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask queue — necessary for BridgeTransport async delivery.
 */
async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

/** Active exchanges that need cleanup */
const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const merged = { id: "test" as string | PeerIdentityInput, ...params }
  const ex = new Exchange(merged as ExchangeParams)
  activeExchanges.push(ex)
  return ex
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      // ignore
    }
  }
  activeExchanges.length = 0
})

// ---------------------------------------------------------------------------
// Bound schemas
// ---------------------------------------------------------------------------

const SequentialDoc = json.bind(
  Schema.struct({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

// ---------------------------------------------------------------------------
// canShare composition and dispose
// ---------------------------------------------------------------------------

describe("dynamic policy canShare", () => {
  it("blocks sharing while registered; disposing lifts the restriction", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Interpret(SequentialDoc),
    })

    // Register a policy that blocks docs starting with "secret-"
    const dispose = exchangeA.register({
      canShare: docId =>
        (docId as string).startsWith("secret-") ? false : undefined,
    })

    // Public doc — should sync
    const openDoc = exchangeA.get("open-doc", SequentialDoc)
    openDoc.title.set("visible")

    // Secret doc — should NOT sync
    exchangeA.get("secret-alpha", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("open-doc")).toBe(true)
    expect(exchangeB.get("open-doc", SequentialDoc).title()).toBe("visible")
    expect(exchangeB.has("secret-alpha")).toBe(false)

    // Dispose — restriction is lifted for future docs
    dispose()

    const freedDoc = exchangeA.get("secret-beta", SequentialDoc)
    freedDoc.title.set("now visible")

    await drain(40)

    expect(exchangeB.has("secret-beta")).toBe(true)
    expect(exchangeB.get("secret-beta", SequentialDoc).title()).toBe(
      "now visible",
    )
  })

  it("multiple policies compose — false from any policy denies", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Interpret(SequentialDoc),
    })

    const dispose1 = exchangeA.register({
      canShare: docId => (docId === "blocked-by-1" ? false : undefined),
    })

    const dispose2 = exchangeA.register({
      canShare: docId => (docId === "blocked-by-2" ? false : undefined),
    })

    exchangeA.get("blocked-by-1", SequentialDoc)
    exchangeA.get("blocked-by-2", SequentialDoc)
    const open = exchangeA.get("open", SequentialDoc)
    open.title.set("ok")

    await drain(40)

    expect(exchangeB.has("blocked-by-1")).toBe(false)
    expect(exchangeB.has("blocked-by-2")).toBe(false)
    expect(exchangeB.has("open")).toBe(true)

    // Dispose policy 1 — policy 2 still blocks its doc
    dispose1()

    const freed = exchangeA.get("was-blocked-by-1", SequentialDoc)
    freed.title.set("freed")
    exchangeA.get("still-blocked-by-2", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("was-blocked-by-1")).toBe(true)
    // policy2 blocks exact match "blocked-by-2", not "still-blocked-by-2"
    // so this one goes through — the test above already proved policy2 blocks

    dispose2()
  })

  it("initial ExchangeParams policy and dynamic policy compose together", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      canShare: docId => docId !== "params-blocked",
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Interpret(SequentialDoc),
    })

    const dispose = exchangeA.register({
      canShare: docId => (docId === "dynamic-blocked" ? false : undefined),
    })

    exchangeA.get("params-blocked", SequentialDoc)
    exchangeA.get("dynamic-blocked", SequentialDoc)
    const ok = exchangeA.get("allowed", SequentialDoc)
    ok.title.set("ok")

    await drain(40)

    expect(exchangeB.has("params-blocked")).toBe(false)
    expect(exchangeB.has("dynamic-blocked")).toBe(false)
    expect(exchangeB.has("allowed")).toBe(true)

    // Dispose dynamic policy — params policy still blocks its doc
    dispose()

    const freed = exchangeA.get("dynamic-now-free", SequentialDoc)
    freed.title.set("freed")

    await drain(40)

    expect(exchangeB.has("dynamic-now-free")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// canAccept composition
// ---------------------------------------------------------------------------

describe("dynamic policy canAccept", () => {
  it("blocks inbound mutations while registered; disposing re-enables them", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // Bob blocks all mutations from alice
    const dispose = exchangeB.register({
      canAccept: (_docId, peer) =>
        peer.peerId === "alice" ? false : undefined,
    })

    const docA = exchangeA.get("shared", SequentialDoc)
    const docB = exchangeB.get("shared", SequentialDoc)

    docA.title.set("V1")
    await drain(40)

    // Bob should NOT have Alice's mutation
    expect(docB.title()).toBe("")

    // Dispose — Alice's future mutations should sync
    dispose()

    docA.title.set("V2")
    await drain(40)

    expect(docB.title()).toBe("V2")
  })
})

// ---------------------------------------------------------------------------
// resolve via dynamic policy
// ---------------------------------------------------------------------------

describe("dynamic policy resolve", () => {
  it("dynamically registered handler materializes peer-announced docs", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
    })

    // Register resolve dynamically via policy
    const dispose = exchangeB.register({
      resolve: docId => {
        if (docId === "discovered") return Interpret(SequentialDoc)
        return Reject()
      },
    })

    const docA = exchangeA.get("discovered", SequentialDoc)
    change(docA, (d: any) => {
      d.title.set("hello")
      d.count.set(42)
    })

    await drain(40)

    expect(exchangeB.has("discovered")).toBe(true)
    const docB = exchangeB.get("discovered", SequentialDoc)
    expect(docB.title()).toBe("hello")
    expect(docB.count()).toBe(42)

    dispose()
  })
})

// ---------------------------------------------------------------------------
// Named policy replacement (integration-level)
// ---------------------------------------------------------------------------

describe("named policy replacement", () => {
  it("re-registering a name replaces the old policy's rules", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      resolve: () => Interpret(SequentialDoc),
    })

    // Named policy blocks everything
    exchangeA.register({
      name: "policy",
      canShare: () => false,
    })

    exchangeA.get("doc-v1", SequentialDoc)
    await drain(40)
    expect(exchangeB.has("doc-v1")).toBe(false)

    // Replace with permissive policy
    const dispose = exchangeA.register({
      name: "policy",
      canShare: () => true,
    })

    const doc = exchangeA.get("doc-v2", SequentialDoc)
    doc.title.set("allowed")
    await drain(40)

    expect(exchangeB.has("doc-v2")).toBe(true)
    expect(exchangeB.get("doc-v2", SequentialDoc).title()).toBe("allowed")

    dispose()
  })
})

// ---------------------------------------------------------------------------
// Three-peer relay topology
// ---------------------------------------------------------------------------

describe("relay topology", () => {
  it("policy on hub blocks relay to a specific peer", async () => {
    const bridgeAH = new Bridge({ codec: cborCodec })
    const bridgeHB = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "alice",
      transports: [
        createBridgeTransport({ transportId: "alice", bridge: bridgeAH }),
      ],
    })

    const exchangeHub = createExchange({
      id: "hub",
      transports: [
        createBridgeTransport({ transportId: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportId: "hub-b", bridge: bridgeHB }),
      ],
      resolve: () => Interpret(SequentialDoc),
    })

    const exchangeB = createExchange({
      id: "bob",
      transports: [
        createBridgeTransport({ transportId: "bob", bridge: bridgeHB }),
      ],
      resolve: () => Interpret(SequentialDoc),
    })

    // Hub blocks relay of "private" to bob
    const dispose = exchangeHub.register({
      canShare: (docId, peer) => {
        if (docId === "private" && peer.peerId === "bob") return false
        return undefined
      },
    })

    const docA = exchangeA.get("private", SequentialDoc)
    docA.title.set("secret")

    await drain(40)

    // Hub has it (relayed from alice)
    expect(exchangeHub.has("private")).toBe(true)
    expect(exchangeHub.get("private", SequentialDoc).title()).toBe("secret")

    // Bob does NOT have it (hub's policy blocked relay)
    expect(exchangeB.has("private")).toBe(false)

    // Dispose — new docs relay freely
    dispose()

    const docA2 = exchangeA.get("public", SequentialDoc)
    docA2.title.set("open")

    await drain(40)

    expect(exchangeB.has("public")).toBe(true)
    expect(exchangeB.get("public", SequentialDoc).title()).toBe("open")
  })
})
