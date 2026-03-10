// === Retraction & Dominance ===
// Implements §6 of the spec: computing Active(S) from Valid(S).
//
// The retraction graph is a DAG of edges from retract constraints to
// their targets. Dominance is computed by reverse topological traversal:
//
// 1. If c has no valid retract constraints targeting it → active.
// 2. If c has at least one active retract targeting it → dominated.
// 3. If all retract constraints targeting c are themselves dominated → active.
//
// Additional rules:
// - Structure constraints are immune to retraction (§6 + §2.1).
// - A retract constraint must have its target in its refs (causal safety).
// - Retraction depth can be limited (default 2: retract + undo).
//
// Active(S) = { c ∈ Valid(S) | dom(c) = active }
//
// Properties:
// - Deterministic: same S → same Active(S) regardless of insertion order.
// - Commutativity/idempotence inherited from set union on S.
//
// See unified-engine.md §6.

import type {
  Constraint,
  RetractConstraint,
  CnId,
} from './types.js';
import { cnIdKey } from './cnid.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Retraction depth configuration.
 *
 * | depth | Meaning                                     |
 * |-------|---------------------------------------------|
 * | 0     | No retraction. Monotonic constraint growth.  |
 * | 1     | Retract values only. No undo-of-undo.        |
 * | 2     | Undo + redo. Recommended default.             |
 * | Infinity | Unlimited retraction chains.               |
 */
export interface RetractionConfig {
  /** Maximum retraction chain depth. Default: 2. */
  readonly maxDepth: number;
}

export const DEFAULT_RETRACTION_CONFIG: RetractionConfig = {
  maxDepth: 2,
};

// ---------------------------------------------------------------------------
// Retraction Result
// ---------------------------------------------------------------------------

/**
 * The result of computing Active(S).
 */
export interface RetractionResult {
  /** Constraints that are active (not dominated). */
  readonly active: readonly Constraint[];

  /** Constraints that are dominated by retraction. */
  readonly dominated: readonly Constraint[];

  /**
   * Retraction violations — retract constraints that were rejected
   * because they violate structural rules (target not in refs, or
   * target is a structure constraint).
   */
  readonly violations: readonly RetractionViolation[];
}

/**
 * A retraction rule violation.
 */
export interface RetractionViolation {
  readonly retractConstraint: RetractConstraint;
  readonly reason: RetractionViolationReason;
}

export type RetractionViolationReason =
  | { readonly kind: 'targetNotInRefs'; readonly target: CnId }
  | { readonly kind: 'targetIsStructure'; readonly target: CnId }
  | { readonly kind: 'targetIsAuthority'; readonly target: CnId }
  | { readonly kind: 'depthExceeded'; readonly depth: number; readonly maxDepth: number };

// ---------------------------------------------------------------------------
// Compute Active(S)
// ---------------------------------------------------------------------------

/**
 * Compute the active set from a collection of valid constraints.
 *
 * This function:
 * 1. Validates retraction structural rules (target-in-refs, no-structure).
 * 2. Builds the retraction graph.
 * 3. Computes dominance via reverse topological traversal.
 * 4. Enforces retraction depth limits.
 * 5. Returns Active(S) and diagnostic information.
 *
 * @param validConstraints - Constraints that have already passed Valid(S).
 * @param config - Retraction configuration (depth limit). Defaults to depth 2.
 * @returns RetractionResult with active set, dominated set, and violations.
 */
