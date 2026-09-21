// ephemeral-topology — propagation through peers that cannot reach each other.
//
// Every other ephemeral suite puts its peers on one bridge, where everybody
// can hear everybody. That is the topology in which relaying an import is
// redundant, and it is the only one under test — so the case relaying exists
// for has no coverage at all.
//
// These build the shapes where it is load-bearing. A peer joins one bridge per
// link it has, so two peers share a link only if they share a bridge.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { batch, ephemeral, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"

const Roster = ephemeral.bind(
  Schema.struct({ peers: Schema.record(Schema.string()) }),
)

async function drain(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0))
}

/** A peer reachable only over the bridges it is given. */
function peerOn(id: string, bridges: readonly Bridge[]) {
  const exchange = new Exchange({
    id,
    transports: bridges.map((bridge, i) =>
      createBridgeTransport({ transportId: `${id}#${i}`, bridge }),
    ),
    schemas: [Roster],
  })
  return { exchange, doc: exchange.get("presence", Roster) }
}

function meterFrames(bridges: readonly Bridge[]) {
  const counter = { frames: 0 }
  for (const bridge of bridges) {
    const route = bridge.routeBytes.bind(bridge)
    bridge.routeBytes = (from, to, bytes) => {
      counter.frames += 1
      route(from, to, bytes)
    }
  }
  return counter
}

describe("a chain: A — B — C, with no link between A and C", () => {
  it("carries a write from one end to the other", async () => {
    const ab = new Bridge()
    const bc = new Bridge()
    const a = peerOn("alice", [ab])
    const b = peerOn("bob", [ab, bc])
    const c = peerOn("carol", [bc])
    await drain()

    batch(a.doc, d => d.peers.set("alice", "online"))
    await drain()

    // Carol shares no channel with Alice. The only way this arrives is Bob
    // passing on what he imported.
    expect(c.doc.peers()?.alice).toBe("online")
    expect(b.doc.peers()?.alice).toBe("online")
  }, 30_000)

  it("carries writes from both ends past each other", async () => {
    const ab = new Bridge()
    const bc = new Bridge()
    const a = peerOn("alice", [ab])
    const b = peerOn("bob", [ab, bc])
    const c = peerOn("carol", [bc])
    await drain()

    batch(a.doc, d => d.peers.set("alice", "online"))
    batch(c.doc, d => d.peers.set("carol", "online"))
    await drain()

    for (const { doc } of [a, b, c]) {
      expect(doc.peers()).toEqual({ alice: "online", carol: "online" })
    }
  }, 30_000)

  it("delivers a later change to the far end, not just the first", async () => {
    // The first write arrives during initial sync, which would pass even if
    // relaying were broken for steady-state updates.
    const ab = new Bridge()
    const bc = new Bridge()
    const a = peerOn("alice", [ab])
    const b = peerOn("bob", [ab, bc])
    const c = peerOn("carol", [bc])
    await drain()

    batch(a.doc, d => d.peers.set("alice", "online"))
    await drain()
    expect(c.doc.peers()?.alice).toBe("online")

    batch(a.doc, d => d.peers.set("alice", "away"))
    await drain()
    expect(c.doc.peers()?.alice).toBe("away")
    void b
  }, 30_000)
})

describe("hub and spoke: every spoke reaches only the hub", () => {
  const SPOKES = 6

  const build = () => {
    const bridges = Array.from({ length: SPOKES }, () => new Bridge())
    const hub = peerOn("hub", bridges)
    const spokes = bridges.map((bridge, i) => peerOn(`spoke-${i}`, [bridge]))
    return { bridges, hub, spokes }
  }

  it("propagates one spoke's write to every other spoke", async () => {
    const { hub, spokes } = build()
    await drain()

    batch(spokes[0].doc, d => d.peers.set("spoke-0", "online"))
    await drain()

    expect(hub.doc.peers()?.["spoke-0"]).toBe("online")
    for (const spoke of spokes.slice(1)) {
      expect(spoke.doc.peers()?.["spoke-0"]).toBe("online")
    }
  }, 30_000)

  it("converges when every spoke writes its own key", async () => {
    const { hub, spokes } = build()
    await drain()

    for (let i = 0; i < SPOKES; i++) {
      batch(spokes[i].doc, d => d.peers.set(`spoke-${i}`, "online"))
    }
    await drain(100)

    const expected = Object.fromEntries(
      Array.from({ length: SPOKES }, (_, i) => [`spoke-${i}`, "online"]),
    )
    expect(hub.doc.peers()).toEqual(expected)
    for (const spoke of spokes) expect(spoke.doc.peers()).toEqual(expected)
  }, 30_000)

  it("costs a frame count linear in the spokes, since nothing is redundant", async () => {
    const { bridges, hub, spokes } = build()
    await drain()
    for (let i = 0; i < SPOKES; i++) {
      batch(spokes[i].doc, d => d.peers.set(`spoke-${i}`, "online"))
    }
    await drain(100)

    const counter = meterFrames(bridges)
    batch(spokes[0].doc, d => d.peers.set("spoke-0", "away"))
    await drain()

    for (const spoke of spokes.slice(1)) {
      expect(spoke.doc.peers()?.["spoke-0"]).toBe("away")
    }
    void hub
    // Every relayed frame here is the only copy its recipient will get, which
    // is the opposite of the complete mesh: there, the same count is almost
    // entirely waste. Recorded so the difference between the two topologies
    // stays visible if the relay is ever made more selective.
    console.log(`hub-and-spoke ${SPOKES} spokes: ${counter.frames} frames`)
    expect(counter.frames).toBeLessThanOrEqual(4 * SPOKES)
  }, 30_000)
})

