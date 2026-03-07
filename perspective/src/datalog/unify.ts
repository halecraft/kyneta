// === Datalog Unification & Substitution ===
// Implements variable binding, substitution application, and term matching
// against ground facts. Used by the evaluator to instantiate rule bodies
// and produce derived facts.
//
// Key invariant from §3: `number` and `bigint` are distinct types that
// NEVER unify with each other. int(3n) ≠ float(3.0).

import type {
  Value,
  Term,
  Atom,
  FactTuple,
  Substitution,
} from './types.js';
import { valuesEqual } from './types.js';

// ---------------------------------------------------------------------------
// Substitution helpers
// ---------------------------------------------------------------------------

/** The empty substitution — no variables bound. */
export const EMPTY_SUBSTITUTION: Substitution = new Map();

/**
 * Extend a substitution with a new binding.
 * Returns a new Substitution (the original is not mutated).
 */
export function extendSubstitution(
  sub: Substitution,
  varName: string,
  value: Value,
): Substitution {
  const next = new Map(sub);
  next.set(varName, value);
  return next;
}

// ---------------------------------------------------------------------------
// Term resolution
// ---------------------------------------------------------------------------

/**
 * Apply a substitution to a term, resolving variables to their bound values.
 *
 * - If the term is a constant, returns the constant value.
 * - If the term is a variable bound in the substitution, returns the bound value.
 * - If the term is an unbound variable, returns `undefined`.
 */
export function resolveTerm(term: Term, sub: Substitution): Value | undefined {
  if (term.kind === 'const') {
    return term.value;
  }
  // Variable — look it up
  return sub.get(term.name);
}

// ---------------------------------------------------------------------------
// Unification of a single term against a ground value
// ---------------------------------------------------------------------------

/**
 * Attempt to unify a term with a ground value under the given substitution.
 *
 * Returns the (possibly extended) substitution on success, or `null` on failure.
 *
 * Rules:
 * - Constant term: succeeds iff the constant equals the value (structural equality).
 * - Variable term, already bound: succeeds iff the bound value equals the ground value.
 * - Variable term, unbound: succeeds by extending the substitution with the binding.
 *
 * IMPORTANT: Uses `valuesEqual` which respects the number/bigint distinction.
 */
export function unifyTermWithValue(
  term: Term,
  value: Value,
  sub: Substitution,
): Substitution | null {
  if (term.kind === 'const') {
    return valuesEqual(term.value, value) ? sub : null;
  }

  // Variable
  const bound = sub.get(term.name);
  if (bound !== undefined) {
    // Already bound — check consistency
    return valuesEqual(bound, value) ? sub : null;
  }

  // Unbound variable — bind it
  // Special case: if the value is `null`, we need to handle the fact that
  // Map.get returns undefined for missing keys. We use `has` to distinguish
  // "bound to null" from "unbound".
  if (sub.has(term.name)) {
    // Bound to null — check consistency
    return value === null ? sub : null;
  }

  return extendSubstitution(sub, term.name, value);
}

// ---------------------------------------------------------------------------
// Matching an atom against a ground fact tuple
// ---------------------------------------------------------------------------

/**
 * Attempt to match an atom's terms against a ground fact tuple.
 *
 * The atom and tuple must have the same arity. Returns the extended
 * substitution on success, or `null` on failure.
 */
