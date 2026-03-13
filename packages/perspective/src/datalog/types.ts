// === Datalog Core Types ===
// Implements §B.3 of the Unified CCS Engine Specification.
// All types are immutable (readonly).

// ---------------------------------------------------------------------------
// Result type — re-exported from shared base so kernel and datalog layers
// don't depend on each other.
// ---------------------------------------------------------------------------

export { type Result, ok, err } from '../base/result.js';

// ---------------------------------------------------------------------------
// Shared identity and value types — re-exported from shared base so kernel
// and datalog layers use a single definition.
// ---------------------------------------------------------------------------

export { type CnId, type PeerID, type Counter, type Value, isSafeUint } from '../base/types.js';

import type { CnId, Value } from '../base/types.js';

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
// unification / pattern matching. Enriched with a weight field for
// Z-set arithmetic in the weighted Datalog evaluator (Plan 006.1).
//
// Weight semantics:
// - Positive atom join: weight = sub.weight × tuple.weight (provenance product)
// - Negation/guard: weight preserved on pass, substitution dropped on fail
// - Aggregation: output weight = 1 (group-by boundary resets provenance)
// - groundHead: duplicate facts sum weights (Z-set addition)
// ---------------------------------------------------------------------------

export interface Substitution {
  readonly bindings: ReadonlyMap<string, Value>;
  readonly weight: number;
}

// ---------------------------------------------------------------------------
// Relation — a dual-weight set of tuples for a single predicate.
//
// Internally stored as a Map<string, RelationEntry> keyed by serialized
// tuple. Each entry carries two integer weights (DBSP Z-set semantics).
//
// Presence-checking methods (`has`, `tuples`, `size`, `weightedTuples`,
// `isEmpty`) all read `clampedWeight`. `getWeight` and `allWeightedTuples`
// return the true `weight`.
//
// Zero-weight entries are pruned eagerly (both `weight` and `clampedWeight`
// are 0 → entry deleted).
//
// See Plan 006.2, Phase 0 (tasks 0.1–0.10).
// See DBSP (Budiu & McSherry, 2023) §5 (nested streams, distinct operator).
// ---------------------------------------------------------------------------

/**
 * Dual-weight entry stored per tuple in a Relation.
 *
 * - `weight`: the true Z-set multiplicity — number of independent
 *   derivation paths minus retraction paths. May be > 1 (multiple
 *   derivation paths), 0 (all paths retracted), or transiently < 0
 *   during an iteration (retraction overshoot, floored by `applyDistinct`).
 *
 * - `clampedWeight`: the post-`distinct` presence signal, always 0 or 1.
 *   Updated **eagerly** by `addWeighted` for mid-iteration visibility —
 *   facts derived by one rule are immediately visible to subsequent rules
 *   via `weightedTuples()`. Authoritatively set by `applyDistinct` for the
 *   negative-floor clamp.
 *
 * See Plan 006.2, Phase 0; DBSP §5 (nested streams, distinct^Δ).
 */
interface RelationEntry {
  readonly tuple: FactTuple;
  weight: number;
  clampedWeight: number;
}

export class Relation {
  private readonly _map: Map<string, RelationEntry> = new Map();

  /** Count of tuples with clampedWeight > 0 (i.e., "present" tuples). */
  get size(): number {
    let count = 0;
    for (const entry of this._map.values()) {
      if (entry.clampedWeight > 0) count++;
    }
    return count;
  }

  /**
   * Count of all stored entries (including negative weights).
   *
   * Unlike `size` which counts only clampedWeight > 0 entries, this returns
   * the total number of entries in the internal map. Used for delta
   * databases where negative weights represent retractions.
   */
  get allEntryCount(): number {
    return this._map.size;
  }

  /** All tuples with clampedWeight > 0, in insertion order. */
  tuples(): readonly FactTuple[] {
    const result: FactTuple[] = [];
    for (const entry of this._map.values()) {
      if (entry.clampedWeight > 0) {
        result.push(entry.tuple);
      }
    }
    return result;
  }

