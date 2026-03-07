// === Kernel Types ===
// Implements the spec's §1–§3 directly. All types are immutable (readonly).
//
// Convention: `Uint8Array` immutability.
// Uint8Array is inherently mutable in JavaScript. All code in this codebase
// treats Uint8Array values as logically immutable — never call .set(), .fill(),
// or mutate buffer contents after construction. Enforced by convention, not
// the type system.

// ---------------------------------------------------------------------------
// Result type — re-exported from shared base.
// ---------------------------------------------------------------------------

export { type Result, ok, err } from '../base/result.js';

// ---------------------------------------------------------------------------
// Datalog types — re-exported so RulePayload is properly typed and
// downstream consumers can import everything from kernel/types.
// ---------------------------------------------------------------------------

export type {
  Atom,
  Term,
  ConstTerm,
  VarTerm,
  WildcardTerm,
  GuardOp,
  GuardElement,
  BodyElement,
  AtomElement,
  NegationElement,
  AggregationElement,
  AggregationClause,
  Rule,
} from '../datalog/types.js';

// ---------------------------------------------------------------------------
// Identity (§1)
// ---------------------------------------------------------------------------

/**
 * Peer identifier — public key or hash thereof.
 *
 * In production this is a public key. For testing we use human-readable
 * strings like "alice", "bob".
 */
export type PeerID = string;

/**
 * Monotonically increasing per-peer operation counter.
 *
 * Must satisfy: `Number.isSafeInteger(x) && x >= 0`.
 * Enforced at Agent construction and store insertion boundaries.
 */
export type Counter = number;

/**
 * Lamport timestamp for causal ordering.
 *
 * Must satisfy: `Number.isSafeInteger(x) && x >= 0`.
 * Enforced at Agent construction and store insertion boundaries.
 */
export type Lamport = number;

/**
 * Constraint Id — globally unique identifier for a constraint.
 *
 * The pair (peer, counter) is globally unique because each peer
 * maintains a monotonically increasing counter.
 */
export interface CnId {
  readonly peer: PeerID;
  readonly counter: Counter;
}

// ---------------------------------------------------------------------------
// Safe-integer validation
// ---------------------------------------------------------------------------

/**
 * Check that a number is a safe unsigned integer (0 ≤ x ≤ 2^53 − 1).
 *
 * Structural integer fields (counter, lamport, layer) must pass this check.
 * See unified-engine.md §1 for rationale.
 */
export function isSafeUint(x: number): boolean {
  return Number.isSafeInteger(x) && x >= 0;
}

// ---------------------------------------------------------------------------
// Version Vector (type alias only — functions live in version-vector.ts)
// ---------------------------------------------------------------------------

/**
 * Version vector — maps each peer to the next expected counter.
 *
 * Semantics: vv[peer] = n means we have seen operations 0..n-1 from that peer.
 */
export type VersionVector = ReadonlyMap<PeerID, Counter>;

/**
 * Mutable version vector for internal use.
 */
export type MutableVersionVector = Map<PeerID, Counter>;

// ---------------------------------------------------------------------------
// Values (§3)
//
// `number` and `bigint` are distinct types with distinct comparison semantics.
// int(3n) and float(3.0) are NOT equal — this avoids precision-loss bugs
// across language boundaries. See unified-engine.md §3 for full rationale.
// ---------------------------------------------------------------------------

/**
 * The value domain for constraint payloads and Datalog terms.
 *
 * - `null`       — absence (for Map deletion via LWW)
 * - `boolean`    — true / false
 * - `number`     — IEEE 754 f64 (floats and safe integers)
 * - `bigint`     — arbitrary-precision integer
 * - `string`     — UTF-8 string
 * - `Uint8Array` — raw binary (logically immutable by convention)
 * - `{ ref }`    — reference to a structure constraint (for nesting)
 */
export type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | { readonly ref: CnId };

// ---------------------------------------------------------------------------
// Policies (§8)
// ---------------------------------------------------------------------------

export type Policy = 'map' | 'seq';

// ---------------------------------------------------------------------------
// Constraint Types (§2)
// ---------------------------------------------------------------------------

// §2.1 — Structure

/**
 * Structural assertion — asserts the permanent existence of a node.
 * Never retractable.
 */
export type StructurePayload =
  | { readonly kind: 'map'; readonly parent: CnId; readonly key: string }
  | { readonly kind: 'seq'; readonly parent: CnId; readonly originLeft: CnId | null; readonly originRight: CnId | null }
  | { readonly kind: 'root'; readonly containerId: string; readonly policy: Policy };

// §2.2 — Value

