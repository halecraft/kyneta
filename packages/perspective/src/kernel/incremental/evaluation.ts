// === Incremental Evaluation Stage ===
// Strategy wrapper that delegates to either native incremental solvers
// (LWW + Fugue) or the unified weighted Datalog evaluator, based on
// active rules.
//
// This stage sits between projection and skeleton in the incremental DAG. On
// the Datalog path it is R(E(Δ)), in the notation of theory/incremental.md
// §5.6–5.7: E, the evaluator, emits Δ_derived, a delta of derived facts that
// knows nothing about constraints; R, `winnerDeltas` and `fuguePairDeltas`
// in `resolve.ts`, reads `winner` and `fugue_before` out of it.
//
//   P^Δ (projection) → Δ_facts → E^Δ → Δ_derived → R → { Δ_resolved, Δ_fuguePairs } → K^Δ (skeleton)
//
// The native path (Phase 2–3) handles default LWW/Fugue rules in O(|Δ|).
// The Datalog path uses the unified evaluator from Plan 006.1, which
// replaces the old incremental-evaluate.ts with weighted semi-naive
// evaluation and dirty-map-based delta extraction.
//
// Strategy switching occurs when rule constraints are added or retracted.
// On switch, the new strategy is bootstrapped from accumulated facts and
// a diff is emitted against the old strategy's accumulated resolution.
// The current step's deltaFacts are then processed through the newly-active
// strategy and combined with the switch diff.
//
// See Plan 006 §Architecture, §Functional Core / Imperative Shell.
// See Plan 006.1 Phase 3: Wire Unified Evaluator into Pipeline.
// The §B.7 native-solver fast path this stage used to switch between is gone;
// see .plans/008-retire-the-native-fast-path.md.

import type { Fact, Host, Rule } from "@kyneta/datalog"
import { createEvaluator, type Evaluator } from "@kyneta/datalog"
import type { ZSet } from "@kyneta/zset"
import {
  zsetAdd,
  zsetEmpty,
  zsetForEach,
  zsetIsEmpty,
  zsetSingleton,
} from "@kyneta/zset"
import { cnIdKey } from "../cnid.js"
import type {
  FugueBeforePair,
  ResolutionResult,
  ResolvedWinner,
} from "../resolve.js"
import { extractResolution, fuguePairDeltas, winnerDeltas } from "../resolve.js"
import type { Constraint, RuleConstraint } from "../types.js"

// ---------------------------------------------------------------------------
// Pure utility: rule deltas
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
  let ruleDeltas = zsetEmpty<Rule>()

  zsetForEach(activeDelta, (entry, _key) => {
    const c = entry.element
    if (c.type === "rule") {
      const rc = c as RuleConstraint
      const rule: Rule = { head: rc.payload.head, body: rc.payload.body }
      // Key by a stable identity — use the constraint's CnId
      const ruleKey = cnIdKey(rc.id)
      ruleDeltas = zsetAdd(
        ruleDeltas,
        zsetSingleton(ruleKey, rule, entry.weight),
      )
    }
  })

  return ruleDeltas
}

// ---------------------------------------------------------------------------
// IncrementalEvaluation interface
// ---------------------------------------------------------------------------

/**
 * The incremental evaluation stage.
 *
 * Wraps native incremental solvers and the incremental Datalog evaluator
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
   * This used to take two more parameters — lazy getters for the whole
   * accumulated fact set and the whole active constraint set. They existed
   * only so that a switch between the Datalog evaluator and the hand-written
   * §B.7 solvers could rebuild the newly-chosen one from the entire world.
   * With one evaluation path there is nothing to switch, and the stage is a
   * function of its own delta and its own accumulated state — which is what a
   * DBSP pipeline stage is supposed to be.
   *
   * @param deltaFacts - Z-set delta from the projection stage.
   * @param deltaRules - Changed rules (weight +1 = added, −1 = retracted).
   *                     Empty on most insertions.
   * @returns Resolution deltas for the skeleton stage.
   */
  step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): {
    deltaResolved: ZSet<ResolvedWinner>
    deltaFuguePairs: ZSet<FugueBeforePair>
  }

  /** Full materialized resolution result. */
  current(): ResolutionResult

  /** Reset to empty state. */
  reset(): void
}

/** R applied to E's output: the resolution deltas the skeleton consumes. */
function resolutionDeltas(derived: ZSet<Fact>): {
  deltaResolved: ZSet<ResolvedWinner>
  deltaFuguePairs: ZSet<FugueBeforePair>
} {
  return {
    deltaResolved: winnerDeltas(derived),
    deltaFuguePairs: fuguePairDeltas(derived),
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental evaluation stage.
 *
 * The stage owns one long-lived Datalog evaluator. Rules reach it the same way
 * facts do — as a delta — because rules are constraints, so a rule arriving or
 * being retracted is just another change in the store.
 *
 * @returns An IncrementalEvaluation instance with empty state.
 */
export function createIncrementalEvaluation(
  host?: Host,
): IncrementalEvaluation {
  // Created eagerly and empty. It used to be built lazily, on the first switch
  // away from the native solvers; with no switch there is no reason to defer.
  // An evaluator with no rules derives nothing, which is the right answer for
  // a store that has not been bootstrapped yet.
  let datalog: Evaluator = createEvaluator([], host)

  function step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): {
    deltaResolved: ZSet<ResolvedWinner>
    deltaFuguePairs: ZSet<FugueBeforePair>
  } {
    if (zsetIsEmpty(deltaFacts) && zsetIsEmpty(deltaRules)) {
      return { deltaResolved: zsetEmpty(), deltaFuguePairs: zsetEmpty() }
    }

    if (!zsetIsEmpty(deltaRules)) {
      // A rule change re-derives every stratum over the facts as they stand;
      // the fact delta then applies incrementally on top. Z-set addition nets
      // the two, so a fact that flipped in both directions cancels out and the
      // skeleton sees one clean delta.
      return resolutionDeltas(
        zsetAdd(datalog.changeRules(deltaRules), datalog.step(deltaFacts)),
      )
    }

    return resolutionDeltas(datalog.step(deltaFacts))
  }

  function current(): ResolutionResult {
    return extractResolution(datalog.currentDatabase())
  }

  function reset(): void {
    datalog = createEvaluator([], host)
  }

  return { step, current, reset }
}
