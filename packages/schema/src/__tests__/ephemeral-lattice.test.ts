// ephemeral-lattice — the `ephemeral` substrate's merge is a join-semilattice.
//
// A CvRDT converges only if its merge is commutative, associative and
// idempotent. Those laws are the whole reason two peers can exchange state in
// any order, any number of times, and still agree.
//
// Commutativity used to fail. On a timestamp tie the merge took the remote
// value — deterministic, but deterministic is not commutative, and it is
// commutativity peers depend on. Two peers writing different values in the
// same millisecond each kept their own, permanently, with no error raised.
//
// Checked exhaustively over a curated set rather than by random generation:
// the case that broke is the tie, and a generator over timestamps would
// almost never produce two equal ones.

import { describe, expect, it } from "vitest"
import {
  ephemeralReplicaFactory,
  StateVersion,
} from "../substrates/ephemeral.js"
import { DEFAULT_LINEAGE } from "../substrates/plain.js"
import {
  encodeTree,
  joinTuples,
  mergeStateTree,
  type StateTree,
  type StateTuple,
  stateTreeDigest,
} from "../substrates/state-tree.js"

const clone = (tuple: StateTuple): StateTuple => tuple.slice() as StateTuple

/**
 * A tuple as a peer would hold it. The install ordinal is fixed because these
 * tests are about the join, which never reads it.
 */
const tup = (value: unknown, timestamp: number, deleted?: true): StateTuple =>
  deleted ? [value, timestamp, 1, true] : [value, timestamp, 1]

const merge = (local: StateTree, remote: StateTree) =>
  mergeStateTree(local, remote, 1)

/**
 * Compare what replicates, not what a replica happens to hold.
 *
 * Two peers that reach the same state by opposite merge orders differ in two
 * ways that carry no meaning: their install ordinals, which are each
 * replica's own bookkeeping, and the order keys were added in, since a merge
 * unions keys in whichever order it met them. `encodeTree` drops the first
 * and sorting drops the second. What is left is the state peers exchange.
 */
const canonical = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(node as Record<string, unknown>).sort()) {
    sorted[key] = canonical((node as Record<string, unknown>)[key])
  }
  return sorted
}

const replicated = (tree: StateTree): string =>
  JSON.stringify(canonical(JSON.parse(encodeTree(tree))))

const sameState = (a: StateTree, b: StateTree): boolean =>
  replicated(a) === replicated(b)

// Representative tuples: ties on both equal and differing values, ordinary
// timestamp ordering, and the value shapes a register can actually hold —
// objects (a sum variant or `.json()` blob), null (legal under a nullable
// schema), and undefined (whose serialisation needs special handling).
//
// Tombstones are in here because they are the case the laws are least likely
// to hold for and the most likely to be left out: the tie-break ranks the
// tuple, and a tombstone differs from a live `null` in no other slot. A
// sample without one pins the laws over exactly the inputs that cannot fail.
const SAMPLES: StateTuple[] = [
  tup("from-A", 1000),
  tup("from-B", 1000), // ties with the above — the case that used to diverge
  tup("from-A", 2000),
  tup("from-B", 999),
  tup({ kind: "circle", radius: 5 }, 1000), // a register value, tied
  tup({ kind: "square", side: 3 }, 1000), // ...against another whole variant
  tup(null, 1000),
  tup(undefined, 1000),
  tup(0, 1000),
  tup("", 1000),
  tup(null, 1000, true), // a tombstone, tied against the live `null` above
  tup(null, 2000, true), // ...and against the later live write
  tup(null, 999, true),
]

