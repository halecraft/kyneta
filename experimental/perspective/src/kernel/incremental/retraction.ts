// === Incremental Retraction Stage ===
// Maintains the retraction graph as persistent state and processes
// constraint deltas incrementally. For each new constraint, cascades
// dominance and emits a Z-set delta of active-set changes.
//
// Correctness invariant:
//   current() == computeActive(all constraints seen so far)
//
// This mirrors the batch `computeActive()` in `kernel/retraction.ts`
// but maintains state across calls rather than rebuilding from scratch.
//
// Key design decisions:
// - Non-retract constraints enter as active (+1) unless a standing
//   retractor already targets them.
// - Retract constraints record graph edges immediately. If the target
//   hasn't arrived yet, the edge is a "standing instruction" that
//   takes effect when the target arrives.
// - Multi-element deltas (from authority re-validation) are processed
//   in two passes: non-retracts first, then retracts, so that edges
//   can find their targets within the same delta.
// - Dominance is recomputed from the graph for affected constraints
//   on each step, not cached across steps (the graph is small and
//   the cascade is bounded by maxDepth).
//
// See .plans/005-incremental-kernel-pipeline.md § Phase 3.
// See theory/incremental.md §5.4.

import type { ZSet } from "../../base/zset.js"
import {
  zsetAdd,
  zsetEmpty,
  zsetForEach,
  zsetIsEmpty,
  zsetSingleton,
} from "../../base/zset.js"
import { cnIdKey } from "../cnid.js"
import type {
  RetractionConfig,
  RetractionViolation,
  RetractionViolationReason,
} from "../retraction.js"
import { DEFAULT_RETRACTION_CONFIG } from "../retraction.js"
import type { Constraint, RetractConstraint } from "../types.js"

// ---------------------------------------------------------------------------
// Incremental Retraction Stage
// ---------------------------------------------------------------------------

/**
 * The incremental retraction stage.
 *
 * Maintains the retraction graph and accumulated active/dominated sets
 * as persistent state. Processes constraint deltas and emits Z-set
 * deltas of active-set changes.
 *
 * Follows the three shared conventions:
 *   1. step(Δ_valid) — process input delta, update state, return output delta
 *   2. current() — return full materialized active set
 *   3. reset() — return to empty state
 */
export interface IncrementalRetraction {
  /**
   * Process a delta of valid constraints and return the active-set delta.
   *
   * For each constraint in the input delta:
   * - weight +1: a newly-valid constraint entering the system
   * - weight −1: a constraint leaving validity (e.g., authority revocation)
   *
   * Returns a Z-set delta over the active set:
   * - weight +1: constraint became active
   * - weight −1: constraint became dominated (or was removed)
   */
  step(delta: ZSet<Constraint>): ZSet<Constraint>

  /**
   * Return the current accumulated active constraint set.
   * Equal to computeActive(all constraints seen so far).
   */
  current(): Constraint[]

  /**
   * Return accumulated violations from all steps so far.
   */
  violations(): readonly RetractionViolation[]

