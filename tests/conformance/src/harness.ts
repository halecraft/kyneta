import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Exchange, type ExchangeParams } from "@kyneta/exchange"
import { batch } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import type { SubstrateProfile } from "./profiles.js"

// biome-ignore lint/suspicious/noExplicitAny: docs are accessed untyped — the harness
// is deliberately substrate-agnostic, exercising the runtime, not the type surface.
type Doc = any

// The substrate-agnostic bound schema, taken from the profile table rather than
// re-derived, so the helpers below accept exactly what `profile.bind()` returns.
type Bound = ReturnType<SubstrateProfile["bind"]>

// Advance micro- and macro-task queues enough times for a full present/interest/
// offer handshake plus any reset re-request round trips.
async function drain(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const read = (doc: Doc) => ({ a: doc.a() as string, b: doc.b() as string })

/**
 * Assert a `Shape` value is one whole variant, not a mixture of two.
 *
 * Hand-written rather than delegated to `tryValidate`, because validation only
 * covers half of it: it does reject a tag that disagrees with its payload
 * (`{kind:"circle", side:3}`), but it ACCEPTS `{kind:"circle", radius:5, side:3}`,
 * since it does not reject excess properties. The excess field is the whole
 * signature of a blend, so that half has to be checked here.
 */
function expectCoherentVariant(v: any): void {
  expect(v == null ? null : v.kind).toBeDefined()
  if (v.kind === "circle") {
    expect(typeof v.radius).toBe("number")
    expect(v.side).toBeUndefined() // a field from the losing variant
  } else {
    expect(v.kind).toBe("square")
    expect(typeof v.side).toBe("number")
    expect(v.radius).toBeUndefined()
  }
}

/**
 * Runs the substrate-unification conformance battery against one profile through
 * the real Exchange/Bridge sync machinery.
 *
 * Universal invariants — convergence, fresh-peer adoption, and sum-variant
 * coherence — must hold for every substrate. Capability-gated ones (compaction)
 * run only where the profile declares support. See `profiles.ts` for the matrix
 * these assertions enforce.
 *
 * One scenario currently FAILS on every profile, on purpose. It asserts that a
 * write inside a sum reaches the other peer, which is a guarantee the Exchange
 * does not presently keep. It is left red rather than skipped or pinned to the
 * broken value, because a suite that reports green while it knows a guarantee is
 * broken is how the last three sum bugs survived — every test passed the whole
 * time they were live. See `sum-interior-write-sync-issue.md`.
 */
export function runSubstrateConformance(profile: SubstrateProfile): void {
  describe(`substrate conformance — ${profile.name}`, () => {
    const active: Exchange[] = []
    const spawn = (
      id: string,
      bridge: Bridge | null,
      bound: Bound,
    ): Exchange => {
      const ex = new Exchange({
        id,
        schemas: [bound],
        transports: bridge
          ? [createBridgeTransport({ transportId: id, bridge })]
          : [],
      } as ExchangeParams)
      active.push(ex)
      return ex
    }
    afterEach(async () => {
      for (const ex of active) {
        try {
          await ex.shutdown()
        } catch {
          /* ignore */
        }
      }
      active.length = 0
    })

    // --- Peer setups -------------------------------------------------------
    //
    // Two ways to get a pair of peers, factored out so each scenario below is
    // just "put two peers in a state, then assert a property of the result".
    // Assembling an Exchange pair is effectful and fiddly; the invariants are
    // plain questions about two values. Keeping them apart is what lets a
    // scenario read as a specification rather than as a setup script.

    /** Two peers already joined by a bridge. Writes propagate as they happen. */
    const connectedPair = (bound: Bound): [Doc, Doc] => {
      const bridge = new Bridge()
      // Each doc is annotated rather than inferred: returning `.get()` results
      // straight into a tuple makes TypeScript build the full typed `DocRef` for
      // this schema, which exceeds its instantiation-depth limit. The harness
      // works untyped on purpose, so pinning them to `Doc` costs nothing.
      const docA: Doc = spawn("A", bridge, bound).get("doc", bound)
      const docB: Doc = spawn("B", bridge, bound).get("doc", bound)
      return [docA, docB]
    }

    /**
     * Two peers that each write while disconnected, then reconnect.
     *
     * A partition is the only way to get genuinely concurrent writes: with a
     * live bridge, whichever peer writes second has already seen the first.
     *
     * The `drain(5)` between the two writes is load-bearing, not cosmetic.
     * Timestamps taken in the same millisecond compare "equal", and the
     * synchronizer skips a sync it believes is a no-op — so without the gap the
     * partition heals into silence and the scenario asserts nothing.
     */
    const partitionedWrites = async (
      bound: Bound,
      writeA: (d: Doc) => void,
      writeB: (d: Doc) => void,
    ): Promise<[Doc, Doc]> => {
      const a = spawn("A", null, bound)
      const b = spawn("B", null, bound)
      const docA: Doc = a.get("doc", bound)
      const docB: Doc = b.get("doc", bound)

      batch(docA, writeA)
      await drain(5)
      batch(docB, writeB)

      const bridge = new Bridge()
      await a.addTransport(createBridgeTransport({ transportId: "A", bridge }))
      await b.addTransport(createBridgeTransport({ transportId: "B", bridge }))
      await drain()

      return [docA, docB]
    }

    /**
     * Two peers that agree on a starting state, then split, write, and rejoin.
     *
     * `partitionedWrites` starts both peers from genesis, which is enough for
     * concurrent *writes* but not for a concurrent *removal*: a peer can only
     * remove a key it already has, and the removal is only interesting if the
     * other peer also had it and never saw it go. So this one seeds a shared
     * base first, then partitions.
     *
     * The partition is real: `removeTransport` detaches the peers, rather than
     * closing a bridge that may still deliver. If the split silently fails to
     * take, the "concurrent" writes are merely sequential — and then every
     * substrate passes, for the wrong reason and with nothing to show for it.
     */
    const seededPartition = async (
      bound: Bound,
      seed: (d: Doc) => void,
      writeA: (d: Doc) => void,
      writeB: (d: Doc) => void,
    ): Promise<[Doc, Doc]> => {
      const bridge = new Bridge()
      const a = spawn("A", bridge, bound)
      const b = spawn("B", bridge, bound)
      const docA: Doc = a.get("doc", bound)
      const docB: Doc = b.get("doc", bound)

      batch(docA, seed)
      await drain()

      await a.removeTransport("A")
      await b.removeTransport("B")

      batch(docA, writeA)
      await drain(5) // same-millisecond guard as in `partitionedWrites`
      batch(docB, writeB)
      await drain(5)

      const healed = new Bridge()
      await a.addTransport(
        createBridgeTransport({ transportId: "A2", bridge: healed }),
      )
      await b.addTransport(
        createBridgeTransport({ transportId: "B2", bridge: healed }),
      )
      await drain()

      return [docA, docB]
    }

    it("converges to equal state; keeps independent-field writes iff it merges below whole-document granularity", async () => {
      const bound = profile.bind()

      if (profile.writerModel === "serialized") {
        // One authoritative writer at a time is the supported pattern for a
        // serialized substrate (two peers racing the same doc is misuse). Each
        // write syncs before the next, so both survive.
        const [docA, docB] = connectedPair(bound)
        batch(docA, (d: Doc) => d.a.set("A"))
        await drain()
        batch(docB, (d: Doc) => d.b.set("B"))
        await drain()
        expect(read(docA)).toEqual(read(docB))
        expect(docA.a()).toBe("A")
        expect(docA.b()).toBe("B")
        return
      }

      const [docA, docB] = await partitionedWrites(
        bound,
        (d: Doc) => d.a.set("A"),
        (d: Doc) => d.b.set("B"),
      )

      // Universal: both peers reach the same materialized state.
      expect(read(docA)).toEqual(read(docB))

      if (profile.fieldConcurrency === "both-survive") {
        expect(docA.a()).toBe("A")
        expect(docA.b()).toBe("B")
      } else {
        // Whole-document LWW: exactly one of the two field writes survives.
        const survivors = [docA.a() === "A", docA.b() === "B"].filter(
          Boolean,
        ).length
        expect(survivors).toBe(1)
      }
    })

    it("a concurrent variant switch resolves to ONE coherent variant", async () => {
      // Universal, and gated on nothing — but every substrate arrives at it by a
      // different route. `json` gets it from serialized writes, `ephemeral` from
      // storing a sum as one atomic `[value, timestamp]` register, `loro` and
      // `yjs` from keeping a sum's interior opaque. Three mechanisms, one
      // guarantee, and no shared assertion until now — which is exactly the
      // shape of thing a conformance suite is for. Three separate sum bugs, one
      // per substrate, were live simultaneously before this landed.
      const bound = profile.bind()

      if (profile.writerModel === "serialized") {
        // Racing one document is misuse for a serialized substrate, so switch
        // sequentially. The coherence property is still asserted; only the
        // concurrency is dropped.
        const [docA, docB] = connectedPair(bound)
        batch(docA, (d: Doc) => d.shape.set({ kind: "circle", radius: 5 }))
        await drain()
        batch(docB, (d: Doc) => d.shape.set({ kind: "square", side: 3 }))
        await drain()
        expectCoherentVariant(docA.shape())
        expect(docA.shape()).toEqual(docB.shape())
        return
      }

      const [docA, docB] = await partitionedWrites(
        bound,
        (d: Doc) => d.shape.set({ kind: "circle", radius: 5 }),
        (d: Doc) => d.shape.set({ kind: "square", side: 3 }),
      )

      // Agreement alone is not enough: two peers can agree on a blended value,
      // and that is precisely the bug `ephemeral` shipped before its sum values
      // became atomic registers. Both peers converged — on a shape carrying a
      // tag from one variant and fields from both.
      expect(docA.shape()).toEqual(docB.shape())
      expectCoherentVariant(docA.shape())
      expectCoherentVariant(docB.shape())
    })

    it("a write inside a sum reaches the other peer", async () => {
      // FAILING ON PURPOSE — this is a live bug, and the suite is supposed to
      // say so. See `sum-interior-write-sync-issue.md`.
      //
      // A write inside a sum applies locally, bumps the substrate version, and
      // fires the changefeed — but the Exchange never offers it. Peer A reads
      // its own write back correctly; the other peer stays on the previous value
      // however long the harness drains. Any later unrelated write carries it
      // across, so the data is intact and it is the sync trigger that is missing.
      //
      // It reproduces identically on all five substrates including `json`, which
      // rules out the substrates and places the fault above them. Diagnosis and
      // fix are separate work at the Exchange layer.
      //
      // Deliberately NOT `it.fails`, and deliberately not pinned to the wrong
      // value. Both of those report green, and a green suite is exactly how the
      // three sum bugs before this one survived — every test passed the entire
      // time they were live. A conformance suite that knows a guarantee is broken
      // should fail; that is what makes the gap impossible to forget rather than
      // merely recorded somewhere.
      const bound = profile.bind()
      const [docA, docB] = connectedPair(bound)

      batch(docA, (d: Doc) => d.optional.set({ from: 1, to: 7 }))
      await drain()
      // The whole-value write syncs correctly — so the pair is genuinely
      // connected, and it is specifically the interior write that is lost.
      expect(docB.optional()).toEqual({ from: 1, to: 7 })

      batch(docA, (d: Doc) => (d.optional as Doc).to.set(2))
      await drain()

      expect(docA.optional()).toEqual({ from: 1, to: 2 })
      // Asserted on the receiving peer, not the writer: every substrate serves
      // local reads from a shadow that `prepare` updates directly, so the writer
      // looks correct no matter what actually reached the network.
      expect(docB.optional()).toEqual({ from: 1, to: 2 })
    })

    it("record keys written by different peers both survive", async () => {
      // The dynamic-key counterpart to the independent-field scenario above.
      // A record is where membership itself is concurrent: two peers adding
      // different keys is the presence-roster shape, and it is the reason the
      // `ephemeral` substrate exists.
      const bound = profile.bind()

      if (profile.writerModel === "serialized") {
        const [docA, docB] = connectedPair(bound)
        batch(docA, (d: Doc) => d.peers.set("alice", 1))
        await drain()
        batch(docB, (d: Doc) => d.peers.set("bob", 2))
        await drain()
        expect(docA.peers()).toEqual({ alice: 1, bob: 2 })
        expect(docA.peers()).toEqual(docB.peers())
        return
      }

      const [docA, docB] = await partitionedWrites(
        bound,
        (d: Doc) => d.peers.set("alice", 1),
        (d: Doc) => d.peers.set("bob", 2),
      )

      expect(docA.peers()).toEqual(docB.peers())
      if (profile.fieldConcurrency === "both-survive") {
        expect(docA.peers()).toEqual({ alice: 1, bob: 2 })
      } else {
        // Whole-document LWW: the newer snapshot replaces everything, so only
        // one peer's key is left. Which one is not the point; agreeing is.
        expect(Object.keys(docA.peers() as object)).toHaveLength(1)
      }
    })

    it("a removed record key stays removed after merging a peer that still has it", async () => {
      // Absence carries no information in a key-union merge: a key one peer
      // lacks looks exactly like a key it has never seen. Every substrate has
      // to represent removal somehow — a CRDT delete, a tombstone, or a newer
      // whole-document snapshot — and which one it picks decides whether a
      // removal can survive a concurrent write by someone who never saw it.
      //
      // The `fieldConcurrency` branch below measures that, the same way the
      // first scenario measures it for field values. Every profile shipping
      // today merges below whole-document granularity and keeps the removal;
      // the `one-wins` branch remains for any substrate that does not.
      const bound = profile.bind()

      if (profile.writerModel === "serialized") {
        // Racing one document is misuse for a serialized substrate. Delete
        // sequentially instead — the removal is still asserted, only the
        // concurrency is dropped.
        const [docA, docB] = connectedPair(bound)
        batch(docA, (d: Doc) => {
          d.peers.set("alice", 1)
          d.peers.set("bob", 2)
        })
        await drain()
        batch(docB, (d: Doc) => d.peers.delete("alice"))
        await drain()
        expect(docA.peers()).toEqual({ bob: 2 })
        expect(docA.peers()).toEqual(docB.peers())
        return
      }

      const [docA, docB] = await seededPartition(
        bound,
        (d: Doc) => {
          d.peers.set("alice", 1)
          d.peers.set("bob", 2)
        },
        // A removes alice while partitioned.
        (d: Doc) => d.peers.delete("alice"),
        // B never sees the removal and writes an unrelated key, so it has
        // something of its own to contribute at heal time.
        (d: Doc) => d.peers.set("carol", 3),
      )

      // Universal: the peers agree.
      expect(docA.peers()).toEqual(docB.peers())

      if (profile.fieldConcurrency === "both-survive") {
        // The removal and the unrelated add are independent facts, and both
        // hold. `ephemeral` reaches this only because map deletes stopped being a
        // bare removal — before tombstones, merging the peer that still held
        // the key resurrected it, and nothing here would have noticed, because
        // the conformance schema had no dynamic-key collection at all.
        expect(docA.peers()).toEqual({ bob: 2, carol: 3 })
      } else {
        // Whole-document LWW: the newer snapshot replaces everything, so the
        // result is one peer's entire document rather than a merge of the two.
        // A removal therefore survives only if the remover wrote last — and
        // here B did, so alice comes back. Not a defect; it is what choosing
        // whole-document granularity costs, and the reason `ephemeral` exists.
        expect([{ bob: 2 }, { alice: 1, bob: 2, carol: 3 }]).toContainEqual(
          docA.peers(),
        )
      }
    })

    it("a fresh peer adopts an incumbent's state on join", async () => {
      const bound = profile.bind()
      const [docA, docB] = connectedPair(bound)

      // Incumbent A writes; B is a fresh (genesis) peer that never writes.
      batch(docA, (d: Doc) => {
        d.a.set("A")
        d.b.set("B")
      })
      await drain()

      expect(docB.a()).toBe("A")
      expect(docB.b()).toBe("B")
    })

    if (profile.liveCompactable) {
      it("compaction preserves convergence with a synced peer", async () => {
        const bound = profile.bind()
        // Spawned directly rather than via `connectedPair`: this scenario needs
        // the Exchange itself to call `compact()`, not just the document.
        const bridge = new Bridge()
        const a = spawn("A", bridge, bound)
        const b = spawn("B", bridge, bound)
        const docA: Doc = a.get("doc", bound)
        const docB: Doc = b.get("doc", bound)

        // Both write so each sees the other as synced, then A compacts away the
        // shared history and writes again — B must still converge on the new state.
        batch(docA, (d: Doc) => d.a.set("A1"))
        await drain()
        batch(docB, (d: Doc) => d.b.set("B1"))
        await drain()

        await a.compact("doc")
        batch(docA, (d: Doc) => d.a.set("A2"))
        await drain()

        expect(docB.a()).toBe("A2")
        expect(read(docA)).toEqual(read(docB))
      })
    }
  })
}