export function matchAtomWithTuple(
  a: Atom,
  tuple: FactTuple,
  sub: Substitution,
): Substitution | null {
  if (a.terms.length !== tuple.length) {
    return null;
  }

  let current: Substitution | null = sub;
  for (let i = 0; i < a.terms.length; i++) {
    current = unifyTermWithValue(a.terms[i]!, tuple[i]!, current);
    if (current === null) {
      return null;
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Applying a substitution to an atom to produce a ground tuple
// ---------------------------------------------------------------------------

/**
 * Apply a substitution to an atom, producing a ground tuple.
 *
 * All variables in the atom must be bound in the substitution.
 * Returns `null` if any variable is unbound.
 */
export function groundAtom(
  a: Atom,
  sub: Substitution,
): FactTuple | null {
  const values: Value[] = [];
  for (const term of a.terms) {
    const resolved = resolveTerm(term, sub);
    if (resolved === undefined) {
      // Check if the variable is bound to null (undefined means unbound here)
      if (term.kind === 'var' && sub.has(term.name)) {
        // The variable is bound to null (since sub.get returned undefined
        // but sub.has returned true is impossible — Map stores null as a value
        // and get returns null, not undefined). Actually, if the value IS null,
        // sub.get returns null which is not undefined, so this branch should
        // not be reachable for null-bound vars. This is a safety fallback.
        values.push(null);
      } else {
        return null; // Unbound variable
      }
    } else {
      values.push(resolved);
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Matching a full atom against a relation (set of tuples)
// ---------------------------------------------------------------------------

/**
 * Find all substitutions that result from matching an atom against every
 * tuple in a relation, extending the given base substitution.
 *
 * This is the core "join" operation: for each tuple that matches, we get
 * an extended substitution.
 */
export function matchAtomAgainstRelation(
  a: Atom,
  tuples: readonly FactTuple[],
  baseSub: Substitution,
): Substitution[] {
  const results: Substitution[] = [];
  for (const tuple of tuples) {
    const extended = matchAtomWithTuple(a, tuple, baseSub);
    if (extended !== null) {
      results.push(extended);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Built-in comparison predicates
//
// The spec's LWW rules use comparison operators like `>`, `<`, `=`, `\=`
// in rule bodies. We support these as built-in predicates that are evaluated
// directly rather than matched against stored relations.
// ---------------------------------------------------------------------------

/** Set of built-in comparison predicates. */
const BUILTIN_PREDICATES = new Set([
  '__eq',   // =    : term equality
  '__neq',  // \=   : term inequality
  '__lt',   // <    : less than
  '__gt',   // >    : greater than
  '__lte',  // <=   : less than or equal
  '__gte',  // >=   : greater than or equal
]);

/**
 * Check if a predicate name is a built-in.
 */
export function isBuiltinPredicate(predicate: string): boolean {
  return BUILTIN_PREDICATES.has(predicate);
}

/**
 * Evaluate a built-in predicate given resolved argument values.
 *
 * Built-in predicates are binary: they take exactly 2 arguments.
 * Both arguments must be fully resolved (ground).
 *
 * Returns `true` if the predicate holds, `false` otherwise.
 * Returns `null` if evaluation is not possible (wrong arity, unresolved args).
 */
export function evaluateBuiltin(
  predicate: string,
  args: readonly Value[],
): boolean | null {
  if (args.length !== 2) return null;

  const [a, b] = args as [Value, Value];

  switch (predicate) {
    case '__eq':
      return valuesEqual(a, b);

    case '__neq':
      return !valuesEqual(a, b);

    case '__lt':
      return compareSameType(a, b, (cmp) => cmp < 0);

    case '__gt':
      return compareSameType(a, b, (cmp) => cmp > 0);

    case '__lte':
      return compareSameType(a, b, (cmp) => cmp <= 0);

    case '__gte':
      return compareSameType(a, b, (cmp) => cmp >= 0);

    default:
      return null;
  }
}

/**
 * Compare two values of the same type using the provided comparator.
 * Returns `false` if the types are incompatible (cannot compare number vs bigint).
 */
function compareSameType(
  a: Value,
  b: Value,
  pred: (cmp: number) => boolean,
): boolean {
  // Handle null
  if (a === null || b === null) return false;

  const ta = typeof a;
  const tb = typeof b;

  // number vs number
  if (ta === 'number' && tb === 'number') {
    const na = a as number;
    const nb = b as number;
    if (Number.isNaN(na) || Number.isNaN(nb)) return false;
    // Handle -0: treat -0 < +0 for consistent ordering
    if (Object.is(na, -0) && nb === 0) return pred(-1);
    if (na === 0 && Object.is(nb, -0)) return pred(1);
    return pred(na < nb ? -1 : na > nb ? 1 : 0);
  }

  // bigint vs bigint
  if (ta === 'bigint' && tb === 'bigint') {
    const ba = a as bigint;
    const bb = b as bigint;
    return pred(ba < bb ? -1 : ba > bb ? 1 : 0);
  }

  // string vs string
  if (ta === 'string' && tb === 'string') {
    const sa = a as string;
    const sb = b as string;
    return pred(sa < sb ? -1 : sa > sb ? 1 : 0);
  }

  // boolean — false < true
  if (ta === 'boolean' && tb === 'boolean') {
    const ia = (a as boolean) ? 1 : 0;
    const ib = (b as boolean) ? 1 : 0;
    return pred(ia - ib);
  }

  // Uint8Array — lexicographic
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i]! !== b[i]!) {
        return pred(a[i]! < b[i]! ? -1 : 1);
      }
    }
    return pred(a.length - b.length);
  }

  // ref — compare by (peer, counter)
  if (
    ta === 'object' && tb === 'object' &&
    !(a instanceof Uint8Array) && !(b instanceof Uint8Array) &&
    a !== null && b !== null
  ) {
    const ra = (a as { readonly ref: { peer: string; counter: number } }).ref;
    const rb = (b as { readonly ref: { peer: string; counter: number } }).ref;
    if (ra.peer !== rb.peer) {
      return pred(ra.peer < rb.peer ? -1 : 1);
    }
    return pred(ra.counter - rb.counter);
  }

  // Incompatible types — comparison fails
  return false;
}

/**
 * Try to evaluate a built-in predicate in the context of a substitution.
 * Resolves both arguments, then evaluates.
 *
 * Returns:
 * - The original substitution if the built-in holds.
 * - `null` if it doesn't hold or if arguments can't be resolved.
 */
export function tryEvaluateBuiltin(
  a: Atom,
  sub: Substitution,
): Substitution | null {
  const resolvedArgs: Value[] = [];
  for (const term of a.terms) {
    const val = resolveTerm(term, sub);
    if (val === undefined) {
      // Variable not yet bound — can't evaluate. Check if it's bound to null.
      if (term.kind === 'var' && sub.has(term.name)) {
        resolvedArgs.push(null);
      } else {
        return null;
      }
    } else {
      resolvedArgs.push(val);
    }
  }

  const result = evaluateBuiltin(a.predicate, resolvedArgs);
  if (result === true) {
    return sub;
  }
  return null;
}