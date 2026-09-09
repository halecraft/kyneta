// === Unified Weighted Datalog Evaluator ===
// Replaces both `evaluate.ts` (batch) and `incremental-evaluate.ts`
// (incremental) with a single evaluator implementation based on DBSP
// Z-set weight propagation.
//
// Key design:
// - `Relation` stores `{ tuple, weight }` per entry (Phase 1).
// - `Substitution` carries `{ bindings, weight }` (Phase 1).
// - Rule evaluation threads weights through joins (Phase 1).
// - A **dirty map** tracks which facts were modified during stratum
//   evaluation. `distinct` clamps weights to 0/1 on dirty entries only.
//   Delta extraction compares pre-weights to post-weights via the dirty
//   map — no snapshot-and-diff.
// - One `createEvaluator(rules)` subsumes both batch and incremental
//   paths. `evaluate(rules, facts)` is a convenience wrapper.
//
// See Plan 006.1, Phase 2.
// See DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins), §4–5.
// See theory/incremental.md §9.

import type { ZSet, ZSetEntry } from "../base/zset.js"
import {
  zsetEmpty,
  zsetForEach,
  zsetFromEntries,
  zsetIsEmpty,
} from "../base/zset.js"
import type { FugueBeforePair, ResolvedWinner } from "../kernel/resolve.js"
import { fuguePairKey } from "../kernel/resolve.js"
import type { WeightedFact } from "./evaluate.js"
import {
  evaluateRule,
  evaluateRuleDelta,
  getNegationAtomIndices,
  getPositiveAtomIndices,
} from "./evaluate.js"
import {
  bodyPredicates,
  headPredicates,
  type Stratum,
  stratify,
} from "./stratify.js"
import type {
  AtomElement,
  BodyElement,
  Fact,
  FactTuple,
  ReadonlyDatabase,
  Result,
  Rule,
  StratificationError,
  Term,
} from "./types.js"
import {
  Database,
  err,
  factKey,
  factKeyFromTupleKey,
  ok,
  type Relation,
  serializeTuple,
  tupleKeyFromFactKey,
} from "./types.js"

// ---------------------------------------------------------------------------
// Dirty Map — tracks facts modified during stratum evaluation
//
// Key discipline: a fact's key is computed once, where the fact is created
// (`factsToZSet` for ground facts, `groundHead` for derived), and carried.
// Relations and this map use the tuple key; Z-sets at the boundary use the
// fact key. Re-keying a fact the evaluator already holds was its top cost.
// ---------------------------------------------------------------------------

/**
 * A dirty-map entry records a derived fact's weight *before* the current
 * stratum evaluation began. `preWeight` is captured on first touch and never
 * overwritten. After convergence, comparing `preWeight` to the current weight
 * in the db reveals which facts crossed zero (the output delta).
 */
interface DirtyEntry {
  readonly tuple: FactTuple
  readonly preWeight: number
}

/** predicate → tupleKey → entry. Two levels so the inner key is the relation's own. */
type DirtyMap = Map<string, Map<string, DirtyEntry>>

// ---------------------------------------------------------------------------
// Dirty-map helpers
// ---------------------------------------------------------------------------

/**
 * Did a weight change cross the presence boundary? +1 for absent→present,
 * −1 for present→absent, 0 otherwise. A change from 2 to 1 is 0: only
 * presence matters to the next semi-naive iteration and to the output delta.
 */
function presenceChange(before: number, after: number): -1 | 0 | 1 {
  const was = before > 0
  const is = after > 0
  if (!was && is) return 1
  if (was && !is) return -1
  return 0
}

/**
 * Apply a derived weighted fact to the database, record its pre-weight in
 * the dirty map on first touch, and add it to `delta` if its presence
 * changed. Facts whose presence changed seed the next semi-naive iteration.
 */
function applyDerivedFact(
  wf: WeightedFact,
  db: Database,
  dirty: DirtyMap,
  delta: Database,
): void {
  if (wf.weight === 0) return

  const pred = wf.fact.predicate
  const rel = db.relation(pred)
  const before = rel.getWeightByKey(wf.tupleKey)

  let dirtyRel = dirty.get(pred)
  if (dirtyRel === undefined) {
    dirtyRel = new Map()
    dirty.set(pred, dirtyRel)
  }
  if (!dirtyRel.has(wf.tupleKey)) {
    dirtyRel.set(wf.tupleKey, { tuple: wf.fact.values, preWeight: before })
  }

  const after = rel.addWeightedByKey(wf.tupleKey, wf.fact.values, wf.weight)
  const change = presenceChange(before, after)
  if (change !== 0) {
    delta.relation(pred).addWeightedByKey(wf.tupleKey, wf.fact.values, change)
  }
}

/**
 * Apply `distinct` to all dirty entries: negative-floor only.
 *
 * DBSP's `distinct` operator is `distinct(w)(x) = max(0, w(x))` — it
 * floors negatives to 0 but does NOT clamp positives to 1. Weights > 1
 * represent genuine independent derivation paths (true Z-set multiplicity)
 * and must be preserved for correct retraction accounting.
 *
 * - weight < 0 → set to 0 (via addWeighted with -w, which prunes the entry).
 *   `clampedWeight` is already 0 from the eager update in `addWeighted`.
 * - weight >= 0 → no action. `clampedWeight` is already correct from the
 *   eager update in `addWeighted`.
 *
 * Returns true if any weight was clamped (callers may use this for
 * convergence checks in negation strata).
 *
 * See Plan 006.2, Phase 0, Task 0.2.
 * See DBSP (Budiu & McSherry, 2023) §5 (nested streams, distinct operator).
 */