  /**
   * All entries with clampedWeight > 0 as { tuple, weight } pairs.
   *
   * The returned `weight` is the `clampedWeight` (always 1 for present
   * entries). This prevents weight explosion in recursive rules — joins
   * see weight 1, not the true multiplicity.
   */
  weightedTuples(): readonly { readonly tuple: FactTuple; readonly weight: number }[] {
    const result: { tuple: FactTuple; weight: number }[] = [];
    for (const entry of this._map.values()) {
      if (entry.clampedWeight > 0) {
        result.push({ tuple: entry.tuple, weight: entry.clampedWeight });
      }
    }
    return result;
  }

  /**
   * All entries (including negative weights) as { tuple, weight } pairs.
   *
   * Unlike `weightedTuples()` which filters to clampedWeight > 0 and
   * returns the clamped value, this returns every stored entry with the
   * true `weight`. Used for delta databases where negative weights
   * represent retractions and true multiplicities matter for the
   * provenance product.
   */
  allWeightedTuples(): readonly { readonly tuple: FactTuple; readonly weight: number }[] {
    const result: { tuple: FactTuple; weight: number }[] = [];
    for (const entry of this._map.values()) {
      result.push({ tuple: entry.tuple, weight: entry.weight });
    }
    return result;
  }

  /**
   * Add a tuple with weight 1. Returns true if the tuple became newly
   * present (clampedWeight went from 0 to 1).
   *
   * Inlines the addWeighted logic for efficiency (single map lookup in
   * the common case) while maintaining the same dual-weight semantics.
   */
  add(tuple: FactTuple): boolean {
    const key = serializeTuple(tuple);
    const existing = this._map.get(key);
    if (existing !== undefined) {
      const oldClamped = existing.clampedWeight;
      const newWeight = existing.weight + 1;
      if (newWeight === 0) {
        this._map.delete(key);
        return false;
      }
      existing.weight = newWeight;
      existing.clampedWeight = newWeight > 0 ? 1 : 0;
      return oldClamped === 0 && existing.clampedWeight === 1;
    }
    this._map.set(key, { tuple, weight: 1, clampedWeight: 1 });
    return true;
  }

  /** Check if a tuple is present (clampedWeight > 0). */
  has(tuple: FactTuple): boolean {
    const entry = this._map.get(serializeTuple(tuple));
    return entry !== undefined && entry.clampedWeight > 0;
  }

  /**
   * Add a weighted delta to a tuple. Weights are summed. Zero-weight
   * entries are pruned. `clampedWeight` is eagerly set to
   * `newWeight > 0 ? 1 : 0` for mid-iteration visibility.
   * Returns the new weight.
   */
  addWeighted(tuple: FactTuple, weight: number): number {
    if (weight === 0) {
      const entry = this._map.get(serializeTuple(tuple));
      return entry !== undefined ? entry.weight : 0;
    }
    const key = serializeTuple(tuple);
    const existing = this._map.get(key);
    if (existing !== undefined) {
      const newWeight = existing.weight + weight;
      if (newWeight === 0) {
        this._map.delete(key);
        return 0;
      }
      existing.weight = newWeight;
      existing.clampedWeight = newWeight > 0 ? 1 : 0;
      return newWeight;
    }
    this._map.set(key, { tuple, weight, clampedWeight: weight > 0 ? 1 : 0 });
    return weight;
  }

  /**
   * Get the true Z-set weight of a tuple. Returns 0 if absent.
   *
   * This returns the raw multiplicity, not the clamped presence signal.
   * Used by dirty-map `preWeight` recording and zero-crossing detection
   * in `applyDerivedFact`.
   */
  getWeight(tuple: FactTuple): number {
    const entry = this._map.get(serializeTuple(tuple));
    return entry !== undefined ? entry.weight : 0;
  }

