// === Datalog Aggregation ===
// Implements min, max, count, sum aggregation operators.
//
// Aggregation is a special body element that groups matched tuples by
// a set of grouping variables and computes an aggregate over a target
// variable within each group.
//
// Type handling (§3, §B.3):
// - `number` (f64) and `bigint` (int) are distinct types that never mix.
// - sum of bigints → bigint; sum of numbers → number.
// - Mixed-type aggregation (e.g. sum over a group containing both number
//   and bigint) is a type error and returns null for that group.
// - min/max respect the same type separation.
// - count always returns a number (it counts tuples, not values).
//
// Weight semantics (Plan 006.1):
// - Aggregation is a group-by boundary that resets provenance.
// - Output substitutions always have weight = 1 regardless of input weights.
// - Only tuples with weight > 0 participate (enforced by tuples() returning
//   weight > 0 entries from the weighted Relation).

import type {
  Value,
  Atom,
  AggregationClause,
  FactTuple,
  Substitution,
} from './types.js';
import {
  serializeValue,
  compareValues,
} from './types.js';
import type { ReadonlyDatabase } from './types.js';
import {
  matchAtomWithTuple,
  EMPTY_SUBSTITUTION,
  resolveTerm,
} from './unify.js';

// ---------------------------------------------------------------------------
// Group key computation
// ---------------------------------------------------------------------------

/**
 * Compute a string key for the grouping variables in a substitution.
 * The key is deterministic: same bindings produce the same key.
 */
function groupKey(
  groupBy: readonly string[],
  sub: Substitution,
): string | null {
  const parts: string[] = [];
  for (const varName of groupBy) {
    const val = sub.bindings.get(varName);
    if (val === undefined && !sub.bindings.has(varName)) {
      // Unbound grouping variable — can't form a group
      return null;
    }
    // val may be null (bound to null) which is fine
    parts.push(serializeValue(val === undefined ? null : val));
  }
  return parts.join('|');
}

/**
 * Extract the bound values for grouping variables from a substitution.
 */
