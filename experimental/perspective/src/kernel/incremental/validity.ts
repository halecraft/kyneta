// === Incremental Validity Stage ===
// Maintains validity state as persistent state and processes constraint
// deltas incrementally. For each new constraint, checks signature and
// capability against the accumulated AuthorityState. When an authority
// constraint arrives, replays the full authority state and diffs against
// the previous state to find peers whose capabilities changed, then
// re-checks all of their constraints.
//
// Correctness invariant:
//   current() == computeValid(all constraints seen so far, creator).valid
//
// This mirrors the batch `computeValid()` in `kernel/validity.ts`
// but maintains state across calls rather than rebuilding from scratch.
//
// Key design decisions:
// - Authority changes trigger full replay via `computeAuthority()`.
//   Authority constraints are rare (typically single-digit count per
//   reality), so full replay is effectively O(1) in practice.
// - A per-peer constraint index enables O(constraints-by-peer) re-checking
//   when an authority change affects a specific peer, rather than scanning
//   all constraints.
// - Non-authority constraints are validated in O(1) against the cached
//   AuthorityState.
// - Out-of-order: a constraint arriving before the authority grant that
//   authorizes it is held in the invalid set. When the grant arrives,
//   the authority diff surfaces that peer, and re-checking promotes the
//   constraint to valid.
//
// See .plans/005-incremental-kernel-pipeline.md § Phase 6.
// See theory/incremental.md §5.2.

import type { ZSet } from "../../base/zset.js"
import {
  zsetAdd,
  zsetEmpty,
  zsetForEach,
  zsetSingleton,
} from "../../base/zset.js"
import {
  type AuthorityState,
  computeAuthority,
  hasCapability,
  requiredCapability,
} from "../authority.js"
import { cnIdKey } from "../cnid.js"
import { verify } from "../signature.js"
import type {
  AuthorityConstraint,
  Constraint,
  PeerID,
  ValidationError,
} from "../types.js"

// ---------------------------------------------------------------------------
// Incremental Validity Stage
// ---------------------------------------------------------------------------

/**
 * The incremental validity stage.
 *
 * Maintains the accumulated AuthorityState, valid/invalid constraint sets,
 * and per-peer constraint index as persistent state. Processes constraint
 * deltas and emits Z-set deltas of valid-set changes.
 *
 * Follows the three shared conventions:
 *   1. step(Δ_filtered) — process input delta, update state, return output delta
 *   2. current() — return full materialized valid set
 *   3. reset() — return to empty state
 */
export interface IncrementalValidity {
  /**
   * Process a delta of filtered constraints and return the valid-set delta.
   *
   * For each constraint in the input delta:
   * - weight +1: a new constraint entering the system
   * - weight −1: a constraint being removed (not currently used by
   *   upstream stages in Plan 005, but supported for completeness)
   *
   * Returns a Z-set delta over the valid set:
   * - weight +1: constraint became valid
   * - weight −1: constraint became invalid (e.g., authority revocation)
   */
  step(delta: ZSet<Constraint>): ZSet<Constraint>

  /**
   * Return the current accumulated valid constraint set.
   * Equal to computeValid(all constraints seen so far, creator).valid.
   */
  current(): Constraint[]