function applyDistinct(db: Database, dirty: DirtyMap): boolean {
  let clamped = false
  for (const [pred, dirtyRel] of dirty) {
    const rel = db.getRelation(pred)
    for (const [tupleKey, { tuple }] of dirtyRel) {
      const w = rel.getWeightByKey(tupleKey)
      if (w < 0) {
        // Floor to 0: add (-w) to reach 0, which prunes the entry.
        rel.addWeightedByKey(tupleKey, tuple, -w)
        clamped = true
      }
      // weight >= 0: no action. True multiplicity (weight > 1) is preserved.
      // clampedWeight is already correct from eager update in addWeighted.
    }
  }
  return clamped
}

/**
 * Extract the output delta from the dirty map after stratum convergence:
 * every dirty fact whose presence differs from its `preWeight`, as +1 or −1.
 */
function extractDelta(db: Database, dirty: DirtyMap): Database {
  const delta = new Database()
  for (const [pred, dirtyRel] of dirty) {
    const rel = db.getRelation(pred)
    for (const [tupleKey, { tuple, preWeight }] of dirtyRel) {
      const change = presenceChange(preWeight, rel.getWeightByKey(tupleKey))
      if (change !== 0) {
        delta.relation(pred).addWeightedByKey(tupleKey, tuple, change)
      }
    }
  }
  return delta
}

// ---------------------------------------------------------------------------
// Stratum evaluation
// ---------------------------------------------------------------------------

/** Safety bound to prevent infinite loops. */
const MAX_ITERATIONS = 100_000

/**
 * Check if a stratum has aggregation body elements.
 *
 * Aggregation strata still require wipe-and-recompute because
 * differential aggregation (tracking per-group state changes) is
 * substantially more complex. This is a scoped limitation — negation
 * strata now use the unified differential loop.
 *
 * See Plan 006.2, Phase 2, Task 2.6.
 */
function stratumHasAggregation(rules: readonly Rule[]): boolean {
  return rules.some(r => r.body.some(b => b.kind === "aggregation"))
}

/**
 * Lazy read-only view of a database with a delta subtracted.
 *
 * Computes P_old = P_new − Δ lazily: `getRelation(pred)` returns the
 * base relation unchanged when the delta has no entries for that
 * predicate, and materializes `base.subtract(delta)` on first access
 * otherwise. Materialized results are cached for the lifetime of the
 * view instance.
 *
 * This replaces the eager `constructDbOld` which called `db.clone()`
 * (O(|db|) — copying every predicate's entire relation) followed by
 * weight subtraction. The lazy view is O(|delta|) in the common case
 * where rule bodies reference many predicates but the delta touches
 * only a few.
 *
 * Used for the asymmetric join: positions after deltaIdx use P_old,
 * positions before deltaIdx use P_new (= db).
 *
 * See Plan 007, Phase 1.5, Task 1.5.2.
 */
export class DatabaseView implements ReadonlyDatabase {
  private readonly _cache: Map<string, Relation> = new Map()

  constructor(
    private readonly _base: Database,
    private readonly _delta: Database,
  ) {}

  getRelation(predicate: string): Relation {
    // Fast path: check cache first (for repeated access to the same predicate).
    const cached = this._cache.get(predicate)
    if (cached !== undefined) return cached

    const baseRel = this._base.getRelation(predicate)
    const deltaRel = this._delta.getRelation(predicate)

    // No delta entries for this predicate — share the base relation directly.
    if (deltaRel.allEntryCount === 0) return baseRel

    // Materialize P_old for this predicate: base − delta.
    const result = baseRel.subtract(deltaRel)
    this._cache.set(predicate, result)
    return result
  }

  predicates(): Iterable<string> {
    return this._base.predicates()
  }

  hasFact(f: Fact): boolean {
    return this.getRelation(f.predicate).has(f.values)
  }
}

/**
 * Evaluate a single stratum given an input delta, using the unified
 * weighted semi-naive loop with deferred delta, asymmetric join, and
 * differential negation.
 *
 * This is the functional core of the evaluator — a pure-ish function
 * that mutates `db` as a side effect of convergence and returns the
 * output delta.
 *
 * **Unified algorithm** (positive-only, negation, or mixed strata):
 * The same weighted semi-naive loop handles all stratum types uniformly.
 * Positive atoms and negation atoms are both eligible as delta sources.
 * The asymmetric join prevents self-join double-counting. Differential
 * negation handles sign inversion for negated predicates.
 *
 * **Aggregation strata** are the sole exception: they delegate to
 * `recomputeAggregationStratum` (wipe-and-recompute), because
 * differential aggregation requires per-group state tracking.
 *
 * **Asymmetric join**: `db` arrives as P_new (the input delta is
 * already applied by the caller). The seed phase constructs
 * P_old = P_new - inputDelta for the asymmetric join. This avoids
 * cloning or snapshotting the full database.
 *
 * @param rules        Rules for this stratum.
 * @param db           The accumulated database (mutated in place).
 *                     Must be P_new (post-delta) on entry.
 * @param inputDelta   The input delta — facts whose weight changed.
 * @returns            Output delta Database (facts with weight +1 or −1).
 *
 * See Plan 006.2, Phase 2, Tasks 2.2–2.5.
 * See DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins), §4–5.
 */
