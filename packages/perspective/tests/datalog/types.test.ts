// === Key Discipline and Relation Tests ===
//
// Two things live here, and they are related.
//
// 1. `serializeTuple` — the single key-building primitive. `Relation`'s tuple
//    keys, the join index's bucket keys, `factKey` and aggregation's group keys
//    are all built from it, so its injectivity is load-bearing for all of them.
//
// 2. `Relation`'s behaviour under *non-monotone* mutation — weights driven to
//    zero, negative weights, removal. The roguelike workload that motivated the
//    join index only ever adds facts, so it exercises none of this. These tests
//    are the baseline the join index has to reproduce; they were written before
//    the index existed, so they characterize the relation rather than confirm
//    the index agrees with itself.

import { describe, expect, it } from "vitest"
import { evaluateAggregation } from "../../src/datalog/aggregate.js"
import type { FactTuple, Probe, Value } from "../../src/datalog/types.js"
import {
  ALL_POSITIONS,
  aggregation,
  atom,
  Database,
  fact,
  factKey,
  factKeyFromTupleKey,
  Relation,
  serializeTuple,
  serializeValue,
  tupleKeyFromFactKey,
  varTerm,
} from "../../src/datalog/types.js"
import {
  EMPTY_SUBSTITUTION,
  extendSubstitution,
} from "../../src/datalog/unify.js"

const $ = varTerm

// ---------------------------------------------------------------------------
// serializeTuple — the key discipline
// ---------------------------------------------------------------------------

describe("serializeTuple", () => {
  it("the default mask and ALL_POSITIONS agree", () => {
    const t = ["a", 1, true, null, 2n]
    expect(serializeTuple(t)).toBe(serializeTuple(t, ALL_POSITIONS))
  })

  it("the default mask covers arity > 31, where the shift count wraps", () => {
    // JavaScript shifts modulo 32, so `1 << 32` is `1`, not `0`. That is
    // exactly why ALL_POSITIONS works at any arity: `-1 & (any power of two)`
    // is always nonzero. Guarding this because it reads like an accident.
    const wide = Array.from({ length: 40 }, (_v, i) => i)
    const parts = serializeTuple(wide).split("|")
    expect(parts).toHaveLength(40)
    expect(serializeTuple(wide)).toBe(serializeTuple(wide, ALL_POSITIONS))
  })

  it("a masked key ignores unmasked positions — the point of the index", () => {
    // Two adjacency tuples that share their first two positions land in the
    // same bucket. Narrowing the search, not answering the query.
    const mask = 0b0011
    expect(serializeTuple([1, 2, 3, 4], mask)).toBe(
      serializeTuple([1, 2, 9, 9], mask),
    )
  })

  it("a masked key separates tuples that differ inside the mask", () => {
    const mask = 0b0011
    expect(serializeTuple([1, 2, 3, 4], mask)).not.toBe(
      serializeTuple([1, 5, 3, 4], mask),
    )
  })

  it("is injective across value types that must never unify", () => {
    // number(3) and bigint(3n) are distinct types in this engine (§3).
    expect(serializeTuple([3])).not.toBe(serializeTuple([3n]))
    expect(serializeTuple([0])).not.toBe(serializeTuple([-0]))
    expect(serializeTuple([null])).not.toBe(serializeTuple(["null"]))
    expect(serializeTuple([true])).not.toBe(serializeTuple(["true"]))
  })

  it("is injective when a string value contains the separator", () => {
    // Length-prefixed strings keep the concatenation uniquely decodable.
    expect(serializeTuple(["a|b"])).not.toBe(serializeTuple(["a", "b"]))
  })

  it("matches the original implementation byte for byte", () => {
    // The key format is a contract beyond this package: downstream code sorts
    // facts by it and compares trace snapshots built from it. The serializer
    // has been rewritten for speed (integer fast path, no intermediate array),
    // so this pins the output to the original, allocation-heavy definition
    // across every value type and every kind of mask.
    const referenceValue = (v: Value): string => {
      if (v === null) return "N"
      if (typeof v === "boolean") return v ? "T" : "F"
      if (typeof v === "number")
        return `f:${Object.is(v, -0) ? "-0" : String(v)}`
      if (typeof v === "bigint") return `i:${String(v)}`
      if (typeof v === "string") return `s:${v.length}:${v}`
      if (v instanceof Uint8Array) {
        let hex = "b:"
        for (let j = 0; j < v.length; j++) {
          hex += (v[j]! < 16 ? "0" : "") + v[j]?.toString(16)
        }
        return hex
      }
      return `r:${v.ref.peer}:${v.ref.counter}`
    }
    const referenceTuple = (tuple: FactTuple, mask: number): string => {
      const parts: string[] = []
      for (let i = 0; i < tuple.length; i++) {
        if ((mask & (1 << i)) !== 0) parts.push(referenceValue(tuple[i]!))
      }
      return parts.join("|")
    }

    const values: Value[] = [
      null,
      true,
      false,
      0,
      -0,
      1,
      -1,
      2 ** 31 - 1,
      2 ** 31,
      -(2 ** 31),
      2 ** 53,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      7n,
      -7n,
      "",
      "a|b",
      "héllo",
      new Uint8Array([]),
      new Uint8Array([0, 15, 16, 255]),
      { ref: { peer: "p", counter: 3 } },
    ]

    for (const v of values) {
      expect(serializeValue(v)).toBe(referenceValue(v))
    }
    for (const mask of [0, 0b1, 0b101, 0b110, ALL_POSITIONS]) {
      expect(serializeTuple(values, mask)).toBe(referenceTuple(values, mask))
      expect(serializeTuple([], mask)).toBe(referenceTuple([], mask))
    }
  })
})