/** Content assertion — asserts content at a node. Retractable. */
export interface ValuePayload {
  readonly target: CnId;
  readonly content: Value;
}

// §2.3 — Retract

/** Retraction assertion — asserts that a target should be dominated. */
export interface RetractPayload {
  readonly target: CnId;
}

// §2.4 — Rule

/**
 * Solver rule — asserts a Datalog rule at layer ≥ 2.
 * Retractable.
 */
export interface RulePayload {
  readonly layer: number; // must be ≥ 2
  readonly head: import('../datalog/types.js').Atom;
  readonly body: readonly import('../datalog/types.js').BodyElement[];
}

// §2.5 — Authority

/**
 * Capability — what an agent is authorized to do.
 * Recursive discriminated union.
 */
export type Capability =
  | { readonly kind: 'write'; readonly pathPattern: readonly string[] }
  | { readonly kind: 'createNode'; readonly pathPattern: readonly string[] }
  | { readonly kind: 'retract'; readonly scope: RetractScope }
  | { readonly kind: 'createRule'; readonly minLayer: number }
  | { readonly kind: 'authority'; readonly capability: Capability }
  | { readonly kind: 'admin' };

/** Scope of a retraction capability. */
export type RetractScope =
  | { readonly kind: 'own' }
  | { readonly kind: 'byPath'; readonly pattern: readonly string[] }
  | { readonly kind: 'any' };

/** Grant or revoke. */
export type AuthorityAction = 'grant' | 'revoke';

/** Authority assertion — changes an agent's capabilities. */
export interface AuthorityPayload {
  readonly targetPeer: PeerID;
  readonly action: AuthorityAction;
  readonly capability: Capability;
}

// §2.6 — Bookmark

/** Named point in causal time. */
export interface BookmarkPayload {
  readonly name: string;
  readonly version: VersionVector;
}

// ---------------------------------------------------------------------------
// Constraint (§1) — discriminated union
//
// `type` narrows `payload` so switch/if-narrowing works without casts.
// ---------------------------------------------------------------------------

/** Fields shared by every constraint variant. */
export interface ConstraintBase {
  readonly id: CnId;
  readonly lamport: Lamport;
  readonly refs: readonly CnId[];
  readonly sig: Uint8Array; // ed25519 signature (stub: empty array)
}

/** Structure constraint — permanent node. */
export interface StructureConstraint extends ConstraintBase {
  readonly type: 'structure';
  readonly payload: StructurePayload;
}

/** Value constraint — content at a node. */
export interface ValueConstraint extends ConstraintBase {
  readonly type: 'value';
  readonly payload: ValuePayload;
}

/** Retract constraint — dominate a target. */
export interface RetractConstraint extends ConstraintBase {
  readonly type: 'retract';
  readonly payload: RetractPayload;
}

/** Rule constraint — Datalog rule. */
export interface RuleConstraint extends ConstraintBase {
  readonly type: 'rule';
  readonly payload: RulePayload;
}

/** Authority constraint — capability change. */
export interface AuthorityConstraint extends ConstraintBase {
  readonly type: 'authority';
  readonly payload: AuthorityPayload;
}

/** Bookmark constraint — named causal moment. */
export interface BookmarkConstraint extends ConstraintBase {
  readonly type: 'bookmark';
  readonly payload: BookmarkPayload;
}

/**
 * The atomic unit of the system. A subjective assertion by an agent
 * about what should be true.
 *
 * Discriminated union on `type` — switch/if on `type` narrows `payload`.
 */
export type Constraint =
  | StructureConstraint
  | ValueConstraint
  | RetractConstraint
  | RuleConstraint
  | AuthorityConstraint
  | BookmarkConstraint;

/** All possible constraint type discriminants. */
export type ConstraintType = Constraint['type'];

// ---------------------------------------------------------------------------
// Reality (§7.3) — output of the solver pipeline
// ---------------------------------------------------------------------------

export interface RealityNode {
  readonly id: CnId;
  readonly policy: Policy;
  readonly children: ReadonlyMap<string, RealityNode>;
  readonly value: Value | undefined;
}

export interface Reality {
  readonly root: RealityNode;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Errors that can occur when inserting a constraint into the store. */
export type InsertError =
  | { readonly kind: 'invalidSignature'; readonly constraintId: CnId }
  | { readonly kind: 'outOfRange'; readonly field: string; readonly value: number }
  | { readonly kind: 'malformed'; readonly reason: string };

/** Errors from the validity check (Phase 3). */
export type ValidationError =
  | { readonly kind: 'invalidSignature'; readonly constraintId: CnId }
  | { readonly kind: 'missingCapability'; readonly constraintId: CnId; readonly required: Capability };