export function evaluateStratumFromDelta(
  rules: readonly Rule[],
  db: Database,
  inputDelta: Database,
): Database {
  // Aggregation strata: wipe-and-recompute (scoped limitation).
  if (stratumHasAggregation(rules)) {
    return recomputeAggregationStratum(rules, db)
  }

  const dirty: DirtyMap = new Map()

  // --- Seed phase (asymmetric join) ---
  //
  // db is P_new (input delta already applied by the caller).
  // Construct a lazy view for P_old = P_new - inputDelta.
  // The DatabaseView only materializes the subtraction for predicates
  // actually accessed during rule evaluation — O(|delta|), not O(|db|).
  //
  // The asymmetric join ensures each derivation path is counted
  // exactly once: positions after deltaIdx use P_old (the view),
  // positions before deltaIdx use P_new (= db).

  const dbOld: ReadonlyDatabase = new DatabaseView(db, inputDelta)

  // Collect all seed-derived facts without applying them yet.
  const seedDerived: WeightedFact[] = []

  for (const rule of rules) {
    const positiveAtomIndices = getPositiveAtomIndices(rule.body)
    const negationAtomIndices = getNegationAtomIndices(rule.body)

    if (positiveAtomIndices.length === 0 && negationAtomIndices.length === 0) {
      // Rule with no positive or negation atoms (empty body or only guards).
      // Evaluate against db (P_new) — these fire unconditionally.
      const derived = evaluateRule(rule, db, db)
      for (const wf of derived) {
        seedDerived.push(wf)
      }
    } else if (inputDelta.hasAnyEntries()) {
      // Positive atom delta sources.
      //
      // Only atoms whose predicate actually changed are worth driving. If the
      // delta holds nothing for this atom's predicate, `evaluatePositiveAtom`
      // matches against an empty relation, yields zero substitutions, and
      // `evaluateRuleDelta` provably returns []. Skipping is not a heuristic —
      // it removes a call whose result is already known.
      //
      // Worth knowing: the negation loop below has always had this guard. The
      // positive loop did not, and the cost was invisible because it produced
      // no wrong answers, only a full |body[0]| x |body[1]| scan per iteration
      // per predicate that happened not to have changed.
      for (const deltaIdx of positiveAtomIndices) {
        const atomPred = (rule.body[deltaIdx]! as AtomElement).atom.predicate
        if (inputDelta.getRelation(atomPred).allEntryCount === 0) continue

        const derived = evaluateRuleDelta(rule, dbOld, db, inputDelta, deltaIdx)
        for (const wf of derived) {
          seedDerived.push(wf)
        }
      }

      // Negation atom delta sources (differential negation).
      for (const negIdx of negationAtomIndices) {
        const negAtom = (
          rule.body[negIdx]! as {
            kind: "negation"
            atom: { predicate: string }
          }
        ).atom
        if (inputDelta.getRelation(negAtom.predicate).allEntryCount > 0) {
          const derived = evaluateRuleDelta(rule, dbOld, db, inputDelta, negIdx)
          for (const wf of derived) {
            seedDerived.push(wf)
          }
        }
      }
    }
  }

  if (!inputDelta.hasAnyEntries() && seedDerived.length === 0) {
    // No input delta and no unconditional derivations — nothing to do.
    return extractDelta(db, dirty)
  }

  // Apply seed-derived facts to db and detect zero-crossings.
  // Note: we do NOT record inputDelta facts in the dirty map — those
  // are input facts owned by lower strata or ground facts, not derived
  // facts owned by this stratum. The dirty map only tracks facts that
  // this stratum derives (touched by applyDerivedFact / touchFact).
  let currentDelta = new Database()
  for (const wf of seedDerived) {
    applyDerivedFact(wf, db, dirty, currentDelta)
  }

  applyDistinct(db, dirty)

  // --- Iteration phase (asymmetric join with derived deltas) ---
  let iterations = 0
  while (currentDelta.hasAnyEntries() && iterations < MAX_ITERATIONS) {
    iterations++

    // Construct a lazy view for P_old: db - currentDelta.
    // This is needed for the asymmetric join on self-join predicates.
    // The view materializes only predicates accessed by rule bodies.
    const dbOldIter: ReadonlyDatabase = new DatabaseView(db, currentDelta)

    const nextDelta = new Database()

    for (const rule of rules) {
      // Positive atom delta sources (asymmetric semi-naive).
      // Same skip as the seed phase — see the comment there.
      const positiveAtomIndices = getPositiveAtomIndices(rule.body)
      for (const deltaIdx of positiveAtomIndices) {
        const atomPred = (rule.body[deltaIdx]! as AtomElement).atom.predicate
        if (currentDelta.getRelation(atomPred).allEntryCount === 0) continue

        const derived = evaluateRuleDelta(
          rule,
          dbOldIter,
          db,
          currentDelta,
          deltaIdx,
        )
        for (const wf of derived) {
          applyDerivedFact(wf, db, dirty, nextDelta)
        }
      }

      // Negation atom delta sources (differential negation).
      const negationAtomIndices = getNegationAtomIndices(rule.body)
      for (const negIdx of negationAtomIndices) {
        const negAtom = (
          rule.body[negIdx]! as {
            kind: "negation"
            atom: { predicate: string }
          }
        ).atom
        if (currentDelta.getRelation(negAtom.predicate).allEntryCount > 0) {
          const derived = evaluateRuleDelta(
            rule,
            dbOldIter,
            db,
            currentDelta,
            negIdx,
          )
          for (const wf of derived) {
            applyDerivedFact(wf, db, dirty, nextDelta)
          }
        }
      }
    }

    applyDistinct(db, dirty)
    currentDelta = nextDelta
  }

  return extractDelta(db, dirty)
}

