// === Datalog Evaluation Core ===
// Per-rule evaluation functions used by both the unified evaluator
// (evaluator.ts) and the naive test utility below.
//
// Weight semantics (Plan 006.1):
// - Substitutions carry weights through evaluation.
// - Positive atom join: weight = sub.weight × tuple.weight (provenance product).
// - Negation/guard: weight preserved on pass, substitution dropped on fail.
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
  fullDb: Database,
  matchDb: Database,
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
 */
export function evaluateRuleSemiNaive(
  rule: Rule,
  fullDb: Database,
  delta: Database,
  deltaIdx: number,
): WeightedFact[] {
  let subs: Substitution[] = [EMPTY_SUBSTITUTION];

  for (let i = 0; i < rule.body.length; i++) {
    if (subs.length === 0) break;

    const element = rule.body[i]!;

    switch (element.kind) {
      case 'atom': {
        // Use delta for the designated atom, full db for others
        const db = i === deltaIdx ? delta : fullDb;
        subs = evaluatePositiveAtom(element.atom, db, subs);
        break;
      }
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
 */
export function evaluatePositiveAtom(
  a: Atom,
  db: Database,
  subs: readonly Substitution[],
): Substitution[] {
  const relation = db.getRelation(a.predicate);
  const entries = relation.weightedTuples();

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
  db: Database,
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
  db: Database,
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