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
  joinTuples,
  mergeStateTree,
  type StateTree,
  type StateTuple,
} from "../substrates/state-tree.js"

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
  ["from-A", 1000],
  ["from-B", 1000], // ties with the above — the case that used to diverge
  ["from-A", 2000],
  ["from-B", 999],
  [{ kind: "circle", radius: 5 }, 1000], // a register value, tied
  [{ kind: "square", side: 3 }, 1000], // ...against another whole variant
  [null, 1000],
  [undefined, 1000],
  [0, 1000],
  ["", 1000],
  [null, 1000, true], // a tombstone, tied against the live `null` above
  [null, 2000, true], // ...and against the later live write
  [null, 999, true],
]

const clone = (tuple: StateTuple): StateTuple => tuple.slice() as StateTuple

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
    expect(joinTuples(["old", 1000], [circular, 2000])[1]).toBe(2000)
    expect(joinTuples([circular, 2000], ["old", 1000])[1]).toBe(2000)
  })
})

describe("the tie rule", () => {
  it("resolves same-millisecond writes to one agreed value", () => {
    // The exact divergence this fix exists for.
    const a: StateTree = { v: ["from-A", 1000] }
    const b: StateTree = { v: ["from-B", 1000] }

    const ab = mergeStateTree({ v: ["from-A", 1000] }, b).tree
    const ba = mergeStateTree({ v: ["from-B", 1000] }, a).tree

    expect(ab).toEqual(ba)
  })

  it("prefers the greater value, not the later writer", () => {
    // Stated as a decision rather than left to be inferred: a tie IS
    // simultaneity, so there is no later writer to prefer.
    expect(joinTuples(["a", 1000], ["b", 1000])[0]).toBe("b")
    expect(joinTuples(["b", 1000], ["a", 1000])[0]).toBe("b")
  })

  it("keeps a tied register whole rather than blending variants", () => {
    // A sum is stored as one tuple, so the tie-break picks a whole variant.
    // Coherence matters more than which one wins.
    const circle = { kind: "circle", radius: 5 }
    const square = { kind: "square", side: 3 }
    const winner = joinTuples([circle, 1000], [square, 1000])[0] as any
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
    scalar: ["A", 1000],
    nested: { x: [1, 1000], y: [2, 500] },
  })
  const treeB = (): StateTree => ({
    scalar: ["B", 1000],
    nested: { x: [9, 900], z: [3, 700] },
  })

  it("converges regardless of merge direction", () => {
    expect(mergeStateTree(treeA(), treeB()).tree).toEqual(
      mergeStateTree(treeB(), treeA()).tree,
    )
  })

  it("is idempotent over a tree", () => {
    const once = mergeStateTree(treeA(), treeB()).tree
    const twice = mergeStateTree(
      mergeStateTree(treeA(), treeB()).tree,
      treeB(),
    ).tree
    expect(twice).toEqual(once)
  })

  it("unions keys and keeps the higher timestamp per leaf", () => {
    const merged = mergeStateTree(treeA(), treeB()).tree as any
    expect(merged.nested.x).toEqual([1, 1000]) // local is newer
    expect(merged.nested.y).toEqual([2, 500]) // absent from remote
    expect(merged.nested.z).toEqual([3, 700]) // only in remote
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
    { k: { x: ["live", 100], y: [1, 100] } },
    { k: { x: ["other", 100], y: [1, 100] } }, // ties with the above on x
    { k: { x: ["live", 300], y: [1, 100] } },
    { k: { x: [null, 200, true], y: [null, 200, true] } }, // deleted entry
    { k: { x: [null, 100, true], y: [1, 100] } }, // partially tombstoned
    { k: { x: ["live", 400], y: [9, 50] } },
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
        const ab = mergeStateTree(fresh(a), fresh(b)).tree
        const ba = mergeStateTree(fresh(b), fresh(a)).tree
        if (JSON.stringify(ab) !== JSON.stringify(ba)) {
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
        const left = mergeStateTree(
          mergeStateTree(fresh(a), fresh(b)).tree,
          fresh(c),
        ).tree
        const right = mergeStateTree(
          fresh(a),
          mergeStateTree(fresh(b), fresh(c)).tree,
        ).tree
        return JSON.stringify(left) === JSON.stringify(right)
      }),
    ).toEqual([])
  })

  it("is idempotent over shape-stable trees", () => {
    for (const a of TREES) {
      expect(JSON.stringify(mergeStateTree(fresh(a), fresh(a)).tree)).toBe(
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
    const leaf: StateTree = { k: ["leaf", 300] }
    const container: StateTree = { k: { x: [1, 100] } }
    expect(mergeStateTree(fresh(leaf), fresh(container)).tree).toEqual(
      mergeStateTree(fresh(container), fresh(leaf)).tree,
    )
  })

  it("does not alias the remote payload it merged from", () => {
    // The merged tree adopts remote's winning tuples. If it adopted them by
    // reference, a later local write would reach back and mutate a payload the
    // caller still owns.
    const remote = treeB()
    const merged = mergeStateTree({ scalar: ["A", 1] }, remote).tree as Record<
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
    expect(StateVersion.now().lineage).toBe(DEFAULT_LINEAGE)
    expect(new StateVersion(0).lineage).toBe(DEFAULT_LINEAGE)
  })
})

// A join reports whether it moved, and the answer has to be exact. It is what
// a peer uses to decide there is news worth relaying, and a false positive is
// not wasted bytes but a cycle: every peer relays to everyone but the sender,
// so in a mesh of three there is always somewhere left to forward to.
describe("the join reports whether it moved", () => {
  it("merging an identical tree changes nothing", () => {
    const tree = { peers: { alice: ["online", 1000] } }
    expect(
      mergeStateTree(tree, { peers: { alice: ["online", 1000] } }).changed,
    ).toBe(false)
  })

  it("a losing tuple changes nothing", () => {
    const tree = { peers: { alice: ["new", 2000] } }
    expect(
      mergeStateTree(tree, { peers: { alice: ["old", 1000] } }).changed,
    ).toBe(false)
  })

  it("a tie the incoming tuple wins, with equal content, changes nothing", () => {
    // `joinTuples` returns the incoming tuple on some ties, so identity is not
    // the test — two peers holding the same value must not keep announcing it.
    const tree = { peers: { alice: ["same", 1000] } }
    expect(
      mergeStateTree(tree, { peers: { alice: ["same", 1000] } }).changed,
    ).toBe(false)
  })

  it("a newer timestamp on the same value is a change", () => {
    // The timestamp replicates and decay reads it, so it is state.
    const tree = { peers: { alice: ["online", 1000] } }
    expect(
      mergeStateTree(tree, { peers: { alice: ["online", 2000] } }).changed,
    ).toBe(true)
  })

  it("a key we have never seen is a change", () => {
    const tree = { peers: { alice: ["online", 1000] } }
    expect(
      mergeStateTree(tree, { peers: { bob: ["online", 1000] } }).changed,
    ).toBe(true)
  })

  it("a tombstone arriving over a live value is a change", () => {
    const tree = { peers: { alice: ["online", 1000] } }
    expect(
      mergeStateTree(tree, { peers: { alice: [null, 2000, true] } }).changed,
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