  /**
   * Remove a tuple from the relation (delete the entry entirely).
   * Returns true if the tuple was present (clampedWeight > 0) and is now absent.
   */
  remove(tuple: FactTuple): boolean {
    const key = serializeTuple(tuple);
    const existing = this._map.get(key);
    if (existing === undefined) return false;
    if (existing.clampedWeight <= 0) {
      // Already absent — prune and report no change.
      this._map.delete(key);
      return false;
    }
    // Was present — remove by deleting the entry entirely.
    this._map.delete(key);
    return true;
  }

  /**
   * Create a new Relation containing all clampedWeight > 0 tuples from both.
   * Presence semantics: uses clampedWeight for filtering, preserves
   * original weights in the result.
   */
  union(other: Relation): Relation {
    const result = new Relation();
    for (const entry of this._map.values()) {
      if (entry.clampedWeight > 0) {
        result._map.set(serializeTuple(entry.tuple), {
          tuple: entry.tuple, weight: entry.weight, clampedWeight: entry.clampedWeight,
        });
      }
    }
    for (const entry of other._map.values()) {
      if (entry.clampedWeight > 0) {
        const key = serializeTuple(entry.tuple);
        const existing = result._map.get(key);
        if (existing === undefined) {
          result._map.set(key, {
            tuple: entry.tuple, weight: entry.weight, clampedWeight: entry.clampedWeight,
          });
        }
        // If already present from `this`, keep it (union = set union for clampedWeight > 0).
      }
    }
    return result;
  }

  /**
   * Create a new Relation containing clampedWeight > 0 tuples in this
   * but not in other.
   */
  difference(other: Relation): Relation {
    const result = new Relation();
    for (const entry of this._map.values()) {
      if (entry.clampedWeight > 0 && !other.has(entry.tuple)) {
        result._map.set(serializeTuple(entry.tuple), {
          tuple: entry.tuple, weight: entry.weight, clampedWeight: entry.clampedWeight,
        });
      }
    }
    return result;
  }

  /** True if no tuples have clampedWeight > 0. */
  isEmpty(): boolean {
    for (const entry of this._map.values()) {
      if (entry.clampedWeight > 0) return false;
    }
    return true;
  }

  /**
   * Subtract another relation's weights from this one, returning a new
   * Relation with weights `this.weight − other.weight` for each entry.
   *
   * Entries present in `this` but not in `other` are copied as-is.
   * Entries present in `other` but not in `this` appear with negated
   * weight. Entries whose resulting weight is 0 are pruned.
   *
   * Used by `DatabaseView` to lazily compute P_old = P_new − Δ for
   * the asymmetric join in `evaluateStratumFromDelta`.
   *
   * See Plan 007, Phase 1.5, Task 1.5.3.
   */
  subtract(other: Relation): Relation {
    const result = new Relation();

    // Copy all entries from this, subtracting other's weights where present.
    for (const [key, entry] of this._map) {
      const otherEntry = other._map.get(key);
      if (otherEntry === undefined) {
        // No corresponding entry in other — copy as-is.
        result._map.set(key, {
          tuple: entry.tuple,
          weight: entry.weight,
          clampedWeight: entry.clampedWeight,
        });
      } else {
        const newWeight = entry.weight - otherEntry.weight;
        if (newWeight !== 0) {
          result._map.set(key, {
            tuple: entry.tuple,
            weight: newWeight,
            clampedWeight: newWeight > 0 ? 1 : 0,
          });
        }
        // newWeight === 0 → prune (don't add to result).
      }
    }

    // Entries in other but not in this → negated weight.
    for (const [key, entry] of other._map) {
      if (!this._map.has(key)) {
        const negWeight = -entry.weight;
        if (negWeight !== 0) {
          result._map.set(key, {
            tuple: entry.tuple,
            weight: negWeight,
            clampedWeight: negWeight > 0 ? 1 : 0,
          });
        }
      }
    }

    return result;
  }

