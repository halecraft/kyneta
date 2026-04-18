// governance — composable policy registration for gate-based composition.
//
// A Policy bundles predicates governing a region of the document and
// connection space. The Governance class composes all registered policies
// into unified boolean gates using three-valued logic.
//
// Architecture: Functional Core / Imperative Shell
// - `composeGate` is the pure functional core — a single function
//   that evaluates three-valued predicate composition over an iterable
//   of results.
// - `Governance` is the imperative shell — manages the mutable
//   policy list and delegates composition to the pure function.
//
// Gate semantics (three-valued logic):
// - `false` from any policy vetoes the operation (short-circuit deny).
// - `true` from at least one policy (with no vetoes) permits it.
// - When every policy returns `undefined`, the gate falls back to
//   a caller-supplied default.

import type { MergeStrategy, ReplicaType } from "@kyneta/schema"
import type { DocId, PeerIdentityDetails } from "@kyneta/transport"
import type { Disposition } from "./exchange.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Three-valued predicate: true (allow), false (deny), undefined (no opinion).
 *
 * Evaluation semantics:
 * - `true`  — this policy explicitly allows the operation
 * - `false` — this policy explicitly denies the operation (short-circuits)
 * - `undefined` — this policy has no opinion (the doc is outside its concern)
 */
export type GatePredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean | undefined

/**
 * Predicate for compaction-induced entirety resets.
 *
 * Fires when the synchronizer receives an entirety payload for a document
 * that already has local state (i.e., local version is not zero). This
 * happens after a remote peer has called `advance()` to trim history
 * past our known version.
 *
 * Returns:
 * - `true` — accept the reset (discard local state, adopt the entirety)
 * - `false` — reject the reset (keep local state, diverge from compacted peers)
 * - `undefined` — no opinion (defer to other policies or default)
 *
 * Used internally by `Policy.canReset`.
 */
export type EpochBoundaryPredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean | undefined

/**
 * A Policy is a bundle of gate predicates and handlers governing a
 * region of the document and connection space. All fields are optional
 * — a policy only provides the gates it cares about.
 */
export interface Policy {
  /** Optional name for debuggability, introspection, and replacement. */
  name?: string
  canShare?: GatePredicate
  canAccept?: GatePredicate
  canReset?: EpochBoundaryPredicate
  canConnect?: (peer: PeerIdentityDetails) => boolean | undefined
  resolve?: (
    docId: DocId,
    peer: PeerIdentityDetails,
    replicaType: ReplicaType,
    mergeStrategy: MergeStrategy,
    schemaHash: string,
  ) => Disposition | undefined
  dispose?: () => void
}

// ---------------------------------------------------------------------------
// Functional Core — pure three-valued gate composition
// ---------------------------------------------------------------------------

/**
 * Compose an iterable of three-valued results into a single boolean.
 *
 * This is the pure functional core of the composition engine,
 * parameterized by the default value when all results are `undefined`.
 *
 * Logic (with short-circuit):
 * 1. If any result is `false` → return `false` immediately.
 * 2. If at least one result is `true` and none are `false` → `true`.
 * 3. If all results are `undefined` → `defaultWhenAllUndefined`.
 */
export function composeGate(
  results: Iterable<boolean | undefined>,
  defaultWhenAllUndefined: boolean,
): boolean {
  let anyTrue = false
  for (const result of results) {
    if (result === false) return false
    if (result === true) anyTrue = true
  }
  return anyTrue ? true : defaultWhenAllUndefined
}

// ---------------------------------------------------------------------------
// Imperative Shell — mutable policy registry
// ---------------------------------------------------------------------------

/**
 * The Governance manages the mutable policy list and delegates
 * composition to the pure `composeGate` function.
 *
 * Internal storage: an ordered array of Policy entries (preserves
 * registration order for `resolve` evaluation). A parallel Map
 * indexes named policies for O(1) replacement lookup.
 */
export class Governance {
  readonly #policies: Policy[] = []
  readonly #namedPolicies = new Map<string, Policy>()
  readonly #disposers = new Map<Policy, () => void>()

