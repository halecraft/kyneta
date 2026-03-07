// === Datalog Core Types ===
// Implements §B.3 of the Unified CCS Engine Specification.
// All types are immutable (readonly).

// ---------------------------------------------------------------------------
// Result type — re-exported from shared base so kernel and datalog layers
// don't depend on each other.
// ---------------------------------------------------------------------------

export { type Result, ok, err } from '../base/result.js';

// ---------------------------------------------------------------------------
// Values (§3)
//
// `number` and `bigint` are distinct types with distinct comparison semantics.
// int(3n) and float(3.0) are NOT equal — this avoids precision-loss bugs
// across language boundaries. See unified-engine.md §3 for full rationale.
// ---------------------------------------------------------------------------

/**
 * A CnId reference used within Value. Kept lightweight here — the full
 * CnId interface lives in kernel/types.ts (Phase 2). For Phase 1 we only
 * need structural equality in the Datalog layer.
 */
export interface CnIdRef {
  readonly peer: string;
  readonly counter: number;
}

/**
 * The value domain for Datalog terms.
 *
 * - `null`       — absence
 * - `boolean`    — true / false
 * - `number`     — IEEE 754 f64 (floats and safe integers)
 * - `bigint`     — arbitrary-precision integer
 * - `string`     — UTF-8 string
 * - `Uint8Array` — raw binary (logically immutable by convention)
 * - `CnIdRef`    — reference to a structure constraint
 */
export type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | { readonly ref: CnIdRef };

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export interface ConstTerm {
  readonly kind: 'const';
  readonly value: Value;
}

export interface VarTerm {
  readonly kind: 'var';
  readonly name: string;
}

/**
 * Wildcard term — matches any value without binding a variable.
 *
 * In traditional Datalog/Prolog, `_` is an anonymous variable: each
 * occurrence is independent and never constrains other positions.
 * Using `varTerm('_Foo')` is a trap — if two atoms both use
 * `varTerm('_Foo')`, they'll unify (same name = same binding).
 *
 * `wildcard()` avoids this: it always matches, never binds, and
 * multiple occurrences are independent.
 */
export interface WildcardTerm {
  readonly kind: 'wildcard';
}

export type Term = ConstTerm | VarTerm | WildcardTerm;

// Term constructors
export function constTerm(value: Value): ConstTerm {
  return { kind: 'const', value };
}

export function varTerm(name: string): VarTerm {
  return { kind: 'var', name };
}

/** Anonymous wildcard — matches anything, binds nothing. */
export function wildcard(): WildcardTerm {
  return { kind: 'wildcard' };
}

/**
 * Convenience: `_` is a shorthand for `wildcard()`.
 *
 * Usage: `atom('active_value', [_, $Slot, _, $Lamport])`
 */
export const _: WildcardTerm = wildcard();

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

export interface Atom {
  readonly predicate: string;
  readonly terms: readonly Term[];
}

export function atom(predicate: string, terms: readonly Term[]): Atom {
  return { predicate, terms };
}

// ---------------------------------------------------------------------------
// Guard operators (§B.4 comparisons)
//
// Guards are binary constraints on terms — they filter substitutions
// rather than joining against stored relations. They are a distinct
// concept from relational atoms and get their own BodyElement kind.
//
// Previous approach used magic-string predicates like `__neq` stuffed
// into `positiveAtom(atom('__neq', [...]))`. This was:
//   1. Untyped — nothing prevents `atom('__nneq', ...)` (typo compiles)
//   2. Confusing — guards aren't relations, but were wrapped as atoms
//   3. Invisible to the dependency graph (guards don't introduce
//      predicate dependencies, but the old approach added fake edges)
//
// The new `guard` body element makes the type system distinguish
// relational lookups from value constraints.
// ---------------------------------------------------------------------------

export type GuardOp = 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte';

export interface GuardElement {
  readonly kind: 'guard';
  readonly op: GuardOp;
  readonly left: Term;
  readonly right: Term;
}

// ---------------------------------------------------------------------------
// Aggregation (§B.3)
// ---------------------------------------------------------------------------

export type AggregationFn = 'min' | 'max' | 'count' | 'sum';

export interface AggregationClause {
  /** The aggregation function to apply. */
  readonly fn: AggregationFn;
  /** Variable names that define the grouping key. */
  readonly groupBy: readonly string[];
  /** Variable name being aggregated over. */
  readonly over: string;
  /** Variable name for the aggregation result. */
  readonly result: string;
  /** Source atom whose matches are aggregated. */
  readonly source: Atom;
}

