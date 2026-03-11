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

import type {
  Rule,
  BodyElement,
  Term,
  Fact,
  Result,
  StratificationError,
} from './types.js';
import {
  ok,
  err,
  Database,
  factKey,
} from './types.js';
import {
  evaluateRule,
  evaluateRuleSemiNaive,
  getPositiveAtomIndices,
} from './evaluate.js';
import type { WeightedFact } from './evaluate.js';
import {
  stratify,
  type Stratum,
  bodyPredicates,
  headPredicates,
} from './stratify.js';
import type { ZSet } from '../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetIsEmpty,
  zsetForEach,
  zsetMap,
} from '../base/zset.js';
import type { ResolvedWinner, FugueBeforePair } from '../kernel/resolve.js';
import { fuguePairKey } from '../kernel/resolve.js';

// ---------------------------------------------------------------------------
// Dirty Map — tracks facts modified during stratum evaluation
// ---------------------------------------------------------------------------

/**
 * A dirty-map entry records a fact and its weight *before* the current
 * stratum evaluation began. The key is `factKey(fact)`.
 *
 * `preWeight` is captured on first touch and never overwritten. After
 * convergence, comparing `preWeight` to the current weight in the db
 * reveals which facts crossed zero (the output delta).
 */
interface DirtyEntry {
  readonly fact: Fact;
  readonly preWeight: number;
}

/** The dirty map type: factKey → DirtyEntry. */
type DirtyMap = Map<string, DirtyEntry>;

// ---------------------------------------------------------------------------
// Dirty-map helpers
// ---------------------------------------------------------------------------

/**
 * Apply a weighted fact delta to the database, recording the pre-weight
 * in the dirty map on first touch.
 *
 * Returns the new weight of the fact in the database.
 */
function touchFact(
  db: Database,
  dirty: DirtyMap,
  f: Fact,
  weightDelta: number,
): number {
  const key = factKey(f);
  if (!dirty.has(key)) {
    // First touch — record pre-weight before mutation.
    const preWeight = db.getRelation(f.predicate).getWeight(f.values);
    dirty.set(key, { fact: f, preWeight });
  }
  return db.addWeightedFact(f, weightDelta);
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
  let clamped = false;
  for (const { fact } of dirty.values()) {
    const rel = db.getRelation(fact.predicate);
    const w = rel.getWeight(fact.values);
    if (w < 0) {
      // Floor to 0: add (-w) to reach 0, which prunes the entry.
      rel.addWeighted(fact.values, -w);
      clamped = true;
    }
    // weight >= 0: no action. True multiplicity (weight > 1) is preserved.
    // clampedWeight is already correct from eager update in addWeighted.
  }
  return clamped;
}

/**
 * Extract the output delta from the dirty map after stratum convergence.
 *
 * For each dirty entry, compare `preWeight` to the current weight in db.
 * Facts that crossed zero go into the returned delta `Database`:
 * - preWeight ≤ 0 and current > 0 → emit +1 (newly derived)
 * - preWeight > 0 and current ≤ 0 → emit −1 (retracted)
 *
 * The delta Database contains facts with weight +1 or −1 only.
 */
function extractDelta(db: Database, dirty: DirtyMap): Database {
  const delta = new Database();
  for (const { fact, preWeight } of dirty.values()) {
    const currentWeight = db.getRelation(fact.predicate).getWeight(fact.values);
    const wasPresentBefore = preWeight > 0;
    const isPresentNow = currentWeight > 0;

    if (!wasPresentBefore && isPresentNow) {
      // Newly derived: emit +1.
      delta.addWeightedFact(fact, 1);
    } else if (wasPresentBefore && !isPresentNow) {
      // Retracted: emit −1.
      delta.addWeightedFact(fact, -1);
    }
  }
  return delta;
}

// ---------------------------------------------------------------------------
// Stratum evaluation
// ---------------------------------------------------------------------------

/** Safety bound to prevent infinite loops. */
const MAX_ITERATIONS = 100_000;