describe("joinTuples is a join-semilattice", () => {
  it("is commutative — a ⊔ b equals b ⊔ a for every pair", () => {
    const divergent: string[] = []
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        const ab = joinTuples(clone(a), clone(b))
        const ba = joinTuples(clone(b), clone(a))
        // Compared as data, not identity: the join returns one of its inputs,
        // so the two directions legitimately return different objects. What
        // convergence requires is that they carry the same value.
        if (JSON.stringify(ab) !== JSON.stringify(ba)) {
          divergent.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}`)
        }
      }
    }
    expect(divergent).toEqual([])
  })

  it("is associative — (a ⊔ b) ⊔ c equals a ⊔ (b ⊔ c) for every triple", () => {
    // Associativity is what lets three or more peers merge in any grouping.
    // It follows from the join being a maximum over a total order; this pins
    // that the implementation actually is one.
    const divergent: string[] = []
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        for (const c of SAMPLES) {
          const left = joinTuples(joinTuples(clone(a), clone(b)), clone(c))
          const right = joinTuples(clone(a), joinTuples(clone(b), clone(c)))
          if (JSON.stringify(left) !== JSON.stringify(right)) {
            divergent.push(
              `${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(c)}`,
            )
          }
        }
      }
    }
    expect(divergent).toEqual([])
  })

  it("is idempotent — a ⊔ a equals a", () => {
    for (const a of SAMPLES) {
      expect(JSON.stringify(joinTuples(clone(a), clone(a)))).toBe(
        JSON.stringify(a),
      )
    }
  })

  it("takes the highest timestamp, and does not pay for stringify to do it", () => {
    // The ordinary path: unequal timestamps decide it outright. A value that
    // could not be serialised at all must not affect this case.
    const circular: any = {}
    circular.self = circular
    expect(joinTuples(tup("old", 1000), tup(circular, 2000))[1]).toBe(2000)
    expect(joinTuples(tup(circular, 2000), tup("old", 1000))[1]).toBe(2000)
  })
})

describe("the tie rule", () => {
  it("resolves same-millisecond writes to one agreed value", () => {
    // The exact divergence this fix exists for.
    const a: StateTree = { v: tup("from-A", 1000) }
    const b: StateTree = { v: tup("from-B", 1000) }

    const ab = merge({ v: tup("from-A", 1000) }, b).tree
    const ba = merge({ v: tup("from-B", 1000) }, a).tree

    expect(ab).toEqual(ba)
  })

  it("prefers the greater value, not the later writer", () => {
    // Stated as a decision rather than left to be inferred: a tie IS
    // simultaneity, so there is no later writer to prefer.
    expect(joinTuples(tup("a", 1000), tup("b", 1000))[0]).toBe("b")
    expect(joinTuples(tup("b", 1000), tup("a", 1000))[0]).toBe("b")
  })

  it("keeps a tied register whole rather than blending variants", () => {
    // A sum is stored as one tuple, so the tie-break picks a whole variant.
    // Coherence matters more than which one wins.
    const circle = { kind: "circle", radius: 5 }
    const square = { kind: "square", side: 3 }
    const winner = joinTuples(tup(circle, 1000), tup(square, 1000))[0] as any
    expect(winner).toEqual(
      expect.objectContaining({ kind: expect.any(String) }),
    )
    expect(
      winner.kind === "circle" ? winner.side : winner.radius,
    ).toBeUndefined()
  })
})

describe("mergeStateTree over whole trees", () => {
  const treeA = (): StateTree => ({
    scalar: tup("A", 1000),
    nested: { x: tup(1, 1000), y: tup(2, 500) },
  })
  const treeB = (): StateTree => ({
    scalar: tup("B", 1000),
    nested: { x: tup(9, 900), z: tup(3, 700) },
  })

  it("converges regardless of merge direction", () => {
    expect(
      sameState(merge(treeA(), treeB()).tree, merge(treeB(), treeA()).tree),
    ).toBe(true)
  })

  it("is idempotent over a tree", () => {
    const once = merge(treeA(), treeB()).tree
    const twice = merge(merge(treeA(), treeB()).tree, treeB()).tree
    expect(twice).toEqual(once)
  })

  it("unions keys and keeps the higher timestamp per leaf", () => {
    const merged = merge(treeA(), treeB()).tree as any
    expect(merged.nested.x).toEqual(tup(1, 1000)) // local is newer
    expect(merged.nested.y).toEqual(tup(2, 500)) // absent from remote
    // Adopted from remote, so stamped as installed by us rather than carrying
    // the sender's ordinal — which would be a number from someone else's
    // counter and meaningless here.
    expect(merged.nested.z).toEqual([3, 700, 1])
  })

  // -------------------------------------------------------------------------
  // The laws again, at tree level, over shapes that disagree with each other
  // -------------------------------------------------------------------------

  // Shape-stable trees: every peer agrees on which nodes are leaves and which
  // are containers. This is what normal operation produces — shape comes from
  // the schema, and even a delete preserves it, because deleting a record entry
  // tombstones the leaves inside it rather than replacing the subtree with one
  // tuple. The laws are guaranteed here, and this is the set that matters.
  const TREES: StateTree[] = [
    { k: { x: tup("live", 100), y: [1, 100] } },
    { k: { x: tup("other", 100), y: [1, 100] } }, // ties with the above on x
    { k: { x: tup("live", 300), y: [1, 100] } },
    { k: { x: tup(null, 200, true), y: tup(null, 200, true) } }, // deleted entry
    { k: { x: tup(null, 100, true), y: [1, 100] } }, // partially tombstoned
    { k: { x: tup("live", 400), y: [9, 50] } },
    { k: {} }, // empty container — distinct from a deleted one
    {}, // key absent entirely
  ]

  const fresh = (tree: StateTree): StateTree =>
    JSON.parse(JSON.stringify(tree)) as StateTree

  const law = (
    name: string,
    check: (a: StateTree, b: StateTree, c: StateTree) => boolean,
  ) => {
    const divergent: string[] = []
    for (const a of TREES) {
      for (const b of TREES) {
        for (const c of TREES) {
          if (!check(a, b, c)) {
            divergent.push(
              `${name}: ${JSON.stringify(a)}, ${JSON.stringify(b)}, ${JSON.stringify(c)}`,
            )
          }
        }
      }
    }
    return divergent
  }

  it("is commutative over shape-stable trees", () => {
    const divergent: string[] = []
    for (const a of TREES) {
      for (const b of TREES) {
        const ab = merge(fresh(a), fresh(b)).tree
        const ba = merge(fresh(b), fresh(a)).tree
        if (!sameState(ab, ba)) {
          divergent.push(
            `${JSON.stringify(a)} vs ${JSON.stringify(b)} → ${JSON.stringify(ab)} / ${JSON.stringify(ba)}`,
          )
        }
      }
    }
    expect(divergent).toEqual([])
  })

  it("is associative over shape-stable trees", () => {
    expect(
      law("assoc", (a, b, c) => {
        const left = merge(merge(fresh(a), fresh(b)).tree, fresh(c)).tree
        const right = merge(fresh(a), merge(fresh(b), fresh(c)).tree).tree
        return sameState(left, right)
      }),
    ).toEqual([])
  })

  it("is idempotent over shape-stable trees", () => {
    for (const a of TREES) {
      expect(JSON.stringify(merge(fresh(a), fresh(a)).tree)).toBe(
        JSON.stringify(a),
      )
    }
  })

  it("resolves a leaf-versus-container shape conflict commutatively", () => {
    // Well-formed peers cannot produce this — shape comes from the schema — so
    // it is the degraded path for malformed or mismatched-schema payloads.
    // Commutativity still holds, which the old "remote always wins" did not.
    // Associativity deliberately does NOT hold and is not claimed: the losing
    // side's contents are discarded, so no later merge can recover them.
    const leaf: StateTree = { k: tup("leaf", 300) }
    const container: StateTree = { k: { x: [1, 100] } }
    expect(merge(fresh(leaf), fresh(container)).tree).toEqual(
      merge(fresh(container), fresh(leaf)).tree,
    )
  })

  it("does not alias the remote payload it merged from", () => {
    // The merged tree adopts remote's winning tuples. If it adopted them by
    // reference, a later local write would reach back and mutate a payload the
    // caller still owns.
    const remote = treeB()
    const merged = merge({ scalar: tup("A", 1) }, remote).tree as Record<
      string,
      StateTuple
    >
    merged.scalar[0] = "mutated"
    expect((remote as any).scalar[0]).toBe("B")
  })
})

describe("StateVersion carries no lineage", () => {
  it("always reports DEFAULT_LINEAGE", () => {
    // `Version.lineage` is the writer-identity coordinate. A substrate that
    // mints a REAL one is telling the exchange "my history is a distinct
    // identity from yours", which triggers a lineage-boundary reset: local
    // state is discarded and the peer's snapshot adopted wholesale.
    //
    // That is exactly wrong for this substrate. A field-level LWW merge has no
    // history and no identity to diverge — every payload is absorbable, and
    // replacing local state would drop concurrent field writes the sender has
    // not seen yet. Reporting DEFAULT_LINEAGE is what keeps a transient
    // document out of the reset path altogether.
    //
    // The other half of that invariant — durability excluding the compaction
    // trigger — lives in @kyneta/exchange's `reset-trigger.test.ts`, which
    // points back here. Changing this line means revisiting the replicate arm
    // of `Synchronizer.#executeImportDocData`.
    expect(new StateVersion("epoch", 7).lineage).toBe(DEFAULT_LINEAGE)
    expect(new StateVersion("epoch", 0).lineage).toBe(DEFAULT_LINEAGE)
  })
})