/**
 * Wipe-and-recompute for aggregation-only strata.
 *
 * Aggregation is a group-by boundary that resets provenance. Differential
 * aggregation would require maintaining per-group state — substantially
 * more complex than differential negation. This is retained as a scoped
 * limitation for aggregation strata only.
 *
 * See Plan 006.2, Phase 2, Tasks 2.6–2.7.
 */
function recomputeAggregationStratum(
  rules: readonly Rule[],
  db: Database,
): Database {
  const dirty: DirtyMap = new Map()

  // Record pre-wipe weights in the dirty map and delete all derived facts.
  for (const pred of headPredicates(rules)) {
    const rel = db.getRelation(pred)
    const dirtyRel = new Map<string, DirtyEntry>()
    const present: [string, FactTuple, number][] = []
    rel.forEachEntry((tupleKey, tuple, weight) => {
      if (weight > 0) present.push([tupleKey, tuple, weight])
    })
    for (const [tupleKey, tuple, weight] of present) {
      dirtyRel.set(tupleKey, { tuple, preWeight: weight })
      rel.addWeightedByKey(tupleKey, tuple, -weight)
    }
    if (dirtyRel.size > 0) dirty.set(pred, dirtyRel)
  }

  // Naive iteration: re-derive all facts.
  let changed = true
  let iterations = 0
  while (changed && iterations < MAX_ITERATIONS) {
    changed = false
    iterations++
    for (const rule of rules) {
      const derived = evaluateRule(rule, db, db)
      for (const wf of derived) {
        const pred = wf.fact.predicate
        const rel = db.relation(pred)
        if (wf.weight > 0 && rel.getWeightByKey(wf.tupleKey) <= 0) {
          let dirtyRel = dirty.get(pred)
          if (dirtyRel === undefined) {
            dirtyRel = new Map()
            dirty.set(pred, dirtyRel)
          }
          if (!dirtyRel.has(wf.tupleKey)) {
            dirtyRel.set(wf.tupleKey, { tuple: wf.fact.values, preWeight: 0 })
          }
          rel.addWeightedByKey(wf.tupleKey, wf.fact.values, 1)
          changed = true
        }
      }
    }
  }

  return extractDelta(db, dirty)
}

// ---------------------------------------------------------------------------
// Stratum dependency analysis (migrated from incremental-evaluate.ts)
// ---------------------------------------------------------------------------

/**
 * Build a map: predicate → set of stratum indices whose rules reference
 * that predicate in their body. Used to determine which strata are
 * affected by a change in a given predicate.
 */
function buildPredicateToAffectedStrata(
  strata: readonly Stratum[],
): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>()

  for (const stratum of strata) {
    for (const rule of stratum.rules) {
      const preds = bodyPredicates(rule.body)
      for (const pred of preds) {
        let set = result.get(pred)
        if (set === undefined) {
          set = new Set()
          result.set(pred, set)
        }
        set.add(stratum.index)
      }
    }
  }

  return result
}

/**
 * Determine which stratum indices are affected by a set of changed
 * predicates, considering transitive propagation through strata.
 *
 * Returns affected stratum indices in bottom-up (ascending) order.
 */
