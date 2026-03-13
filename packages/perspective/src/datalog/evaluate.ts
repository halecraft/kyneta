// === Datalog Evaluation Core ===
// Per-rule evaluation functions used by both the unified evaluator
// (evaluator.ts) and the naive test utility below.
//
// Weight semantics (Plan 006.1, extended by Plan 006.2):
// - Substitutions carry weights through evaluation.
// - Positive atom join: weight = sub.weight × tuple.weight (provenance product).
// - Negation/guard: weight preserved on pass, substitution dropped on fail.
// - Differential negation: weight = sub.weight × (-deltaWeight) (sign inversion).
// - Aggregation: output weight = 1 (group-by boundary resets provenance).
// - groundHead: duplicate facts sum weights (Z-set addition).
// - evaluateRule returns WeightedFact[] with summed weights per fact.
// - In batch mode, all input weights are 1, so all derived weights are 1.
//   The weight infrastructure is invisible to batch consumers.
//
// Stratum-level evaluation and the public `evaluate()`/`evaluatePositive()`
// entry points live in `evaluator.ts` (the unified weighted evaluator).
// This module provides only the rule-level building blocks and
// `evaluateNaive()` (a test utility for correctness oracle comparisons).
//
// References:
// - unified-engine.md §B.3 (evaluator requirements)
// - Ullman, "Principles of Database and Knowledge-Base Systems" Vol 1, Ch 3
// - DBSP (Budiu & McSherry, 2023) §3.2 (Z-set joins)

import type {
  Rule,
  BodyElement,
  Atom,
  Substitution,
  Fact,
  AggregationClause,
  GuardElement,
  ReadonlyDatabase,
} from './types.js';
import {
  Database,
  Relation,
  factKey,
} from './types.js';
import {
  EMPTY_SUBSTITUTION,
  matchAtomWithTuple,
  matchAtomAgainstRelation,
  groundAtom,
  evaluateGuard,
} from './unify.js';
import { evaluateAggregation } from './aggregate.js';

// ---------------------------------------------------------------------------
// Weighted Fact type
// ---------------------------------------------------------------------------

/**
 * A fact with an associated Z-set weight.
 *
 * In batch evaluation, all weights are 1. In incremental evaluation,
 * weights encode provenance multiplicity: +1 for derived, −1 for
 * retracted, and sums for multiple derivation paths.
 */
export interface WeightedFact {
  readonly fact: Fact;
  readonly weight: number;
}

// ---------------------------------------------------------------------------
// Test utility
// ---------------------------------------------------------------------------

/**
 * Evaluate rules naively (recompute everything each iteration until fixed point).
 *
 * This is less efficient than semi-naive but useful for correctness testing:
 * both approaches must produce the same result.
 *
 * @param rules  Positive Datalog rules.
 * @param facts  Ground facts.
 * @returns      The complete database.
 */
