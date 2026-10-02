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

import { type ReplicaType, type SyncMode, WriteRefusal } from "@kyneta/schema"
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
export type LineageBoundaryPredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean | undefined

/**
 * Who is authoritative for a document — i.e. whose answer settles the question
 * "does this document already have data?".
 *
 * This is a property of the deployment topology, not of any one document, so
 * it is normally declared once per process on a {@link Policy} rather than
 * passed at every call site.
 *
 * - `"self"` — this peer is the authority. Its own storage is the last word,
 *   so it never waits for anyone else. This is what a server declares.
 * - `"any"` — the first peer to answer is good enough. Correct in hub-and-spoke,
 *   the dominant topology, because a client links only to the server.
 * - a predicate — a peer it matches is the authority. Identify it by
 *   `principal`, as in `p => p.principal === "my-server"`, rather than by
 *   `type`: a server is a `"service"`, but so is any other service peer on
 *   the network, including a devtools inspector. Not by `peerId` either: a
 *   server without a store is a new seat on every restart, and several
 *   server processes over one store hold different seats.
 */
export type Authority =
  | "self"
  | "any"
  | ((peer: PeerIdentityDetails) => boolean)

/**
 * A bundle of gate predicates and handlers governing a region of the
 * document and connection space. Every field is optional: a policy provides
 * only the gates it cares about. `Governance` composes the gates of every
 * registered policy, and reads them at each use, so a policy registered or
 * disposed later takes effect.
 */
export interface Policy {
  /** Optional name for debuggability, introspection, and replacement. */
  name?: string
  canShare?: GatePredicate
  canAccept?: GatePredicate
  /**
   * May `peer` author operations in `docId`? Judged against this peer's own
   * identity for local writes, and against the sender of every offer.
   */
  canWrite?: GatePredicate
  canReset?: LineageBoundaryPredicate
  cohort?: GatePredicate
  canConnect?: (peer: PeerIdentityDetails) => boolean | undefined
  /**
   * Who this peer treats as authoritative. See {@link Authority}.
   *
   * Resolved first-non-`undefined` in registration order, like `resolve` —
   * this is a value to look up, not a boolean gate to compose.
   */
  authority?: Authority
  resolve?: (
    docId: DocId,
    peer: PeerIdentityDetails,
    replicaType: ReplicaType,
    syncMode: SyncMode,
    schemaHash: string,
  ) => Disposition | undefined
  dispose?: () => void
}

/**
 * The composed `canWrite` rejects this peer's own identity for `docId`, so
 * the document refuses its authored writes, and its native handle.
 */
export class NotAWriterError extends WriteRefusal {
  override readonly name = "NotAWriterError"

  constructor(
    readonly docId: DocId,
    /** The identity `canWrite` judged: this peer's own. */
    readonly peer: PeerIdentityDetails,
  ) {
    super(
      `Policy: peer ${peer.peerId} (principal "${peer.principal}") ` +
        `may not write document '${docId}'`,
    )
  }
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
  /** Each policy's removal, which reports whether it removed anything and
   *  notifies no one. */
  readonly #removals = new Map<Policy, () => boolean>()
  readonly #listeners = new Set<() => void>()

  /**
   * Register a policy. Returns a dispose function that removes the
   * policy from all compositions.
   *
   * If the policy has a `name` matching an already-registered policy,
   * the existing policy is replaced in-place (preserving its position
   * in the evaluation order).
   */
  register(policy: Policy): () => void {
    const existing =
      policy.name != null ? this.#namedPolicies.get(policy.name) : undefined
    if (existing !== undefined) {
      const idx = this.#policies.indexOf(existing)
      if (idx !== -1) this.#policies[idx] = policy // replace in-place
    } else {
      this.#policies.push(policy)
    }
    if (policy.name != null) this.#namedPolicies.set(policy.name, policy)
    const dispose = this.#createDispose(policy)
    // The old policy is no longer in the list: its removal only marks it
    // disposed and runs its `dispose` callback.
    if (existing !== undefined) this.#removals.get(existing)?.()
    this.#changed()
    return dispose
  }

  #createDispose(policy: Policy): () => void {
    let disposed = false
    const remove = (): boolean => {
      if (disposed) return false
      disposed = true
      const idx = this.#policies.indexOf(policy)
      if (idx !== -1) this.#policies.splice(idx, 1)
      if (policy.name != null) {
        if (this.#namedPolicies.get(policy.name) === policy) {
          this.#namedPolicies.delete(policy.name)
        }
      }
      this.#removals.delete(policy)
      policy.dispose?.()
      return true
    }
    this.#removals.set(policy, remove)
    return () => {
      if (remove()) this.#changed()
    }
  }

  /**
   * Hear every change of the policy list: after a `register` (a named
   * replacement included), after a policy's disposal, and after `clear`,
   * once each. A disposer that already ran changes nothing and notifies no
   * one. Returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener()
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
   * Composed write gate: may `peer` author operations in `docId`? Defaults
   * to open (`true`) when all policies return `undefined`.
   */
  canWrite(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeGate(
      this.#policies.map(p => p.canWrite?.(docId, peer)),
      true,
    )
  }

  /**
   * Composed lineage boundary (reset) gate.
   *
   * Uses three-valued composition: any policy returning `false` vetoes
   * the reset. If no policy has an opinion, defaults to `true` (all
   * sync protocols currently accept by default).
   */
  canReset(
    docId: DocId,
    peer: PeerIdentityDetails,
    _syncMode: SyncMode,
  ): boolean {
    return composeGate(
      this.#policies.map(p => p.canReset?.(docId, peer)),
      true,
    )
  }

  /**
   * Composed cohort gate. Defaults to open (`true`) when all
   * policies return `undefined`.
   */
  cohort(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeGate(
      this.#policies.map(p => p.cohort?.(docId, peer)),
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
   * The declared authority, or `undefined` if no policy declares one.
   *
   * First non-`undefined` in registration order wins — the same rule as
   * `resolve`, because this looks up a value rather than composing a gate.
   * Callers apply their own default when nothing is declared.
   */
  authority(): Authority | undefined {
    for (const policy of this.#policies) {
      if (policy.authority !== undefined) return policy.authority
    }
    return undefined
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
    syncMode: SyncMode,
    schemaHash: string,
  ): Disposition | undefined {
    for (const policy of this.#policies) {
      if (!policy.resolve) continue
      const result = policy.resolve(
        docId,
        peer,
        replicaType,
        syncMode,
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
    const snapshot = [...this.#removals.values()]
    this.#policies.length = 0
    this.#namedPolicies.clear()
    this.#removals.clear()
    const errors: unknown[] = []
    for (const remove of snapshot) {
      try {
        remove()
      } catch (e) {
        errors.push(e)
      }
    }
    this.#changed()
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