function computeAffectedStrata(
  changedPredicates: ReadonlySet<string>,
  strata: readonly Stratum[],
  predToStrata: ReadonlyMap<string, ReadonlySet<number>>,
): number[] {
  const affected = new Set<number>()
  const visited = new Set<string>(changedPredicates)

  // Collect all head predicates per stratum for propagation.
  const stratumHeads = new Map<number, Set<string>>()
  for (const stratum of strata) {
    const heads = headPredicates(stratum.rules)
    stratumHeads.set(stratum.index, heads)
  }

  // BFS: when a stratum is affected, its head predicates may affect
  // higher strata.
  const predQueue = [...changedPredicates]
  while (predQueue.length > 0) {
    const pred = predQueue.pop()!
    const affectedByPred = predToStrata.get(pred)
    if (affectedByPred === undefined) continue

    for (const stratumIdx of affectedByPred) {
      if (!affected.has(stratumIdx)) {
        affected.add(stratumIdx)
        const heads = stratumHeads.get(stratumIdx)
        if (heads !== undefined) {
          for (const head of heads) {
            if (!visited.has(head)) {
              visited.add(head)
              predQueue.push(head)
            }
          }
        }
      }
    }
  }

  // Return in ascending order (bottom-up evaluation).
  return [...affected].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// Stratum helpers (migrated from incremental-evaluate.ts)
// ---------------------------------------------------------------------------

/**
 * Get the set of head predicates for a stratum (the "derived" predicates).
 */
function stratumDerivedPredicates(stratum: Stratum): Set<string> {
  return headPredicates(stratum.rules)
}

// ---------------------------------------------------------------------------
// Rule identity (migrated from incremental-evaluate.ts)
// ---------------------------------------------------------------------------

/**
 * Produce a stable identity string for a rule (for matching on retraction).
 * Structural identity — same head/body shape → same key.
 */
function ruleIdentity(r: Rule): string {
  const headPart = `${r.head.predicate}(${r.head.terms.map(termId).join(",")})`
  const bodyParts = r.body.map(bodyElementId).join(";")
  return `${headPart}:-${bodyParts}`
}

function termId(t: Term): string {
  switch (t.kind) {
    case "const":
      return `c:${String(t.value)}`
    case "var":
      return `v:${t.name}`
    case "wildcard":
      return "_"
  }
}

function bodyElementId(b: BodyElement): string {
  switch (b.kind) {
    case "atom":
      return `+${b.atom.predicate}(${b.atom.terms.map(termId).join(",")})`
    case "negation":
      return `-${b.atom.predicate}(${b.atom.terms.map(termId).join(",")})`
    case "guard":
      return `g:${b.op}(${termId(b.left)},${termId(b.right)})`
    case "aggregation":
      return `a:${b.agg.fn}`
  }
}

// ---------------------------------------------------------------------------
// Resolution extraction from delta Database
// ---------------------------------------------------------------------------

/**
 * Convert winner fact deltas from a delta `Database` into a
 * `ZSet<ResolvedWinner>`.
 *
 * Winner fact schema: `winner(SlotId, CnIdKey, Content)`
 *
 * The delta Database has weight +1 (new winner) or −1 (retracted winner).
 * We group by slotId and apply replacement semantics:
 *   - Both +1 and −1 for same slot → emit only +1 (replacement).
 *   - Only +1 → emit +1 (new winner).
 *   - Only −1 → emit −1 (winner removed).
 *
 * This matches the skeleton's expectation and the native LWW solver's
 * delta contract.
 */
function winnerFactsToResolution(deltaDb: Database): ZSet<ResolvedWinner> {
  const rel = deltaDb.getRelation("winner")
  const entries = rel.allWeightedTuples()

  if (entries.length === 0) {
    return zsetEmpty<ResolvedWinner>()
  }

  // Group by slotId for replacement semantics.
  const bySlot = new Map<
    string,
    { plus: ResolvedWinner | null; minus: ResolvedWinner | null }
  >()

  for (const { tuple, weight } of entries) {
    const slotId = tuple[0] as string
    const winner: ResolvedWinner = {
      slotId,
      winnerCnIdKey: tuple[1] as string,
      content: tuple[2]!,
    }

    let slot = bySlot.get(slotId)
    if (slot === undefined) {
      slot = { plus: null, minus: null }
      bySlot.set(slotId, slot)
    }

    if (weight > 0) {
      slot.plus = winner
    } else if (weight < 0) {
      slot.minus = winner
    }
  }

  // Produce resolution delta with replacement semantics.
  const resolved: [string, ZSetEntry<ResolvedWinner>][] = []

  for (const [slotId, slot] of bySlot) {
    if (slot.plus !== null) {
      // New winner, or a replacement (both +1 and −1 present for the slot):
      // either way only the +1 is emitted.
      resolved.push([slotId, { element: slot.plus, weight: 1 }])
    } else if (slot.minus !== null) {
      // Winner removed: emit −1.
      resolved.push([slotId, { element: slot.minus, weight: -1 }])
    }
  }

  return zsetFromEntries(resolved)
}

/**
 * Convert fugue_before fact deltas from a delta `Database` into a
 * `ZSet<FugueBeforePair>`.
 *
 * Fugue before fact schema: `fugue_before(Parent, A, B)`
 */
function fuguePairFactsToResolution(deltaDb: Database): ZSet<FugueBeforePair> {
  const rel = deltaDb.getRelation("fugue_before")
  const entries = rel.allWeightedTuples()

  if (entries.length === 0) {
    return zsetEmpty<FugueBeforePair>()
  }

  const pairs: [string, ZSetEntry<FugueBeforePair>][] = []

  for (const { tuple, weight } of entries) {
    const pair: FugueBeforePair = {
      parentKey: tuple[0] as string,
      a: tuple[1] as string,
      b: tuple[2] as string,
    }
    pairs.push([
      fuguePairKey(pair),
      { element: pair, weight: weight > 0 ? 1 : -1 },
    ])
  }

  return zsetFromEntries(pairs)
}

/**
 * Convert a delta `Database` into a `ZSet<Fact>` of everything it changed.
 *
 * Weights are normalised to ±1: the delta already records presence changes,
 * so multiplicity carries no extra information downstream.
 */
function derivedFactsToZSet(deltaDb: Database): ZSet<Fact> {
  const entries: [string, ZSetEntry<Fact>][] = []
  for (const pred of deltaDb.predicates()) {
    deltaDb.getRelation(pred).forEachEntry((tupleKey, tuple, weight) => {
      entries.push([
        factKeyFromTupleKey(pred, tupleKey),
        {
          element: { predicate: pred, values: tuple },
          weight: weight > 0 ? 1 : -1,
        },
      ])
    })
  }
  return zsetFromEntries(entries)
}

const EMPTY_STEP_RESULT: EvaluatorStepResult = {
  deltaResolved: zsetEmpty<ResolvedWinner>(),
  deltaFuguePairs: zsetEmpty<FugueBeforePair>(),
  deltaDerived: zsetEmpty<Fact>(),
}

/**
 * The step result for a delta database: winner and Fugue pair deltas for
 * the skeleton, plus every derived fact that changed. All three `step`
 * paths end here.
 */
function resultFromDelta(delta: Database): EvaluatorStepResult {
  if (!delta.hasAnyEntries()) return EMPTY_STEP_RESULT
  return {
    deltaResolved: winnerFactsToResolution(delta),
    deltaFuguePairs: fuguePairFactsToResolution(delta),
    deltaDerived: derivedFactsToZSet(delta),
  }
}

/**
 * Build `step` input from plain facts: every entry keyed by `factKey`, with
 * the given weight (+1 to insert, −1 to retract). Duplicate facts sum into
 * one entry.
 *
 * This is the documented way to key a `ZSet<Fact>` for the evaluator, which
 * trusts the key rather than recomputing it. Built in one pass; a fold over
 * `zsetAdd` is quadratic (see TECHNICAL.md, "Evaluator performance").
 */
/**
 * The tuple key for a fact the caller supplied a Z-set key for.
 *
 * `factsToZSet` keys by `factKey`, which is `predicate|tupleKey`, so the tuple
 * key is already in hand and costs a slice rather than a re-serialization —
 * the reason `step` takes keyed input at all. A caller that keys its Z-set
 * some other way is not punished with a wrong answer: the key is checked
 * against the predicate, and anything else is serialized the slow way.
 */
function tupleKeyFor(zsetKey: string, f: Fact): string {
  return tupleKeyFromFactKey(zsetKey, f.predicate) ?? serializeTuple(f.values)
}

export function factsToZSet(facts: readonly Fact[], weight = 1): ZSet<Fact> {
  return zsetFromEntries(facts.map(f => [factKey(f), { element: f, weight }]))
}

// ---------------------------------------------------------------------------
// Evaluator interface
// ---------------------------------------------------------------------------

/**
 * The step result from the unified evaluator.
 */
export interface EvaluatorStepResult {
  /** Resolution deltas for the skeleton stage. */
  readonly deltaResolved: ZSet<ResolvedWinner>
  /** Fugue pair deltas for the skeleton stage. */
  readonly deltaFuguePairs: ZSet<FugueBeforePair>
  /** All derived fact deltas (for downstream consumers). */
  readonly deltaDerived: ZSet<Fact>
}

/**
 * A unified Datalog evaluator that subsumes both batch and incremental
 * evaluation.
 *
 * Follows the three shared conventions:
 *   1. step(deltaFacts, deltaRules) — process deltas, return resolution deltas
 *   2. currentDatabase() — return full accumulated Database
 *   3. reset() — return to empty state
 */
export interface Evaluator {
  /**
   * Process a delta of ground facts and optional rule changes.
   *
   * @param deltaFacts - Z-set delta of ground facts.
   * @param deltaRules - Changed rules (+1 = added, −1 = retracted).
   *   Empty on most insertions.
   * @returns Resolution deltas and derived fact deltas.
   */
  step(deltaFacts: ZSet<Fact>, deltaRules: ZSet<Rule>): EvaluatorStepResult

  /** The full accumulated Database (ground + derived facts). */
  currentDatabase(): Database

  /**
   * Extract the current resolution from the accumulated Database.
   */
  currentResolution(): {
    winners: ReadonlyMap<string, ResolvedWinner>
    fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>
  }

  /** Reset to empty state. */
  reset(): void
}

// ---------------------------------------------------------------------------
// Evaluator construction
// ---------------------------------------------------------------------------

/**
 * Create a new unified Datalog evaluator.
 *
 * The evaluator maintains persistent state across time steps. Each call
 * to `step(deltaFacts, deltaRules)` applies the delta to the accumulated
 * database, evaluates affected strata using weighted semi-naive, and
 * returns the resolution delta.
 *
 * @param initialRules - The initial set of rules.
 * @returns An Evaluator instance with empty state.
 */
export function createEvaluator(initialRules: readonly Rule[]): Evaluator {
  // --- Mutable state ---

  /** Accumulated database: ground + derived facts. */
  let db = new Database()

  /** Current rules. */
  let rules: Rule[] = [...initialRules]

  /** Current stratification (recomputed on rule changes). */
  let strata: readonly Stratum[] = []

  /** Map from stratum index → Stratum for O(1) lookup. */
  let strataByIndex: Map<number, Stratum> = new Map()

  /** Map from predicate → affected stratum indices. */
  let predToStrata: Map<string, Set<number>> = new Map()

  /** All derived predicates across all strata. */
  let allDerivedPreds: Set<string> = new Set()

  /** Whether step() has ever been called. Used by batch wrappers to
   *  ensure strata are evaluated even with zero ground facts (rules
   *  with empty bodies must still fire on first invocation). */
  let hasBeenStepped = false

  // Initialize stratification.
  restratify()

  // --- Internal helpers ---

  function restratify(): void {
    if (rules.length === 0) {
      strata = []
      strataByIndex = new Map()
      predToStrata = new Map()
      allDerivedPreds = new Set()
      return
    }

    const result = stratify(rules)
    if (!result.ok) {
      // Cyclic negation — clear strata.
      strata = []
      strataByIndex = new Map()
      predToStrata = new Map()
      allDerivedPreds = new Set()
      return
    }

    strata = result.value
    strataByIndex = new Map()
    for (const s of strata) {
      strataByIndex.set(s.index, s)
    }
    predToStrata = buildPredicateToAffectedStrata(strata)
    allDerivedPreds = headPredicates(rules)
  }

  /** Present tuples of `preds`, by predicate and tuple key. */
  function presenceSnapshot(
    preds: ReadonlySet<string>,
  ): Map<string, Map<string, FactTuple>> {
    const snapshot = new Map<string, Map<string, FactTuple>>()
    for (const pred of preds) {
      const present = new Map<string, FactTuple>()
      db.getRelation(pred).forEachEntry((tupleKey, tuple, weight) => {
        if (weight > 0) present.set(tupleKey, tuple)
      })
      snapshot.set(pred, present)
    }
    return snapshot
  }

  /**
   * Apply a ground-fact delta to `db`. Returns the predicates touched.
   */
  function applyGroundDelta(deltaFacts: ZSet<Fact>): Set<string> {
    const changedPreds = new Set<string>()
    zsetForEach(deltaFacts, (entry, key) => {
      const pred = entry.element.predicate
      db.relation(pred).addWeightedByKey(
        tupleKeyFor(key, entry.element),
        entry.element.values,
        entry.weight,
      )
      changedPreds.add(pred)
    })
    return changedPreds
  }

  // --- Public interface ---

  function step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): EvaluatorStepResult {
    // --- Handle rule changes ---
    if (!zsetIsEmpty(deltaRules)) {
      // Apply rule changes.
      zsetForEach(deltaRules, entry => {
        if (entry.weight > 0) {
          rules.push(entry.element)
        } else if (entry.weight < 0) {
          const rKey = ruleIdentity(entry.element)
          const idx = rules.findIndex(r => ruleIdentity(r) === rKey)
          if (idx !== -1) {
            rules.splice(idx, 1)
          }
        }
      })

      // Track all derived preds (old + new) for complete snapshot.
      const oldDerivedPreds = new Set(allDerivedPreds)

      // Restratify with new rules.
      restratify()

      // Union of old and new derived preds for snapshot scope.
      const allRelevantPreds = new Set([...oldDerivedPreds, ...allDerivedPreds])

      // Snapshot what is derived now, then wipe it. This path still uses
      // snapshot-and-diff (Plan 006.1 retired it elsewhere); it is rare.
      const before = presenceSnapshot(allRelevantPreds)
      for (const [pred, present] of before) {
        const rel = db.getRelation(pred)
        for (const [tupleKey, tuple] of present) {
          rel.addWeightedByKey(tupleKey, tuple, -rel.getWeightByKey(tupleKey))
        }
      }

      // Apply ground fact delta first (if any).
      applyGroundDelta(deltaFacts)

      // Replay all strata from scratch.
      for (const stratum of strata) {
        if (stratum.rules.length === 0) continue

        // For full replay, seed with all ground facts that are inputs
        // to this stratum.
        const inputDelta = new Database()
        for (const pred of db.predicates()) {
          if (!allDerivedPreds.has(pred)) {
            // Ground predicate — include all facts as input delta.
            for (const tuple of db.getRelation(pred).tuples()) {
              inputDelta.addFact({ predicate: pred, values: tuple })
            }
          }
        }
        // Also include derived facts from lower strata (already computed).
        for (const s of strata) {
          if (s.index >= stratum.index) break
          for (const pred of stratumDerivedPredicates(s)) {
            for (const tuple of db.getRelation(pred).tuples()) {
              inputDelta.addFact({ predicate: pred, values: tuple })
            }
          }
        }

        evaluateStratumFromDelta(stratum.rules, db, inputDelta)
      }

      // Diff presence before and after into a delta database.
      const delta = new Database()
      for (const [pred, wasPresent] of before) {
        const rel = db.getRelation(pred)
        const deltaRel = delta.relation(pred)
        rel.forEachEntry((tupleKey, tuple, weight) => {
          if (weight > 0 && !wasPresent.has(tupleKey)) {
            deltaRel.addWeightedByKey(tupleKey, tuple, 1)
          }
        })
        for (const [tupleKey, tuple] of wasPresent) {
          if (rel.getWeightByKey(tupleKey) <= 0) {
            deltaRel.addWeightedByKey(tupleKey, tuple, -1)
          }
        }
      }
      return resultFromDelta(delta)
    }

    // --- No rule change — incremental evaluation ---

    if (zsetIsEmpty(deltaFacts)) {
      if (hasBeenStepped) return EMPTY_STEP_RESULT
      // First invocation with no facts — still need to evaluate strata
      // for rules with empty bodies (e.g., axiom(42) :- .).
      hasBeenStepped = true

      const outputDelta = new Database()
      for (const stratum of strata) {
        if (stratum.rules.length === 0) continue
        outputDelta.addAllWeighted(
          evaluateStratumFromDelta(stratum.rules, db, new Database()),
        )
      }
      return resultFromDelta(outputDelta)
    }

    hasBeenStepped = true

    // 1. Apply the ground-fact delta to the accumulated db.
    const changedPreds = applyGroundDelta(deltaFacts)

    // 2. Determine affected strata.
    const affectedIndices = computeAffectedStrata(
      changedPreds,
      strata,
      predToStrata,
    )

    if (affectedIndices.length === 0) {
      return EMPTY_STEP_RESULT
    }

    // 3. Build initial input delta from ground fact changes.
    const currentInputDelta = new Database()
    zsetForEach(deltaFacts, (entry, key) => {
      currentInputDelta
        .relation(entry.element.predicate)
        .addWeightedByKey(
          tupleKeyFor(key, entry.element),
          entry.element.values,
          entry.weight,
        )
    })

    // 4. Evaluate affected strata bottom-up.
    // Each stratum's output delta feeds the next stratum's input.
    // The unified loop handles all stratum types (positive, negation,
    // mixed) uniformly — no retractionsPresent flag needed.
    const outputDelta = new Database()

    for (const stratumIdx of affectedIndices) {
      const stratum = strataByIndex.get(stratumIdx)
      if (stratum === undefined || stratum.rules.length === 0) continue

      const stratumDelta = evaluateStratumFromDelta(
        stratum.rules,
        db,
        currentInputDelta,
      )

      // The stratum's output joins the cumulative output and feeds higher
      // strata, which see changes from ground facts and lower derivations.
      outputDelta.addAllWeighted(stratumDelta)
      currentInputDelta.addAllWeighted(stratumDelta)
    }

    return resultFromDelta(outputDelta)
  }

  function currentDatabase(): Database {
    return db
  }

  function currentResolution(): {
    winners: ReadonlyMap<string, ResolvedWinner>
    fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>
  } {
    // Extract winners from the winner relation.
    const winners = new Map<string, ResolvedWinner>()
    for (const tuple of db.getRelation("winner").tuples()) {
      const slotId = tuple[0] as string
      const winnerCnIdKey = tuple[1] as string
      const content = tuple[2]!
      winners.set(slotId, { slotId, winnerCnIdKey, content })
    }

    // Extract fugue pairs from the fugue_before relation.
    const fuguePairs = new Map<string, FugueBeforePair[]>()
    for (const tuple of db.getRelation("fugue_before").tuples()) {
      const parentKey = tuple[0] as string
      const a = tuple[1] as string
      const b = tuple[2] as string
      const pair: FugueBeforePair = { parentKey, a, b }

      let existing = fuguePairs.get(parentKey)
      if (existing === undefined) {
        existing = []
        fuguePairs.set(parentKey, existing)
      }
      existing.push(pair)
    }

    return { winners, fuguePairs }
  }

  function reset(): void {
    db = new Database()
    rules = []
    strata = []
    strataByIndex = new Map()
    predToStrata = new Map()
    allDerivedPreds = new Set()
    hasBeenStepped = false
  }

  return { step, currentDatabase, currentResolution, reset }
}