describe("a longer chain: A — B — C — D — E", () => {
  /** Five peers in a line; each link is its own bridge. */
  const build = () => {
    const links = Array.from({ length: 4 }, () => new Bridge())
    const a = peerOn("alice", [links[0]])
    const b = peerOn("bob", [links[0], links[1]])
    const c = peerOn("carol", [links[1], links[2]])
    const d = peerOn("dave", [links[2], links[3]])
    const e = peerOn("erin", [links[3]])
    return { links, peers: [a, b, c, d, e] }
  }

  it("carries a write three hops from one end to the other", async () => {
    const { peers } = build()
    await drain(80)

    batch(peers[0].doc, d => d.peers.set("alice", "online"))
    await drain(80)

    // Alice shares a channel only with Bob. Reaching Erin means Bob, Carol
    // and Dave each passed on something they had just imported.
    for (const { doc } of peers) {
      expect(doc.peers()?.alice).toBe("online")
    }
  }, 30_000)

  it("carries a later change the whole way, not just the first", async () => {
    const { peers } = build()
    await drain(80)

    batch(peers[0].doc, d => d.peers.set("alice", "online"))
    await drain(80)
    expect(peers[4].doc.peers()?.alice).toBe("online")

    batch(peers[0].doc, d => d.peers.set("alice", "away"))
    await drain(80)
    expect(peers[4].doc.peers()?.alice).toBe("away")
  }, 30_000)

  it("converges when both ends write at once", async () => {
    const { peers } = build()
    await drain(80)

    batch(peers[0].doc, d => d.peers.set("alice", "online"))
    batch(peers[4].doc, d => d.peers.set("erin", "online"))
    await drain(120)

    for (const { doc } of peers) {
      expect(doc.peers()).toEqual({ alice: "online", erin: "online" })
    }
  }, 30_000)

  it("converges when every peer writes its own key", async () => {
    const { peers } = build()
    const names = ["alice", "bob", "carol", "dave", "erin"]
    await drain(80)

    for (let i = 0; i < peers.length; i++) {
      batch(peers[i].doc, d => d.peers.set(names[i], "online"))
    }
    await drain(160)

    const expected = Object.fromEntries(names.map(n => [n, "online"]))
    for (const { doc } of peers) expect(doc.peers()).toEqual(expected)
  }, 30_000)

  it("settles, and one write costs a frame count linear in the chain", async () => {
    const { links, peers } = build()
    const names = ["alice", "bob", "carol", "dave", "erin"]
    await drain(80)
    for (let i = 0; i < peers.length; i++) {
      batch(peers[i].doc, d => d.peers.set(names[i], "online"))
    }
    await drain(160)

    const counter = meterFrames(links)
    batch(peers[0].doc, d => d.peers.set("alice", "away"))
    await drain(120)

    expect(peers[4].doc.peers()?.alice).toBe("away")
    // Measured at 4 frames across 4 links — one per link, which is the
    // theoretical minimum: the change has to traverse every link once to
    // reach the far end, and it traverses none of them twice.
    //
    // Worth putting beside the complete-mesh figure. Five peers in a line
    // cost 4 frames; five peers all connected cost 16, of which 12 are
    // redundant. Same code, same rule, same peer count.
    expect(counter.frames).toBeLessThanOrEqual(2 * links.length)
  }, 30_000)
})