  /** Deep clone — copies all entries (including weight ≤ 0 entries). */
  clone(): Relation {
    const result = new Relation();
    for (const [key, entry] of this._map) {
      result._map.set(key, {
        tuple: entry.tuple, weight: entry.weight, clampedWeight: entry.clampedWeight,
      });
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// ReadonlyDatabase — read-only interface for Database access.
//
// Used by evaluation functions that only need to read relations (e.g.,
// evaluateRuleDelta's fullDbOld parameter). Enables DatabaseView to
// provide a lazy view without exposing mutation methods.
//
// See Plan 007, Phase 1.5, Task 1.5.1.
// ---------------------------------------------------------------------------

export interface ReadonlyDatabase {
  /** Get the relation if it exists, or an empty relation if it doesn't. */
  getRelation(predicate: string): Relation;

  /** All predicate names in the database. */
  predicates(): Iterable<string>;

  /** Check if a fact exists (clampedWeight > 0) in the database. */
  hasFact(f: Fact): boolean;
}

// ---------------------------------------------------------------------------
// Database — a collection of relations keyed by predicate name.
// ---------------------------------------------------------------------------

export class Database implements ReadonlyDatabase {
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

  /**
   * Add a weighted fact delta. Weights are summed in the underlying
   * relation. Returns the new weight.
   */
  addWeightedFact(f: Fact, weight: number): number {
    return this.relation(f.predicate).addWeighted(f.values, weight);
  }

  /**
   * Remove a fact from the database (zero its weight).
   * Returns true if the fact was present and is now absent.
   */
  removeFact(f: Fact): boolean {
    const rel = this._relations.get(f.predicate);
    if (rel === undefined) return false;
    return rel.remove(f.values);
  }

  /**
   * Merge all facts from another database. For weight > 0 tuples in
   * `other`, adds them with weight 1 (backward-compatible set union).
   * Returns the number of newly-present facts.
   */
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

  /**
   * Create a deep clone of this database.
   *
   * Preserves all weights faithfully (including weight ≤ 0 entries)
   * by delegating to Relation.clone() which copies the internal map
   * directly. Previously this iterated tuples() (weight > 0 only) and
   * called add() (weight = 1), silently flattening weights — a footgun
   * for any caller that snapshots mid-evaluation.
   *
   * See Plan 006.1, task 2.0.
   */
  clone(): Database {
    const result = new Database();
    for (const pred of this.predicates()) {
      result._relations.set(pred, this.getRelation(pred).clone());
    }
    return result;
  }

  /** Total number of facts with clampedWeight > 0 across all relations. */
  get size(): number {
    let total = 0;
    for (const rel of this._relations.values()) {
      total += rel.size;
    }
    return total;
  }

  /**
   * Check if any relation has any stored entries (regardless of weight sign).
   *
   * Unlike `size` which counts only clampedWeight > 0 entries, this returns
   * true if any relation has any stored entries at all — including negative-
   * weight entries in delta databases. Used for convergence checks and seed
   * guards where retraction-only deltas must not be silently skipped.
   */
  hasAnyEntries(): boolean {
    for (const rel of this._relations.values()) {
      if (rel.allEntryCount > 0) return true;
    }
    return false;
  }

  /** Check if a fact exists (clampedWeight > 0) in the database. */
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

/**
 * Produce a deterministic string key for a fact, for deduplication
 * and Z-set keying.
 *
 * The key is `predicate|serialized(v0)|serialized(v1)|...`.
 * Two facts with the same predicate and values produce the same key.
 *
 * Moved from `evaluate.ts` (where it was private) to support
 * incremental projection's Z-set keying (Plan 005, Phase 5).
 */
export function factKey(f: Fact): string {
  const parts: string[] = [f.predicate];
  for (const v of f.values) {
    parts.push(serializeValue(v));
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
    const ra = (a as { readonly ref: CnId }).ref;
    const rb = (b as { readonly ref: CnId }).ref;
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
    const ra = (a as { readonly ref: CnId }).ref;
    const rb = (b as { readonly ref: CnId }).ref;
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
    const ra = (a as { readonly ref: CnId }).ref;
    const rb = (b as { readonly ref: CnId }).ref;
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