// ---------------------------------------------------------------------------
// Batch wrappers
// ---------------------------------------------------------------------------

/**
 * Evaluate a Datalog program (rules + ground facts) and return the
 * complete minimal model.
 *
 * This is a convenience wrapper over `createEvaluator`. It creates a
 * fresh evaluator, feeds all facts as +1, and returns the database.
 * The batch pipeline's `solve()` calls this.
 *
 * @param rules  The Datalog rules to evaluate.
 * @param facts  Ground facts (base relations).
 * @returns      The complete database (ground facts + all derived facts),
 *               or a StratificationError if rules have cyclic negation.
 */
export function evaluateUnified(
  rules: readonly Rule[],
  facts: readonly Fact[],
): Result<Database, StratificationError> {
  // Validate stratification upfront for the error path.
  if (rules.length > 0) {
    const stratResult = stratify(rules)
    if (!stratResult.ok) {
      return err(stratResult.error)
    }
  }

  return ok(evaluateBatch(rules, facts))
}

/**
 * Evaluate a positive Datalog program (no negation, no aggregation).
 * Convenience wrapper that skips stratification validation.
 *
 * @param rules  Positive Datalog rules.
 * @param facts  Ground facts.
 * @returns      The complete database.
 */
export function evaluatePositiveUnified(
  rules: readonly Rule[],
  facts: readonly Fact[],
): Database {
  return evaluateBatch(rules, facts)
}

/** One fresh evaluator, every fact as +1, its database as the result. */
function evaluateBatch(
  rules: readonly Rule[],
  facts: readonly Fact[],
): Database {
  if (rules.length === 0) {
    // No rules means no strata, so an evaluator would have nothing to seed;
    // the result is just the ground facts.
    const db = new Database()
    for (const f of facts) {
      db.addFact(f)
    }
    return db
  }

  // The evaluator's own database is the result. Filling a separate one first
  // used to cost a full serialize-and-insert pass that was then thrown away.
  const evaluator = createEvaluator(rules)
  evaluator.step(factsToZSet(facts), zsetEmpty())

  return evaluator.currentDatabase()
}
