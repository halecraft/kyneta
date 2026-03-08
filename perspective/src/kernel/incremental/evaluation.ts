// === Incremental Evaluation Stage ===
// Strategy wrapper that delegates to either native incremental solvers
// (LWW + Fugue) or the batch Datalog evaluator, based on active rules.
//
// This stage sits between projection and skeleton in the incremental DAG:
//
//   P^Δ (projection) → Δ_facts → E^Δ (this stage) → { Δ_resolved, Δ_fuguePairs } → K^Δ (skeleton)
//
// The native path (Phase 2–3) handles default LWW/Fugue rules in O(|Δ|).
// The batch Datalog fallback (Phase 4) handles custom rules but is O(|S|).
// Phase 7 replaces the batch fallback with the incremental Datalog evaluator.
//
// Strategy switching occurs when rule constraints are added or retracted.
// On switch, the new strategy is bootstrapped from accumulated facts and
// a diff is emitted against the old strategy's accumulated resolution.
//
// See Plan 006 §Architecture, §Functional Core / Imperative Shell.
// See theory/incremental.md §9.7 (native solver fast path).

import type { Fact, Rule } from '../../datalog/types.js';
import type {
  Constraint,
  RuleConstraint,
} from '../types.js';
import type {
  ResolvedWinner,
  FugueBeforePair,
  ResolutionResult,
} from '../resolve.js';
import {
  nativeResolution,
  fuguePairKey,
} from '../resolve.js';
import {
  extractRules,
  selectResolutionStrategy,
  type ResolutionStrategy,
} from '../rule-detection.js';
import { buildNativeResolution } from '../native-resolution.js';
import type { StructureIndex } from '../structure-index.js';
import { evaluate } from '../../datalog/evaluate.js';
import { extractResolution } from '../resolve.js';
import { cnIdKey } from '../cnid.js';
import {
  createIncrementalLWW,
  type IncrementalLWW,
} from '../../solver/incremental-lww.js';
import {
  createIncrementalFugue,
  type IncrementalFugue,
} from '../../solver/incremental-fugue.js';
import type { ZSet } from '../../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetIsEmpty,
  zsetForEach,
} from '../../base/zset.js';

// ---------------------------------------------------------------------------
// Pure utility: fact routing
// ---------------------------------------------------------------------------

/**
 * Split a mixed `ZSet<Fact>` by predicate into separate Z-sets.
 *
 * This is a pure function — independently testable.
 * The evaluation stage uses it to route facts to the appropriate
 * native solver (LWW gets `active_value`, Fugue gets
 * `active_structure_seq` + `constraint_peer`).
 */
export function routeFactsByPredicate(
  deltaFacts: ZSet<Fact>,
): {
  lwwFacts: ZSet<Fact>;
  fugueFacts: ZSet<Fact>;
  otherFacts: ZSet<Fact>;
} {
  let lwwFacts = zsetEmpty<Fact>();
  let fugueFacts = zsetEmpty<Fact>();
  let otherFacts = zsetEmpty<Fact>();

  zsetForEach(deltaFacts, (entry, key) => {
    const pred = entry.element.predicate;
    const singleton = zsetSingleton(key, entry.element, entry.weight);

    if (pred === 'active_value') {
      lwwFacts = zsetAdd(lwwFacts, singleton);
    } else if (pred === 'active_structure_seq' || pred === 'constraint_peer') {
      fugueFacts = zsetAdd(fugueFacts, singleton);
    } else {
      otherFacts = zsetAdd(otherFacts, singleton);
    }
  });

  return { lwwFacts, fugueFacts, otherFacts };
}

// ---------------------------------------------------------------------------
// Pure utility: rule delta extraction
// ---------------------------------------------------------------------------

/**
 * Extract rule deltas from the active-set delta.
 *
 * Inspects `Δ_active` for rule constraints and produces a Z-set of
 * `Rule` objects (head + body) with the same weights. This tells the
 * evaluation stage which rules were added (+1) or retracted (−1).
 */
