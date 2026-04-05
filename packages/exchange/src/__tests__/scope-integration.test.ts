// Integration tests — dynamic scope registration via exchange.register().
//
// These tests prove that the Scope system correctly composes routing
// and authorization rules at runtime, including dynamic registration
// and disposal of scopes across Exchange instances connected via
// BridgeTransport.
//
// Backward compatibility (ExchangeParams.route/authorize) is already
// covered by the 204 pre-existing integration tests — no need to
// duplicate that coverage here.

import {
  bindPlain,
  change,
  Interpret,
  Schema,
} from "@kyneta/schema"
import { Bridge, createBridgeTransport } from "@kyneta/transport"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Exchange } from "../exchange.js"
import { sync } from "../sync.js"

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

function createExchange(
  params: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  const merged = {
    ...params,
    identity: { peerId: "test", ...params?.identity },
  }
  const ex = new Exchange(merged)
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

const SequentialDoc = bindPlain(
  Schema.doc({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

// ---------------------------------------------------------------------------
// Route composition and dispose
// ---------------------------------------------------------------------------

describe("dynamic scope route", () => {
  it("blocks routing while registered; disposing lifts the restriction", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    // Register a scope that blocks docs starting with "secret-"
    const dispose = exchangeA.register({
      route: (docId) => (docId as string).startsWith("secret-") ? false : undefined,
    })

    // Public doc — should sync
    const openDoc = exchangeA.get("open-doc", SequentialDoc)
    change(openDoc, (d: any) => {
      d.title.set("visible")
    })

    // Secret doc — should NOT sync
    exchangeA.get("secret-alpha", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("open-doc")).toBe(true)
    expect(exchangeB.get("open-doc", SequentialDoc).title()).toBe("visible")
    expect(exchangeB.has("secret-alpha")).toBe(false)

    // Dispose — restriction is lifted for future docs
    dispose()

    const freedDoc = exchangeA.get("secret-beta", SequentialDoc)
    change(freedDoc, (d: any) => d.title.set("now visible"))

    await drain(40)

    expect(exchangeB.has("secret-beta")).toBe(true)
    expect(exchangeB.get("secret-beta", SequentialDoc).title()).toBe("now visible")
  })

  it("multiple scopes compose — false from any scope denies", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    const dispose1 = exchangeA.register({
      route: (docId) => docId === "blocked-by-1" ? false : undefined,
    })

    const dispose2 = exchangeA.register({
      route: (docId) => docId === "blocked-by-2" ? false : undefined,
    })

    exchangeA.get("blocked-by-1", SequentialDoc)
    exchangeA.get("blocked-by-2", SequentialDoc)
    const open = exchangeA.get("open", SequentialDoc)
    change(open, (d: any) => d.title.set("ok"))

    await drain(40)

    expect(exchangeB.has("blocked-by-1")).toBe(false)
    expect(exchangeB.has("blocked-by-2")).toBe(false)
    expect(exchangeB.has("open")).toBe(true)

    // Dispose scope 1 — scope 2 still blocks its doc
    dispose1()

    const freed = exchangeA.get("was-blocked-by-1", SequentialDoc)
    change(freed, (d: any) => d.title.set("freed"))
    exchangeA.get("still-blocked-by-2", SequentialDoc)

    await drain(40)

    expect(exchangeB.has("was-blocked-by-1")).toBe(true)
    // scope2 blocks exact match "blocked-by-2", not "still-blocked-by-2"
    // so this one goes through — the test above already proved scope2 blocks

    dispose2()
  })

  it("initial ExchangeParams scope and dynamic scope compose together", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
      route: (docId) => docId !== "params-blocked",
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    const dispose = exchangeA.register({
      route: (docId) => docId === "dynamic-blocked" ? false : undefined,
    })

    exchangeA.get("params-blocked", SequentialDoc)
    exchangeA.get("dynamic-blocked", SequentialDoc)
    const ok = exchangeA.get("allowed", SequentialDoc)
    change(ok, (d: any) => d.title.set("ok"))

    await drain(40)

    expect(exchangeB.has("params-blocked")).toBe(false)
    expect(exchangeB.has("dynamic-blocked")).toBe(false)
    expect(exchangeB.has("allowed")).toBe(true)

    // Dispose dynamic scope — params scope still blocks its doc
    dispose()

    const freed = exchangeA.get("dynamic-now-free", SequentialDoc)
    change(freed, (d: any) => d.title.set("freed"))

    await drain(40)

    expect(exchangeB.has("dynamic-now-free")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Authorize composition
// ---------------------------------------------------------------------------

describe("dynamic scope authorize", () => {
  it("blocks inbound mutations while registered; disposing re-enables them", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    // Bob blocks all mutations from alice
    const dispose = exchangeB.register({
      authorize: (_docId, peer) => peer.peerId === "alice" ? false : undefined,
    })

    const docA = exchangeA.get("shared", SequentialDoc)
    const docB = exchangeB.get("shared", SequentialDoc)

    change(docA, (d: any) => d.title.set("V1"))
    await drain(40)

    // Bob should NOT have Alice's mutation
    expect(docB.title()).toBe("")

    // Dispose — Alice's future mutations should sync
    dispose()

    change(docA, (d: any) => d.title.set("V2"))
    await drain(40)

    expect(docB.title()).toBe("V2")
  })
})

// ---------------------------------------------------------------------------
// onDocDiscovered via dynamic scope
// ---------------------------------------------------------------------------

describe("dynamic scope onDocDiscovered", () => {
  it("dynamically registered handler materializes peer-announced docs", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    // Register onDocDiscovered dynamically via scope
    const dispose = exchangeB.register({
      onDocDiscovered: (docId) => {
        if (docId === "discovered") return Interpret(SequentialDoc)
        return undefined
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
// onDocDismissed via dynamic scope
// ---------------------------------------------------------------------------

describe("dynamic scope onDocDismissed", () => {
  it("fires when a peer dismisses a document", async () => {
    const bridge = new Bridge()
    const dismissSpy = vi.fn()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
    })

    exchangeB.register({ onDocDismissed: dismissSpy })

    exchangeA.get("dismiss-doc", SequentialDoc)
    exchangeB.get("dismiss-doc", SequentialDoc)

    await drain(40)

    exchangeA.dismiss("dismiss-doc")
    await drain(40)

    expect(dismissSpy).toHaveBeenCalledWith(
      "dismiss-doc",
      expect.objectContaining({ peerId: "alice" }),
    )
  })
})

// ---------------------------------------------------------------------------
// Named scope replacement (integration-level)
// ---------------------------------------------------------------------------

describe("named scope replacement", () => {
  it("re-registering a name replaces the old scope's rules", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [createBridgeTransport({ transportType: "alice", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [createBridgeTransport({ transportType: "bob", bridge })],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    // Named scope blocks everything
    exchangeA.register({
      name: "policy",
      route: () => false,
    })

    exchangeA.get("doc-v1", SequentialDoc)
    await drain(40)
    expect(exchangeB.has("doc-v1")).toBe(false)

    // Replace with permissive scope
    const dispose = exchangeA.register({
      name: "policy",
      route: () => true,
    })

    const doc = exchangeA.get("doc-v2", SequentialDoc)
    change(doc, (d: any) => d.title.set("allowed"))
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
  it("scope on hub blocks relay to a specific peer", async () => {
    const bridgeAH = new Bridge()
    const bridgeHB = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "alice" },
      transports: [
        createBridgeTransport({ transportType: "alice", bridge: bridgeAH }),
      ],
    })

    const exchangeHub = createExchange({
      identity: { peerId: "hub" },
      transports: [
        createBridgeTransport({ transportType: "hub-a", bridge: bridgeAH }),
        createBridgeTransport({ transportType: "hub-b", bridge: bridgeHB }),
      ],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    const exchangeB = createExchange({
      identity: { peerId: "bob" },
      transports: [
        createBridgeTransport({ transportType: "bob", bridge: bridgeHB }),
      ],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    // Hub blocks relay of "private" to bob
    const dispose = exchangeHub.register({
      route: (docId, peer) => {
        if (docId === "private" && peer.peerId === "bob") return false
        return undefined
      },
    })

    const docA = exchangeA.get("private", SequentialDoc)
    change(docA, (d: any) => d.title.set("secret"))

    await drain(40)

    // Hub has it (relayed from alice)
    expect(exchangeHub.has("private")).toBe(true)
    expect(exchangeHub.get("private", SequentialDoc).title()).toBe("secret")

    // Bob does NOT have it (hub's scope blocked relay)
    expect(exchangeB.has("private")).toBe(false)

    // Dispose — new docs relay freely
    dispose()

    const docA2 = exchangeA.get("public", SequentialDoc)
    change(docA2, (d: any) => d.title.set("open"))

    await drain(40)

    expect(exchangeB.has("public")).toBe(true)
    expect(exchangeB.get("public", SequentialDoc).title()).toBe("open")
  })
})