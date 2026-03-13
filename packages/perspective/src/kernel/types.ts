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
// Shared identity and value types — re-exported from shared base so
// downstream consumers can import everything from kernel/types.
// ---------------------------------------------------------------------------

export { type PeerID, type Counter, type Lamport, type CnId, type Value, isSafeUint } from '../base/types.js';

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

import type { PeerID, Counter, Lamport, CnId, Value } from '../base/types.js';

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
  readonly layer: number; // Layer 1 = default solver rules (bootstrap); Layer ≥ 2 = user rules (Agent)
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
// Settling & Compaction (§11, §12)
// ---------------------------------------------------------------------------

/**
 * Compaction policy controls which constraints are eligible for removal.
 *
 * - 'frontier-only': Remove only constraints below V_stable whose
 *   retraction chains are depth-exhausted.
 * - 'snapshot-preserving': Remove dominated constraints below V_stable,
 *   preserving enough for historical snapshot queries.
 * - 'full-history': Remove all dominated constraints below V_stable
 *   regardless of historical query support.
 */
export type CompactionPolicy = 'frontier-only' | 'snapshot-preserving' | 'full-history';

/**
 * Configuration for the stability frontier.
 *
 * The frontier V_stable is the component-wise minimum of all agents'
 * version vectors. Single-agent: V_stable = store VV. Multi-agent:
 * V_stable = vvMin(peer VVs).
 */
export interface FrontierConfig {
  /** Compaction policy. */
  readonly compactionPolicy: CompactionPolicy;
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