describe("factKey", () => {
  it("separates facts differing only by predicate", () => {
    expect(factKey(fact("p", [1]))).not.toBe(factKey(fact("q", [1])))
  })

  it("separates facts differing only by arity", () => {
    expect(factKey(fact("p", [1]))).not.toBe(factKey(fact("p", [1, 1])))
  })

  it("separates facts differing only by a value's type", () => {
    expect(factKey(fact("p", [3]))).not.toBe(factKey(fact("p", [3n])))
  })

  it("separates a zero-arity fact from same-named facts with values", () => {
    const nullary = factKey(fact("p", []))
    expect(nullary).not.toBe(factKey(fact("p", [1])))
    expect(nullary).not.toBe(factKey(fact("p", [null])))
    expect(nullary).not.toBe(factKey(fact("p|", [])))
  })
})

// ---------------------------------------------------------------------------
// Aggregation grouping — the unbound vs bound-to-null distinction
//
// `resolveGroupValues` is private, so these exercise it through the only
// caller. The distinction matters: an *unbound* grouping variable means the
// substitution cannot form a group at all, while a variable *bound to null*
// forms a perfectly good group keyed on null.
// ---------------------------------------------------------------------------

describe("aggregation grouping", () => {
  const db = new Database()
  db.addFact(fact("score", [null, 10]))
  db.addFact(fact("score", [null, 20]))
  db.addFact(fact("score", ["a", 5]))

  it("groups on a variable bound to null", () => {
    const agg = aggregation({
      fn: "sum",
      groupBy: ["G"],
      over: "V",
      result: "Total",
      source: atom("score", [$("G"), $("V")]),
    }).agg

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION)
    const nullGroup = results.find(r => r.bindings.get("G") === null)
    expect(nullGroup?.bindings.get("Total")).toBe(30)
  })

  it("skips a substitution whose grouping variable never gets bound", () => {
    // `G` is not among the source atom's terms, so nothing can bind it.
    const agg = aggregation({
      fn: "count",
      groupBy: ["Missing"],
      over: "V",
      result: "N",
      source: atom("score", [$("G"), $("V")]),
    }).agg

    expect(evaluateAggregation(agg, db, EMPTY_SUBSTITUTION)).toHaveLength(0)
  })

  it("groups on a variable bound by the incoming substitution", () => {
    const agg = aggregation({
      fn: "count",
      groupBy: ["G"],
      over: "V",
      result: "N",
      source: atom("score", [$("G"), $("V")]),
    }).agg

    const sub = extendSubstitution(EMPTY_SUBSTITUTION, "G", "a")
    const results = evaluateAggregation(agg, db, sub)
    expect(results).toHaveLength(1)
    expect(results[0]?.bindings.get("N")).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Relation under non-monotone mutation
//
// `weight` is the true Z-set multiplicity and may go negative mid-iteration;
// `clampedWeight` is the 0/1 presence signal. `tuples()` / `weightedTuples()`
// read the clamp; `allWeightedTuples()` / `getWeight()` read the true weight.
// ---------------------------------------------------------------------------

describe("Relation under non-monotone mutation", () => {
  it("prunes a tuple whose weight is driven to exactly zero", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 2)
    rel.addWeighted(["a"], -2)

    expect(rel.tuples()).toHaveLength(0)
    expect(rel.weightedTuples()).toHaveLength(0)
    expect(rel.allWeightedTuples()).toHaveLength(0)
    expect(rel.getWeight(["a"])).toBe(0)
    expect(rel.has(["a"])).toBe(false)
  })

  it("retains a negative-weight tuple, hidden from the clamped readers", () => {
    // This is the entry state the two `candidates` modes must disagree about:
    // a retraction that has overshot and not yet been floored by `distinct`.
    const rel = new Relation()
    rel.addWeighted(["a"], -1)

    expect(rel.has(["a"])).toBe(false)
    expect(rel.tuples()).toHaveLength(0)
    expect(rel.weightedTuples()).toHaveLength(0)
    expect(rel.allWeightedTuples()).toEqual([{ tuple: ["a"], weight: -1 }])
    expect(rel.getWeight(["a"])).toBe(-1)
    expect(rel.allEntryCount).toBe(1)
  })

  it("restores a tuple driven negative and back, at its original position", () => {
    // Going negative does NOT delete the entry, so the tuple keeps its place
    // in insertion order. Contrast with the prune-and-reinsert case below.
    const rel = new Relation()
    rel.add(["first"])
    rel.add(["target"])
    rel.add(["last"])

    rel.addWeighted(["target"], -3)
    expect(rel.tuples()).toEqual([["first"], ["last"]])

    rel.addWeighted(["target"], 3)
    expect(rel.getWeight(["target"])).toBe(1)
    expect(rel.tuples()).toEqual([["first"], ["target"], ["last"]])
  })

  it("moves a pruned-then-reinserted tuple to the end of insertion order", () => {
    // Prune deletes the Map entry, so reinserting appends. The join index has
    // to move it identically, or bucket order would stop matching scan order —
    // which is what makes indexed lookups order-preserving.
    const rel = new Relation()
    rel.add(["first"])
    rel.add(["target"])
    rel.add(["last"])

    rel.addWeighted(["target"], -1) // weight 1 -> 0, entry pruned
    expect(rel.allEntryCount).toBe(2)

    rel.add(["target"])
    expect(rel.tuples()).toEqual([["first"], ["last"], ["target"]])
  })

  it("reports no change when removing an already-absent negative entry", () => {
    // The `clampedWeight <= 0` branch of `remove()`: the entry exists in the
    // map but is not present, so removal prunes it and reports no change.
    const rel = new Relation()
    rel.addWeighted(["a"], -1)

    expect(rel.remove(["a"])).toBe(false)
    expect(rel.allEntryCount).toBe(0)
    expect(rel.getWeight(["a"])).toBe(0)
  })

  it("reports a change when removing a present entry", () => {
    const rel = new Relation()
    rel.add(["a"])

    expect(rel.remove(["a"])).toBe(true)
    expect(rel.remove(["a"])).toBe(false)
  })

  it("keeps true multiplicity distinct from the presence signal", () => {
    const rel = new Relation()
    rel.addWeighted(["a"], 3)

    expect(rel.getWeight(["a"])).toBe(3)
    expect(rel.weightedTuples()).toEqual([{ tuple: ["a"], weight: 1 }])
    expect(rel.allWeightedTuples()).toEqual([{ tuple: ["a"], weight: 3 }])
  })
})

// ---------------------------------------------------------------------------
// The join index
//
// Every assertion here is phrased as "the index agrees with an unindexed
// scan", not as a fresh expectation. That is the contract: `candidates()`
// returns a superset of the matches in scan order, so the index can narrow
// the search but never change an answer.
// ---------------------------------------------------------------------------

/** What `candidates()` must agree with: a scan filtered by the probe. */
function scanFiltered(
  rel: Relation,
  probe: Probe,
  allEntries: boolean,
): readonly { tuple: FactTuple; weight: number }[] {
  const all = allEntries ? rel.allWeightedTuples() : rel.weightedTuples()
  return all.filter(w => serializeTuple(w.tuple, probe.mask) === probe.key)
}

/** A relation large enough to cross MIN_INDEXED_SIZE (16). */
function adjacencyRelation(cells = 6): Relation {
  const rel = new Relation()
  for (let x = 0; x < cells; x++) {
    for (let y = 0; y < cells; y++) {
      rel.add([x, y, x + 1, y])
      rel.add([x, y, x, y + 1])
    }
  }
  return rel
}

describe("Relation join index", () => {
  const mask = 0b0011 // first two positions bound, as in adj(X1, Y1, _, _)
  const probeAt = (x: number, y: number): Probe => ({
    mask,
    key: serializeTuple([x, y], mask),
  })

  it("returns a superset of the matches, and only real candidates", () => {
    const rel = adjacencyRelation()
    const got = rel.candidates(probeAt(2, 3), false)

    expect(got).toEqual(scanFiltered(rel, probeAt(2, 3), false))
    expect(got).toHaveLength(2) // right and down neighbours
    for (const { tuple } of got) {
      expect([tuple[0], tuple[1]]).toEqual([2, 3])
    }
  })

  it("returns nothing for a key no tuple carries", () => {
    const rel = adjacencyRelation()
    expect(rel.candidates(probeAt(99, 99), false)).toHaveLength(0)
  })

  it("preserves scan order within a bucket", () => {
    // The order-preservation property: candidate order equals the full scan
    // filtered to the same tuples. Everything downstream of `tuples()` depends
    // on derived facts arriving in an unchanged order.
    const rel = new Relation()
    for (let i = 0; i < 20; i++) rel.add(["shared", i])
    for (let i = 0; i < 20; i++) rel.add(["other", i])

    const probe: Probe = { mask: 0b01, key: serializeTuple(["shared"], 0b01) }
    expect(rel.candidates(probe, false)).toEqual(
      scanFiltered(rel, probe, false),
    )
  })

  it("scans below MIN_INDEXED_SIZE and agrees once past it", () => {
    const small = new Relation()
    small.add([1, 1, 2, 1])
    small.add([1, 1, 1, 2])
    // Too small to index — must still answer correctly, by scanning.
    expect(small.candidates(probeAt(1, 1), false)).toEqual(
      scanFiltered(small, probeAt(1, 1), false),
    )

    const large = adjacencyRelation()
    expect(large.candidates(probeAt(1, 1), false)).toEqual(
      scanFiltered(large, probeAt(1, 1), false),
    )
  })

  it("a zero mask falls back to the full scan", () => {
    const rel = adjacencyRelation()
    const probe: Probe = { mask: 0, key: "" }
    expect(rel.candidates(probe, false)).toEqual(rel.weightedTuples())
    expect(rel.candidates(probe, true)).toEqual(rel.allWeightedTuples())
  })

  it("tracks tuples added after the index was built", () => {
    const rel = adjacencyRelation()
    rel.candidates(probeAt(0, 0), false) // force the index to exist
    rel.add([0, 0, 99, 99])

    expect(rel.candidates(probeAt(0, 0), false)).toEqual(
      scanFiltered(rel, probeAt(0, 0), false),
    )
  })

  it("agrees with a scan across the whole 0 / negative / positive cycle", () => {
    // The paths a monotone workload never reaches. An entry pruned at zero
    // must leave its bucket; an entry at negative weight must stay in the
    // bucket but be invisible to the clamped reader.
    const rel = adjacencyRelation()
    rel.candidates(probeAt(1, 1), false) // force the index to exist
    const target: FactTuple = [1, 1, 2, 1]

    const agrees = () => {
      expect(rel.candidates(probeAt(1, 1), false)).toEqual(
        scanFiltered(rel, probeAt(1, 1), false),
      )
      expect(rel.candidates(probeAt(1, 1), true)).toEqual(
        scanFiltered(rel, probeAt(1, 1), true),
      )
    }

    rel.addWeighted(target, -1) // 1 -> 0, entry pruned
    expect(rel.getWeight(target)).toBe(0)
    agrees()

    rel.addWeighted(target, -1) // absent -> -1, entry retained but not present
    expect(rel.getWeight(target)).toBe(-1)
    expect(
      rel.candidates(probeAt(1, 1), true).map(c => c.tuple),
    ).toContainEqual(target)
    expect(
      rel.candidates(probeAt(1, 1), false).map(c => c.tuple),
    ).not.toContainEqual(target)
    agrees()

    rel.addWeighted(target, 2) // -1 -> 1, present again
    expect(rel.getWeight(target)).toBe(1)
    agrees()

    rel.remove(target)
    agrees()
  })

  it("gives clone() and presenceBefore() results their own index", () => {
    // These build a fresh Relation. If a copy ever shared or inherited the
    // source's index, mutating the source afterwards would corrupt the copy —
    // the failure a missed funnel site would produce.
    const rel = adjacencyRelation()
    rel.candidates(probeAt(0, 0), false) // index the source

    const copy = rel.clone()
    rel.add([0, 0, 77, 77])

    expect(copy.candidates(probeAt(0, 0), false)).toEqual(
      scanFiltered(copy, probeAt(0, 0), false),
    )
    expect(copy.candidates(probeAt(0, 0), false)).toHaveLength(2)
    expect(rel.candidates(probeAt(0, 0), false)).toHaveLength(3)

    const built = rel.presenceBefore(new Relation())
    expect(built.candidates(probeAt(0, 0), false)).toEqual(
      scanFiltered(built, probeAt(0, 0), false),
    )
  })

  it("supports several masks over the same relation at once", () => {
    const rel = adjacencyRelation()
    const byTarget: Probe = {
      mask: 0b1100,
      key: serializeTuple([3, 2], 0b1100),
    }

    expect(rel.candidates(probeAt(3, 2), false)).toEqual(
      scanFiltered(rel, probeAt(3, 2), false),
    )
    expect(rel.candidates(byTarget, false)).toEqual(
      scanFiltered(rel, byTarget, false),
    )

    rel.add([3, 2, 3, 2])
    expect(rel.candidates(probeAt(3, 2), false)).toEqual(
      scanFiltered(rel, probeAt(3, 2), false),
    )
    expect(rel.candidates(byTarget, false)).toEqual(
      scanFiltered(rel, byTarget, false),
    )
  })
})

// ---------------------------------------------------------------------------
// Keyed operations — the evaluator computes a tuple's key once and carries it
//
// The contract is simple: an operation given the key must leave the relation
// in exactly the state the tuple-taking operation would have. Every test here
// is phrased that way.
// ---------------------------------------------------------------------------

describe("Relation keyed operations", () => {
  const tuples: FactTuple[] = [
    [1, 2],
    ["a", null],
    [3n, true],
    [1, 2], // duplicate, to exercise weight summing
  ]

  it("addWeightedByKey agrees with addWeighted, including pruning to zero", () => {
    const byTuple = new Relation()
    const byKey = new Relation()
    const weights = [1, 2, -1, -1]
    tuples.forEach((t, i) => {
      byTuple.addWeighted(t, weights[i]!)
      byKey.addWeightedByKey(serializeTuple(t), t, weights[i]!)
    })

    expect(byKey.tuples()).toEqual(byTuple.tuples())
    expect(byKey.allEntryCount).toBe(byTuple.allEntryCount)
    for (const t of tuples) {
      expect(byKey.getWeightByKey(serializeTuple(t))).toBe(byTuple.getWeight(t))
    }
    // [1, 2] went +1 then −1 and must be gone from both, not left at 0.
    expect(byKey.getWeightByKey(serializeTuple([1, 2]))).toBe(0)
    expect(byKey.allEntryCount).toBe(2)
  })

  it("a zero weight reads without writing, by key as by tuple", () => {
    const rel = new Relation()
    expect(rel.addWeightedByKey(serializeTuple([9]), [9], 0)).toBe(0)
    expect(rel.allEntryCount).toBe(0)
  })

  it("forEachEntry visits every entry with its key, negatives included", () => {
    const rel = new Relation()
    rel.addWeighted([1], 2)
    rel.addWeighted([2], -1)
    rel.addWeighted([3], 1)

    const seen: [string, FactTuple, number][] = []
    rel.forEachEntry((key, tuple, weight) => seen.push([key, tuple, weight]))

    expect(seen.map(([, tuple]) => tuple)).toEqual([[1], [2], [3]])
    expect(seen.map(([, , weight]) => weight)).toEqual([2, -1, 1])
    for (const [key, tuple] of seen) {
      expect(key).toBe(serializeTuple(tuple))
    }
  })

  it("keeps the join index correct through keyed inserts and removals", () => {
    const rel = new Relation()
    for (let x = 0; x < 6; x++) {
      for (let y = 0; y < 6; y++) {
        rel.addWeightedByKey(
          serializeTuple([x, y, x + 1, y]),
          [x, y, x + 1, y],
          1,
        )
      }
    }
    const mask = 0b0011
    const probe: Probe = { mask, key: serializeTuple([2, 3], mask) }
    // Build the index, then mutate by key on both sides of it.
    expect(rel.candidates(probe, false)).toEqual(
      scanFiltered(rel, probe, false),
    )
    rel.addWeightedByKey(serializeTuple([2, 3, 2, 4]), [2, 3, 2, 4], 1)
    rel.addWeightedByKey(serializeTuple([2, 3, 3, 3]), [2, 3, 3, 3], -1)
    expect(rel.candidates(probe, false)).toEqual(
      scanFiltered(rel, probe, false),
    )
    expect(rel.candidates(probe, false)).toHaveLength(1)
  })
})

describe("Database.addAllWeighted", () => {
  it("sums weights, carries retractions, and prunes zeros", () => {
    const summed = new Database()
    summed.addWeightedFact(fact("p", [1]), 1)
    summed.addWeightedFact(fact("p", [2]), 1)

    const delta = new Database()
    delta.addWeightedFact(fact("p", [1]), 1) // now weight 2
    delta.addWeightedFact(fact("p", [2]), -1) // cancels to 0, pruned
    delta.addWeightedFact(fact("p", [3]), -1) // a retraction of nothing
    delta.addWeightedFact(fact("q", [1]), 1) // a new relation

    summed.addAllWeighted(delta)
    expect(summed.getRelation("p").getWeight([1])).toBe(2)
    expect(summed.getRelation("p").allEntryCount).toBe(2) // [1] and [3]
    expect(summed.getRelation("p").getWeight([3])).toBe(-1)
    expect(summed.getRelation("q").getWeight([1])).toBe(1)
  })
})

describe("fact-key helpers", () => {
  it("round-trip through the fact key, even with a separator in the predicate", () => {
    for (const f of [
      fact("p", [1, "x|y"]),
      fact("odd|name", [null]),
      fact("n", []),
    ]) {
      expect(factKey(f)).toBe(
        factKeyFromTupleKey(f.predicate, serializeTuple(f.values)),
      )
      expect(tupleKeyFromFactKey(factKey(f), f.predicate)).toBe(
        serializeTuple(f.values),
      )
    }
  })
})