/**
 * Evaluate a single stratum given an input delta, using weighted
 * semi-naive evaluation with dirty-map-based `distinct`.
 *
 * This is the functional core of the evaluator — a pure-ish function
 * that mutates `db` as a side effect of convergence and returns the
 * output delta.
 *
 * **Positive strata** (no negation/aggregation):
 * - Insertions only: weighted semi-naive seeded from inputDelta.
 * - Retractions present: wipe-and-recompute.
 *
 * **Negation/aggregation strata**: always wipe-and-recompute. Even
 * when the input contains only insertions (+1), new positive facts in
 * lower strata can invalidate previously-derived negation facts. For
 * example, if `unreachable(c) :- node(c), not reachable(c)` was
 * derived and then `reachable(c)` becomes true via a new edge,
 * `unreachable(c)` must be retracted. Naive iteration can only add
 * facts, not remove them, so wipe-and-recompute is required for
 * correctness.
 *
 * The dirty map captures pre-wipe weights, so delta extraction
 * correctly produces −1 for retracted facts and +1 for newly derived
 * facts. This replaces the old DRed approach but uses the dirty map
 * instead of snapshot-and-diff.
 *
 * @param rules        Rules for this stratum.
 * @param db           The accumulated database (mutated in place).
 * @param inputDelta   The input delta — facts whose weight changed.
 * @param hasNegOrAgg  Whether this stratum has negation or aggregation.
 * @param inputHasRetractions  Whether the input delta contains −1 entries.
 * @returns            Output delta Database (facts with weight +1 or −1).
 */
export function evaluateStratumFromDelta(
  rules: readonly Rule[],
  db: Database,
  inputDelta: Database,
  hasNegOrAgg: boolean,
  inputHasRetractions: boolean = false,
): Database {
  const dirty: DirtyMap = new Map();

  if (hasNegOrAgg) {
    // Negation/aggregation strata always wipe-and-recompute.
    // New positive facts can invalidate negation-derived facts,
    // so naive iteration (which only adds) is insufficient.
    return wipeAndRecompute(rules, db, dirty, hasNegOrAgg);
  }

  if (inputHasRetractions) {
    // Positive stratum with retractions — wipe and recompute.
    return wipeAndRecompute(rules, db, dirty, hasNegOrAgg);
  }

  return evaluatePositiveStratum(rules, db, inputDelta, dirty);
}

/**
 * Wipe all derived facts for this stratum, then recompute from scratch.
 *
 * Used when retractions are present — semi-naive alone cannot handle
 * lost support from retracted input facts.
 *
 * The dirty map records pre-wipe weights so that delta extraction
 * correctly detects which facts were added or removed.
 */
function wipeAndRecompute(
  rules: readonly Rule[],
  db: Database,
  dirty: DirtyMap,
  hasNegOrAgg: boolean,
): Database {
  // Determine which predicates this stratum derives.
  const derivedPreds = headPredicates(rules);

  // Record pre-wipe weights in the dirty map and delete all derived facts.
  for (const pred of derivedPreds) {
    const tuples = db.getRelation(pred).tuples(); // snapshot weight > 0
    for (const tuple of tuples) {
      const f: Fact = { predicate: pred, values: tuple };
      const key = factKey(f);
      if (!dirty.has(key)) {
        dirty.set(key, { fact: f, preWeight: db.getRelation(pred).getWeight(tuple) });
      }
      db.removeFact(f);
    }
  }

  // Recompute: re-derive all facts for this stratum.
  if (hasNegOrAgg) {
    // Naive iteration for negation/aggregation strata.
    let changed = true;
    let iterations = 0;
    while (changed && iterations < MAX_ITERATIONS) {
      changed = false;
      iterations++;
      for (const rule of rules) {
        const derived = evaluateRule(rule, db, db);
        for (const wf of derived) {
          if (wf.weight > 0 && !db.hasFact(wf.fact)) {
            const key = factKey(wf.fact);
            if (!dirty.has(key)) {
              dirty.set(key, { fact: wf.fact, preWeight: 0 });
            }
            db.addFact(wf.fact);
            changed = true;
          }
        }
      }
    }
  } else {
    // Semi-naive for positive strata.
    // Initial pass: evaluate all rules against the full db.
    const delta = new Database();
    for (const rule of rules) {
      const derived = evaluateRule(rule, db, db);
      for (const wf of derived) {
        if (wf.weight > 0 && !db.hasFact(wf.fact)) {
          const key = factKey(wf.fact);
          if (!dirty.has(key)) {
            dirty.set(key, { fact: wf.fact, preWeight: 0 });
          }
          delta.addFact(wf.fact);
        }
      }
    }
    db.mergeFrom(delta);

    // Semi-naive iteration.
    let currentDelta = delta;
    let iterations = 0;
    while (currentDelta.size > 0 && iterations < MAX_ITERATIONS) {
      iterations++;
      const nextDelta = new Database();
      for (const rule of rules) {
        const positiveAtomIndices = getPositiveAtomIndices(rule.body);
        for (const deltaIdx of positiveAtomIndices) {
          const derived = evaluateRuleSemiNaive(rule, db, currentDelta, deltaIdx);
          for (const wf of derived) {
            if (wf.weight > 0 && !db.hasFact(wf.fact)) {
              const key = factKey(wf.fact);
              if (!dirty.has(key)) {
                dirty.set(key, { fact: wf.fact, preWeight: 0 });
              }
              nextDelta.addFact(wf.fact);
            }
          }
        }
      }
      db.mergeFrom(nextDelta);
      currentDelta = nextDelta;
    }
  }

  return extractDelta(db, dirty);
}