function groupValues(
  groupBy: readonly string[],
  sub: Substitution,
): Value[] {
  const values: Value[] = [];
  for (const varName of groupBy) {
    const val = sub.bindings.get(varName);
    values.push(val === undefined ? null : val);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Aggregation group
// ---------------------------------------------------------------------------

interface AggregationGroup {
  /** The bound values for groupBy variables. */
  readonly groupVals: Value[];
  /** All values of the `over` variable in this group. */
  readonly overValues: Value[];
}

// ---------------------------------------------------------------------------
// Core aggregation evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an aggregation clause against the current database.
 *
 * For each match of the source atom in the database:
 *   1. Extract the grouping variable bindings.
 *   2. Extract the `over` variable value.
 *   3. Accumulate into groups.
 *
 * Then for each group, compute the aggregate and produce a substitution
 * binding the groupBy variables and the result variable.
 *
 * Output substitutions have weight = 1 (aggregation is a group-by
 * boundary that resets provenance).
 *
 * @param agg       The aggregation clause to evaluate.
 * @param db        The current database of facts.
 * @param baseSub   An existing substitution to extend (from prior body elements).
 * @returns         An array of substitutions, one per group, each binding the
 *                  groupBy variables and the result variable.
 */
export function evaluateAggregation(
  agg: AggregationClause,
  db: ReadonlyDatabase,
  baseSub: Substitution,
): Substitution[] {
  const relation = db.getRelation(agg.source.predicate);
  const tuples = relation.tuples();

  // Step 1: Match source atom against all tuples, collecting groups.
  const groups = new Map<string, AggregationGroup>();

  for (const tuple of tuples) {
    const matched = matchAtomWithTuple(agg.source, tuple, baseSub);
    if (matched === null) continue;

    // Extract grouping key
    const key = groupKey(agg.groupBy, matched);
    if (key === null) continue;

    // Extract the `over` variable value
    const overVal = matched.bindings.get(agg.over);
    if (overVal === undefined && !matched.bindings.has(agg.over)) {
      // The `over` variable is unbound — skip this tuple
      continue;
    }
    const resolvedOver: Value = overVal === undefined ? null : overVal;

    let group = groups.get(key);
    if (group === undefined) {
      group = {
        groupVals: groupValues(agg.groupBy, matched),
        overValues: [],
      };
      groups.set(key, group);
    }
    // Mutable push — we own the array
    (group.overValues as Value[]).push(resolvedOver);
  }

  // Step 2: Compute aggregate for each group and produce substitutions.
  const results: Substitution[] = [];

  for (const group of groups.values()) {
    const aggResult = computeAggregate(agg.fn, group.overValues);
    if (aggResult === undefined) {
      // Type error in aggregation (e.g., mixed number/bigint in sum)
      // Skip this group — it produces no result.
      continue;
    }

    // Build substitution: baseSub bindings + groupBy bindings + result binding.
    // Output weight = 1 (aggregation is a group-by boundary).
    const sub = new Map(baseSub.bindings);
    for (let i = 0; i < agg.groupBy.length; i++) {
      sub.set(agg.groupBy[i]!, group.groupVals[i]!);
    }
    sub.set(agg.result, aggResult);
    results.push({ bindings: sub, weight: 1 });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Aggregate computation
// ---------------------------------------------------------------------------

/**
 * Compute an aggregate function over a list of values.
 *
 * Returns `undefined` on type error (mixed number/bigint for sum/min/max).
 *
 * Type rules:
 * - count: always returns `number` (count of values).
 * - sum: returns `number` if all values are `number`, `bigint` if all are
 *   `bigint`. Mixed types → undefined (type error).
 * - min/max: returns the min/max value. All values must be the same
 *   comparable type. Mixed types → undefined.
 */
function computeAggregate(
  fn: 'min' | 'max' | 'count' | 'sum',
  values: readonly Value[],
): Value | undefined {
  switch (fn) {
    case 'count':
      return computeCount(values);
    case 'sum':
      return computeSum(values);
    case 'min':
      return computeMin(values);
    case 'max':
      return computeMax(values);
  }
}

function computeCount(values: readonly Value[]): Value {
  return values.length;
}

function computeSum(values: readonly Value[]): Value | undefined {
  if (values.length === 0) return 0;

  // Determine the type of the first numeric value
  let hasNumber = false;
  let hasBigint = false;

  for (const v of values) {
    if (typeof v === 'number') hasNumber = true;
    else if (typeof v === 'bigint') hasBigint = true;
    else {
      // Non-numeric value in sum — type error
      return undefined;
    }
  }

  if (hasNumber && hasBigint) {
    // Mixed types — type error
    return undefined;
  }

  if (hasBigint) {
    let total = 0n;
    for (const v of values) {
      total += v as bigint;
    }
    return total;
  }

  // All numbers
  let total = 0;
  for (const v of values) {
    total += v as number;
  }
  return total;
}

function computeMin(values: readonly Value[]): Value | undefined {
  if (values.length === 0) return undefined;

  let best: Value = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    const cmp = compareValues(v, best);
    if (Number.isNaN(cmp)) {
      // Incompatible types — type error
      return undefined;
    }
    if (cmp < 0) {
      best = v;
    }
  }
  return best;
}

function computeMax(values: readonly Value[]): Value | undefined {
  if (values.length === 0) return undefined;

  let best: Value = values[0]!;
  for (let i = 1; i < values.length; i++) {
    const v = values[i]!;
    const cmp = compareValues(v, best);
    if (Number.isNaN(cmp)) {
      // Incompatible types — type error
      return undefined;
    }
    if (cmp > 0) {
      best = v;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Convenience: evaluate aggregation from a body element during rule eval
// ---------------------------------------------------------------------------

/**
 * Evaluate an aggregation clause as part of rule body processing.
 *
 * This is called by the evaluator when it encounters an `aggregation`
 * body element. It takes the current set of substitutions (from prior
 * body elements) and for each one, evaluates the aggregation, producing
 * new substitutions with the result variable bound.
 *
 * Output substitutions have weight = 1 (aggregation resets provenance).
 *
 * @param agg     The aggregation clause.
 * @param db      The current database.
 * @param subs    Current substitutions from prior body elements.
 * @returns       Extended substitutions with the aggregate result bound.
 */
export function evaluateAggregationForSubs(
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