// ---------------------------------------------------------------------------
// Body Elements
// ---------------------------------------------------------------------------

export interface AtomElement {
  readonly kind: 'atom';
  readonly atom: Atom;
}

export interface NegationElement {
  readonly kind: 'negation';
  readonly atom: Atom;
}

export interface AggregationElement {
  readonly kind: 'aggregation';
  readonly agg: AggregationClause;
}

export type BodyElement =
  | AtomElement
  | NegationElement
  | AggregationElement
  | GuardElement;

// ---------------------------------------------------------------------------
// Body element constructors
// ---------------------------------------------------------------------------

export function positiveAtom(a: Atom): AtomElement {
  return { kind: 'atom', atom: a };
}

export function negation(a: Atom): NegationElement {
  return { kind: 'negation', atom: a };
}

export function aggregation(agg: AggregationClause): AggregationElement {
  return { kind: 'aggregation', agg };
}

// ---------------------------------------------------------------------------
// Guard constructors
//
// These replace the old `positiveAtom(atom('__neq', [varTerm('X'), varTerm('Y')]))`
// pattern with `neq($X, $Y)` — shorter, type-safe, and semantically honest.
// ---------------------------------------------------------------------------

/** Guard: left == right (structural equality, respects number/bigint distinction). */
export function eq(left: Term, right: Term): GuardElement {
  return { kind: 'guard', op: 'eq', left, right };
}

/** Guard: left ≠ right. */
export function neq(left: Term, right: Term): GuardElement {
  return { kind: 'guard', op: 'neq', left, right };
}

/** Guard: left < right (same-type ordering). */
export function lt(left: Term, right: Term): GuardElement {
  return { kind: 'guard', op: 'lt', left, right };
}

/** Guard: left > right (same-type ordering). */
export function gt(left: Term, right: Term): GuardElement {
  return { kind: 'guard', op: 'gt', left, right };
}

/** Guard: left ≤ right. */
export function lte(left: Term, right: Term): GuardElement {
  return { kind: 'guard', op: 'lte', left, right };
}

