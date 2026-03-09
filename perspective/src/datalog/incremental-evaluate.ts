// === Incremental Datalog Evaluator ===
// Cross-time incremental Datalog evaluator following DBSP §4–5.
//
// Maintains a persistent `Database` across outer time steps. Each step
// receives a `ZSet<Fact>` delta from projection, applies it to the
// accumulated database, and re-evaluates affected strata to produce
// a `ZSet<Fact>` delta of derived facts.
//
// Two nested loops:
//   - Outer (cross-time): one step per constraint insertion.
//   - Inner (intra-time): semi-naive fixed-point within a single step.
//
// Monotone strata (no retractions) use semi-naive from the input delta.
// Negation/aggregation strata, and any stratum when retractions are present,
// use the DRed (Delete and Rederive) pattern:
//   1. Delete phase: remove all derived facts for the stratum.
//   2. Rederive phase: re-evaluate the stratum's rules to a fixed point.
//
// The evaluator reuses the batch evaluator's per-rule primitives
// (`evaluateRule`, `evaluateRuleSemiNaive`, etc.) directly — the
// accumulated `Database` IS the `fullDb` parameter. No adapters.
//
// See Plan 006, Phase 5.
// See theory/incremental.md §9.
// See DBSP (Budiu & McSherry, 2023) §4–5.

import type { Fact, Rule, BodyElement, Term } from './types.js';
import { Database, factKey } from './types.js';
import {
  evaluateRule,
  evaluateRuleSemiNaive,
  getPositiveAtomIndices,
} from './evaluate.js';
import { stratify, type Stratum, bodyPredicates, headPredicates } from './stratify.js';
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
// Bridge Utilities
// ---------------------------------------------------------------------------

/**
 * Apply a `ZSet<Fact>` delta to a `Database`.
 * +1 entries → `addFact`, −1 entries → `removeFact`.
 */
export function applyFactDelta(db: Database, delta: ZSet<Fact>): void {
  zsetForEach(delta, (entry) => {
    if (entry.weight > 0) {
      db.addFact(entry.element);
    } else if (entry.weight < 0) {
      db.removeFact(entry.element);
    }
  });
}

/**
 * Diff two Databases to produce a `ZSet<Fact>` delta.
 * Facts in `newDb` but not `oldDb` get weight +1.
 * Facts in `oldDb` but not `newDb` get weight −1.
 */
export function diffDatabases(oldDb: Database, newDb: Database): ZSet<Fact> {
  let delta = zsetEmpty<Fact>();

  // Facts added (in new but not old)
  for (const pred of newDb.predicates()) {
    for (const tuple of newDb.getRelation(pred).tuples()) {
      const f: Fact = { predicate: pred, values: tuple };
      if (!oldDb.hasFact(f)) {
        const key = factKey(f);
        delta = zsetAdd(delta, zsetSingleton(key, f, 1));
      }
    }
  }

  // Facts removed (in old but not new)
  for (const pred of oldDb.predicates()) {
    for (const tuple of oldDb.getRelation(pred).tuples()) {
      const f: Fact = { predicate: pred, values: tuple };
      if (!newDb.hasFact(f)) {
        const key = factKey(f);
        delta = zsetAdd(delta, zsetSingleton(key, f, -1));
      }
    }
  }

  return delta;
}

/**
 * Split a mixed `ZSet<Fact>` into per-predicate Z-sets.
 */
export function groupByPredicate(zs: ZSet<Fact>): Map<string, ZSet<Fact>> {
  const groups = new Map<string, ZSet<Fact>>();

  zsetForEach(zs, (entry, key) => {
    const pred = entry.element.predicate;
    const singleton = zsetSingleton(key, entry.element, entry.weight);
    const existing = groups.get(pred) ?? zsetEmpty<Fact>();
    groups.set(pred, zsetAdd(existing, singleton));
  });

  return groups;
}

// ---------------------------------------------------------------------------
// Stratum Dependency Analysis
// ---------------------------------------------------------------------------

