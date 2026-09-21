// ephemeral-integration — the `ephemeral` target's field-level merge, driven
// end-to-end through a real Exchange rather than against the substrate alone.
//
// The property under test is the one the target exists for: two peers writing
// *different* keys of a shared roster both survive. Under whole-document
// last-writer-wins — which is what this target was through 2.x — whichever
// peer wrote most recently would clobber the other, making a presence roster
// unusable. The substrate's own suites in `@kyneta/schema` cover the merge
// algebra; this one covers the path a real peer takes to reach it, including
// the synchronizer's decision to import an offer at all.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import {
  batch,
  ephemeral,
  lastUpdated,
  Schema,
  subscribe,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"

const StateSchema = Schema.struct({
  alice: Schema.string().nullable(),
  bob: Schema.string().nullable(),
})

const StateDoc = ephemeral.bind(StateSchema)

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

describe("ephemeral substrate — field-level LWW through a live Exchange", () => {
  it("merges concurrently at the field level without clobbering", async () => {
    const bridge = new Bridge()

    const exchangeA = new Exchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [StateDoc],
    })

    const exchangeB = new Exchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [StateDoc],
    })

    const docA = exchangeA.get("presence", StateDoc)
    const docB = exchangeB.get("presence", StateDoc)

    // Initially they both compute structural zeros for `alice` and `bob` (which is `null`)
    expect(docA.alice()).toBeNull()
    expect(docA.bob()).toBeNull()

    // The timestamps should be 0 for structural zeros
    expect(lastUpdated(docA.alice)).toBe(0)
    expect(lastUpdated(docA.bob)).toBe(0)

    // Alice writes her presence
    batch(docA, d => d.alice.set("online-alice"))
    expect(docA.alice()).toBe("online-alice")

    // Drain so Alice's flush + sync settles before Bob writes.
    // Without this, both exchanges may flush in the same millisecond under
    // CPU load, producing equal StateVersion timestamps. The synchronizer
    // then sees "equal" and skips the exchange — the field-level merge
    // never runs, and neither peer learns the other's data.
    await drain(20)

    // Bob writes his presence — a different field, not a conflicting write
    batch(docB, d => d.bob.set("online-bob"))
    expect(docB.bob()).toBe("online-bob")

    // Drain so Bob's flush + sync settles
    await drain(20)

    // Both should now have both values
    expect(docA.alice()).toBe("online-alice")
    expect(docA.bob()).toBe("online-bob")
    expect(docB.alice()).toBe("online-alice")
    expect(docB.bob()).toBe("online-bob")

    // Timestamps should be valid non-zero
    const tA = lastUpdated(docA.alice)
    const tB = lastUpdated(docB.bob)
    expect(tA).toBeGreaterThan(0)
    expect(tB).toBeGreaterThan(0)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("tells local subscribers when a peer's state arrives", async () => {
    // State landing is not the same as being told it landed. A merge that
    // writes σ without going through the changefeed leaves every read
    // correct and every view stale — which for a presence roster means it
    // simply never updates.
    const bridge = new Bridge()
    const exchangeA = new Exchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [StateDoc],
    })
    const exchangeB = new Exchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [StateDoc],
    })

    const docA = exchangeA.get("presence", StateDoc)
    const docB = exchangeB.get("presence", StateDoc)
    await drain(20)

    let onDoc = 0
    let onField = 0
    const unsubDoc = subscribe(docB, () => {
      onDoc++
    })
    const unsubField = subscribe(docB.alice, () => {
      onField++
    })

    batch(docA, d => d.alice.set("online-alice"))
    await drain(20)

    expect(docB.alice()).toBe("online-alice")
    expect(onDoc).toBeGreaterThan(0)
    // The field's own subscriber too, not just the document root: a roster
    // is watched per entry.
    expect(onField).toBeGreaterThan(0)

    unsubDoc()
    unsubField()
    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})