  /**
   * Reset to empty state.
   */
  reset(): void
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental retraction stage.
 *
 * @param config - Retraction depth configuration. Defaults to depth 2.
 */
export function createIncrementalRetraction(
  config: RetractionConfig = DEFAULT_RETRACTION_CONFIG,
): IncrementalRetraction {
  // --- Persistent state ---

  // All constraints seen so far, by CnId key.
  let allByKey = new Map<string, Constraint>()

  // Retraction graph: targetKey → array of retract constraints targeting it.
  // Only structurally valid retracts (pass target-in-refs, no-structure,
  // no-authority checks) are added to the graph.
  let retractEdges = new Map<string, RetractConstraint[]>()

  // Current dominance status for every constraint.
  let domStatus = new Map<string, "active" | "dominated">()

  // Accumulated violations.
  let accViolations: RetractionViolation[] = []

  // --- Internal helpers ---

  /**
   * Validate structural rules for a retract constraint.
   * Returns null if valid, or a RetractionViolation if invalid.
   *
   * Note: when the target hasn't arrived yet, we can't check
   * structure/authority immunity. Those checks happen when the
   * target arrives (see processNonRetract).
   */
  function validateRetract(
    retract: RetractConstraint,
  ): RetractionViolation | null {
    const targetKey = cnIdKey(retract.payload.target)
    const target = allByKey.get(targetKey)

    // Rule: target must be in refs (causal safety)
    const targetPeer = retract.payload.target.peer
    const targetCounter = retract.payload.target.counter
    const targetInRefs = retract.refs.some(
      ref => ref.peer === targetPeer && ref.counter >= targetCounter,
    )
    if (!targetInRefs) {
      return {
        retractConstraint: retract,
        reason: { kind: "targetNotInRefs", target: retract.payload.target },
      }
    }

    // Rule: structure constraints are immune to retraction
    if (target !== undefined && target.type === "structure") {
      return {
        retractConstraint: retract,
        reason: { kind: "targetIsStructure", target: retract.payload.target },
      }
    }

    // Rule: authority constraints are immune to retraction
    if (target !== undefined && target.type === "authority") {
      return {
        retractConstraint: retract,
        reason: { kind: "targetIsAuthority", target: retract.payload.target },
      }
    }

    return null
  }

  /**
   * Compute the retraction chain depth for a target.
   *
   * Depth 1: a retract targeting a non-retract constraint.
   * Depth 2: a retract targeting another retract (undo).
   * Depth N: a retract targeting a depth N-1 retract.
   *
   * For non-retract targets, depth is 1.
   * For retract targets, depth is 1 + depth(target's target).
   */
  function computeDepth(targetKey: string): number {
    const target = allByKey.get(targetKey)
    if (target === undefined || target.type !== "retract") {
      return 1
    }

    // Target is itself a retract — depth is 1 + depth of its target
    const innerTarget = (target as RetractConstraint).payload.target
    const innerKey = cnIdKey(innerTarget)
    return 1 + computeDepth(innerKey)
  }

  /**
   * Compute dominance for a constraint from the current graph state.
   *
   * dom(c):
   *   - If c has no valid retractors → active
   *   - If any retractor of c is active → dominated
   *   - If all retractors of c are dominated → active
   *
   * Uses memoized results from a local cache within one computation
   * pass, plus a computing set for cycle detection.
   */
  function computeDom(
    key: string,
    localCache: Map<string, "active" | "dominated">,
    computing: Set<string>,
  ): "active" | "dominated" {
    const cached = localCache.get(key)
    if (cached !== undefined) return cached

    // Cycle detection (defensive)
    if (computing.has(key)) {
      return "active"
    }
    computing.add(key)

    // If depth 0 mode, everything is active
    if (config.maxDepth === 0) {
      localCache.set(key, "active")
      computing.delete(key)
      return "active"
    }

    const retractors = retractEdges.get(key)

    // No retractors → active
    if (retractors === undefined || retractors.length === 0) {
      localCache.set(key, "active")
      computing.delete(key)
      return "active"
    }

    // Check each retractor
    for (const retract of retractors) {
      const retractKey = cnIdKey(retract.id)

      // Depth limit check
      const depth = computeDepth(key)
      if (depth > config.maxDepth) {
        // This retraction exceeds depth limit — ignore it
        continue
      }

      // Check if the retractor itself is active
      const retractorDom = computeDom(retractKey, localCache, computing)
      if (retractorDom === "active") {
        localCache.set(key, "dominated")
        computing.delete(key)
        return "dominated"
      }
    }

    // All retractors are either dominated or exceeded depth limit → active
    localCache.set(key, "active")
    computing.delete(key)
    return "active"
  }

  /**
   * Recompute dominance for a constraint and all constraints
   * transitively affected by changes to it. Returns the Z-set
   * delta of status changes.
   *
   * "Affected" means: the constraint itself, plus any constraint
   * that has this constraint as a retractor (direct targets), plus
   * any constraint that has those as retractors, etc. In practice
   * the cascade is bounded by maxDepth.
   */
  function recomputeAffected(seedKeys: Set<string>): ZSet<Constraint> {
    // Collect all keys that need recomputation: the seeds plus
    // anything transitively reachable as a target of the seeds.
    const toRecompute = new Set<string>(seedKeys)

    // BFS: if a retract constraint's status might change, its
    // target's status might also change.
    const queue = [...seedKeys]
    while (queue.length > 0) {
      const key = queue.shift()!
      // If key is a retract, its target might be affected
      const c = allByKey.get(key)
      if (c !== undefined && c.type === "retract") {
        const targetKey = cnIdKey((c as RetractConstraint).payload.target)
        if (allByKey.has(targetKey) && !toRecompute.has(targetKey)) {
          toRecompute.add(targetKey)
          queue.push(targetKey)
        }
      }
      // Also, anything that retract-targets this key might be affected
      // (if this key's status changes, its retractors' targets' statuses
      // could change). We need to find constraints whose retractors include
      // this key — i.e., constraints that this key retracts.
      // Actually, that's: for each constraint C where key is a retractor of C,
      // C's status might change.
      // retractEdges is targetKey → retractors, so we need the inverse:
      // "what does key retract?" → if key is a retract constraint, its target.
      // That's handled above. But we also need: "who retracts key?" → those
      // are retractEdges.get(key). If key's status changes, then for each
      // constraint that key retracts (key's target), we already handle that
      // above. And for the retractors OF key — their status is upstream and
      // doesn't depend on key. So we actually just need to go downward:
      // key → key's target (if key is a retract) → target's target, etc.
    }

    // Also add all constraints that are directly retracted by any seed,
    // because the targets' status depends on the retractors' status.
    // Walk the retraction graph downward from all recompute candidates.
    let expanded = true
    while (expanded) {
      expanded = false
      for (const key of toRecompute) {
        // Find what key retracts
        const c = allByKey.get(key)
        if (c !== undefined && c.type === "retract") {
          const targetKey = cnIdKey((c as RetractConstraint).payload.target)
          if (allByKey.has(targetKey) && !toRecompute.has(targetKey)) {
            toRecompute.add(targetKey)
            expanded = true
          }
        }
        // Also: if key's retractors changed status, key's status might change.
        // Walk upward: find retractors of key.
        const retractors = retractEdges.get(key)
        if (retractors !== undefined) {
          for (const r of retractors) {
            const rKey = cnIdKey(r.id)
            if (!toRecompute.has(rKey)) {
              toRecompute.add(rKey)
              expanded = true
            }
          }
        }
      }
    }

    // Recompute dominance for all affected constraints
    const localCache = new Map<string, "active" | "dominated">()
    const computing = new Set<string>()

    // Pre-seed the local cache with the current status of constraints
    // that are NOT being recomputed (stable context)
    for (const [key, status] of domStatus) {
      if (!toRecompute.has(key)) {
        localCache.set(key, status)
      }
    }

    // Compute new status for all affected constraints
    let delta = zsetEmpty<Constraint>()

    for (const key of toRecompute) {
      const c = allByKey.get(key)
      if (c === undefined) continue

      const oldStatus = domStatus.get(key)
      const newStatus = computeDom(key, localCache, computing)

      // Update persistent status
      domStatus.set(key, newStatus)

      // Emit delta for status changes
      if (oldStatus === undefined) {
        // New constraint — emit +1 if active
        if (newStatus === "active") {
          delta = zsetAdd(delta, zsetSingleton(key, c, 1))
        }
      } else if (oldStatus !== newStatus) {
        if (newStatus === "active") {
          // Was dominated, now active → +1
          delta = zsetAdd(delta, zsetSingleton(key, c, 1))
        } else {
          // Was active, now dominated → −1
          delta = zsetAdd(delta, zsetSingleton(key, c, -1))
        }
      }
      // If oldStatus === newStatus, no delta
    }

    return delta
  }

  /**
   * Process a retract constraint entering the system (weight +1).
   * Adds it to the allByKey index, validates structural rules,
   * adds edges to the graph, and returns affected key set.
   */
  function addRetract(
    retract: RetractConstraint,
    affectedKeys: Set<string>,
  ): void {
    const key = cnIdKey(retract.id)

    // Validate structural rules
    const violation = validateRetract(retract)
    if (violation !== null) {
      accViolations.push(violation)
      // Invalid retract still gets a dominance status (it's a constraint
      // in the system, just not a valid retract). It enters as active
      // since it has no retractors of its own yet (unless one already exists).
      affectedKeys.add(key)
      return
    }

    // Add edge to retraction graph
    const targetKey = cnIdKey(retract.payload.target)
    let edges = retractEdges.get(targetKey)
    if (edges === undefined) {
      edges = []
      retractEdges.set(targetKey, edges)
    }
    edges.push(retract)

    // The retract itself and its target are affected
    affectedKeys.add(key)
    if (allByKey.has(targetKey)) {
      affectedKeys.add(targetKey)
    }
  }

  /**
   * Process a retract constraint leaving the system (weight −1).
   * Removes edges from the graph and returns affected key set.
   */
  function removeRetract(
    retract: RetractConstraint,
    affectedKeys: Set<string>,
  ): void {
    const key = cnIdKey(retract.id)
    const targetKey = cnIdKey(retract.payload.target)

    // Remove edge from retraction graph
    const edges = retractEdges.get(targetKey)
    if (edges !== undefined) {
      const idx = edges.findIndex(e => cnIdKey(e.id) === key)
      if (idx !== -1) {
        edges.splice(idx, 1)
        if (edges.length === 0) {
          retractEdges.delete(targetKey)
        }
      }
    }

    // The retract's target might change status
    if (allByKey.has(targetKey)) {
      affectedKeys.add(targetKey)
    }
    affectedKeys.add(key)
  }

  /**
   * Check for deferred structure/authority immunity violations.
   *
   * When a retract arrives before its target, we can't check
   * structure/authority immunity. When the target arrives, we
   * check all existing retract edges pointing at it.
   */
  function checkDeferredImmunity(
    targetKey: string,
    target: Constraint,
    affectedKeys: Set<string>,
  ): void {
    if (target.type !== "structure" && target.type !== "authority") {
      return
    }

    const edges = retractEdges.get(targetKey)
    if (edges === undefined || edges.length === 0) return

    // Remove all edges targeting this immune constraint and record violations
    const violatingRetracts = [...edges]
    retractEdges.delete(targetKey)

    for (const retract of violatingRetracts) {
      const reason: RetractionViolationReason =
        target.type === "structure"
          ? { kind: "targetIsStructure", target: retract.payload.target }
          : { kind: "targetIsAuthority", target: retract.payload.target }

      accViolations.push({ retractConstraint: retract, reason })

      // The retract constraint is now just a regular active constraint
      // (its edge was removed), so it might change status
      affectedKeys.add(cnIdKey(retract.id))
    }
  }

  // --- Public interface ---

  function step(delta: ZSet<Constraint>): ZSet<Constraint> {
    if (delta.size === 0) return zsetEmpty()

    // Separate into additions (+1) and removals (−1).
    // Within additions, separate retracts from non-retracts for
    // two-pass processing (task 3.3).
    const additionsNonRetract: Constraint[] = []
    const additionsRetract: RetractConstraint[] = []
    const removals: Constraint[] = []

    zsetForEach(delta, (entry, _key) => {
      if (entry.weight > 0) {
        if (entry.element.type === "retract") {
          additionsRetract.push(entry.element as RetractConstraint)
        } else {
          additionsNonRetract.push(entry.element)
        }
      } else if (entry.weight < 0) {
        removals.push(entry.element)
      }
    })

    const affectedKeys = new Set<string>()

    // Pass 1: Add all non-retract constraints to the index first.
    // This ensures that when we process retracts in pass 2, their
    // targets may already be in the index (handles same-delta case).
    for (const c of additionsNonRetract) {
      const key = cnIdKey(c.id)
      if (allByKey.has(key)) continue // dedup
      allByKey.set(key, c)
      affectedKeys.add(key)

      // Check for deferred immunity violations
      checkDeferredImmunity(key, c, affectedKeys)
    }

    // Pass 2: Add retract constraints.
    for (const retract of additionsRetract) {
      const key = cnIdKey(retract.id)
      if (allByKey.has(key)) continue // dedup
      allByKey.set(key, retract)
      addRetract(retract, affectedKeys)
    }

    // Pass 3: Process removals (weight −1).
    // Collect removal deltas for all active removals, then recompute
    // affected keys once at the end. Previous code had a bug where
    // the first active removal triggered an early return, silently
    // dropping subsequent removals in the same delta.
    let removalDelta = zsetEmpty<Constraint>()

    for (const c of removals) {
      const key = cnIdKey(c.id)
      if (!allByKey.has(key)) continue // not present

      // Remove from index
      allByKey.delete(key)

      // If it was a retract, remove its graph edges
      if (c.type === "retract") {
        removeRetract(c as RetractConstraint, affectedKeys)
      } else {
        affectedKeys.add(key)
      }

      // Record removal: if it was active, emit −1
      const oldStatus = domStatus.get(key)
      domStatus.delete(key)
      if (oldStatus === "active") {
        // The constraint is gone from allByKey, so recomputeAffected
        // can't handle it. Emit the −1 delta directly and remove
        // from the recompute set.
        affectedKeys.delete(key)
        removalDelta = zsetAdd(removalDelta, zsetSingleton(key, c, -1))
      }
    }

    // Recompute dominance for all affected constraints
    if (affectedKeys.size === 0 && zsetIsEmpty(removalDelta)) return zsetEmpty()

    const recomputeDelta =
      affectedKeys.size > 0
        ? recomputeAffected(affectedKeys)
        : zsetEmpty<Constraint>()

    return zsetAdd(removalDelta, recomputeDelta)
  }

  function current(): Constraint[] {
    const result: Constraint[] = []
    for (const [key, c] of allByKey) {
      if (domStatus.get(key) === "active") {
        result.push(c)
      }
    }
    return result
  }

  function getViolations(): readonly RetractionViolation[] {
    return accViolations
  }

  function reset(): void {
    allByKey = new Map()
    retractEdges = new Map()
    domStatus = new Map()
    accViolations = []
  }

  return {
    step,
    current,
    violations: getViolations,
    reset,
  }
}