export function evaluateNaive(
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

  // Iterate until fixed point
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of rules) {
      const derived = evaluateRule(rule, db, db);
      for (const wf of derived) {
        if (wf.weight > 0 && db.addFact(wf.fact)) {
          changed = true;
        }
      }
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single rule against the database, producing weighted derived facts.
 *
 * Substitutions carry weights through body element evaluation. The head
 * is grounded with each surviving substitution, producing weighted facts.
 * Duplicate facts (same predicate + values) have their weights summed.
 *
 * @param rule     The rule to evaluate.
 * @param fullDb   The full database (for general matching and negation).
 * @param matchDb  The database to match positive atoms against
 *                 (could be delta for semi-naive).
 * @returns        Weighted derived facts from this rule.
 */
export function evaluateRule(
  rule: Rule,
  fullDb: ReadonlyDatabase,
  matchDb: ReadonlyDatabase,
): WeightedFact[] {
  // Start with a single empty substitution (weight 1)
  let subs: Substitution[] = [EMPTY_SUBSTITUTION];

  // Process each body element, extending substitutions
  for (const element of rule.body) {
    if (subs.length === 0) break;

    switch (element.kind) {
      case 'atom':
        subs = evaluatePositiveAtom(element.atom, matchDb, subs);
        break;
      case 'negation':
        subs = evaluateNegation(element.atom, fullDb, subs);
        break;
      case 'aggregation':
        subs = evaluateAggregationElement(element.agg, fullDb, subs);
        break;
      case 'guard':
        subs = evaluateGuardElement(element, subs);
        break;
    }
  }

  // Ground the head atom with each surviving substitution
  return groundHead(rule.head, subs);
}

/**
 * Evaluate a single rule in semi-naive mode: one specific body atom
 * (at `deltaIdx`) matches against the delta, while all other positive
 * atoms match against the full database.
 *
 * Returns weighted derived facts with duplicate-summing.
 *
 * @deprecated Use `evaluateRuleDelta` for new code. This function is
 *   retained for backward compatibility and does not support asymmetric
 *   joins or differential negation.
 */
export function evaluateRuleSemiNaive(
  rule: Rule,
  fullDb: ReadonlyDatabase,
  delta: ReadonlyDatabase,
  deltaIdx: number,
): WeightedFact[] {
  return evaluateRuleDelta(rule, fullDb, fullDb, delta, deltaIdx);
}

/**
 * Evaluate a single rule in delta-driven mode with asymmetric join support.
 *
 * One specific body element (at `deltaIdx`) matches against the `delta`
 * database, while other body elements match against `fullDbOld` or
 * `fullDbNew` depending on their position relative to `deltaIdx`. The
 * body element at `deltaIdx` knows its own kind (`atom` vs `negation`),
 * so no separate `deltaKind` parameter is needed.
 *
 * **Asymmetric join (DBSP incremental join):**
 * For a binary join `A ⋈ B` where A = B = P (self-join), the correct
 * incremental update is `ΔA ⋈ B_new + A_old ⋈ ΔB`. Standard semi-naive
 * uses `A_new` for both, double-counting pairs where both elements are
 * in ΔP. The asymmetry ensures each (a, b) pair is counted exactly once.
 *
 * For non-delta positive atoms:
 * - Positions `j < deltaIdx` on the same predicate as the delta: use
 *   `fullDbNew` (post-update state, = P_new).
 * - Positions `j > deltaIdx`, or on different predicates: use `fullDbOld`
 *   (pre-update state, = P_old).
 *
 * For the delta element itself:
 * - `case 'atom'`: evaluate against `delta` with `allEntries: true`
 *   (sees negative-weight entries for retraction propagation).
 * - `case 'negation'`: evaluate via `evaluateDifferentialNegation`
 *   against `delta` (sign inversion for negation semantics).
 *
 * Non-delta negations evaluate against `fullDbNew` (the current state
 * of the negated relation matters for boolean negation-as-failure).
 *
 * @param rule       The rule to evaluate.
 * @param fullDbOld  Pre-update database (P_old). For predicates not in
 *                   the delta, this is identical to fullDbNew.
 * @param fullDbNew  Post-update database (P_new = P_old + delta).
 * @param delta      The delta database (changed entries only).
 * @param deltaIdx   Index of the body element driven by the delta.
 * @returns          Weighted derived facts with duplicate-summing.
 *
 * See Plan 006.2, Phase 1, Task 1.2.
 * See DBSP (Budiu & McSherry, 2023) §3.2.
 */
export function evaluateRuleDelta(
  rule: Rule,
  fullDbOld: ReadonlyDatabase,
  fullDbNew: ReadonlyDatabase,
  delta: ReadonlyDatabase,
  deltaIdx: number,
): WeightedFact[] {
  let subs: Substitution[] = [EMPTY_SUBSTITUTION];

  // Collect predicates present in the delta for asymmetric join dispatch.
  const deltaPreds = new Set<string>(delta.predicates());

  for (let i = 0; i < rule.body.length; i++) {
    if (subs.length === 0) break;

    const element = rule.body[i]!;
    const isDeltaSource = i === deltaIdx;

    switch (element.kind) {
      case 'atom': {
        if (isDeltaSource) {
          // Delta source: match against delta with allEntries = true
          // to see negative-weight entries (retraction propagation).
          subs = evaluatePositiveAtom(element.atom, delta, subs, true);
        } else {
          // Asymmetric join: positions before deltaIdx on the same
          // predicate as the delta use fullDbNew (P_new); positions
          // after use fullDbOld (P_old). This prevents double-counting
          // in self-joins.
          const db = (i < deltaIdx && deltaPreds.has(element.atom.predicate))
            ? fullDbNew : fullDbOld;
          subs = evaluatePositiveAtom(element.atom, db, subs);
        }
        break;
      }
      case 'negation': {
        if (isDeltaSource) {
          // Differential negation: process the delta entries with
          // sign inversion (appearance blocks, disappearance unblocks).
          subs = evaluateDifferentialNegation(element.atom, delta, subs);
        } else {
          // Non-delta negation: boolean negation-as-failure against
          // the current (post-update) state.
          subs = evaluateNegation(element.atom, fullDbNew, subs);
        }
        break;
      }
      case 'aggregation':
        subs = evaluateAggregationElement(element.agg, fullDbNew, subs);
        break;
      case 'guard':
        subs = evaluateGuardElement(element, subs);
        break;
    }
  }

  return groundHead(rule.head, subs);
}

// ---------------------------------------------------------------------------
// Body element evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a positive atom: for each current substitution, match the atom
 * against all tuples in the database and collect extended substitutions.
 *
 * Weight multiplication (provenance semiring product): the extended
 * substitution's weight is `sub.weight × tuple.weight`. This is the
 * core of Z-set join semantics. In batch evaluation where all weights
 * are 1, this is a no-op multiplication.
 *
 * We iterate tuples directly (rather than delegating to
 * matchAtomAgainstRelation) so that we have access to each tuple for
 * weight lookup. This avoids re-grounding the atom — which would fail
 * for atoms containing wildcards.
 *
 * @param a          The atom to match.
 * @param db         The database to match against.
 * @param subs       Current substitutions to extend.
 * @param allEntries When `true`, uses `allWeightedTuples()` which includes
 *                   negative-weight entries (for delta databases). When
 *                   `false` (default), uses `weightedTuples()` which returns
 *                   only clampedWeight > 0 entries with weight = 1
 *                   (preventing weight explosion in recursive joins).
 *                   See Plan 006.2, Phase 1, Task 1.4.
 */
export function evaluatePositiveAtom(
  a: Atom,
  db: ReadonlyDatabase,
  subs: readonly Substitution[],
  allEntries: boolean = false,
): Substitution[] {
  const relation = db.getRelation(a.predicate);
  const entries = allEntries
    ? relation.allWeightedTuples()
    : relation.weightedTuples();

  const results: Substitution[] = [];
  for (const sub of subs) {
    for (const { tuple, weight: tupleWeight } of entries) {
      const extended = matchAtomWithTuple(a, tuple, sub);
      if (extended === null) continue;

      if (tupleWeight === 1) {
        // Common case (batch evaluation) — no multiplication needed.
        results.push(extended);
      } else {
        // Weight multiplication: sub.weight × tuple.weight (provenance product).
        results.push({ bindings: extended.bindings, weight: extended.weight * tupleWeight });
      }
    }
  }
  return results;
}

/**
 * Evaluate a negated atom: keep only substitutions for which the atom
 * has NO match in the database.
 *
 * Negation-as-failure with safety: all variables in the negated atom
 * that are not grouping variables must already be bound in the substitution.
 * We check each substitution against the full database — if ANY tuple
 * matches (weight > 0, which is what tuples() returns), the substitution
 * is removed. Weight is preserved on pass.
 */
export function evaluateNegation(
  a: Atom,
  db: ReadonlyDatabase,
  subs: readonly Substitution[],
): Substitution[] {
  const relation = db.getRelation(a.predicate);
  const tuples = relation.tuples();

  const results: Substitution[] = [];
  for (const sub of subs) {
    // Check if any tuple matches
    const matches = matchAtomAgainstRelation(a, tuples, sub);
    if (matches.length === 0) {
      // No match — negation holds, keep this substitution (weight preserved)
      results.push(sub);
    }
  }
  return results;
}

/**
 * Evaluate differential negation: process delta entries for a negated atom
 * with sign inversion.
 *
 * Unlike `evaluateNegation` (boolean filter — pass or block), this function
 * produces weighted substitutions from changes in the negated relation:
 *
 * - Delta weight +1 (fact appeared in negated relation): this binding is
 *   now blocked → emit substitution with `weight = sub.weight × (-1)`.
 * - Delta weight −1 (fact disappeared from negated relation): this binding
 *   is now unblocked → emit substitution with `weight = sub.weight × (+1)`.
 *
 * The general formula is: `output_weight = sub.weight × (-deltaWeight)`.
 *
 * The sign inversion encodes negation-as-failure semantics: appearance of
 * a negated fact *removes* derivations; disappearance *adds* derivations.
 *
 * Uses `allWeightedTuples()` to see both positive and negative delta entries.
 *
 * @param a      The negated atom to match against the delta.
 * @param delta  The delta database (entries with +1 or −1 weights).
 * @param subs   Current substitutions to extend.
 * @returns      Extended substitutions with sign-inverted weights.
 *
 * See Plan 006.2, Phase 1, Task 1.1.
 */
export function evaluateDifferentialNegation(
  a: Atom,
  delta: ReadonlyDatabase,
  subs: readonly Substitution[],
): Substitution[] {
  const relation = delta.getRelation(a.predicate);
  const entries = relation.allWeightedTuples();

  if (entries.length === 0) return [];

  const results: Substitution[] = [];
  for (const sub of subs) {
    for (const { tuple, weight: deltaWeight } of entries) {
      const extended = matchAtomWithTuple(a, tuple, sub);
      if (extended === null) continue;

      // Sign inversion: appearance (+1) blocks (→ -1), disappearance (-1) unblocks (→ +1).
      const outputWeight = extended.weight * (-deltaWeight);
      if (outputWeight !== 0) {
        results.push({ bindings: extended.bindings, weight: outputWeight });
      }
    }
  }
  return results;
}

/**
 * Evaluate a guard body element: keep only substitutions for which the
 * guard condition holds. Weight is preserved on pass.
 */
export function evaluateGuardElement(
  guard: GuardElement,
  subs: readonly Substitution[],
): Substitution[] {
  const results: Substitution[] = [];
  for (const sub of subs) {
    const result = evaluateGuard(guard, sub);
    if (result !== null) {
      results.push(result);
    }
  }
  return results;
}

/**
 * Evaluate an aggregation body element.
 * Aggregation output substitutions have weight = 1 (group-by boundary
 * that resets provenance).
 */
export function evaluateAggregationElement(
  agg: AggregationClause,
  db: ReadonlyDatabase,
  subs: readonly Substitution[],
): Substitution[] {
  const results: Substitution[] = [];
  for (const sub of subs) {
    const extended = evaluateAggregation(agg, db, sub);
    for (const s of extended) {
      results.push(s);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Head grounding
// ---------------------------------------------------------------------------

/**
 * Ground the head atom with each substitution, producing weighted facts.
 * Substitutions that leave variables unbound are silently dropped.
 *
 * Duplicate facts (same predicate + values) have their weights summed
 * (Z-set addition). In batch evaluation where all weights are 1, the
 * deduplication behavior is preserved (first occurrence wins, weight
 * stays 1 since duplicates sum to the same value).
 */
export function groundHead(head: Atom, subs: readonly Substitution[]): WeightedFact[] {
  const weightMap = new Map<string, { fact: Fact; weight: number }>();

  for (const sub of subs) {
    const tuple = groundAtom(head, sub);
    if (tuple === null) continue;

    const fact: Fact = { predicate: head.predicate, values: tuple };
    const key = factKey(fact);

    const existing = weightMap.get(key);
    if (existing !== undefined) {
      existing.weight += sub.weight;
    } else {
      weightMap.set(key, { fact, weight: sub.weight });
    }
  }

  const results: WeightedFact[] = [];
  for (const entry of weightMap.values()) {
    if (entry.weight !== 0) {
      results.push({ fact: entry.fact, weight: entry.weight });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get indices of positive atom body elements (for semi-naive evaluation).
 */
export function getPositiveAtomIndices(body: readonly BodyElement[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'atom') {
      indices.push(i);
    }
  }
  return indices;
}

/**
 * Get indices of negation body elements (for differential negation).
 *
 * Mirrors `getPositiveAtomIndices`. Used by the unified semi-naive loop
 * to enumerate negation atoms as potential delta sources.
 *
 * See Plan 006.2, Phase 1, Task 1.3.
 */
export function getNegationAtomIndices(body: readonly BodyElement[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === 'negation') {
      indices.push(i);
    }
  }
  return indices;
}