// A join reports whether it moved, and the answer has to be exact. It is what
// a peer uses to decide there is news worth relaying, and a false positive is
// not wasted bytes but a cycle: every peer relays to everyone but the sender,
// so in a mesh of three there is always somewhere left to forward to.
describe("the join reports whether it moved", () => {
  it("merging an identical tree changes nothing", () => {
    const tree = { peers: { alice: tup("online", 1000) } }
    expect(merge(tree, { peers: { alice: tup("online", 1000) } }).changed).toBe(
      false,
    )
  })

  it("a losing tuple changes nothing", () => {
    const tree = { peers: { alice: tup("new", 2000) } }
    expect(merge(tree, { peers: { alice: tup("old", 1000) } }).changed).toBe(
      false,
    )
  })

  it("a tie the incoming tuple wins, with equal content, changes nothing", () => {
    // `joinTuples` returns the incoming tuple on some ties, so identity is not
    // the test — two peers holding the same value must not keep announcing it.
    const tree = { peers: { alice: tup("same", 1000) } }
    expect(merge(tree, { peers: { alice: tup("same", 1000) } }).changed).toBe(
      false,
    )
  })

  it("a newer timestamp on the same value is a change", () => {
    // The timestamp replicates and decay reads it, so it is state.
    const tree = { peers: { alice: tup("online", 1000) } }
    expect(merge(tree, { peers: { alice: tup("online", 2000) } }).changed).toBe(
      true,
    )
  })

  it("a key we have never seen is a change", () => {
    const tree = { peers: { alice: tup("online", 1000) } }
    expect(merge(tree, { peers: { bob: tup("online", 1000) } }).changed).toBe(
      true,
    )
  })

  it("a tombstone arriving over a live value is a change", () => {
    const tree = { peers: { alice: tup("online", 1000) } }
    expect(
      merge(tree, { peers: { alice: tup(null, 2000, true) } }).changed,
    ).toBe(true)
  })
})

