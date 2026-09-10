// === Weighted Datalog Evaluator ===
// The stratum loop over deltas (`evaluateStratumFromDelta`), the long-lived
// `createEvaluator`, the batch wrappers `evaluate` / `evaluatePositive`, and
// `factsToZSet`, the keyed constructor for `step` input.
//
// Facts in, derived facts out. The evaluator knows nothing about constraints,
// winners or Fugue ordering. Those belong to the kernel: `kernel/resolve.ts`
// reads them out of the derived-fact deltas this module returns.
//
// Key design:
// - `Relation` stores `{ tuple, weight }` per entry; `Substitution` carries
//   `{ bindings, weight }`; rule evaluation threads weights through joins.
// - A **dirty map** tracks which facts were modified during stratum
//   evaluation. `distinct` clamps weights to 0/1 on dirty entries only.
//   Delta extraction compares pre-weights to post-weights via the dirty
//   map — no snapshot-and-diff.
// - One `createEvaluator(rules)` serves both batch and incremental use;
//   `evaluate(rules, facts)` is a wrapper over it.
//
// See DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins), §4–5.
// See theory/incremental.md §5.6 (this stage) and §9.

import type { ZSet, ZSetEntry } from "../base/zset.js"
import {
  zsetEmpty,
  zsetForEach,
  zsetFromEntries,
  zsetIsEmpty,
} from "../base/zset.js"
import type { WeightedFact } from "./evaluate.js"
import {
  evaluateRule,
  evaluateRuleDelta,
  getNegationAtomIndices,
  getPositiveAtomIndices,
} from "./evaluate.js"
import {
  EMPTY_HOST,
  type ForeignRelation,
  foreignRelations,
  type Host,
  type HostFunction,
  hostFunctions,
  NO_FUNCTIONS,
} from "./host.js"
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
 * Lazy read-only view of the database as it was before a delta.
 *
 * `getRelation(pred)` returns the base relation unchanged when the delta has
 * no entries for that predicate, and otherwise materializes P_old once,
 * caching it for the lifetime of the view.
 *
 * P_old is rebuilt by `Relation.presenceBefore`, which undoes each presence
 * flip rather than subtracting weights — see there for why the distinction
 * matters.
 *
 * This replaces the eager `constructDbOld`, which cloned every predicate's
 * entire relation on every call. The lazy view is O(|delta|) in the common
 * case where rule bodies reference many predicates but the delta touches
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

    const result = baseRel.presenceBefore(deltaRel)
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

/** For callers with no ground part to protect. Never written to. */
const NO_GROUND: ReadonlyDatabase = new Database()

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
 * Two exceptions recompute the stratum from scratch instead. **Aggregation
 * strata** always do, because a change in an aggregated relation is not a
 * delta source for the rule. **A recursive stratum that a retraction
 * reaches** does, as a stopgap: see `recomputeStratum`.
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
 * @param ground       The ground part of any predicate this stratum derives.
 *                     A predicate can be both inserted and derived; a
 *                     recompute wipes only the derived part.
 * @param functions    The host's point functions, for compute elements.
 * @returns            Output delta Database (facts with weight +1 or −1).
 *
 * See Plan 006.2, Phase 2, Tasks 2.2–2.5.
 * See DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins), §4–5.
 */
export function evaluateStratumFromDelta(
  rules: readonly Rule[],
  db: Database,
  inputDelta: Database,
  ground: ReadonlyDatabase = NO_GROUND,
  functions: ReadonlyMap<string, HostFunction> = NO_FUNCTIONS,
): Database {
  if (
    stratumHasAggregation(rules) ||
    retractsIntoRecursion(rules, db, inputDelta)
  ) {
    return recomputeStratum(rules, db, ground, functions)
  }
  return evaluateStratumSemiNaive(rules, db, inputDelta, functions)
}

/**
 * The weighted semi-naive loop: a seed phase over the asymmetric join, then
 * iterate on presence flips until nothing changes.
 */