  /**
   * Register a policy. Returns a dispose function that removes the
   * policy from all compositions.
   *
   * If the policy has a `name` matching an already-registered policy,
   * the existing policy is replaced in-place (preserving its position
   * in the evaluation order).
   */
  register(policy: Policy): () => void {
    if (policy.name != null) {
      const existing = this.#namedPolicies.get(policy.name)
      if (existing) {
        const idx = this.#policies.indexOf(existing)
        if (idx !== -1) this.#policies[idx] = policy // replace in-place
        this.#namedPolicies.set(policy.name, policy) // point name to new policy
        this.#disposers.get(existing)?.() // dispose old (no-op removal, fires callback)
        return this.#createDispose(policy)
      }
      this.#namedPolicies.set(policy.name, policy)
    }

    this.#policies.push(policy)
    return this.#createDispose(policy)
  }

  #createDispose(policy: Policy): () => void {
    let disposed = false
    const fn = () => {
      if (disposed) return
      disposed = true
      const idx = this.#policies.indexOf(policy)
      if (idx !== -1) this.#policies.splice(idx, 1)
      if (policy.name != null) {
        if (this.#namedPolicies.get(policy.name) === policy) {
          this.#namedPolicies.delete(policy.name)
        }
      }
      this.#disposers.delete(policy)
      policy.dispose?.()
    }
    this.#disposers.set(policy, fn)
    return fn
  }

  /**
   * Composed sharing gate. Defaults to open (`true`) when all
   * policies return `undefined`.
   */
  canShare(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeGate(
      this.#policies.map(p => p.canShare?.(docId, peer)),
      true,
    )
  }

  /**
   * Composed acceptance gate. Defaults to open (`true`) when all
   * policies return `undefined`.
   */
  canAccept(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeGate(
      this.#policies.map(p => p.canAccept?.(docId, peer)),
      true,
    )
  }

  /**
   * Composed epoch boundary (reset) gate.
   *
   * Uses three-valued composition: any policy returning `false` vetoes
   * the reset. If no policy has an opinion, defaults to `true` (all
   * strategies currently accept by default).
   */
  canReset(
    docId: DocId,
    peer: PeerIdentityDetails,
    _strategy: MergeStrategy,
  ): boolean {
    return composeGate(
      this.#policies.map(p => p.canReset?.(docId, peer)),
      true,
    )
  }

  /**
   * Composed connection gate. Defaults to open (`true`) when all
   * policies return `undefined`.
   */
  canConnect(peer: PeerIdentityDetails): boolean {
    return composeGate(
      this.#policies.map(p => p.canConnect?.(peer)),
      true,
    )
  }

  /**
   * Composed resolve — evaluate policies in registration order.
   * First non-`undefined` disposition wins. If all return `undefined`,
   * the result is `undefined`.
   */
  resolve(
    docId: DocId,
    peer: PeerIdentityDetails,
    replicaType: ReplicaType,
    mergeStrategy: MergeStrategy,
    schemaHash: string,
  ): Disposition | undefined {
    for (const policy of this.#policies) {
      if (!policy.resolve) continue
      const result = policy.resolve(
        docId,
        peer,
        replicaType,
        mergeStrategy,
        schemaHash,
      )
      if (result !== undefined) return result
    }
    return undefined
  }

  /**
   * Remove all policies. Used during `exchange.reset()` and
   * `exchange.shutdown()`.
   *
   * Snapshot-then-clear: a disposer may re-enter, so we clear internal
   * state before invoking callbacks. Never throws — collects errors and
   * returns them for the caller to handle.
   */
  clear(): unknown[] {
    const snapshot = [...this.#disposers.values()]
    this.#policies.length = 0
    this.#namedPolicies.clear()
    this.#disposers.clear()
    const errors: unknown[] = []
    for (const dispose of snapshot) {
      try {
        dispose()
      } catch (e) {
        errors.push(e)
      }
    }
    return errors
  }

  /**
   * Returns the names of all named policies, in registration order.
   */
  get names(): readonly string[] {
    const result: string[] = []
    for (const policy of this.#policies) {
      if (policy.name != null) result.push(policy.name)
    }
    return result
  }
}