/**
 * Weighted semi-naive for positive-only strata.
 *
 * The initial pass evaluates all rules against the full db. For each
 * derived WeightedFact, we apply it to the db via touchFact. Facts that
 * are new (not already present) go into the initial currentDelta for
 * semi-naive iteration.
 *
 * This differs from the old `evaluateMonotoneStratumIncremental` which
 * ignored its `_inputDelta` parameter and evaluated everything against
 * the full db. Here, the inputDelta is already applied to the db before
 * this function is called, so the initial pass naturally picks up new
 * derivations from those changes.
 */
function evaluatePositiveStratum(
  rules: readonly Rule[],
  db: Database,
  inputDelta: Database,
  dirty: DirtyMap,
): Database {
  // Initial pass: evaluate all rules. For the first iteration, we use
  // semi-naive seeded from inputDelta — each rule has at least one
  // positive atom matched against the inputDelta while others match
  // against the full db. This is the _inputDelta fix: O(|Δ|×|DB|)
  // instead of O(|DB|²).
  //
  // However, if the inputDelta IS the full db (batch mode), this
  // degenerates to the standard initial pass. We detect this by checking
  // if inputDelta is empty — in batch mode the caller passes all facts
  // as ground facts in the db and an empty inputDelta for the first
  // stratum (since all ground facts are already in the db before
  // stratum evaluation begins).
  //
  // Actually, for the batch wrapper, we pass a "full" inputDelta
  // containing all ground facts. For the incremental path, we pass the
  // actual delta. Either way, the semi-naive seeded from inputDelta
  // is correct.

  let currentDelta: Database;

  // Seed: evaluate rules semi-naively against inputDelta.
  // Also handle rules with empty bodies (no positive atoms) — these
  // derive facts unconditionally and are missed by semi-naive iteration
  // which only iterates over positive atom indices.
  currentDelta = new Database();

  for (const rule of rules) {
    const positiveAtomIndices = getPositiveAtomIndices(rule.body);
    if (positiveAtomIndices.length === 0) {
      // Rule with no positive atoms (empty body or only negation/guards).
      // Evaluate against full db — these fire unconditionally.
      const derived = evaluateRule(rule, db, db);
      for (const wf of derived) {
        applyDerivedFact(wf, db, dirty, currentDelta);
      }
    } else if (inputDelta.size > 0) {
      for (const deltaIdx of positiveAtomIndices) {
        const derived = evaluateRuleSemiNaive(rule, db, inputDelta, deltaIdx);
        for (const wf of derived) {
          applyDerivedFact(wf, db, dirty, currentDelta);
        }
      }
    }
  }

  if (inputDelta.size === 0 && currentDelta.size === 0) {
    // No input delta and no unconditional derivations — nothing to do.
    return extractDelta(db, dirty);
  }

  applyDistinct(db, dirty);

  // Semi-naive iteration from the initial delta.
  let iterations = 0;
  while (currentDelta.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const nextDelta = new Database();

    for (const rule of rules) {
      const positiveAtomIndices = getPositiveAtomIndices(rule.body);
      for (const deltaIdx of positiveAtomIndices) {
        const derived = evaluateRuleSemiNaive(rule, db, currentDelta, deltaIdx);
        for (const wf of derived) {
          applyDerivedFact(wf, db, dirty, nextDelta);
        }
      }
    }

    applyDistinct(db, dirty);
    currentDelta = nextDelta;
  }

  return extractDelta(db, dirty);
}

/**
 * Naive iteration for negation/aggregation strata.
 *
 * Negation strata cannot use semi-naive because the negation check
 * must be evaluated against the full db. We iterate naively until
 * convergence.
 */
function evaluateNegationStratum(
  rules: readonly Rule[],
  db: Database,
  dirty: DirtyMap,
): Database {
  let changed = true;
  let iterations = 0;

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    iterations++;

    for (const rule of rules) {
      const derived = evaluateRule(rule, db, db);
      for (const wf of derived) {
        const key = factKey(wf.fact);
        if (!dirty.has(key)) {
          const preWeight = db.getRelation(wf.fact.predicate).getWeight(wf.fact.values);
          dirty.set(key, { fact: wf.fact, preWeight });
        }

        const currentWeight = db.getRelation(wf.fact.predicate).getWeight(wf.fact.values);
        if (wf.weight > 0 && currentWeight <= 0) {
          // This fact is newly derivable — apply it.
          db.addWeightedFact(wf.fact, wf.weight);
          changed = true;
        } else if (wf.weight > 0 && currentWeight > 0) {
          // Already present — no change needed for naive iteration.
          // Weight stays at 1 (distinct will clamp if needed).
        }
      }
    }

    applyDistinct(db, dirty);
  }

  return extractDelta(db, dirty);
}