function evaluateStratumSemiNaive(
  rules: readonly Rule[],
  db: Database,
  inputDelta: Database,
  functions: ReadonlyMap<string, HostFunction>,
): Database {
  const dirty: DirtyMap = new Map()

  // --- Seed phase (asymmetric join) ---
  //
  // db is P_new (input delta already applied by the caller).
  // Construct a lazy view of the state before inputDelta. The DatabaseView
  // only materializes P_old for predicates actually accessed during rule
  // evaluation — O(|delta|), not O(|db|).
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
      const derived = evaluateRule(rule, db, db, functions)
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

        const derived = evaluateRuleDelta(
          rule,
          dbOld,
          db,
          inputDelta,
          deltaIdx,
          functions,
        )
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
          const derived = evaluateRuleDelta(
            rule,
            dbOld,
            db,
            inputDelta,
            negIdx,
            functions,
          )
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
          functions,
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
            functions,
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
 * Reduce each of `heads` to its ground part, and report every fact that was
 * present before with its weight, keyed like the dirty map.
 *
 * A predicate can be both inserted directly and derived by rules: a ground
 * `lit(0, 0)` seeds the fire that derives the rest of `lit`. The database
 * holds the sum, so a recompute must wipe only the derived part.
 */
function wipeDerived(
  heads: ReadonlySet<string>,
  db: Database,
  ground: ReadonlyDatabase,
): DirtyMap {
  const wiped: DirtyMap = new Map()
  for (const pred of heads) {
    const rel = db.getRelation(pred)
    const groundRel = ground.getRelation(pred)
    const wipedRel = new Map<string, DirtyEntry>()
    rel.forEachEntry((tupleKey, tuple, weight) => {
      if (weight > 0) wipedRel.set(tupleKey, { tuple, preWeight: weight })
    })
    for (const [tupleKey, { tuple, preWeight }] of wipedRel) {
      const keep = Math.max(groundRel.getWeightByKey(tupleKey), 0)
      if (keep !== preWeight) {
        rel.addWeightedByKey(tupleKey, tuple, keep - preWeight)
      }
    }
    if (wipedRel.size > 0) wiped.set(pred, wipedRel)
  }
  return wiped
}

/**
 * Does `inputDelta` retract into a recursive stratum that has something to
 * lose? A stratum with nothing derived yet has nothing to strand, so the
 * loop from the delta is exact and a first load never pays for a recompute.
 */
function retractsIntoRecursion(
  rules: readonly Rule[],
  db: Database,
  inputDelta: Database,
): boolean {
  const heads = headPredicates(rules)
  const recursive = rules.some(rule => {
    for (const pred of bodyPredicates(rule.body)) {
      if (heads.has(pred)) return true
    }
    return false
  })
  if (!recursive) return false
  let derived = false
  for (const pred of heads) {
    if (db.getRelation(pred).allEntryCount > 0) derived = true
  }
  return derived && retractsInto(rules, inputDelta)
}

/**
 * Can `inputDelta` remove a derivation of these rules? A retraction from a
 * positively read predicate can; so can an insertion into a negated one.
 */
function retractsInto(rules: readonly Rule[], inputDelta: Database): boolean {
  const retracting = new Set<string>()
  const inserting = new Set<string>()
  for (const pred of inputDelta.predicates()) {
    inputDelta.getRelation(pred).forEachEntry((_key, _tuple, weight) => {
      if (weight < 0) retracting.add(pred)
      else if (weight > 0) inserting.add(pred)
    })
  }
  return rules.some(rule =>
    rule.body.some(
      el =>
        (el.kind === "atom" && retracting.has(el.atom.predicate)) ||
        (el.kind === "negation" && inserting.has(el.atom.predicate)),
    ),
  )
}

/**
 * Wipe a stratum's derived facts and derive them again from its inputs,
 * returning the presence delta.
 *
 * Aggregation strata always come here, because a change in an aggregated
 * relation is not a delta source for the rule.
 *
 * Retraction into a recursive stratum comes here as a STOPGAP. Counting
 * cannot tell real support from circular support: over cyclic data,
 * `reach(a)` and `reach(b)` hold each other up after the path to both is
 * cut, and the counting loop never retracts them. Per-round counts (DBSP
 * nested streams) fix this at a cost proportional to the change; until then
 * such a retraction costs the whole stratum. Delete `retractsIntoRecursion`
 * and its dispatch in `evaluateStratumFromDelta` when the per-round work
 * lands. See TECHNICAL.md, "Known follow-ups".
 */
function recomputeStratum(
  rules: readonly Rule[],
  db: Database,
  ground: ReadonlyDatabase,
  functions: ReadonlyMap<string, HostFunction>,
): Database {
  const heads = headPredicates(rules)

  // The wipe emits −1 per fact it removes and the replay emits +1 per fact
  // it derives, so a fact present both before and after cancels out.
  const delta = extractDelta(db, wipeDerived(heads, db, ground))

  // Every input the stratum reads, as +1: to the loop, all of it is new.
  // That includes the ground part of its own heads, which seeds it. This is
  // the batch path's seed, and it costs the flood, not the seeding.
  const inputDelta = new Database()
  const seeded = new Set<string>()
  const seed = (pred: string): void => {
    if (seeded.has(pred)) return
    seeded.add(pred)
    const inputRel = inputDelta.relation(pred)
    db.getRelation(pred).forEachEntry((tupleKey, tuple, weight) => {
      if (weight > 0) inputRel.addWeightedByKey(tupleKey, tuple, 1)
    })
  }
  for (const pred of heads) seed(pred)
  for (const rule of rules) {
    for (const pred of bodyPredicates(rule.body)) seed(pred)
  }

  delta.addAllWeighted(
    evaluateStratumSemiNaive(rules, db, inputDelta, functions),
  )
  return delta
}

/**
 * A read-only window onto the database that answers only for a foreign
 * relation's declared inputs. Anything else throws: an undeclared read would
 * see a relation the stratifier never ordered before this one, and fail
 * silently and late instead of loudly and here.
 */
class HostView implements ReadonlyDatabase {
  private readonly inputs: ReadonlySet<string>

  constructor(
    private readonly db: Database,
    private readonly foreign: ForeignRelation,
  ) {
    this.inputs = new Set(foreign.inputs)
  }

  getRelation(predicate: string): Relation {
    if (!this.inputs.has(predicate)) {
      throw new Error(
        `foreign relation "${this.foreign.predicate}" read "${predicate}", which it does not declare as an input`,
      )
    }
    return this.db.getRelation(predicate)
  }

  predicates(): Iterable<string> {
    return this.inputs
  }

  hasFact(f: Fact): boolean {
    return this.getRelation(f.predicate).has(f.values)
  }
}

/**
 * Run a foreign relation and return its presence delta.
 *
 * An opaque operator has no algebraic delta form, so its incremental version
 * is DBSP's general one: run it on the new state and diff against what it
 * produced last time. That is the aggregation path with a function in place
 * of a rule body, built from the same parts. `wipeDerived` takes the head
 * down to its ground part and records every wiped fact's pre-weight; the
 * function's tuples are added through the first-touch idiom
 * `applyDerivedFact` uses, into that same map; one `extractDelta` over the
 * map is then the whole diff: wiped and back is 0, wiped and gone is −1, new
 * is +1. `changed` is passed on as a hint for a memo inside the function and
 * decides nothing here.
 */
function recomputeForeign(
  foreign: ForeignRelation,
  db: Database,
  changed: ReadonlySet<string>,
  ground: ReadonlyDatabase,
): Database {
  const dirty = wipeDerived(new Set([foreign.predicate]), db, ground)
  let dirtyRel = dirty.get(foreign.predicate)
  if (dirtyRel === undefined) {
    dirtyRel = new Map()
    dirty.set(foreign.predicate, dirtyRel)
  }
  const rel = db.relation(foreign.predicate)

  // Set semantics: the function describes a relation, so a tuple it yields
  // twice is present once.
  const seen = new Set<string>()
  for (const tuple of foreign.compute(new HostView(db, foreign), changed)) {
    const tupleKey = serializeTuple(tuple)
    if (seen.has(tupleKey)) continue
    seen.add(tupleKey)
    if (!dirtyRel.has(tupleKey)) {
      dirtyRel.set(tupleKey, { tuple, preWeight: rel.getWeightByKey(tupleKey) })
    }
    rel.addWeightedByKey(tupleKey, tuple, 1)
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
    const reads = new Set<string>(stratum.foreign?.inputs ?? [])
    for (const rule of stratum.rules) {
      for (const pred of bodyPredicates(rule.body)) reads.add(pred)
    }
    for (const pred of reads) {
      let set = result.get(pred)
      if (set === undefined) {
        set = new Set()
        result.set(pred, set)
      }
      set.add(stratum.index)
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
    if (stratum.foreign !== undefined) heads.add(stratum.foreign.predicate)
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
    case "compute":
      return `c:${b.fn}(${b.args.map(termId).join(",")})->${termId(b.result)}`
  }
}

// ---------------------------------------------------------------------------
// Delta conversion
// ---------------------------------------------------------------------------

/**
 * Convert a delta `Database` into the `ZSet<Fact>` that `step` and
 * `changeRules` return: everything that appeared or disappeared, keyed by
 * `factKey`. Every path through the evaluator ends here.
 *
 * Weights are normalised to ±1: the delta already records presence changes,
 * so multiplicity carries no extra information downstream.
 */
function derivedFactsToZSet(deltaDb: Database): ZSet<Fact> {
  if (!deltaDb.hasAnyEntries()) return zsetEmpty()
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

/**
 * Build `step` input from plain facts: every entry keyed by `factKey`, with
 * the given weight (+1 to insert, −1 to retract). Duplicate facts sum into
 * one entry.
 *
 * This is the documented way to key a `ZSet<Fact>` for the evaluator, which
 * trusts the key rather than recomputing it. Built in one pass; a fold over
 * `zsetAdd` is quadratic (see TECHNICAL.md, "Evaluator performance").
 */
export function factsToZSet(facts: readonly Fact[], weight = 1): ZSet<Fact> {
  return zsetFromEntries(facts.map(f => [factKey(f), { element: f, weight }]))
}

// ---------------------------------------------------------------------------
// Evaluator interface
// ---------------------------------------------------------------------------

/**
 * A long-lived Datalog evaluator: ground facts go in as deltas, derived
 * facts come out as deltas, and the database accumulates between calls.
 *
 * Both `step` and `changeRules` return the same thing, a `ZSet<Fact>` of the
 * derived facts that appeared (+1) or disappeared (−1), keyed by `factKey`.
 * They are separate methods because they cost different things: a fact
 * delta is incremental, while a rule change derives every stratum again and
 * returns a full diff. An optional parameter would hide that.
 */
export interface Evaluator {
  /**
   * Apply a delta of ground facts and return the derived facts that
   * changed. Key entries by `factKey` (`factsToZSet` does); the evaluator
   * reads the tuple key out of it instead of re-serializing.
   */
  step(delta: ZSet<Fact>): ZSet<Fact>

  /**
   * Add (+1) or retract (−1) rules, then derive every stratum again from
   * scratch. Returns the derived facts that changed as a result.
   */
  changeRules(delta: ZSet<Rule>): ZSet<Fact>

  /**
   * The live database, ground plus derived facts. Not a snapshot: the next
   * `step` mutates it, so read what you need before stepping again.
   */
  currentDatabase(): Database
}

// ---------------------------------------------------------------------------
// Evaluator construction
// ---------------------------------------------------------------------------

/**
 * Create a long-lived evaluator over `initialRules`.
 *
 * Each `step` applies a ground-fact delta to the accumulated database,
 * evaluates the affected strata with the weighted semi-naive loop, and
 * returns the derived-fact delta.
 *
 * @param initialRules - The initial set of rules.
 * @param host - Host-computed relations and point functions the rules may
 *   reference by name (see `host.ts`). A rule naming something the host
 *   lacks throws here rather than deriving an empty relation later.
 * @returns An Evaluator holding no facts.
 */
export function createEvaluator(
  initialRules: readonly Rule[],
  host: Host = EMPTY_HOST,
): Evaluator {
  // --- Mutable state ---

  /** Accumulated database: ground + derived facts. */
  const db = new Database()

  /** Current rules. */
  const rules: Rule[] = [...initialRules]

  /** Current stratification (recomputed on rule changes). */
  let strata: readonly Stratum[] = []

  /** Map from stratum index → Stratum for O(1) lookup. */
  let strataByIndex: Map<number, Stratum> = new Map()

  /** Map from predicate → affected stratum indices. */
  let predToStrata: Map<string, Set<number>> = new Map()

  /** All derived predicates across all strata. */
  let allDerivedPreds: Set<string> = new Set()

  /**
   * The ground part of every predicate rules have ever derived. A predicate
   * can be both inserted and derived; `db` holds the sum, and a recompute
   * wipes only the derived part. Tracking starts the moment a predicate
   * becomes derived, so it stays exact across rule changes.
   */
  const groundInDerived = new Database()

  /** The predicates `groundInDerived` tracks. */
  const trackedGround = new Set<string>()

  /** The host's point functions, resolved once. */
  const functions = hostFunctions(host)

  // Stratify, then derive what needs no facts at all: a rule with an empty
  // body holds from the start, a foreign relation with no inputs likewise,
  // and what they derive may feed a higher stratum. Recomputing each stratum
  // bottom-up over an empty database is exactly that.
  restratify()
  for (const stratum of strata) recomputeStratumOf(stratum)

  // --- Internal helpers ---

  function restratify(): void {
    if (rules.length === 0 && foreignRelations(host).length === 0) {
      strata = []
      strataByIndex = new Map()
      predToStrata = new Map()
      allDerivedPreds = new Set()
      return
    }

    const result = stratify(rules, host)
    if (!result.ok) {
      // A rule that needs host code the host lacks is a configuration error,
      // not a data condition: fail here, loudly.
      if (result.error.kind !== "cyclicNegation") {
        throw new Error(describeHostError(result.error))
      }
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
    for (const s of strata) {
      if (s.foreign !== undefined) allDerivedPreds.add(s.foreign.predicate)
    }
    trackGround()
  }

  /** Derive one stratum from an input delta: what `step` does per stratum. */
  function deriveStratum(stratum: Stratum, inputDelta: Database): Database {
    if (stratum.foreign !== undefined) {
      const changed = new Set<string>()
      for (const input of stratum.foreign.inputs) {
        if (inputDelta.getRelation(input).allEntryCount > 0) changed.add(input)
      }
      return recomputeForeign(stratum.foreign, db, changed, groundInDerived)
    }
    if (stratum.rules.length === 0) return new Database()
    return evaluateStratumFromDelta(
      stratum.rules,
      db,
      inputDelta,
      groundInDerived,
      functions,
    )
  }

  /** Derive one stratum again from scratch: what `changeRules` does per stratum. */
  function recomputeStratumOf(stratum: Stratum): Database {
    if (stratum.foreign !== undefined) {
      return recomputeForeign(
        stratum.foreign,
        db,
        new Set(stratum.foreign.inputs),
        groundInDerived,
      )
    }
    if (stratum.rules.length === 0) return new Database()
    return recomputeStratum(stratum.rules, db, groundInDerived, functions)
  }

  /** Start keeping the ground part of predicates that have become derived. */
  function trackGround(): void {
    for (const pred of allDerivedPreds) {
      if (trackedGround.has(pred)) continue
      trackedGround.add(pred)
      // Nothing derived it until now, so what it holds is all ground.
      const groundRel = groundInDerived.relation(pred)
      db.getRelation(pred).forEachEntry((tupleKey, tuple, weight) => {
        groundRel.addWeightedByKey(tupleKey, tuple, weight)
      })
    }
  }

  /**
   * Apply a ground-fact delta to `db` and return what the strata should see:
   * +1 or −1 for each fact whose presence changed. A ground fact's Z-set
   * weight is a reference count and strata read presence, so the raw weight
   * must not leak through: a fact arriving at weight 2 would derive at count
   * 2, and a later retraction could only take back 1.
   */
  function applyGroundDelta(deltaFacts: ZSet<Fact>): Database {
    const flips = new Database()
    zsetForEach(deltaFacts, (entry, key) => {
      const { predicate, values } = entry.element
      const rel = db.relation(predicate)
      const tupleKey = tupleKeyFor(key, entry.element)
      const before = rel.getWeightByKey(tupleKey)
      const after = rel.addWeightedByKey(tupleKey, values, entry.weight)
      if (trackedGround.has(predicate)) {
        groundInDerived
          .relation(predicate)
          .addWeightedByKey(tupleKey, values, entry.weight)
      }
      const change = presenceChange(before, after)
      if (change !== 0) {
        flips.relation(predicate).addWeightedByKey(tupleKey, values, change)
      }
    })
    return flips
  }

  // --- Public interface ---

  function changeRules(deltaRules: ZSet<Rule>): ZSet<Fact> {
    if (zsetIsEmpty(deltaRules)) return zsetEmpty()

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

    const oldDerivedPreds = new Set(allDerivedPreds)
    restratify()

    // A predicate no rule derives any more keeps only its ground part.
    const orphaned = new Set(
      [...oldDerivedPreds].filter(pred => !allDerivedPreds.has(pred)),
    )
    const delta = extractDelta(db, wipeDerived(orphaned, db, groundInDerived))

    // Derive every stratum again from scratch, bottom-up. Rule changes are
    // rare enough that a full recompute is fine.
    for (const stratum of strata) {
      delta.addAllWeighted(recomputeStratumOf(stratum))
    }
    return derivedFactsToZSet(delta)
  }

  function step(deltaFacts: ZSet<Fact>): ZSet<Fact> {
    if (zsetIsEmpty(deltaFacts)) return zsetEmpty()

    // 1. Apply the ground-fact delta to the accumulated db. Its presence
    //    flips are the first stratum input.
    const currentInputDelta = applyGroundDelta(deltaFacts)

    // 2. Determine affected strata.
    const affectedIndices = computeAffectedStrata(
      new Set(currentInputDelta.predicates()),
      strata,
      predToStrata,
    )
    if (affectedIndices.length === 0) return zsetEmpty()

    // 3. Evaluate affected strata bottom-up. Each stratum's output delta
    //    feeds the next stratum's input.
    const outputDelta = new Database()
    for (const stratumIdx of affectedIndices) {
      const stratum = strataByIndex.get(stratumIdx)
      if (stratum === undefined) continue

      const stratumDelta = deriveStratum(stratum, currentInputDelta)

      // The stratum's output joins the cumulative output and feeds higher
      // strata, which see changes from ground facts and lower derivations.
      outputDelta.addAllWeighted(stratumDelta)
      currentInputDelta.addAllWeighted(stratumDelta)
    }

    return derivedFactsToZSet(outputDelta)
  }

  function currentDatabase(): Database {
    return db
  }

  return { step, changeRules, currentDatabase }
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
  host?: Host,
): Result<Database, StratificationError> {
  // Validate stratification upfront for the error path.
  if (rules.length > 0 || foreignRelations(host).length > 0) {
    const stratResult = stratify(rules, host)
    if (!stratResult.ok) {
      return err(stratResult.error)
    }
  }

  return ok(evaluateBatch(rules, facts, host))
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
  host?: Host,
): Database {
  return evaluateBatch(rules, facts, host)
}

/** One fresh evaluator, every fact as +1, its database as the result. */
function evaluateBatch(
  rules: readonly Rule[],
  facts: readonly Fact[],
  host?: Host,
): Database {
  if (rules.length === 0 && foreignRelations(host).length === 0) {
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
  const evaluator = createEvaluator(rules, host)
  evaluator.step(factsToZSet(facts))

  return evaluator.currentDatabase()
}

/** One line a thrown host error can carry. */
function describeHostError(error: StratificationError): string {
  switch (error.kind) {
    case "unknownHostFunction":
      return `rule for "${error.rule.head.predicate}" names host function "${error.fn}", which is not registered`
    case "foreignPredicateDerived":
      return `rule derives "${error.predicate}", which is a foreign relation the host computes`
    case "unboundComputeArgument":
      return `rule for "${error.rule.head.predicate}" passes unbound variable "${error.variable}" to host function "${error.fn}"`
    case "cyclicNegation":
      return `cyclic negation through ${error.cycle.join(", ")}`
  }
}
