// doc-governance — composable policy registration for dynamic rule composition.
//
// A DocPolicy bundles predicates and handlers governing a region of the
// document space. The DocGovernance composes all registered policies
// into unified predicates using three-valued logic.
//
// Architecture: Functional Core / Imperative Shell
// - `composeRule` is the pure functional core — a single function
//   that evaluates three-valued predicate composition.
// - `DocGovernance` is the imperative shell — manages the mutable
//   policy list and delegates composition to the pure function.
//
// The `onEpochBoundary` predicate governs compaction-induced resets:
// when a peer receives an entirety payload for a document it already
// has local state for, the epoch boundary policy decides whether to
// accept (reset) or reject (diverge). Strategy-aware defaults apply
// when no policy provides an opinion.

import type { MergeStrategy } from "@kyneta/schema"
import type { DocId, PeerIdentityDetails } from "@kyneta/transport"
import type {
  Disposition,
  OnDocCreated,
  OnDocDismissed,
  OnUnresolvedDoc,
} from "./exchange.js"

// ---------------------------------------------------------------------------
// Epoch boundary predicate
// ---------------------------------------------------------------------------

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
 * - `undefined` — no opinion (defer to other policies or strategy-aware default)
 */
export type EpochBoundaryPredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean | undefined

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
export type RulePredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean | undefined

/**
 * A DocPolicy is a bundle of predicates and handlers governing a region
 * of the document space. All fields are optional — a policy only
 * provides the predicates it cares about.
 *
 * The `onUnresolvedDoc`, `onDocCreated`, and `onDocDismissed` fields
 * reuse the existing types from `exchange.ts` — no wrapper types needed.
 */
export interface DocPolicy {
  /** Optional name for debuggability, introspection, and replacement. */
  name?: string
  route?: RulePredicate
  authorize?: RulePredicate
  onEpochBoundary?: EpochBoundaryPredicate
  onUnresolvedDoc?: (
    ...args: Parameters<OnUnresolvedDoc>
  ) => Disposition | undefined
  onDocCreated?: OnDocCreated
  onDocDismissed?: OnDocDismissed
  dispose?: () => void
}

// ---------------------------------------------------------------------------
// Functional Core — pure three-valued predicate composition
// ---------------------------------------------------------------------------

/**
 * Compose multiple policies' predicates using three-valued logic.
 *
 * This is the pure functional core of the composition engine,
 * parameterized by the default value when all policies return `undefined`.
 *
 * Logic (with short-circuit):
 * 1. If any policy returns `false` → return `false` immediately.
 * 2. If at least one policy returns `true` and none return `false` → `true`.
 * 3. If all policies return `undefined` → `defaultWhenAllUndefined`.
 */
export function composeRule(
  policies: readonly DocPolicy[],
  field: "route" | "authorize",
  docId: DocId,
  peer: PeerIdentityDetails,
  defaultWhenAllUndefined: boolean,
): boolean {
  let anyTrue = false
  for (const policy of policies) {
    const predicate = policy[field]
    if (!predicate) continue
    const result = predicate(docId, peer)
    if (result === false) return false
    if (result === true) anyTrue = true
    // undefined → skip
  }
  return anyTrue ? true : defaultWhenAllUndefined
}

// ---------------------------------------------------------------------------
// Imperative Shell — mutable policy registry
// ---------------------------------------------------------------------------

/**
 * The DocGovernance manages the mutable policy list and delegates
 * composition to the pure `composeRule` function.
 *
 * Internal storage: an ordered array of DocPolicy entries (preserves
 * registration order for `onUnresolvedDoc` evaluation). A parallel
 * Map indexes named policies for O(1) replacement lookup.
 */
export class DocGovernance {
  readonly #policies: DocPolicy[] = []
  readonly #namedPolicies = new Map<string, DocPolicy>()
  readonly #disposers = new Map<DocPolicy, () => void>()