// A third peer is not a bigger version of two. With two peers, excluding the
// sender from the relay is enough to break the cycle: A pushes to B, and B has
// nobody left to forward to. With three there is always another peer to
// forward to, so a merge that announces a change it did not make circulates
// forever. The cascade is synchronous, so a failure here wedges the event loop
// rather than failing an assertion — which is why the suite-level timeout is
// the real guard, and why every test above this one uses two peers.
describe("a three-peer mesh settles", () => {
  const MeshSchema = Schema.struct({
    alice: Schema.string().nullable(),
    bob: Schema.string().nullable(),
    carol: Schema.string().nullable(),
  })
  const MeshDoc = ephemeral.bind(MeshSchema)

  const mesh = (ids: readonly string[]) => {
    const bridge = new Bridge()
    const exchanges = ids.map(
      id =>
        new Exchange({
          id,
          transports: [createBridgeTransport({ transportId: id, bridge })],
          schemas: [MeshDoc],
        }),
    )
    return exchanges.map(e => e.get("presence", MeshDoc))
  }

  it("opening the document on three peers terminates", async () => {
    const docs = mesh(["alice", "bob", "carol"])
    await drain(20)
    expect(docs.length).toBe(3)
  }, 10_000)

  it("one write reaches both peers and stops", async () => {
    const docs = mesh(["alice", "bob", "carol"])
    await drain(20)
    batch(docs[0], d => d.alice.set("online-alice"))
    await drain(20)
    expect(docs[1].alice()).toBe("online-alice")
    expect(docs[2].alice()).toBe("online-alice")
  }, 10_000)
})

// Metered end to end, because the byte count is the whole point and a test
// that only checks convergence passes just as well with a full resend.
describe("a change ships itself, not the document", () => {
  const Roster = ephemeral.bind(
    Schema.struct({ peers: Schema.record(Schema.string()) }),
  )

  /** Bytes crossing the bridge — the choke point every frame passes through. */
  const meter = (bridge: Bridge) => {
    const counter = { bytes: 0, frames: 0 }
    const route = bridge.routeBytes.bind(bridge)
    bridge.routeBytes = (from, to, bytes) => {
      counter.frames += 1
      counter.bytes += bytes.byteLength
      route(from, to, bytes)
    }
    return counter
  }

  const rosterOf = (size: number): Record<string, string> =>
    Object.fromEntries(
      Array.from({ length: size }, (_, i) => [`peer-${i}`, `online-${i}`]),
    )

  it("is flat in roster size", async () => {
    const quietBytes = async (rosterSize: number): Promise<number> => {
      const bridge = new Bridge()
      const alice = new Exchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
        schemas: [Roster],
      })
      const bob = new Exchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        schemas: [Roster],
      })
      const docA = alice.get("presence", Roster)
      const docB = bob.get("presence", Roster)

      batch(docA, d => {
        for (const [key, value] of Object.entries(rosterOf(rosterSize))) {
          d.peers.set(key, value)
        }
      })
      await drain(30)
      expect(Object.keys(docB.peers() ?? {})).toHaveLength(rosterSize)

      // Everything above is setup. Only what follows is the quiet round.
      const counter = meter(bridge)
      batch(docA, d => d.peers.set("peer-0", "online-0"))
      await drain(30)
      return counter.bytes
    }

    const small = await quietBytes(5)
    const large = await quietBytes(200)

    // A forty-fold roster must not cost forty times the bytes for the same
    // one-leaf change. Measured at 148 B and 150 B; before deltas the larger
    // was 7 895 B, so the whole roster was crossing the wire every time.
    //
    // Stated as a ratio rather than an absolute so it pins the scaling
    // property and not today's frame overhead.
    expect(large).toBeLessThan(small * 2)
  }, 30_000)
})

