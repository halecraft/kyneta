// Cohort governance predicate — compaction-safe replication.
//
// Why authoritative (PlainSubstrate) documents, not CRDTs?
// Compacted CRDT entireties lack the causal history needed for safe merge.
// A peer receiving a compacted entirety cannot distinguish "new epoch" from
// "late-arriving ops," so merge produces silent op loss or corruption.
// Authoritative documents give clean, deterministic epoch-reset behavior:
// the entirety replaces the local state unconditionally.
//
// Why sequential writes with drain between?
// Authoritative sync is unidirectional — the originator pushes but never
// receives an offer back. The server therefore sees a receiver as "pending,"
// not "synced," until the receiver also writes (sending an offer the server
// can import). Sequential writes (server → drain → client → drain) ensure
// the transport handshake completes before offers flow, so "synced" status
// is reached deterministically rather than racing.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { change, json, Schema } from "@kyneta/schema"
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

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

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
// Bound schema
// ---------------------------------------------------------------------------

const TestDoc = json.bind(
  Schema.struct({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

// ---------------------------------------------------------------------------
// Cohort integration tests
// ---------------------------------------------------------------------------

describe("cohort governance predicate", () => {
  it("compact preserves delta sync when no cohort policy is set", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })

    const client = createExchange({
      id: "client",
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })

    const docServer = server.get("doc-1", TestDoc)
    const docClient = client.get("doc-1", TestDoc)

    change(docServer, (d: any) => {
      d.title.set("V1")
      d.count.set(1)
    })
    await drain(40)

    expect(docClient.title()).toBe("V1")

    // Client must write so the server sees it as "synced" (see header).
    change(docClient, (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    await server.compact("doc-1")

    change(docServer, (d: any) => {
      d.title.set("V2")
      d.count.set(2)
    })
    await drain(40)

    expect(docClient.title()).toBe("V2")
    expect(docClient.count()).toBe(2)
  })

  it("LCV excludes non-cohort peers; compact preserves cohort member", async () => {
    const bridgeSR = new Bridge({ codec: cborCodec })
    const bridgeSB = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "server-r", bridge: bridgeSR }),
        createBridgeTransport({ transportId: "server-b", bridge: bridgeSB }),
      ],
      cohort: (_docId, peer) => (peer.type === "service" ? true : false),
    })

    const relay = createExchange({
      id: { peerId: "relay", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "relay", bridge: bridgeSR }),
      ],
    })

    const browser = createExchange({
      id: { peerId: "browser", type: "user" },
      transports: [
        createBridgeTransport({ transportId: "browser", bridge: bridgeSB }),
      ],
    })

    const docServer = server.get("shared", TestDoc)
    const docRelay = relay.get("shared", TestDoc)
    browser.get("shared", TestDoc)

    change(docServer, (d: any) => {
      d.title.set("V1")
      d.count.set(1)
    })
    await drain(40)

    // Relay and browser both write to reach "synced" from server's POV.
    change(docRelay, (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    change(browser.get("shared", TestDoc), (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    expect(docRelay.title()).toBe("V1")

    // LCV is non-null: relay (cohort) is synced.
    // Browser is synced too but excluded by the policy.
    const lcv = server.leastCommonVersion("shared")
    expect(lcv).not.toBeNull()

    await server.compact("shared")

    change(docServer, (d: any) => {
      d.title.set("V2")
      d.count.set(2)
    })
    await drain(40)

    // Relay (cohort member) receives the update via delta, not epoch reset.
    expect(docRelay.title()).toBe("V2")
    expect(docRelay.count()).toBe(2)
  })

  it("non-cohort writer loses writes on epoch reset", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      cohort: (_docId, peer) => (peer.type === "service" ? true : false),
    })

    const client = createExchange({
      id: { peerId: "client", type: "user" },
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })

    const docServer = server.get("doc-1", TestDoc)
    const docClient = client.get("doc-1", TestDoc)

    change(docServer, (d: any) => {
      d.title.set("server-V1")
      d.count.set(1)
    })
    await drain(40)

    // Client writes to reach "synced" from server's perspective.
    change(docClient, (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    expect(docClient.title()).toBe("server-V1")

    // This local write will be lost — the client is outside the cohort.
    change(docClient, (d: any) => {
      d.title.set("client-local-write")
      d.count.set(999)
    })
    expect(docClient.title()).toBe("client-local-write")

    change(docServer, (d: any) => {
      d.title.set("server-V2")
      d.count.set(2)
    })
    await drain(40)

    // Compact ignores the client's version (not in cohort), so it
    // advances past the client's confirmed state. The next offer
    // triggers exportEntirety (epoch reset), replacing the client's
    // local state unconditionally.
    await server.compact("doc-1")

    change(docServer, (d: any) => {
      d.title.set("server-V3")
      d.count.set(3)
    })
    await drain(40)

    expect(docClient.title()).toBe("server-V3")
    expect(docClient.count()).toBe(3)
  })

  it("cohort member's writes survive compaction", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      cohort: () => true,
    })

    const client = createExchange({
      id: { peerId: "client", type: "user" },
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })

    const docServer = server.get("doc-1", TestDoc)
    const docClient = client.get("doc-1", TestDoc)

    change(docServer, (d: any) => {
      d.title.set("server-V1")
      d.count.set(1)
    })
    await drain(40)

    // Client writes to reach "synced" from server's perspective.
    change(docClient, (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    expect(docClient.title()).toBe("server-V1")

    change(docClient, (d: any) => {
      d.title.set("client-write")
      d.count.set(42)
    })

    // LCV is bounded by the client's confirmed version (client is in
    // cohort), so compact cannot advance past it.
    await server.compact("doc-1")

    await drain(40)

    const clientTitle = docClient.title()
    const serverTitle = docServer.title()

    expect(clientTitle).toBe(serverTitle)
    expect(clientTitle).toBe("client-write")
  })

  it("cohort policy that discriminates by docId", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    // Only the "durable" doc has cohort protection; "ephemeral" does not.
    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      cohort: (docId, _peer) => (docId === "durable" ? true : false),
    })

    const client = createExchange({
      id: { peerId: "client", type: "service" },
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })

    const durableServer = server.get("durable", TestDoc)
    const ephemeralServer = server.get("ephemeral", TestDoc)
    client.get("durable", TestDoc)
    client.get("ephemeral", TestDoc)

    change(durableServer, (d: any) => {
      d.title.set("A")
      d.count.set(1)
    })
    change(ephemeralServer, (d: any) => {
      d.title.set("B")
      d.count.set(2)
    })
    await drain(40)

    // Client writes to both docs to reach "synced" from server's POV.
    change(client.get("durable", TestDoc), (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    change(client.get("ephemeral", TestDoc), (d: any) => {
      d.count.set(0)
    })
    await drain(40)

    // "durable" includes the client in its cohort → LCV is non-null.
    // "ephemeral" excludes all peers → LCV is null.
    // This verifies the (docId, peer) argument order is wired correctly
    // through peerFilter(peer, docId) → governance.cohort(docId, peer).
    expect(server.leastCommonVersion("durable")).not.toBeNull()
    expect(server.leastCommonVersion("ephemeral")).toBeNull()
  })

  it("empty cohort triggers full projection on compact", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      cohort: () => false,
    })

    const client = createExchange({
      id: { peerId: "client", type: "user" },
      transports: [createBridgeTransport({ transportId: "client", bridge })],
    })

    const docServer = server.get("doc-1", TestDoc)
    client.get("doc-1", TestDoc)

    change(docServer, (d: any) => {
      d.title.set("V1")
      d.count.set(1)
    })
    await drain(40)

    const lcv = server.leastCommonVersion("doc-1")
    expect(lcv).toBeNull()

    // Null LCV → compact advances to replica.version() (full projection).
    await server.compact("doc-1")

    change(docServer, (d: any) => {
      d.title.set("V2")
      d.count.set(2)
    })
    await drain(40)

    // Client still converges via entirety (epoch reset).
    expect(client.get("doc-1", TestDoc).title()).toBe("V2")
    expect(client.get("doc-1", TestDoc).count()).toBe(2)
  })
})