/** Guard: left ≥ right. */
export function gte(left: Term, right: Term): GuardElement {
  return { kind: 'guard', op: 'gte', left, right };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface Rule {
  readonly head: Atom;
  readonly body: readonly BodyElement[];
}

export function rule(head: Atom, body: readonly BodyElement[]): Rule {
  return { head, body };
}

// ---------------------------------------------------------------------------
// Facts and Relations
//
// A Fact is a ground atom (all terms are constants). We represent facts as
// tuples of Values keyed by predicate name. A Relation is a set of fact
// tuples for a single predicate.
// ---------------------------------------------------------------------------

/**
 * A ground tuple — an ordered list of constant values.
 * Semantically: a row in a relation.
 */
export type FactTuple = readonly Value[];

/**
 * A named ground atom — predicate + ground tuple.
 */
export interface Fact {
  readonly predicate: string;
  readonly values: FactTuple;
}

export function fact(predicate: string, values: FactTuple): Fact {
  return { predicate, values };
}

// ---------------------------------------------------------------------------
// Substitution
//
// A mapping from variable names to ground values, produced during
// unification / pattern matching.
// ---------------------------------------------------------------------------

export type Substitution = ReadonlyMap<string, Value>;

// ---------------------------------------------------------------------------
// Relation — a set of tuples for a single predicate.
//
// Internally stored as a Set of serialized tuples for O(1) dedup, with the
// actual tuple arrays stored alongside.
// ---------------------------------------------------------------------------

export class Relation {
  private readonly _tuples: FactTuple[] = [];
  private readonly _serialized: Set<string> = new Set();

  get size(): number {
    return this._tuples.length;
  }

  /** All tuples in insertion order. */
  tuples(): readonly FactTuple[] {
    return this._tuples;
  }

  /** Returns true if the tuple was newly added, false if it was a duplicate. */
  add(tuple: FactTuple): boolean {
    const key = serializeTuple(tuple);
    if (this._serialized.has(key)) {
      return false;
    }
    this._serialized.add(key);
    this._tuples.push(tuple);
    return true;
  }

  has(tuple: FactTuple): boolean {
    return this._serialized.has(serializeTuple(tuple));
  }

  /** Create a new Relation containing all tuples from both this and other. */
  union(other: Relation): Relation {
    const result = new Relation();
    for (const t of this._tuples) {
      result.add(t);
    }
    for (const t of other._tuples) {
      result.add(t);
    }
    return result;
  }

  /** Create a new Relation containing only tuples in this but not in other. */
  difference(other: Relation): Relation {
    const result = new Relation();
    for (const t of this._tuples) {
      if (!other.has(t)) {
        result.add(t);
      }
    }
    return result;
  }

  isEmpty(): boolean {
    return this._tuples.length === 0;
  }

  clone(): Relation {
    const result = new Relation();
    for (const t of this._tuples) {
      result.add(t);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Database — a collection of relations keyed by predicate name.
// ---------------------------------------------------------------------------

export class Database {
  private readonly _relations: Map<string, Relation> = new Map();

  /** Get or create the relation for the given predicate. */
  relation(predicate: string): Relation {
    let rel = this._relations.get(predicate);
    if (rel === undefined) {
      rel = new Relation();
      this._relations.set(predicate, rel);
    }
    return rel;
  }

  /** Get the relation if it exists, or an empty relation if it doesn't. */
  getRelation(predicate: string): Relation {
    return this._relations.get(predicate) ?? new Relation();
  }

  /** All predicate names in the database. */
  predicates(): Iterable<string> {
    return this._relations.keys();
  }

  /** Insert a fact into the database. Returns true if the fact was new. */
  addFact(f: Fact): boolean {
    return this.relation(f.predicate).add(f.values);
  }

  /** Insert all facts from another database. Returns the number of new facts added. */
  mergeFrom(other: Database): number {
    let count = 0;
    for (const pred of other.predicates()) {
      const rel = this.relation(pred);
      for (const tuple of other.getRelation(pred).tuples()) {
        if (rel.add(tuple)) {
          count++;
        }
      }
    }
    return count;
  }

  /** Create a deep clone of this database. */
  clone(): Database {
    const result = new Database();
    for (const pred of this.predicates()) {
      const rel = result.relation(pred);
      for (const tuple of this.getRelation(pred).tuples()) {
        rel.add(tuple);
      }
    }
    return result;
  }

  /** Total number of facts across all relations. */
  get size(): number {
    let total = 0;
    for (const rel of this._relations.values()) {
      total += rel.size;
    }
    return total;
  }

  /** Check if a fact exists in the database. */
  hasFact(f: Fact): boolean {
    return this.getRelation(f.predicate).has(f.values);
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers for Value / Tuple identity
//
// We need structural equality for facts. Two facts with the same predicate
// and the same values (by structural comparison) are the same fact.
// ---------------------------------------------------------------------------

/**
 * Serialize a Value to a string key suitable for Set/Map membership.
 *
 * The serialization is injective — distinct values produce distinct keys.
 * This is critical: `number(3)` and `bigint(3n)` MUST produce different keys,
 * as they are distinct types that never unify (§3).
 */
export function serializeValue(v: Value): string {
  if (v === null) return 'N';
  if (typeof v === 'boolean') return v ? 'T' : 'F';
  if (typeof v === 'number') return `f:${Object.is(v, -0) ? '-0' : String(v)}`;
  if (typeof v === 'bigint') return `i:${String(v)}`;
  if (typeof v === 'string') return `s:${v.length}:${v}`;
  if (v instanceof Uint8Array) {
    // Encode bytes as hex for deterministic serialization
    let hex = 'b:';
    for (let j = 0; j < v.length; j++) {
      hex += (v[j]! < 16 ? '0' : '') + v[j]!.toString(16);
    }
    return hex;
  }
  // ref
  return `r:${v.ref.peer}:${v.ref.counter}`;
}

function serializeTuple(tuple: FactTuple): string {
  // Use a separator that cannot appear inside our serialized values
  // (we prefix each value with its type tag, so '|' is safe)
  const parts: string[] = [];
  for (let i = 0; i < tuple.length; i++) {
    parts.push(serializeValue(tuple[i]!));
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Value comparison (used by aggregation and rule evaluation)
// ---------------------------------------------------------------------------

/**
 * Compare two Values of the same type for ordering.
 *
 * Returns negative if a < b, 0 if a === b, positive if a > b.
 *
 * IMPORTANT: `number` and `bigint` are distinct types and CANNOT be compared
 * with each other. Attempting to compare values of different types returns NaN
 * to signal a type error. The caller must handle this.
 */
export function compareValues(a: Value, b: Value): number {
  // Same-type fast path
  if (a === null && b === null) return 0;
  if (a === null || b === null) return NaN; // different types

  const ta = typeof a;
  const tb = typeof b;

  // Check for ref type
  const aIsRef = ta === 'object' && !(a instanceof Uint8Array);
  const bIsRef = tb === 'object' && !(b instanceof Uint8Array);

  if (ta !== tb && !aIsRef && !bIsRef) return NaN; // different types

  if (ta === 'boolean' && tb === 'boolean') {
    return (a as boolean) === (b as boolean) ? 0 : (a as boolean) ? 1 : -1;
  }

  if (ta === 'number' && tb === 'number') {
    const na = a as number;
    const nb = b as number;
    if (na < nb) return -1;
    if (na > nb) return 1;
    if (Object.is(na, nb)) return 0;
    // Handle -0 vs +0
    if (Object.is(na, -0)) return -1;
    if (Object.is(nb, -0)) return 1;
    // NaN cases
    return NaN;
  }

  if (ta === 'bigint' && tb === 'bigint') {
    const ba = a as bigint;
    const bb = b as bigint;
    if (ba < bb) return -1;
    if (ba > bb) return 1;
    return 0;
  }

  if (ta === 'string' && tb === 'string') {
    const sa = a as string;
    const sb = b as string;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  }

  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i]! < b[i]!) return -1;
      if (a[i]! > b[i]!) return 1;
    }
    return a.length - b.length;
  }

  if (aIsRef && bIsRef) {
    const ra = (a as { readonly ref: CnIdRef }).ref;
    const rb = (b as { readonly ref: CnIdRef }).ref;
    if (ra.peer < rb.peer) return -1;
    if (ra.peer > rb.peer) return 1;
    return ra.counter - rb.counter;
  }

  // Mixed types
  return NaN;
}

/**
 * Check structural equality of two Values.
 */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  const ta = typeof a;
  const tb = typeof b;

  // Handle number specially BEFORE the === fast path,
  // because 0 === -0 is true but Object.is(0, -0) is false,
  // and NaN !== NaN but Object.is(NaN, NaN) is true.
  if (ta === 'number' && tb === 'number') {
    return Object.is(a, b);
  }

  if (a === b) return true;

  if (ta !== tb) {
    // Could both be objects (Uint8Array or ref) with different subtypes
    if (ta === 'object' && tb === 'object') {
      // Fall through to object comparison below
    } else {
      return false;
    }
  }

  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ref comparison
  if (ta === 'object' && tb === 'object' && !(a instanceof Uint8Array) && !(b instanceof Uint8Array)) {
    const ra = (a as { readonly ref: CnIdRef }).ref;
    const rb = (b as { readonly ref: CnIdRef }).ref;
    return ra.peer === rb.peer && ra.counter === rb.counter;
  }

  // Primitives (boolean, bigint, string) — identity comparison
  return a === b;
}

// ---------------------------------------------------------------------------
// Guard evaluation
//
// Evaluates a guard operator against two resolved Values.
// Used by the evaluator when processing `guard` body elements.
// ---------------------------------------------------------------------------

/**
 * Evaluate a guard operator on two ground values.
 *
 * Returns `true` if the guard holds, `false` otherwise.
 * Cross-type ordering comparisons (e.g. number vs bigint for lt/gt)
 * return `false` — they are incomparable.
 */
export function evaluateGuardOp(op: GuardOp, left: Value, right: Value): boolean {
  switch (op) {
    case 'eq':
      return valuesEqual(left, right);
    case 'neq':
      return !valuesEqual(left, right);
    case 'lt':
      return compareSameType(left, right, (cmp) => cmp < 0);
    case 'gt':
      return compareSameType(left, right, (cmp) => cmp > 0);
    case 'lte':
      return compareSameType(left, right, (cmp) => cmp <= 0);
    case 'gte':
      return compareSameType(left, right, (cmp) => cmp >= 0);
  }
}

/**
 * Compare two values of the same type using the provided predicate.
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

// ---------------------------------------------------------------------------
// Stratification error types
// ---------------------------------------------------------------------------

export interface CyclicNegationError {
  readonly kind: 'cyclicNegation';
  readonly cycle: readonly string[]; // predicate names involved in the cycle
}

export type StratificationError = CyclicNegationError;