/**
 * Apply a derived weighted fact to the database and the current delta.
 *
 * The fact is applied via touchFact (which records preWeight in the
 * dirty map). If the fact's presence changed (crossed zero or weight
 * increased), it's added to the delta for the next semi-naive iteration.
 */
function applyDerivedFact(
  wf: WeightedFact,
  db: Database,
  dirty: DirtyMap,
  delta: Database,
): void {
  if (wf.weight === 0) return;

  const key = factKey(wf.fact);
  const prevWeight = db.getRelation(wf.fact.predicate).getWeight(wf.fact.values);
  const newWeight = touchFact(db, dirty, wf.fact, wf.weight);

  // Add to delta if the fact became newly present or if its weight changed
  // in a way that could produce new derivations.
  const wasPresentBefore = prevWeight > 0;
  const isPresentNow = newWeight > 0;

  if (!wasPresentBefore && isPresentNow) {
    // Newly derived — seed the next semi-naive iteration.
    delta.addFact(wf.fact);
  }
  // Note: we don't propagate weight *increases* for already-present facts
  // because distinct will clamp everything to 0/1. Only zero-crossings
  // matter for convergence.
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
  const result = new Map<string, Set<number>>();

  for (const stratum of strata) {
    for (const rule of stratum.rules) {
      const preds = bodyPredicates(rule.body);
      for (const pred of preds) {
        let set = result.get(pred);
        if (set === undefined) {
          set = new Set();
          result.set(pred, set);
        }
        set.add(stratum.index);
      }
    }
  }

  return result;
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
  const affected = new Set<number>();
  const visited = new Set<string>(changedPredicates);

  // Collect all head predicates per stratum for propagation.
  const stratumHeads = new Map<number, Set<string>>();
  for (const stratum of strata) {
    const heads = headPredicates(stratum.rules);
    stratumHeads.set(stratum.index, heads);
  }

  // BFS: when a stratum is affected, its head predicates may affect
  // higher strata.
  const predQueue = [...changedPredicates];
  while (predQueue.length > 0) {
    const pred = predQueue.pop()!;
    const affectedByPred = predToStrata.get(pred);
    if (affectedByPred === undefined) continue;

    for (const stratumIdx of affectedByPred) {
      if (!affected.has(stratumIdx)) {
        affected.add(stratumIdx);
        const heads = stratumHeads.get(stratumIdx);
        if (heads !== undefined) {
          for (const head of heads) {
            if (!visited.has(head)) {
              visited.add(head);
              predQueue.push(head);
            }
          }
        }
      }
    }
  }

  // Return in ascending order (bottom-up evaluation).
  return [...affected].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Stratum helpers (migrated from incremental-evaluate.ts)
// ---------------------------------------------------------------------------

/**
 * Check if a stratum has negation or aggregation body elements.
 */
function stratumHasNegationOrAggregation(stratum: Stratum): boolean {
  return stratum.rules.some((r) =>
    r.body.some((b) => b.kind === 'negation' || b.kind === 'aggregation'),
  );
}

/**
 * Get the set of head predicates for a stratum (the "derived" predicates).
 */
function stratumDerivedPredicates(stratum: Stratum): Set<string> {
  return headPredicates(stratum.rules);
}

// ---------------------------------------------------------------------------
// Rule identity (migrated from incremental-evaluate.ts)
// ---------------------------------------------------------------------------

/**
 * Produce a stable identity string for a rule (for matching on retraction).
 * Structural identity — same head/body shape → same key.
 */
function ruleIdentity(r: Rule): string {
  const headPart = `${r.head.predicate}(${r.head.terms.map(termId).join(',')})`;
  const bodyParts = r.body.map(bodyElementId).join(';');
  return `${headPart}:-${bodyParts}`;
}

function termId(t: Term): string {
  switch (t.kind) {
    case 'const': return `c:${String(t.value)}`;
    case 'var': return `v:${t.name}`;
    case 'wildcard': return '_';
  }
}

function bodyElementId(b: BodyElement): string {
  switch (b.kind) {
    case 'atom':
      return `+${b.atom.predicate}(${b.atom.terms.map(termId).join(',')})`;
    case 'negation':
      return `-${b.atom.predicate}(${b.atom.terms.map(termId).join(',')})`;
    case 'guard':
      return `g:${b.op}(${termId(b.left)},${termId(b.right)})`;
    case 'aggregation':
      return `a:${b.agg.fn}`;
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
function winnerFactsToResolution(
  deltaDb: Database,
): ZSet<ResolvedWinner> {
  const rel = deltaDb.getRelation('winner');
  const entries = rel.allWeightedTuples();

  if (entries.length === 0) {
    return zsetEmpty<ResolvedWinner>();
  }

  // Group by slotId for replacement semantics.
  const bySlot = new Map<string, { plus: ResolvedWinner | null; minus: ResolvedWinner | null }>();

  for (const { tuple, weight } of entries) {
    const slotId = tuple[0] as string;
    const winner: ResolvedWinner = {
      slotId,
      winnerCnIdKey: tuple[1] as string,
      content: tuple[2]!,
    };

    let slot = bySlot.get(slotId);
    if (slot === undefined) {
      slot = { plus: null, minus: null };
      bySlot.set(slotId, slot);
    }

    if (weight > 0) {
      slot.plus = winner;
    } else if (weight < 0) {
      slot.minus = winner;
    }
  }

  // Produce resolution delta with replacement semantics.
  let result = zsetEmpty<ResolvedWinner>();

  for (const [slotId, slot] of bySlot) {
    if (slot.plus !== null && slot.minus !== null) {
      // Replacement: emit only +1 for the new winner.
      result = zsetAdd(result, zsetSingleton(slotId, slot.plus, 1));
    } else if (slot.plus !== null) {
      // New winner: emit +1.
      result = zsetAdd(result, zsetSingleton(slotId, slot.plus, 1));
    } else if (slot.minus !== null) {
      // Winner removed: emit −1.
      result = zsetAdd(result, zsetSingleton(slotId, slot.minus, -1));
    }
  }

  return result;
}

/**
 * Convert fugue_before fact deltas from a delta `Database` into a
 * `ZSet<FugueBeforePair>`.
 *
 * Fugue before fact schema: `fugue_before(Parent, A, B)`
 */
function fuguePairFactsToResolution(
  deltaDb: Database,
): ZSet<FugueBeforePair> {
  const rel = deltaDb.getRelation('fugue_before');
  const entries = rel.allWeightedTuples();

  if (entries.length === 0) {
    return zsetEmpty<FugueBeforePair>();
  }

  let result = zsetEmpty<FugueBeforePair>();

  for (const { tuple, weight } of entries) {
    const pair: FugueBeforePair = {
      parentKey: tuple[0] as string,
      a: tuple[1] as string,
      b: tuple[2] as string,
    };
    const key = fuguePairKey(pair);
    result = zsetAdd(result, zsetSingleton(key, pair, weight > 0 ? 1 : -1));
  }

  return result;
}

// ---------------------------------------------------------------------------
// Evaluator interface
// ---------------------------------------------------------------------------

/**
 * The step result from the unified evaluator.
 */
export interface EvaluatorStepResult {
  /** Resolution deltas for the skeleton stage. */
  readonly deltaResolved: ZSet<ResolvedWinner>;
  /** Fugue pair deltas for the skeleton stage. */
  readonly deltaFuguePairs: ZSet<FugueBeforePair>;
  /** All derived fact deltas (for downstream consumers). */
  readonly deltaDerived: ZSet<Fact>;
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
  step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): EvaluatorStepResult;

  /** The full accumulated Database (ground + derived facts). */
  currentDatabase(): Database;

  /**
   * Extract the current resolution from the accumulated Database.
   */
  currentResolution(): {
    winners: ReadonlyMap<string, ResolvedWinner>;
    fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>;
  };

  /** Reset to empty state. */
  reset(): void;
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
export function createEvaluator(
  initialRules: readonly Rule[],
): Evaluator {
  // --- Mutable state ---

  /** Accumulated database: ground + derived facts. */
  let db = new Database();

  /** Current rules. */
  let rules: Rule[] = [...initialRules];

  /** Current stratification (recomputed on rule changes). */
  let strata: readonly Stratum[] = [];

  /** Map from predicate → affected stratum indices. */
  let predToStrata: Map<string, Set<number>> = new Map();

  /** All derived predicates across all strata. */
  let allDerivedPreds: Set<string> = new Set();

  /** Accumulated ground facts for rule-change replay. */
  let accumulatedGroundFacts: Map<string, Fact> = new Map();

  /** Whether step() has ever been called. Used by batch wrappers to
   *  ensure strata are evaluated even with zero ground facts (rules
   *  with empty bodies must still fire on first invocation). */
  let hasBeenStepped = false;

  // Initialize stratification.
  restratify();

  // --- Internal helpers ---

  function restratify(): void {
    if (rules.length === 0) {
      strata = [];
      predToStrata = new Map();
      allDerivedPreds = new Set();
      return;
    }

    const result = stratify(rules);
    if (!result.ok) {
      // Cyclic negation — clear strata.
      strata = [];
      predToStrata = new Map();
      allDerivedPreds = new Set();
      return;
    }

    strata = result.value;
    predToStrata = buildPredicateToAffectedStrata(strata);
    allDerivedPreds = headPredicates(rules);
  }

  /**
   * Build a ZSet<Fact> delta from all derived facts whose weight
   * changed between two snapshots (before/after).
   */
  function diffDerivedSnapshots(
    before: Database,
    after: Database,
    derivedPreds: ReadonlySet<string>,
  ): ZSet<Fact> {
    let delta = zsetEmpty<Fact>();

    // Facts added (in after but not before).
    for (const pred of derivedPreds) {
      for (const tuple of after.getRelation(pred).tuples()) {
        const f: Fact = { predicate: pred, values: tuple };
        if (!before.hasFact(f)) {
          delta = zsetAdd(delta, zsetSingleton(factKey(f), f, 1));
        }
      }
    }

    // Facts removed (in before but not after).
    for (const pred of derivedPreds) {
      for (const tuple of before.getRelation(pred).tuples()) {
        const f: Fact = { predicate: pred, values: tuple };
        if (!after.hasFact(f)) {
          delta = zsetAdd(delta, zsetSingleton(factKey(f), f, -1));
        }
      }
    }

    return delta;
  }

  // --- Public interface ---

  function step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): EvaluatorStepResult {
    const emptyResult: EvaluatorStepResult = {
      deltaResolved: zsetEmpty<ResolvedWinner>(),
      deltaFuguePairs: zsetEmpty<FugueBeforePair>(),
      deltaDerived: zsetEmpty<Fact>(),
    };

    // --- Handle rule changes ---
    if (!zsetIsEmpty(deltaRules)) {
      // Apply rule changes.
      zsetForEach(deltaRules, (entry) => {
        if (entry.weight > 0) {
          rules.push(entry.element);
        } else if (entry.weight < 0) {
          const rKey = ruleIdentity(entry.element);
          const idx = rules.findIndex((r) => ruleIdentity(r) === rKey);
          if (idx !== -1) {
            rules.splice(idx, 1);
          }
        }
      });

      // Track all derived preds (old + new) for complete snapshot.
      const oldDerivedPreds = new Set(allDerivedPreds);

      // Restratify with new rules.
      restratify();

      // Union of old and new derived preds for snapshot scope.
      const allRelevantPreds = new Set([...oldDerivedPreds, ...allDerivedPreds]);

      // Snapshot derived facts before wipe.
      const beforeSnapshot = new Database();
      for (const pred of allRelevantPreds) {
        for (const { tuple, weight } of db.getRelation(pred).weightedTuples()) {
          beforeSnapshot.addWeightedFact({ predicate: pred, values: tuple }, weight);
        }
      }

      // Wipe all derived facts.
      for (const pred of allRelevantPreds) {
        for (const tuple of db.getRelation(pred).tuples()) {
          db.removeFact({ predicate: pred, values: tuple });
        }
      }

      // Apply ground fact delta first (if any).
      if (!zsetIsEmpty(deltaFacts)) {
        zsetForEach(deltaFacts, (entry) => {
          const key = factKey(entry.element);
          if (entry.weight > 0) {
            accumulatedGroundFacts.set(key, entry.element);
          } else if (entry.weight < 0) {
            accumulatedGroundFacts.delete(key);
          }
          db.addWeightedFact(entry.element, entry.weight);
        });
      }

      // Replay all strata from scratch.
      for (const stratum of strata) {
        if (stratum.rules.length === 0) continue;
        const hasNegOrAgg = stratumHasNegationOrAggregation(stratum);

        // For full replay, seed with all ground facts that are inputs
        // to this stratum.
        const inputDelta = new Database();
        const derivedPreds = stratumDerivedPredicates(stratum);
        for (const pred of db.predicates()) {
          if (!allDerivedPreds.has(pred)) {
            // Ground predicate — include all facts as input delta.
            for (const tuple of db.getRelation(pred).tuples()) {
              inputDelta.addFact({ predicate: pred, values: tuple });
            }
          }
        }
        // Also include derived facts from lower strata (already computed).
        for (const s of strata) {
          if (s.index >= stratum.index) break;
          for (const pred of stratumDerivedPredicates(s)) {
            for (const tuple of db.getRelation(pred).tuples()) {
              inputDelta.addFact({ predicate: pred, values: tuple });
            }
          }
        }

        evaluateStratumFromDelta(stratum.rules, db, inputDelta, hasNegOrAgg);
      }

      // Snapshot derived facts after replay.
      const afterSnapshot = new Database();
      for (const pred of allRelevantPreds) {
        for (const { tuple, weight } of db.getRelation(pred).weightedTuples()) {
          afterSnapshot.addWeightedFact({ predicate: pred, values: tuple }, weight);
        }
      }

      // Diff snapshots to produce derived delta.
      const deltaDerived = diffDerivedSnapshots(beforeSnapshot, afterSnapshot, allRelevantPreds);

      if (zsetIsEmpty(deltaDerived)) return emptyResult;

      // Build a delta Database from deltaDerived for resolution extraction.
      const deltaDb = new Database();
      zsetForEach(deltaDerived, (entry) => {
        deltaDb.addWeightedFact(entry.element, entry.weight);
      });

      const deltaResolved = winnerFactsToResolution(deltaDb);
      const deltaFuguePairs = fuguePairFactsToResolution(deltaDb);

      return { deltaResolved, deltaFuguePairs, deltaDerived };
    }

    // --- No rule change — incremental evaluation ---

    if (zsetIsEmpty(deltaFacts)) {
      if (hasBeenStepped) return emptyResult;
      // First invocation with no facts — still need to evaluate strata
      // for rules with empty bodies (e.g., axiom(42) :- .).
      hasBeenStepped = true;
      if (strata.length === 0) return emptyResult;

      // Evaluate all strata with empty input delta.
      const outputDelta = new Database();
      for (const stratum of strata) {
        if (stratum.rules.length === 0) continue;
        const hasNegOrAgg = stratumHasNegationOrAggregation(stratum);
        const stratumDelta = evaluateStratumFromDelta(
          stratum.rules, db, new Database(), hasNegOrAgg, false,
        );
        for (const pred of stratumDelta.predicates()) {
          for (const { tuple, weight } of stratumDelta.getRelation(pred).allWeightedTuples()) {
            outputDelta.addWeightedFact({ predicate: pred, values: tuple }, weight);
          }
        }
      }

      let outputHasEntries = false;
      for (const pred of outputDelta.predicates()) {
        if (outputDelta.getRelation(pred).allEntryCount > 0) {
          outputHasEntries = true;
          break;
        }
      }
      if (!outputHasEntries) return emptyResult;

      const deltaResolved = winnerFactsToResolution(outputDelta);
      const deltaFuguePairs = fuguePairFactsToResolution(outputDelta);
      let deltaDerived = zsetEmpty<Fact>();
      for (const pred of outputDelta.predicates()) {
        for (const { tuple, weight } of outputDelta.getRelation(pred).allWeightedTuples()) {
          const f: Fact = { predicate: pred, values: tuple };
          deltaDerived = zsetAdd(deltaDerived, zsetSingleton(factKey(f), f, weight > 0 ? 1 : -1));
        }
      }
      return { deltaResolved, deltaFuguePairs, deltaDerived };
    }

    hasBeenStepped = true;

    // 1. Track ground facts and apply weighted delta to accumulated db.
    const changedPreds = new Set<string>();
    zsetForEach(deltaFacts, (entry) => {
      const key = factKey(entry.element);
      if (entry.weight > 0) {
        accumulatedGroundFacts.set(key, entry.element);
      } else if (entry.weight < 0) {
        accumulatedGroundFacts.delete(key);
      }
      db.addWeightedFact(entry.element, entry.weight);
      changedPreds.add(entry.element.predicate);
    });

    // 2. Determine affected strata.
    const affectedIndices = computeAffectedStrata(changedPreds, strata, predToStrata);

    if (affectedIndices.length === 0) {
      return emptyResult;
    }

    // 3. Detect if the delta contains retractions.
    let hasRetractionsInDelta = false;
    zsetForEach(deltaFacts, (entry) => {
      if (entry.weight < 0) hasRetractionsInDelta = true;
    });

    // 4. Build initial input delta from ground fact changes.
    let currentInputDelta = new Database();
    zsetForEach(deltaFacts, (entry) => {
      currentInputDelta.addWeightedFact(entry.element, entry.weight);
    });

    // 5. Evaluate affected strata bottom-up.
    // Each stratum's output delta feeds the next stratum's input.
    // Track whether retractions have propagated — if a lower stratum
    // produces −1 deltas, higher strata must also wipe-and-recompute.
    let retractionsPresent = hasRetractionsInDelta;
    const outputDelta = new Database();

    for (const stratumIdx of affectedIndices) {
      const stratum = strata.find((s) => s.index === stratumIdx);
      if (stratum === undefined || stratum.rules.length === 0) continue;

      const hasNegOrAgg = stratumHasNegationOrAggregation(stratum);
      const stratumDelta = evaluateStratumFromDelta(
        stratum.rules,
        db,
        currentInputDelta,
        hasNegOrAgg,
        retractionsPresent,
      );

      // Merge stratum output into the cumulative output delta.
      // Use allWeightedTuples() because delta databases contain both
      // +1 (new) and -1 (retracted) entries.
      for (const pred of stratumDelta.predicates()) {
        for (const { tuple, weight } of stratumDelta.getRelation(pred).allWeightedTuples()) {
          outputDelta.addWeightedFact({ predicate: pred, values: tuple }, weight);
          // If this stratum produced retractions, propagate the flag
          // so higher strata also use wipe-and-recompute.
          if (weight < 0) {
            retractionsPresent = true;
          }
        }
      }

      // Propagate this stratum's output as input to the next stratum.
      // Merge it into currentInputDelta so higher strata see changes
      // from both ground facts and lower-stratum derivations.
      for (const pred of stratumDelta.predicates()) {
        for (const { tuple, weight } of stratumDelta.getRelation(pred).allWeightedTuples()) {
          currentInputDelta.addWeightedFact({ predicate: pred, values: tuple }, weight);
        }
      }
    }

    // 6. Extract resolution deltas from the collected output delta.
    // Check allEntryCount (not size) because delta databases contain
    // negative-weight entries that size would miss.
    let outputHasEntries = false;
    for (const pred of outputDelta.predicates()) {
      if (outputDelta.getRelation(pred).allEntryCount > 0) {
        outputHasEntries = true;
        break;
      }
    }
    if (!outputHasEntries) {
      return emptyResult;
    }

    const deltaResolved = winnerFactsToResolution(outputDelta);
    const deltaFuguePairs = fuguePairFactsToResolution(outputDelta);

    // 7. Build deltaDerived ZSet from the output delta Database.
    // Use allWeightedTuples() to include negative-weight (retracted) entries.
    let deltaDerived = zsetEmpty<Fact>();
    for (const pred of outputDelta.predicates()) {
      for (const { tuple, weight } of outputDelta.getRelation(pred).allWeightedTuples()) {
        const f: Fact = { predicate: pred, values: tuple };
        deltaDerived = zsetAdd(
          deltaDerived,
          zsetSingleton(factKey(f), f, weight > 0 ? 1 : -1),
        );
      }
    }

    return { deltaResolved, deltaFuguePairs, deltaDerived };
  }

  function currentDatabase(): Database {
    return db;
  }

  function currentResolution(): {
    winners: ReadonlyMap<string, ResolvedWinner>;
    fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>;
  } {
    // Extract winners from the winner relation.
    const winners = new Map<string, ResolvedWinner>();
    for (const tuple of db.getRelation('winner').tuples()) {
      const slotId = tuple[0] as string;
      const winnerCnIdKey = tuple[1] as string;
      const content = tuple[2]!;
      winners.set(slotId, { slotId, winnerCnIdKey, content });
    }

    // Extract fugue pairs from the fugue_before relation.
    const fuguePairs = new Map<string, FugueBeforePair[]>();
    for (const tuple of db.getRelation('fugue_before').tuples()) {
      const parentKey = tuple[0] as string;
      const a = tuple[1] as string;
      const b = tuple[2] as string;
      const pair: FugueBeforePair = { parentKey, a, b };

      let existing = fuguePairs.get(parentKey);
      if (existing === undefined) {
        existing = [];
        fuguePairs.set(parentKey, existing);
      }
      existing.push(pair);
    }

    return { winners, fuguePairs };
  }

  function reset(): void {
    db = new Database();
    rules = [];
    strata = [];
    predToStrata = new Map();
    allDerivedPreds = new Set();
    accumulatedGroundFacts = new Map();
    hasBeenStepped = false;
  }

  return { step, currentDatabase, currentResolution, reset };
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
    const stratResult = stratify(rules);
    if (!stratResult.ok) {
      return err(stratResult.error);
    }
  }

  const db = new Database();
  for (const f of facts) {
    db.addFact(f);
  }

  if (rules.length === 0) {
    return ok(db);
  }

  // Create evaluator and step with all facts.
  const evaluator = createEvaluator(rules);
  let factsZSet = zsetEmpty<Fact>();
  for (const f of facts) {
    factsZSet = zsetAdd(factsZSet, zsetSingleton(factKey(f), f, 1));
  }
  evaluator.step(factsZSet, zsetEmpty());

  return ok(evaluator.currentDatabase());
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
  const db = new Database();
  for (const f of facts) {
    db.addFact(f);
  }

  if (rules.length === 0) {
    return db;
  }

  const evaluator = createEvaluator(rules);
  let factsZSet = zsetEmpty<Fact>();
  for (const f of facts) {
    factsZSet = zsetAdd(factsZSet, zsetSingleton(factKey(f), f, 1));
  }
  evaluator.step(factsZSet, zsetEmpty());

  return evaluator.currentDatabase();
}