export function extractRuleDeltasFromActive(
  activeDelta: ZSet<Constraint>,
): ZSet<Rule> {
  let ruleDeltas = zsetEmpty<Rule>();

  zsetForEach(activeDelta, (entry, _key) => {
    const c = entry.element;
    if (c.type === 'rule') {
      const rc = c as RuleConstraint;
      const rule: Rule = { head: rc.payload.head, body: rc.payload.body };
      // Key by a stable identity — use the constraint's CnId
      const ruleKey = cnIdKey(rc.id);
      ruleDeltas = zsetAdd(
        ruleDeltas,
        zsetSingleton(ruleKey, rule, entry.weight),
      );
    }
  });

  return ruleDeltas;
}

// ---------------------------------------------------------------------------
// IncrementalEvaluation interface
// ---------------------------------------------------------------------------

/**
 * The incremental evaluation stage.
 *
 * Wraps native incremental solvers and the batch Datalog evaluator
 * behind a unified interface. Receives fact and rule deltas, produces
 * resolution deltas for the skeleton.
 *
 * Follows the three shared conventions:
 *   1. step(deltaFacts, deltaRules) — process deltas, return resolution deltas
 *   2. current() — return full materialized resolution result
 *   3. reset() — return to empty state
 */
export interface IncrementalEvaluation {
  /**
   * Process a delta of projected facts and return resolution deltas.
   *
   * @param deltaFacts - Z-set delta from the projection stage.
   * @param deltaRules - Changed rules (weight +1 = added, −1 = retracted).
   *                     Empty on most insertions.
   * @param getAccumulatedFacts - Lazy getter for full accumulated facts
   *   (only called when batch Datalog fallback is needed).
   * @param getActiveConstraints - Lazy getter for full active constraint set
   *   (only called when strategy switching or batch fallback is needed).
   * @param getStructureIndex - Lazy getter for full structure index
   *   (only called when batch native resolution is needed).
   * @returns Resolution deltas for the skeleton stage.
   */
  step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
    getAccumulatedFacts: () => Fact[],
    getActiveConstraints: () => readonly Constraint[],
    getStructureIndex: () => StructureIndex,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  };

  /** Full materialized resolution result. */
  current(): ResolutionResult;

  /** Reset to empty state. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Resolution diffing (for strategy switches and batch fallback)
// ---------------------------------------------------------------------------

/**
 * Diff two ResolutionResults to produce Z-set deltas.
 *
 * Used when switching strategies or when the batch Datalog fallback
 * produces a full result that needs to be compared against the previous.
 *
 * Winner key = slotId. Changed winners emit only +1 (not −1 then +1)
 * because both entries share the same Z-set key and would annihilate.
 * See Plan 005 Learnings: Resolution Diffing.
 */