export function computeActive(
  validConstraints: Iterable<Constraint>,
  config: RetractionConfig = DEFAULT_RETRACTION_CONFIG,
): RetractionResult {
  // Materialize and index constraints by CnId key
  const all: Constraint[] = [];
  const byKey = new Map<string, Constraint>();

  for (const c of validConstraints) {
    all.push(c);
    byKey.set(cnIdKey(c.id), c);
  }

  // Step 1: Collect valid retract constraints and check structural rules.
  // retractEdges: Map<targetKey, retractConstraint[]>
  const retractEdges = new Map<string, RetractConstraint[]>();
  const violations: RetractionViolation[] = [];

  // Track which retract constraints are valid (pass structural checks)
  const validRetracts = new Set<string>(); // keys of valid retract constraints

  for (const c of all) {
    if (c.type !== 'retract') continue;

    const retract = c as RetractConstraint;
    const targetKey = cnIdKey(retract.payload.target);
    const target = byKey.get(targetKey);

    // Rule: target must be in refs (causal safety)
    //
    // Semantic interpretation: a ref (peer, N) implies the agent has
    // observed all of that peer's constraints 0..N (frontier compression).
    // So target (peer, T) is "in refs" if any ref for the same peer
    // has counter >= T. This matches how version vectors work throughout
    // the codebase and is compatible with Agent.currentRefs(), which
    // compresses causal predecessors to the VV frontier.
    const targetPeer = retract.payload.target.peer;
    const targetCounter = retract.payload.target.counter;
    const targetInRefs = retract.refs.some(
      (ref) => ref.peer === targetPeer && ref.counter >= targetCounter,
    );
    if (!targetInRefs) {
      violations.push({
        retractConstraint: retract,
        reason: { kind: 'targetNotInRefs', target: retract.payload.target },
      });
      continue;
    }

    // Rule: structure constraints are immune to retraction
    if (target !== undefined && target.type === 'structure') {
      violations.push({
        retractConstraint: retract,
        reason: { kind: 'targetIsStructure', target: retract.payload.target },
      });
      continue;
    }

    // Rule: authority constraints are immune to retraction (§2.5)
    // Revocation is the dedicated mechanism for removing capabilities.
    // Using retraction to remove authority constraints would circumvent
    // the authority model.
    if (target !== undefined && target.type === 'authority') {
      violations.push({
        retractConstraint: retract,
        reason: { kind: 'targetIsAuthority', target: retract.payload.target },
      });
      continue;
    }

    // Valid retract — add to retraction graph
    validRetracts.add(cnIdKey(retract.id));

    let edges = retractEdges.get(targetKey);
    if (edges === undefined) {
      edges = [];
      retractEdges.set(targetKey, edges);
    }
    edges.push(retract);
  }

  // If no retraction is allowed at all (depth 0), all constraints are active
  if (config.maxDepth === 0) {
    return { active: all, dominated: [], violations };
  }

  // Step 2: Compute dominance via reverse topological traversal.
  //
  // We process constraints in an order where a constraint's retractors
  // are resolved before the constraint itself. Since the retraction graph
  // is acyclic (inherited from causal structure), we can use memoization.
  //
  // dom(c):
  //   - If c has no valid retractors → active
  //   - If any retractor of c is active → dominated
  //   - If all retractors of c are dominated → active
  //
  // We also enforce depth limits: a retract constraint at depth > maxDepth
  // is treated as if it doesn't exist.

  // Cache: constraint key → 'active' | 'dominated'
  const domCache = new Map<string, 'active' | 'dominated'>();

  // Depth cache: constraint key → retraction chain depth
  // (how many levels of retraction point at this constraint)
  const depthCache = new Map<string, number>();

  // Computing set to detect cycles (should not happen in valid data)
  const computing = new Set<string>();

  function computeDom(key: string): 'active' | 'dominated' {
    // Check cache
    const cached = domCache.get(key);
    if (cached !== undefined) return cached;

    // Cycle detection (defensive — should not happen with valid causal data)
    if (computing.has(key)) {
      // Break cycle by treating as active
      return 'active';
    }
    computing.add(key);

    const retractors = retractEdges.get(key);

    // No retractors → active
    if (retractors === undefined || retractors.length === 0) {
      domCache.set(key, 'active');
      computing.delete(key);
      return 'active';
    }

    // Check each retractor
    let allRetractorsDominated = true;

    for (const retract of retractors) {
      const retractKey = cnIdKey(retract.id);

      // Compute the depth of this retraction chain
      const retractDepth = computeDepth(key);
      if (retractDepth > config.maxDepth) {
        // This retraction exceeds the depth limit — ignore it
        // (treat as if it doesn't exist for dominance purposes)
        continue;
      }

      // Check if the retractor itself is active
      const retractorDom = computeDom(retractKey);
      if (retractorDom === 'active') {
        // At least one active retractor → this constraint is dominated
        domCache.set(key, 'dominated');
        computing.delete(key);
        return 'dominated';
      }

      // retractorDom === 'dominated' — this retractor is itself dominated
      // Continue checking others
    }

    // All retractors are either dominated or exceeded depth limit → active
    domCache.set(key, 'active');
    computing.delete(key);
    return 'active';
  }

  /**
   * Compute the retraction chain depth for a constraint.
   *
   * Depth 1: a retract targeting a non-retract constraint.
   * Depth 2: a retract targeting another retract (undo).
   * Depth N: a retract targeting a depth N-1 retract.
   *
   * For non-retract constraints, depth is 0.
   * For retract constraints, depth is 1 + depth(target).
   */
  function computeDepth(targetKey: string): number {
    const cached = depthCache.get(targetKey);
    if (cached !== undefined) return cached;

    const target = byKey.get(targetKey);
    if (target === undefined || target.type !== 'retract') {
      // Non-retract target: retraction depth is 1
      depthCache.set(targetKey, 1);
      return 1;
    }

    // Target is itself a retract — depth is 1 + depth of its target
    const innerTarget = (target as RetractConstraint).payload.target;
    const innerKey = cnIdKey(innerTarget);
    const innerDepth = computeDepth(innerKey);
    const depth = 1 + innerDepth;
    depthCache.set(targetKey, depth);
    return depth;
  }

  // Step 3: Compute dominance for all constraints
  const active: Constraint[] = [];
  const dominated: Constraint[] = [];

  for (const c of all) {
    const key = cnIdKey(c.id);
    const dom = computeDom(key);
    if (dom === 'active') {
      active.push(c);
    } else {
      dominated.push(c);
    }
  }

  return { active, dominated, violations };
}

// ---------------------------------------------------------------------------
// Convenience: filter active only
// ---------------------------------------------------------------------------

/**
 * Filter a set of valid constraints to only those that are active.
 *
 * Simpler API when you don't need the dominated set or violations.
 *
 * @param validConstraints - Constraints that have passed Valid(S).
 * @param config - Retraction configuration. Defaults to depth 2.
 * @returns Array of active constraints.
 */
export function filterActive(
  validConstraints: Iterable<Constraint>,
  config: RetractionConfig = DEFAULT_RETRACTION_CONFIG,
): Constraint[] {
  return [...computeActive(validConstraints, config).active];
}