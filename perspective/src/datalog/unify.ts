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
  GuardOp,
  GuardElement,
} from './types.js';
import { valuesEqual, evaluateGuardOp } from './types.js';

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
 * - If the term is a wildcard, returns `undefined` (wildcards never bind).
 */
export function resolveTerm(term: Term, sub: Substitution): Value | undefined {
  if (term.kind === 'const') {
    return term.value;
  }
  if (term.kind === 'wildcard') {
    return undefined;
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
 * - Wildcard term: always succeeds without binding anything.
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

  if (term.kind === 'wildcard') {
    // Wildcard always matches, never binds
    return sub;
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
 * All non-wildcard variables in the atom must be bound in the substitution.
 * Wildcards in head position are a logical error (the head must be fully
 * ground) — returns `null` if a wildcard is encountered.
 *
 * Returns `null` if any variable is unbound or a wildcard is present.
 */
export function groundAtom(
  a: Atom,
  sub: Substitution,
): FactTuple | null {
  const values: Value[] = [];
  for (const term of a.terms) {
    if (term.kind === 'wildcard') {
      // Wildcards cannot appear in grounded atoms (head position)
      return null;
    }
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
// Guard evaluation
//
// Guards are binary constraints on terms that filter substitutions.
// They are evaluated by resolving both operands and applying the operator.
// ---------------------------------------------------------------------------

/**
 * Evaluate a guard element in the context of a substitution.
 *
 * Both operands must be fully resolved (bound variables or constants).
 * Wildcards in guards are a logical error — returns `null`.
 *
 * Returns:
 * - The original substitution if the guard holds.
 * - `null` if it doesn't hold or if operands can't be resolved.
 */
export function evaluateGuard(
  guard: GuardElement,
  sub: Substitution,
): Substitution | null {
  const left = resolveGuardTerm(guard.left, sub);
  if (left === undefined) return null;

  const right = resolveGuardTerm(guard.right, sub);
  if (right === undefined) return null;

  return evaluateGuardOp(guard.op, left, right) ? sub : null;
}

/**
 * Resolve a term for guard evaluation. Unlike `resolveTerm`, this
 * distinguishes "bound to null" from "unresolvable" more carefully.
 *
 * Returns the resolved Value, or `undefined` if unresolvable.
 */
function resolveGuardTerm(term: Term, sub: Substitution): Value | undefined {
  if (term.kind === 'const') {
    return term.value;
  }
  if (term.kind === 'wildcard') {
    // Wildcards have no value — can't be used in guards
    return undefined;
  }
  // Variable
  const val = sub.get(term.name);
  if (val !== undefined) {
    return val;
  }
  // Could be bound to null — check with has
  if (sub.has(term.name)) {
    return null;
  }
  // Unbound
  return undefined;
}

// ---------------------------------------------------------------------------
// Legacy built-in predicates (backward compatibility)
//
// The old API encoded guards as magic-string predicates like `__neq`.
// These are still supported for backward compatibility but the preferred
// API is the `guard` body element with typed GuardOp.
//
// TODO: Remove once all callers migrate to guard body elements.
// ---------------------------------------------------------------------------

/** Set of built-in comparison predicates (legacy). */
const BUILTIN_PREDICATES = new Set([
  '__eq',   // =    : term equality
  '__neq',  // \=   : term inequality
  '__lt',   // <    : less than
  '__gt',   // >    : greater than
  '__lte',  // <=   : less than or equal
  '__gte',  // >=   : greater than or equal
]);

/**
 * Check if a predicate name is a built-in (legacy).
 */
export function isBuiltinPredicate(predicate: string): boolean {
  return BUILTIN_PREDICATES.has(predicate);
}

/** Map legacy predicate names to GuardOp. */
const BUILTIN_TO_GUARD_OP: ReadonlyMap<string, GuardOp> = new Map([
  ['__eq', 'eq'],
  ['__neq', 'neq'],
  ['__lt', 'lt'],
  ['__gt', 'gt'],
  ['__lte', 'lte'],
  ['__gte', 'gte'],
]);

/**
 * Evaluate a built-in predicate given resolved argument values (legacy).
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

  const op = BUILTIN_TO_GUARD_OP.get(predicate);
  if (op === undefined) return null;

  return evaluateGuardOp(op, args[0]!, args[1]!);
}

/**
 * Try to evaluate a built-in predicate in the context of a substitution (legacy).
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
    if (term.kind === 'wildcard') {
      // Wildcards can't be evaluated in builtins
      return null;
    }
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