/**
 * Build a map: predicate → set of stratum indices whose rules reference
 * that predicate in their body (directly). Used to determine which strata
 * are affected by a change in a given predicate.
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
 * Returns affected stratum indices in bottom-up evaluation order.
 */
function affectedStrata(
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
        // This stratum's head predicates may in turn affect higher strata.
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
// Stratum Evaluation Helpers
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

/**
 * Clone only the derived predicates from a database into a new Database.
 * Used for snapshot-and-diff.
 */
function snapshotDerivedPredicates(
  db: Database,
  derivedPreds: ReadonlySet<string>,
): Database {
  const snapshot = new Database();
  for (const pred of derivedPreds) {
    for (const tuple of db.getRelation(pred).tuples()) {
      snapshot.relation(pred).add(tuple);
    }
  }
  return snapshot;
}

/**
 * Evaluate a monotone (positive-only) stratum incrementally.
 *
 * Takes a delta Database containing new input facts, runs semi-naive
 * from it against the full accumulated db, and merges new derivations.
 *
 * Returns the set of newly derived predicates that changed.
 */
function evaluateMonotoneStratumIncremental(
  stratum: Stratum,
  db: Database,
  _inputDelta: Database,
): Set<string> {
  const changedPreds = new Set<string>();

  // Initial pass: evaluate all rules against the full db.
  // This picks up new derivations from the newly-applied ground facts
  // and cross-joins with existing facts (e.g., the LWW self-join on
  // active_value for superseded).
  const initialDelta = new Database();
  for (const rule of stratum.rules) {
    const derived = evaluateRule(rule, db, db);
    for (const wf of derived) {
      if (wf.weight > 0 && !db.hasFact(wf.fact)) {
        initialDelta.addFact(wf.fact);
      }
    }
  }

  if (initialDelta.size > 0) {
    db.mergeFrom(initialDelta);
    for (const pred of initialDelta.predicates()) {
      if (initialDelta.getRelation(pred).size > 0) {
        changedPreds.add(pred);
      }
    }
  }

  // Semi-naive iteration from the initial delta.
  let currentDelta = initialDelta;

  const MAX_ITERATIONS = 100_000;
  let iterations = 0;

  while (currentDelta.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const nextDelta = new Database();

    for (const rule of stratum.rules) {
      const positiveAtomIndices = getPositiveAtomIndices(rule.body);

      for (const deltaIdx of positiveAtomIndices) {
        const derived = evaluateRuleSemiNaive(rule, db, currentDelta, deltaIdx);
        for (const wf of derived) {
          if (wf.weight > 0 && !db.hasFact(wf.fact)) {
            nextDelta.addFact(wf.fact);
          }
        }
      }
    }

    // Merge new derivations into the accumulated db.
    if (nextDelta.size > 0) {
      db.mergeFrom(nextDelta);
      for (const pred of nextDelta.predicates()) {
        if (nextDelta.getRelation(pred).size > 0) {
          changedPreds.add(pred);
        }
      }
    }

    currentDelta = nextDelta;
  }

  return changedPreds;
}

/**
 * Evaluate a stratum using the DRed (Delete and Rederive) pattern.
 *
 * 1. Delete phase: remove all derived facts for this stratum's head
 *    predicates from the accumulated db.
 * 2. Rederive phase: re-evaluate the stratum's rules to a fixed point
 *    against the accumulated db (which now has updated input facts but
 *    no stale derivations for this stratum).
 *
 * This is a conservative approach: rather than tracking individual
 * derivation provenance, we wipe and recompute the entire stratum.
 * For the default rules this is efficient because:
 *   - Stratum 0 (superseded, fugue_child, etc.) is bounded by the
 *     number of constraints.
 *   - Stratum 1 (winner, fugue_before) is bounded by the number of
 *     slots and parents, not the number of constraints.
 *   - The stratum's rules are few (5 for stratum 0, 6 for stratum 1).
 *
 * The snapshot-and-diff at the outer level captures the net delta.
 *
 * Uses naive evaluation for negation strata (negation needs the full db)
 * and semi-naive for monotone strata.
 */
function evaluateStratumDRed(
  stratum: Stratum,
  db: Database,
): Set<string> {
  const changedPreds = new Set<string>();
  const derivedPreds = stratumDerivedPredicates(stratum);

  // Delete phase: remove all derived facts for this stratum.
  for (const pred of derivedPreds) {
    const rel = db.getRelation(pred);
    const tuples = rel.tuples(); // snapshot before removal
    for (const tuple of tuples) {
      db.removeFact({ predicate: pred, values: tuple });
    }
  }

  const hasNegOrAgg = stratumHasNegationOrAggregation(stratum);

  if (hasNegOrAgg) {
    // Rederive phase (naive): evaluate all rules to a fixed point.
    // Naive is required because negation body elements need the full db.
    let changed = true;
    let iterations = 0;
    const MAX_ITERATIONS = 100_000;

    while (changed && iterations < MAX_ITERATIONS) {
      changed = false;
      iterations++;

      for (const rule of stratum.rules) {
        const derived = evaluateRule(rule, db, db);
        for (const wf of derived) {
          if (wf.weight > 0 && db.addFact(wf.fact)) {
            changed = true;
            changedPreds.add(wf.fact.predicate);
          }
        }
      }
    }
  } else {
    // Rederive phase (semi-naive): faster for monotone strata.
    // Initial pass.
    const delta = new Database();
    for (const rule of stratum.rules) {
      const derived = evaluateRule(rule, db, db);
      for (const wf of derived) {
        if (wf.weight > 0 && !db.hasFact(wf.fact)) {
          delta.addFact(wf.fact);
        }
      }
    }
    db.mergeFrom(delta);

    for (const pred of delta.predicates()) {
      if (delta.getRelation(pred).size > 0) {
        changedPreds.add(pred);
      }
    }

    // Semi-naive iteration.
    let currentDelta = delta;
    let iterations = 0;
    const MAX_ITERATIONS = 100_000;

    while (currentDelta.size > 0 && iterations < MAX_ITERATIONS) {
      iterations++;
      const nextDelta = new Database();

      for (const rule of stratum.rules) {
        const positiveAtomIndices = getPositiveAtomIndices(rule.body);
        for (const deltaIdx of positiveAtomIndices) {
          const derived = evaluateRuleSemiNaive(rule, db, currentDelta, deltaIdx);
          for (const wf of derived) {
            if (wf.weight > 0 && !db.hasFact(wf.fact)) {
              nextDelta.addFact(wf.fact);
            }
          }
        }
      }

      db.mergeFrom(nextDelta);
      for (const pred of nextDelta.predicates()) {
        if (nextDelta.getRelation(pred).size > 0) {
          changedPreds.add(pred);
        }
      }
      currentDelta = nextDelta;
    }
  }

  return changedPreds;
}

// ---------------------------------------------------------------------------
// Resolution Extraction
// ---------------------------------------------------------------------------

/**
 * Convert a `ZSet<Fact>` of `winner` fact deltas to `ZSet<ResolvedWinner>`.
 *
 * Winner fact schema: `winner(Slot, CnId, Value)`
 *   [0] = Slot (string)
 *   [1] = CnId (cnIdKey string)
 *   [2] = Value
 *
 * Handles the winner replacement problem: when a winner changes, the
 * derived-fact delta contains both −1 (old winner) and +1 (new winner)
 * for the same slot. A naive `zsetMap` keyed by slotId would sum these
 * weights to 0 (cancellation). Instead, we group by slotId and apply
 * replacement semantics:
 *   - Both +1 and −1 for same slot → emit only +1 (replacement).
 *   - Only +1 → emit +1 (new winner).
 *   - Only −1 → emit −1 (winner removed).
 *
 * This matches the skeleton's expectation and the native LWW solver's
 * delta contract (Plan 005 Learnings: Resolution Diffing).
 */
function winnerFactsToResolution(
  winnerDelta: ZSet<Fact>,
): ZSet<ResolvedWinner> {
  // Group winner fact deltas by slotId.
  const bySlot = new Map<string, { plus: ResolvedWinner | null; minus: ResolvedWinner | null }>();

  zsetForEach(winnerDelta, (entry) => {
    const f = entry.element;
    const slotId = f.values[0] as string;
    const winner: ResolvedWinner = {
      slotId,
      winnerCnIdKey: f.values[1] as string,
      content: f.values[2]!,
    };

    let slot = bySlot.get(slotId);
    if (slot === undefined) {
      slot = { plus: null, minus: null };
      bySlot.set(slotId, slot);
    }

    if (entry.weight > 0) {
      slot.plus = winner;
    } else if (entry.weight < 0) {
      slot.minus = winner;
    }
  });

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
 * Convert a `ZSet<Fact>` of `fugue_before` fact deltas to
 * `ZSet<FugueBeforePair>`.
 *
 * Fugue before fact schema: `fugue_before(Parent, A, B)`
 *   [0] = Parent (cnIdKey string)
 *   [1] = A (cnIdKey string)
 *   [2] = B (cnIdKey string)
 */
function fuguePairFactsToResolution(
  fugueDelta: ZSet<Fact>,
): ZSet<FugueBeforePair> {
  return zsetMap(
    fugueDelta,
    (p: FugueBeforePair) => fuguePairKey(p),
    (f: Fact): FugueBeforePair => ({
      parentKey: f.values[0] as string,
      a: f.values[1] as string,
      b: f.values[2] as string,
    }),
  );
}

// ---------------------------------------------------------------------------
// IncrementalDatalogEvaluator Interface
// ---------------------------------------------------------------------------

/**
 * An incremental Datalog evaluator that maintains persistent state
 * across time steps.
 *
 * Follows the three shared conventions:
 *   1. step(deltaFacts, deltaRules) — process deltas, return derived delta
 *   2. current() — return full accumulated derived Database
 *   3. reset() — return to empty state
 */
export interface IncrementalDatalogEvaluator {
  /**
   * Process a delta of ground facts and optional rule changes.
   *
   * @param deltaFacts - Z-set delta of ground facts from projection.
   * @param deltaRules - Changed rules (+1 = added, −1 = retracted).
   *   Empty on most insertions.
   * @returns Resolution deltas extracted from derived fact changes.
   */
  step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
    deltaDerived: ZSet<Fact>;
  };

  /**
   * The full accumulated Database (ground + derived facts).
   * For testing and strategy-switch bootstrapping.
   */
  currentDatabase(): Database;

  /**
   * Extract the current resolution from derived facts.
   * Convenience for materializing a full ResolutionResult.
   */
  currentResolution(): {
    winners: ReadonlyMap<string, ResolvedWinner>;
    fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>;
  };

  /** Reset to empty state. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental Datalog evaluator.
 *
 * @param initialRules - The initial set of rules (typically the default
 *   LWW + Fugue rules from bootstrap).
 * @returns An IncrementalDatalogEvaluator instance with empty state.
 */
export function createIncrementalDatalogEvaluator(
  initialRules: readonly Rule[],
): IncrementalDatalogEvaluator {
  // --- Mutable state ---

  /** Accumulated database: ground + derived facts. */
  let db = new Database();

  /** Current rules. */
  let rules: Rule[] = [...initialRules];

  /** Current stratification (recomputed on rule changes). */
  let strata: readonly Stratum[] = [];

  /** Map from predicate → affected stratum indices. */
  let predToStrata: Map<string, Set<number>> = new Map();

  /** All derived predicates across all strata (head predicates of rules). */
  let allDerivedPreds: Set<string> = new Set();

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
      // Cyclic negation — clear strata. The evaluator will produce
      // no derived facts until rules are fixed.
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
   * Run a full evaluation from scratch over the accumulated ground facts.
   * Used after rule changes to recompute all derived facts.
   */
  function fullRecompute(): void {
    // Remove all derived facts.
    for (const pred of allDerivedPreds) {
      const tuples = db.getRelation(pred).tuples();
      for (const tuple of tuples) {
        db.removeFact({ predicate: pred, values: tuple });
      }
    }

    // Re-evaluate all strata bottom-up.
    for (const stratum of strata) {
      if (stratum.rules.length === 0) continue;

      const hasNegOrAgg = stratumHasNegationOrAggregation(stratum);

      if (hasNegOrAgg) {
        // Naive evaluation for negation/aggregation strata.
        let changed = true;
        let iterations = 0;
        const MAX_ITERATIONS = 100_000;

        while (changed && iterations < MAX_ITERATIONS) {
          changed = false;
          iterations++;

          for (const rule of stratum.rules) {
            const derived = evaluateRule(rule, db, db);
            for (const wf of derived) {
              if (wf.weight > 0 && db.addFact(wf.fact)) {
                changed = true;
              }
            }
          }
        }
      } else {
        // Semi-naive for monotone strata.
        // Initial pass: evaluate all rules against the full database.
        const delta = new Database();
        for (const rule of stratum.rules) {
          const derived = evaluateRule(rule, db, db);
          for (const wf of derived) {
            if (wf.weight > 0 && !db.hasFact(wf.fact)) {
              delta.addFact(wf.fact);
            }
          }
        }
        db.mergeFrom(delta);

        if (delta.size > 0) {
          // Semi-naive iteration.
          let currentDelta = delta;
          let iterations = 0;
          const MAX_ITERATIONS = 100_000;

          while (currentDelta.size > 0 && iterations < MAX_ITERATIONS) {
            iterations++;
            const nextDelta = new Database();

            for (const rule of stratum.rules) {
              const positiveAtomIndices = getPositiveAtomIndices(rule.body);

              for (const deltaIdx of positiveAtomIndices) {
                const derived = evaluateRuleSemiNaive(
                  rule, db, currentDelta, deltaIdx,
                );
                for (const wf of derived) {
                  if (wf.weight > 0 && !db.hasFact(wf.fact)) {
                    nextDelta.addFact(wf.fact);
                  }
                }
              }
            }

            db.mergeFrom(nextDelta);
            currentDelta = nextDelta;
          }
        }
      }
    }
  }

  // --- Public interface ---

  function step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
    deltaDerived: ZSet<Fact>;
  } {
    const emptyResult = {
      deltaResolved: zsetEmpty<ResolvedWinner>(),
      deltaFuguePairs: zsetEmpty<FugueBeforePair>(),
      deltaDerived: zsetEmpty<Fact>(),
    };

    // --- Handle rule changes ---
    if (!zsetIsEmpty(deltaRules)) {
      // Rebuild rules from delta.
      zsetForEach(deltaRules, (entry) => {
        if (entry.weight > 0) {
          rules.push(entry.element);
        } else if (entry.weight < 0) {
          // Remove matching rule by structural identity.
          const rKey = ruleIdentity(entry.element);
          const idx = rules.findIndex((r) => ruleIdentity(r) === rKey);
          if (idx !== -1) {
            rules.splice(idx, 1);
          }
        }
      });

      // Snapshot derived facts before rule change.
      const oldDerived = snapshotDerivedPredicates(db, allDerivedPreds);

      // Restratify and recompute.
      restratify();

      // Apply any ground fact delta first.
      if (!zsetIsEmpty(deltaFacts)) {
        applyFactDelta(db, deltaFacts);
      }

      fullRecompute();

      // Snapshot new derived facts (with updated derived preds).
      const newDerived = snapshotDerivedPredicates(db, allDerivedPreds);

      // Diff across potentially different predicate sets.
      const deltaDerived = diffDatabases(oldDerived, newDerived);

      if (zsetIsEmpty(deltaDerived)) return emptyResult;

      // Extract resolution deltas.
      const groups = groupByPredicate(deltaDerived);
      const deltaResolved = winnerFactsToResolution(
        groups.get('winner') ?? zsetEmpty(),
      );
      const deltaFuguePairs = fuguePairFactsToResolution(
        groups.get('fugue_before') ?? zsetEmpty(),
      );

      return { deltaResolved, deltaFuguePairs, deltaDerived };
    }

    // --- No rule change — incremental evaluation ---

    if (zsetIsEmpty(deltaFacts)) return emptyResult;

    // 1. Snapshot derived predicates before step.
    const preStepSnapshot = snapshotDerivedPredicates(db, allDerivedPreds);

    // 2. Apply ground fact delta to accumulated db.
    applyFactDelta(db, deltaFacts);

    // 3. Determine which predicates changed.
    const changedPreds = new Set<string>();
    zsetForEach(deltaFacts, (entry) => {
      changedPreds.add(entry.element.predicate);
    });

    // 4. Determine affected strata.
    const affectedIndices = affectedStrata(changedPreds, strata, predToStrata);

    if (affectedIndices.length === 0) {
      // No strata affected — no derived fact changes.
      return emptyResult;
    }

    // 5. Check if the delta contains any retractions (weight −1).
    // If so, monotone strata may have lost support for derived facts,
    // which semi-naive alone cannot handle. We use DRed for all
    // affected strata when retractions are present.
    let hasRetractions = false;
    zsetForEach(deltaFacts, (entry) => {
      if (entry.weight < 0) hasRetractions = true;
    });

    // 6. Build a delta Database for the input delta (only +1 entries,
    //    for semi-naive seeding of monotone strata when no retractions).
    const inputDelta = new Database();
    if (!hasRetractions) {
      zsetForEach(deltaFacts, (entry) => {
        if (entry.weight > 0) {
          inputDelta.addFact(entry.element);
        }
      });
    }

    // 7. Evaluate affected strata bottom-up.
    for (const stratumIdx of affectedIndices) {
      const stratum = strata.find((s) => s.index === stratumIdx);
      if (stratum === undefined || stratum.rules.length === 0) continue;

      const hasNegOrAgg = stratumHasNegationOrAggregation(stratum);

      if (hasNegOrAgg || hasRetractions) {
        // DRed: delete all derived facts for this stratum, then rederive.
        // Used for:
        //   - Negation/aggregation strata (always).
        //   - Any stratum when retractions are present (monotone semi-naive
        //     cannot handle lost support from removed input facts).
        evaluateStratumDRed(stratum, db);
      } else {
        // Monotone with no retractions: incremental semi-naive.
        evaluateMonotoneStratumIncremental(stratum, db, inputDelta);
      }
    }

    // 8. Diff post-step derived facts against pre-step snapshot.
    const postStepSnapshot = snapshotDerivedPredicates(db, allDerivedPreds);
    const deltaDerived = diffDatabases(preStepSnapshot, postStepSnapshot);

    if (zsetIsEmpty(deltaDerived)) return emptyResult;

    // 9. Extract resolution deltas from derived fact changes.
    const groups = groupByPredicate(deltaDerived);
    const deltaResolved = winnerFactsToResolution(
      groups.get('winner') ?? zsetEmpty(),
    );
    const deltaFuguePairs = fuguePairFactsToResolution(
      groups.get('fugue_before') ?? zsetEmpty(),
    );

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
  }

  return { step, currentDatabase, currentResolution, reset };
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a predicate is referenced in any body element of a stratum's
 * rules (i.e., could this stratum be affected by changes to this predicate).
 */
function isReferencedByStratum(pred: string, stratum: Stratum): boolean {
  for (const rule of stratum.rules) {
    const preds = bodyPredicates(rule.body);
    if (preds.has(pred)) return true;
  }
  return false;
}

/**
 * Produce a stable identity string for a rule (for matching on retraction).
 *
 * We serialize the rule's head and body structure. This is structural
 * identity — two rules with the same head/body shape from different
 * constraints produce the same key.
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