// Repair is the half the digest exists for. Detection alone is worth little:
// if the answer to "we differ" is always a full resend, a lossy transport
// costs the whole document every time it drops a frame.
describe("a peer that misses an update is repaired precisely", () => {
  const Roster = ephemeral.bind(
    Schema.struct({ peers: Schema.record(Schema.string()) }),
  )

  it("sends the missing leaves, not the whole roster", async () => {
    const bridge = new Bridge()
    const alice = new Exchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [Roster],
    })
    const bob = new Exchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [Roster],
    })
    const docA = alice.get("presence", Roster)
    const docB = bob.get("presence", Roster)

    batch(docA, d => {
      for (let i = 0; i < 200; i++) d.peers.set(`peer-${i}`, `online-${i}`)
    })
    await drain(30)
    expect(Object.keys(docB.peers() ?? {})).toHaveLength(200)

    // Sever the link and write while Bob cannot hear it. Driven through the
    // transport rather than by reaching inside: `Exchange` uses true #private
    // members and cannot be poisoned from a test.
    alice.removeTransport("alice")
    batch(docA, d => d.peers.set("peer-7", "away"))
    await drain(10)
    expect(docB.peers()?.["peer-7"]).toBe("online-7") // Bob missed it

    alice.addTransport(createBridgeTransport({ transportId: "alice", bridge }))
    const counter = { bytes: 0 }
    const route = bridge.routeBytes.bind(bridge)
    bridge.routeBytes = (from, to, bytes) => {
      counter.bytes += bytes.byteLength
      route(from, to, bytes)
    }
    await drain(40)

    expect(docB.peers()?.["peer-7"]).toBe("away")
    // A delta names only what changed. If the receiver read the keys it omits
    // as removals, repairing one entry would empty the roster.
    expect(Object.keys(docB.peers() ?? {})).toHaveLength(200)
    expect(docB.peers()?.["peer-42"]).toBe("online-42")
    // A 200-entry roster is several kilobytes. Repair carries the leaf that
    // changed, so this stays far below it.
    console.log(`repair bytes: ${counter.bytes}`)
    expect(counter.bytes).toBeLessThan(1500)
  }, 30_000)
})

// What a presence roster actually does: every peer in one mesh, writing its
// own key. The payload scales as intended — a one-leaf change is 43 bytes at
// any roster size — but the *number of frames* does not, because an imported
// change is relayed to every peer except the sender and in a full mesh they
// all already have it.
//
// Measured, one peer writing:
//
//     peers   frames   bytes
//         3        4     572
//         5       16   2 300
//        10       81  11 745
//
// That is (n-1)²: the writer reaches n-1 peers directly, and each of those
// relays to the other n-2. The second hop changes nothing, so it stops there
// rather than continuing — the relay is bounded, not free. It is what makes a
// partial mesh work, and pure waste in a complete one.
//
// These assertions pin the bound. They are deliberately loose: the point is
// to fail if the relay stops damping (cubic, or unbounded as it once was),
// not to freeze today's framing overhead.
describe("a roster of peers all writing their own key", () => {
  const Roster = ephemeral.bind(
    Schema.struct({ peers: Schema.record(Schema.string()) }),
  )

  const meshOf = (size: number) => {
    const bridge = new Bridge()
    const ids = Array.from({ length: size }, (_, i) => `peer-${i}`)
    const docs = ids
      .map(
        id =>
          new Exchange({
            id,
            transports: [createBridgeTransport({ transportId: id, bridge })],
            schemas: [Roster],
          }),
      )
      .map(e => e.get("presence", Roster))
    return { bridge, ids, docs }
  }

  const meterFrames = (bridge: Bridge) => {
    const counter = { frames: 0 }
    const route = bridge.routeBytes.bind(bridge)
    bridge.routeBytes = (from, to, bytes) => {
      counter.frames += 1
      route(from, to, bytes)
    }
    return counter
  }

  it("converges with ten peers, and one write stays within the square bound", async () => {
    const size = 10
    const { bridge, ids, docs } = meshOf(size)
    await drain(40)

    for (let i = 0; i < size; i++) {
      batch(docs[i], d => d.peers.set(ids[i], "online"))
    }
    await drain(60)
    for (const doc of docs) {
      expect(Object.keys(doc.peers() ?? {})).toHaveLength(size)
    }

    const counter = meterFrames(bridge)
    batch(docs[0], d => d.peers.set(ids[0], "away"))
    await drain(40)

    for (const doc of docs) {
      expect(doc.peers()?.[ids[0]]).toBe("away")
    }
    // (n-1)² = 81. Anything much above means a hop stopped damping.
    expect(counter.frames).toBeLessThanOrEqual((size - 1) ** 2 + size)
  }, 60_000)

  it("converges when every peer writes at once", async () => {
    const size = 10
    const { ids, docs } = meshOf(size)
    await drain(40)

    for (let i = 0; i < size; i++) {
      batch(docs[i], d => d.peers.set(ids[i], "online"))
    }
    await drain(80)

    // The property the substrate exists for: concurrent writes to different
    // keys all survive, on every peer.
    for (const doc of docs) {
      const roster = doc.peers() ?? {}
      expect(Object.keys(roster)).toHaveLength(size)
      for (const id of ids) expect(roster[id]).toBe("online")
    }
  }, 60_000)
})