function diffResolution(
  oldRes: ResolutionResult | null,
  newRes: ResolutionResult,
): {
  deltaResolved: ZSet<ResolvedWinner>;
  deltaFuguePairs: ZSet<FugueBeforePair>;
} {
  let deltaResolved = zsetEmpty<ResolvedWinner>();

  const oldWinners = oldRes?.winners ?? new Map<string, ResolvedWinner>();
  const newWinners = newRes.winners;

  for (const [slotId, newWinner] of newWinners) {
    const oldWinner = oldWinners.get(slotId);
    if (oldWinner === undefined) {
      deltaResolved = zsetAdd(
        deltaResolved,
        zsetSingleton(slotId, newWinner, 1),
      );
    } else if (
      oldWinner.winnerCnIdKey !== newWinner.winnerCnIdKey ||
      oldWinner.content !== newWinner.content
    ) {
      // Changed winner — emit only +1 (skeleton handles replacement)
      deltaResolved = zsetAdd(
        deltaResolved,
        zsetSingleton(slotId, newWinner, 1),
      );
    }
  }

  for (const [slotId, oldWinner] of oldWinners) {
    if (!newWinners.has(slotId)) {
      deltaResolved = zsetAdd(
        deltaResolved,
        zsetSingleton(slotId, oldWinner, -1),
      );
    }
  }

  // Fugue pair diffing
  const oldPairsMap = oldRes?.fuguePairs ?? new Map<string, readonly FugueBeforePair[]>();
  const newPairsMap = newRes.fuguePairs;

  const oldFlat = new Map<string, FugueBeforePair>();
  for (const pairs of oldPairsMap.values()) {
    for (const p of pairs) {
      oldFlat.set(fuguePairKey(p), p);
    }
  }

  const newFlat = new Map<string, FugueBeforePair>();
  for (const pairs of newPairsMap.values()) {
    for (const p of pairs) {
      newFlat.set(fuguePairKey(p), p);
    }
  }

  let deltaFuguePairs = zsetEmpty<FugueBeforePair>();

  for (const [key, p] of newFlat) {
    if (!oldFlat.has(key)) {
      deltaFuguePairs = zsetAdd(deltaFuguePairs, zsetSingleton(key, p, 1));
    }
  }

  for (const [key, p] of oldFlat) {
    if (!newFlat.has(key)) {
      deltaFuguePairs = zsetAdd(deltaFuguePairs, zsetSingleton(key, p, -1));
    }
  }

  return { deltaResolved, deltaFuguePairs };
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental evaluation stage.
 *
 * @returns An IncrementalEvaluation instance with empty state.
 */
export function createIncrementalEvaluation(): IncrementalEvaluation {
  // --- Strategy state ---
  let strategy: ResolutionStrategy = 'native';
  let lww: IncrementalLWW = createIncrementalLWW();
  let fugue: IncrementalFugue = createIncrementalFugue();

  // Cached resolution for the batch Datalog fallback path.
  // Only used when strategy === 'datalog'.
  let cachedBatchResolution: ResolutionResult | null = null;

  // Accumulated rules for strategy detection on rule changes.
  let accumulatedRules: Rule[] = [];

  // --- Internal helpers ---

  /**
   * Build a ResolutionResult from the native solvers' current state.
   */
  function nativeCurrentResolution(): ResolutionResult {
    return nativeResolution(lww.current(), fugue.current());
  }

  /**
   * Run the native path: route facts to LWW and Fugue, combine deltas.
   */
  function stepNative(deltaFacts: ZSet<Fact>): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  } {
    const { lwwFacts, fugueFacts } = routeFactsByPredicate(deltaFacts);

    const deltaResolved = lww.step(lwwFacts);
    const deltaFuguePairs = fugue.step(fugueFacts);

    return { deltaResolved, deltaFuguePairs };
  }

  /**
   * Run the batch Datalog fallback: evaluate all rules over all accumulated
   * facts, diff against cached resolution.
   *
   * This is O(|S|) — the same cost as the pre-Phase 4 pipeline. It's
   * encapsulated here so the pipeline composition root doesn't need to
   * know about it. Phase 7 replaces this with the incremental Datalog
   * evaluator.
   */
  function stepBatchDatalog(
    getAccumulatedFacts: () => Fact[],
    getActiveConstraints: () => readonly Constraint[],
    getStructureIndex: () => StructureIndex,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  } {
    const activeConstraints = getActiveConstraints();
    const accFacts = getAccumulatedFacts();
    const rules = extractRules(activeConstraints);

    let newResolution: ResolutionResult;

    const evalResult = evaluate(rules, accFacts);
    if (evalResult.ok) {
      newResolution = extractResolution(evalResult.value);
    } else {
      // Datalog evaluation failed (e.g., cyclic negation).
      // Fall back to native solvers as graceful degradation.
      newResolution = buildNativeResolution(
        activeConstraints,
        getStructureIndex(),
      );
    }

    const delta = diffResolution(cachedBatchResolution, newResolution);
    cachedBatchResolution = newResolution;
    return delta;
  }

  /**
   * Switch from native to batch Datalog.
   * Bootstrap the batch path from accumulated facts, diff against
   * the native path's accumulated resolution.
   */
  function switchToDatalog(
    getAccumulatedFacts: () => Fact[],
    getActiveConstraints: () => readonly Constraint[],
    getStructureIndex: () => StructureIndex,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  } {
    const oldResolution = nativeCurrentResolution();

    // Run batch Datalog from scratch
    const activeConstraints = getActiveConstraints();
    const accFacts = getAccumulatedFacts();
    const rules = extractRules(activeConstraints);

    let newResolution: ResolutionResult;
    const evalResult = evaluate(rules, accFacts);
    if (evalResult.ok) {
      newResolution = extractResolution(evalResult.value);
    } else {
      newResolution = buildNativeResolution(
        activeConstraints,
        getStructureIndex(),
      );
    }

    cachedBatchResolution = newResolution;
    strategy = 'datalog';

    return diffResolution(oldResolution, newResolution);
  }

  /**
   * Switch from batch Datalog back to native.
   * Bootstrap native solvers from accumulated facts, diff against
   * the Datalog path's accumulated resolution.
   */
  function switchToNative(
    getAccumulatedFacts: () => Fact[],
    getActiveConstraints: () => readonly Constraint[],
    getStructureIndex: () => StructureIndex,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  } {
    const oldResolution = cachedBatchResolution;

    // Rebuild native solvers from accumulated facts
    lww = createIncrementalLWW();
    fugue = createIncrementalFugue();

    // Feed all accumulated facts through the native solvers
    const accFacts = getAccumulatedFacts();
    for (const f of accFacts) {
      const key = f.predicate + '|' + (f.values[0] as string);
      const singleton = zsetSingleton(key, f, 1);
      if (f.predicate === 'active_value') {
        lww.step(singleton);
      } else if (
        f.predicate === 'active_structure_seq' ||
        f.predicate === 'constraint_peer'
      ) {
        fugue.step(singleton);
      }
    }

    cachedBatchResolution = null;
    strategy = 'native';

    const newResolution = nativeCurrentResolution();
    return diffResolution(oldResolution, newResolution);
  }

  // --- Public interface ---

  function step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
    getAccumulatedFacts: () => Fact[],
    getActiveConstraints: () => readonly Constraint[],
    getStructureIndex: () => StructureIndex,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  } {
    // --- Handle rule changes ---
    if (!zsetIsEmpty(deltaRules)) {
      // Update accumulated rules
      // Rather than tracking incremental adds/removes, just rebuild
      // from active constraints — rules are rare (typically ~11 default)
      accumulatedRules = extractRules(getActiveConstraints());

      const newStrategy = selectResolutionStrategy(
        true, // always enable Datalog for strategy detection
        accumulatedRules,
        getActiveConstraints(),
      );

      if (newStrategy !== strategy) {
        // Strategy switch needed
        if (newStrategy === 'datalog') {
          return switchToDatalog(
            getAccumulatedFacts,
            getActiveConstraints,
            getStructureIndex,
          );
        } else {
          return switchToNative(
            getAccumulatedFacts,
            getActiveConstraints,
            getStructureIndex,
          );
        }
      }
    }

    // --- No strategy change — process facts through active strategy ---
    if (zsetIsEmpty(deltaFacts) && zsetIsEmpty(deltaRules)) {
      return {
        deltaResolved: zsetEmpty(),
        deltaFuguePairs: zsetEmpty(),
      };
    }

    if (strategy === 'native') {
      return stepNative(deltaFacts);
    } else {
      return stepBatchDatalog(
        getAccumulatedFacts,
        getActiveConstraints,
        getStructureIndex,
      );
    }
  }

  function current(): ResolutionResult {
    if (strategy === 'native') {
      return nativeCurrentResolution();
    } else {
      // Return cached batch resolution, or empty if never computed
      return cachedBatchResolution ?? nativeResolution(new Map(), new Map());
    }
  }

  function reset(): void {
    strategy = 'native';
    lww = createIncrementalLWW();
    fugue = createIncrementalFugue();
    cachedBatchResolution = null;
    accumulatedRules = [];
  }

  return { step, current, reset };
}