describe("a version advances whenever state advances", () => {
  it("two changes inside one millisecond produce different versions", () => {
    const replica = ephemeralReplicaFactory.createEmpty()
    const payload = (value: string, ts: number) => ({
      kind: "entirety" as const,
      encoding: "json" as const,
      data: JSON.stringify({ a: [value, ts] }),
      lineage: "genesis",
    })
    replica.merge(payload("first", 1000))
    const first = replica.version().serialize()
    replica.merge(payload("second", 2000))
    // No clock gap: `Date.now()` would hand back the same value here, and a
    // caller comparing versions would read a real change as none.
    expect(replica.version().serialize()).not.toBe(first)
  })
})

// The install ordinal is the one slot a peer must never see, and the one a
// comparison must never read. Both halves have a failure mode that looks
// like working software: leak it to the wire and the tombstone marker moves,
// read it in a comparison and every merge reports a change.
describe("the install ordinal stays local", () => {
  const entirety = (data: string) => ({
    kind: "entirety" as const,
    encoding: "json" as const,
    data,
    lineage: "genesis",
  })

  it("never reaches the wire, and leaves the tombstone where peers expect it", () => {
    const replica = ephemeralReplicaFactory.createEmpty()
    replica.merge(
      entirety(
        JSON.stringify({
          peers: { alice: ["online", 100], bob: [null, 200, true] },
        }),
      ),
    )

    // Byte-identical to what a peer spoke before the ordinal existed: three
    // slots for a tombstone, two for a live value, and the marker at index 2.
    expect(replica.exportEntirety().data).toBe(
      '{"peers":{"alice":["online",100],"bob":[null,200,true]}}',
    )
  })

  it("does not reach the digest, so opposite install orders agree", () => {
    const fromB = { peers: { bob: tup("here", 200) } }
    const fromC = { peers: { carol: tup("here", 300) } }

    // Same leaves, opposite arrival order, so every ordinal differs.
    const bThenC = merge(merge({}, fromB).tree, fromC).tree
    const cThenB = merge(merge({}, fromC).tree, fromB).tree

    expect(stateTreeDigest(bThenC)).toEqual(stateTreeDigest(cThenB))
  })

  it("does not reach the join, so a re-merge reports no change", () => {
    // The guard against the three-peer cycle. A merge that reported a change
    // here would have every peer re-announce everything it receives.
    const tree = { peers: { alice: tup("online", 100) } }
    const incoming = { peers: { alice: tup("online", 100) } }
    expect(merge(tree, incoming).changed).toBe(false)
  })

  it("survives a round trip through the wire unchanged", () => {
    const original = JSON.stringify({ peers: { alice: ["online", 100] } })
    const a = ephemeralReplicaFactory.createEmpty()
    a.merge(entirety(original))
    const b = ephemeralReplicaFactory.createEmpty()
    b.merge(entirety(a.exportEntirety().data as string))

    expect(b.exportEntirety().data).toBe(original)
  })
})

describe("a no-op merge leaves no trace", () => {
  it("does not advance the version, across a millisecond boundary", () => {
    // The boundary is the test. Both merges inside one tick share a wall
    // clock, so the old unconditional bump looked correct — which is exactly
    // how it survived until three peers wedged on it.
    const payload = {
      kind: "entirety" as const,
      encoding: "json" as const,
      data: JSON.stringify({ a: ["hello", 1000] }),
      lineage: "genesis",
    }
    const replica = ephemeralReplicaFactory.createEmpty()

    replica.merge(payload)
    const first = replica.version().serialize()

    const until = Date.now() + 3
    while (Date.now() < until) {
      /* spin past the millisecond boundary */
    }
    replica.merge(payload)

    expect(replica.version().serialize()).toBe(first)
  })
})
