// state-lattice — the `state` substrate's merge is a join-semilattice.
//
// A CvRDT converges only if its merge is commutative, associative and
// idempotent. Those three laws are the whole reason two peers can exchange
// state in any order, any number of times, and still agree.
//
// Commutativity used to fail. On a timestamp tie the merge took the remote
// value, described in a comment as "arbitrarily pick remote to be
// deterministic" — but deterministic as a function is not the same as
// commutative, and it is commutativity the peers depend on. Two peers writing
// different values in the same millisecond each kept their own, forever, with
// no error and no convergence.
//
// The laws are checked exhaustively over a small curated set rather than with
// random generation, because the case that broke is the tie, and a generator
// over timestamps would almost never produce two equal ones.

import { describe, expect, it } from "vitest"
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

    const ab = mergeStateTree({ v: ["from-A", 1000] }, b)
    const ba = mergeStateTree({ v: ["from-B", 1000] }, a)

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
    expect(mergeStateTree(treeA(), treeB())).toEqual(
      mergeStateTree(treeB(), treeA()),
    )
  })

  it("is idempotent over a tree", () => {
    const once = mergeStateTree(treeA(), treeB())
    const twice = mergeStateTree(mergeStateTree(treeA(), treeB()), treeB())
    expect(twice).toEqual(once)
  })

  it("unions keys and keeps the higher timestamp per leaf", () => {
    const merged = mergeStateTree(treeA(), treeB()) as any
    expect(merged.nested.x).toEqual([1, 1000]) // local is newer
    expect(merged.nested.y).toEqual([2, 500]) // absent from remote
    expect(merged.nested.z).toEqual([3, 700]) // only in remote
  })

  it("does not alias the remote payload it merged from", () => {
    // The merged tree adopts remote's winning tuples. If it adopted them by
    // reference, a later local write would reach back and mutate a payload the
    // caller still owns.
    const remote = treeB()
    const merged = mergeStateTree({ scalar: ["A", 1] }, remote) as Record<
      string,
      StateTuple
    >
    merged.scalar[0] = "mutated"
    expect((remote as any).scalar[0]).toBe("B")
  })
})