  /**
   * Register a policy. Returns a dispose function that removes the
   * policy from all compositions.
   *
   * If the policy has a `name` matching an already-registered policy,
   * the existing policy is replaced in-place (preserving its position
   * in the evaluation order).
   */
  register(policy: DocPolicy): () => void {
    if (policy.name != null) {
      const existing = this.#namedPolicies.get(policy.name)
      if (existing) {
        const idx = this.#policies.indexOf(existing)
        if (idx !== -1) this.#policies[idx] = policy  // replace in-place
        this.#namedPolicies.set(policy.name, policy)    // point name to new policy
        this.#disposers.get(existing)?.()           // dispose old (no-op removal, fires callback)
        return this.#createDispose(policy)
      }
      this.#namedPolicies.set(policy.name, policy)
    }

    this.#policies.push(policy)
    return this.#createDispose(policy)
  }

  #createDispose(policy: DocPolicy): () => void {
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
   * Composed route predicate. Defaults to open (`true`) when all
   * policies return `undefined`.
   */
  route(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeRule(this.#policies, "route", docId, peer, true)
  }

  /**
   * Composed authorize predicate. Defaults to open (`true`) when all
   * policies return `undefined`, matching the current Exchange default
   * of `authorize: () => true`.
   */
  authorize(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeRule(this.#policies, "authorize", docId, peer, true)
  }

  /**
   * Composed epoch boundary predicate.
   *
   * Uses three-valued composition: any policy returning `false` vetoes
   * the reset. If no policy has an opinion, falls back to strategy-aware
   * defaults:
   * - `"authoritative"` → accept (followers don't write)
   * - `"ephemeral"` → accept (no history semantics)
   * - `"collaborative"` → accept by default (developer can override via policy)
   */
  epochBoundary(
    docId: DocId,
    peer: PeerIdentityDetails,
    strategy: MergeStrategy,
  ): boolean {
    // Evaluate policies using the same three-valued logic as route/authorize.
    // The onEpochBoundary field uses the same (docId, peer) → boolean|undefined
    // signature, so we reuse composeRule with a dynamic default.
    let anyTrue = false
    for (const policy of this.#policies) {
      const predicate = policy.onEpochBoundary
      if (!predicate) continue
      const result = predicate(docId, peer)
      if (result === false) return false
      if (result === true) anyTrue = true
    }
    if (anyTrue) return true

    // Strategy-aware defaults when all policies return undefined.
    switch (strategy) {
      case "authoritative":
        return true // Followers don't write — reset is always safe.
      case "ephemeral":
        return true // No history semantics — reset is always safe.
      case "collaborative":
        return true // Accept by default; developer overrides via policy.
    }
  }

  /**
   * Composed onUnresolvedDoc — evaluate policies in registration order.
   * First non-`undefined` disposition wins. If all return `undefined`,
   * the result is `undefined`.
   */
  onUnresolvedDoc(
    docId: DocId,
    peer: PeerIdentityDetails,
    replicaType: Parameters<OnUnresolvedDoc>[2],
    mergeStrategy: Parameters<OnUnresolvedDoc>[3],
    schemaHash: string,
  ): Disposition | undefined {
    for (const policy of this.#policies) {
      if (!policy.onUnresolvedDoc) continue
      const result = policy.onUnresolvedDoc(
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
   * Composed onDocCreated — invoke all policies that have a handler.
   * Unlike predicates, creation is a notification, not a gate.
   */
  docCreated(
    docId: DocId,
    peer: PeerIdentityDetails,
    mode: "interpret" | "replicate",
    origin: "local" | "remote",
  ): void {
    for (const policy of this.#policies) {
      if (!policy.onDocCreated) continue
      policy.onDocCreated(docId, peer, mode, origin)
    }
  }

  /**
   * Composed onDocDismissed — invoke all policies that have a handler.
   * Unlike predicates, dismiss is a notification, not a gate.
   */
  docDismissed(
    docId: DocId,
    peer: PeerIdentityDetails,
    origin: "local" | "remote",
  ): void {
    for (const policy of this.#policies) {
      if (!policy.onDocDismissed) continue
      policy.onDocDismissed(docId, peer, origin)
    }
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
      try { dispose() } catch (e) { errors.push(e) }
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