  /**
   * Reset to empty state.
   */
  reset(): void
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental validity stage.
 *
 * @param creator - PeerID of the reality creator (holds implicit Admin).
 */
export function createIncrementalValidity(
  creator: PeerID,
): IncrementalValidity {
  // --- Persistent state ---

  // All constraints seen so far, keyed by CnId key string.
  let allByKey = new Map<string, Constraint>()

  // Accumulated authority constraints (for full replay).
  let authorityConstraints: AuthorityConstraint[] = []

  // Current authority state (cached; updated on authority constraint arrival).
  let authorityState: AuthorityState = computeAuthority([], creator)

  // Valid constraint keys.
  let validKeys = new Set<string>()

  // Invalid constraint keys.
  let invalidKeys = new Set<string>()

  // Per-peer constraint index: PeerID → Set<CnId key>.
  // Tracks all constraints (both valid and invalid) by their asserting peer.
  let peerIndex = new Map<PeerID, Set<string>>()

  // --- Internal helpers ---

  /**
   * Verify the signature of a constraint.
   * Stub: always returns true (mirrors batch validity.ts).
   */
  function verifySignature(c: Constraint): boolean {
    return verify(new Uint8Array(0), c.sig, new Uint8Array(0))
  }

  /**
   * Validate a single constraint against the current authority state.
   * Returns null if valid, or a ValidationError if invalid.
   *
   * Mirrors the batch `validateConstraint()` in validity.ts.
   */
  function validateConstraint(c: Constraint): ValidationError | null {
    // Check 1: Signature verification (stub: always passes)
    if (!verifySignature(c)) {
      return { kind: "invalidSignature", constraintId: c.id }
    }

    // Check 2: Capability check
    const required = requiredCapability(c)

    // Some constraint types require no capability (e.g., bookmarks)
    if (required === null) {
      return null
    }

    // Check if the asserting peer has the required capability
    if (!hasCapability(authorityState, c.id.peer, required)) {
      return { kind: "missingCapability", constraintId: c.id, required }
    }

    return null
  }

  /**
   * Add a constraint to the per-peer index.
   */
  function addToPeerIndex(c: Constraint): void {
    const peer = c.id.peer
    let keys = peerIndex.get(peer)
    if (keys === undefined) {
      keys = new Set()
      peerIndex.set(peer, keys)
    }
    keys.add(cnIdKey(c.id))
  }

  /**
   * Remove a constraint from the per-peer index.
   */
  function removeFromPeerIndex(c: Constraint): void {
    const peer = c.id.peer
    const keys = peerIndex.get(peer)
    if (keys !== undefined) {
      keys.delete(cnIdKey(c.id))
      if (keys.size === 0) {
        peerIndex.delete(peer)
      }
    }
  }

  /**
   * Diff two AuthorityState objects to find peers whose effective
   * capabilities changed. Returns the set of affected PeerIDs.
   *
   * A peer is affected if:
   * - They gained a new capability (present in newState, absent in oldState)
   * - They lost a capability (present in oldState, absent in newState)
   * - The creator is never affected (implicit Admin is immutable)
   */
  function diffAuthorityStates(
    oldState: AuthorityState,
    newState: AuthorityState,
  ): Set<PeerID> {
    const affected = new Set<PeerID>()

    // Check all peers in the new state
    for (const [peer, newCaps] of newState.effectiveCapabilities) {
      if (peer === creator) continue // creator's Admin never changes

      const oldCaps = oldState.effectiveCapabilities.get(peer)

      if (oldCaps === undefined) {
        // Peer is new in the authority state — they might have gained caps
        if (newCaps.size > 0) {
          // But we need to check if it's just the default empty set
          // Actually, if they have caps, they're affected
          affected.add(peer)
        }
        continue
      }

      // Check for added capabilities
      for (const capKey of newCaps) {
        if (!oldCaps.has(capKey)) {
          affected.add(peer)
          break
        }
      }

      // Check for removed capabilities (only if not already marked)
      if (!affected.has(peer)) {
        for (const capKey of oldCaps) {
          if (!newCaps.has(capKey)) {
            affected.add(peer)
            break
          }
        }
      }
    }

    // Check peers who were in old state but not in new state
    // (they may have lost all capabilities)
    for (const [peer, oldCaps] of oldState.effectiveCapabilities) {
      if (peer === creator) continue
      if (affected.has(peer)) continue

      const newCaps = newState.effectiveCapabilities.get(peer)
      if (newCaps === undefined && oldCaps.size > 0) {
        affected.add(peer)
      }
    }

    return affected
  }

  /**
   * Re-check all constraints for a set of affected peers.
   * Returns a Z-set delta of validity changes.
   */
  function recheckPeers(affectedPeers: Set<PeerID>): ZSet<Constraint> {
    let delta = zsetEmpty<Constraint>()

    for (const peer of affectedPeers) {
      const keys = peerIndex.get(peer)
      if (keys === undefined) continue

      for (const key of keys) {
        const c = allByKey.get(key)
        if (c === undefined) continue

        const wasValid = validKeys.has(key)
        const error = validateConstraint(c)
        const isNowValid = error === null

        if (wasValid && !isNowValid) {
          // Was valid, now invalid → emit −1
          validKeys.delete(key)
          invalidKeys.add(key)
          delta = zsetAdd(delta, zsetSingleton(key, c, -1))
        } else if (!wasValid && isNowValid) {
          // Was invalid, now valid → emit +1
          invalidKeys.delete(key)
          validKeys.add(key)
          delta = zsetAdd(delta, zsetSingleton(key, c, 1))
        }
        // If status unchanged, no delta
      }
    }

    return delta
  }

  // --- Public interface ---

  function step(delta: ZSet<Constraint>): ZSet<Constraint> {
    if (delta.size === 0) return zsetEmpty()

    // Separate into additions (+1) and removals (−1).
    // Within additions, separate authority from non-authority
    // for two-pass processing.
    const additionsNonAuthority: Constraint[] = []
    const additionsAuthority: AuthorityConstraint[] = []
    const removals: Constraint[] = []

    zsetForEach(delta, (entry, _key) => {
      if (entry.weight > 0) {
        if (entry.element.type === "authority") {
          additionsAuthority.push(entry.element as AuthorityConstraint)
        } else {
          additionsNonAuthority.push(entry.element)
        }
      } else if (entry.weight < 0) {
        removals.push(entry.element)
      }
    })

    let result = zsetEmpty<Constraint>()

    // --- Pass 1: Process non-authority additions ---
    // Validate each against the current (pre-authority-update) state.
    // If an authority constraint arrives in the same delta, we'll
    // recheck these in pass 2.
    for (const c of additionsNonAuthority) {
      const key = cnIdKey(c.id)
      if (allByKey.has(key)) continue // dedup

      allByKey.set(key, c)
      addToPeerIndex(c)

      const error = validateConstraint(c)
      if (error === null) {
        validKeys.add(key)
        result = zsetAdd(result, zsetSingleton(key, c, 1))
      } else {
        invalidKeys.add(key)
        // Invalid — no delta emitted (constraint is held in invalid set)
      }
    }

    // --- Pass 2: Process authority additions ---
    // Each authority constraint triggers a full authority replay + diff.
    // We batch all authority additions first, then replay once.
    if (additionsAuthority.length > 0) {
      // Add all authority constraints to the accumulated list and index
      for (const ac of additionsAuthority) {
        const key = cnIdKey(ac.id)
        if (allByKey.has(key)) continue // dedup

        allByKey.set(key, ac)
        addToPeerIndex(ac)
        authorityConstraints.push(ac)
      }

      // Replay authority state from all accumulated authority constraints
      const oldState = authorityState
      authorityState = computeAuthority(authorityConstraints, creator)

      // Validate the authority constraints themselves against the NEW state.
      // Authority constraints need Authority(C) capability to be valid.
      for (const ac of additionsAuthority) {
        const key = cnIdKey(ac.id)
        // Skip if already indexed (dedup case above)
        if (validKeys.has(key) || invalidKeys.has(key)) continue

        const error = validateConstraint(ac)
        if (error === null) {
          validKeys.add(key)
          result = zsetAdd(result, zsetSingleton(key, ac, 1))
        } else {
          invalidKeys.add(key)
        }
      }

      // Diff old vs new authority state to find affected peers
      const affectedPeers = diffAuthorityStates(oldState, authorityState)

      // Re-check all constraints for affected peers.
      // This also re-checks non-authority constraints we added in pass 1
      // that might now have different validity due to the authority change.
      if (affectedPeers.size > 0) {
        const recheckDelta = recheckPeers(affectedPeers)
        result = zsetAdd(result, recheckDelta)
      }
    }

    // --- Pass 3: Process removals (weight −1) ---
    for (const c of removals) {
      const key = cnIdKey(c.id)
      if (!allByKey.has(key)) continue // not present

      const wasValid = validKeys.has(key)

      // Remove from all indexes
      allByKey.delete(key)
      removeFromPeerIndex(c)
      validKeys.delete(key)
      invalidKeys.delete(key)

      // If it was an authority constraint, remove from authority list
      // and replay
      if (c.type === "authority") {
        authorityConstraints = authorityConstraints.filter(
          ac => cnIdKey(ac.id) !== key,
        )

        const oldState = authorityState
        authorityState = computeAuthority(authorityConstraints, creator)

        // Diff and recheck
        const affectedPeers = diffAuthorityStates(oldState, authorityState)
        if (affectedPeers.size > 0) {
          const recheckDelta = recheckPeers(affectedPeers)
          result = zsetAdd(result, recheckDelta)
        }
      }

      // If it was valid, emit −1
      if (wasValid) {
        result = zsetAdd(result, zsetSingleton(key, c, -1))
      }
    }

    return result
  }

  function current(): Constraint[] {
    const result: Constraint[] = []
    for (const key of validKeys) {
      const c = allByKey.get(key)
      if (c !== undefined) {
        result.push(c)
      }
    }
    return result
  }

  function reset(): void {
    allByKey = new Map()
    authorityConstraints = []
    authorityState = computeAuthority([], creator)
    validKeys = new Set()
    invalidKeys = new Set()
    peerIndex = new Map()
  }

  return { step, current, reset }
}
