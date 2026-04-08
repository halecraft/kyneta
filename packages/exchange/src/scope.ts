// scope — composable scope registration for dynamic rule composition.
//
// A Scope bundles predicates and handlers governing a region of the
// document space. The ScopeRegistry composes all registered scopes
// into unified predicates using three-valued logic.
//
// Architecture: Functional Core / Imperative Shell
// - `composeRule` is the pure functional core — a single function
//   that evaluates three-valued predicate composition.
// - `ScopeRegistry` is the imperative shell — manages the mutable
//   scope list and delegates composition to the pure function.
//
// The `onEpochBoundary` predicate governs compaction-induced resets:
// when a peer receives an entirety payload for a document it already
// has local state for, the epoch boundary policy decides whether to
// accept (reset) or reject (diverge). Strategy-aware defaults apply
// when no scope provides an opinion.

import type { DocId, PeerIdentityDetails } from "@kyneta/transport"
import type { MergeStrategy } from "@kyneta/schema"
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
 * - `undefined` — no opinion (defer to other scopes or strategy-aware default)
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
 * - `true`  — this scope explicitly allows the operation
 * - `false` — this scope explicitly denies the operation (short-circuits)
 * - `undefined` — this scope has no opinion (the doc is outside its concern)
 */
export type RulePredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean | undefined

/**
 * A Scope is a bundle of predicates and handlers governing a region
 * of the document space. All fields are optional — a scope only
 * provides the predicates it cares about.
 *
 * The `onUnresolvedDoc`, `onDocCreated`, and `onDocDismissed` fields
 * reuse the existing types from `exchange.ts` — no wrapper types needed.
 */
export interface Scope {
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
}

// ---------------------------------------------------------------------------
// Functional Core — pure three-valued predicate composition
// ---------------------------------------------------------------------------

/**
 * Compose multiple scopes' predicates using three-valued logic.
 *
 * This is the pure functional core of the composition engine,
 * parameterized by the default value when all scopes return `undefined`.
 *
 * Logic (with short-circuit):
 * 1. If any scope returns `false` → return `false` immediately.
 * 2. If at least one scope returns `true` and none return `false` → `true`.
 * 3. If all scopes return `undefined` → `defaultWhenAllUndefined`.
 */
export function composeRule(
  scopes: readonly Scope[],
  field: "route" | "authorize",
  docId: DocId,
  peer: PeerIdentityDetails,
  defaultWhenAllUndefined: boolean,
): boolean {
  let anyTrue = false
  for (const scope of scopes) {
    const predicate = scope[field]
    if (!predicate) continue
    const result = predicate(docId, peer)
    if (result === false) return false
    if (result === true) anyTrue = true
    // undefined → skip
  }
  return anyTrue ? true : defaultWhenAllUndefined
}

// ---------------------------------------------------------------------------
// Imperative Shell — mutable scope registry
// ---------------------------------------------------------------------------

/**
 * The ScopeRegistry manages the mutable scope list and delegates
 * composition to the pure `composeRule` function.
 *
 * Internal storage: an ordered array of Scope entries (preserves
 * registration order for `onUnresolvedDoc` evaluation). A parallel
 * Map indexes named scopes for O(1) replacement lookup.
 */
export class ScopeRegistry {
  readonly #scopes: Scope[] = []
  readonly #namedScopes = new Map<string, Scope>()

  /**
   * Register a scope. Returns a dispose function that removes the
   * scope from all compositions.
   *
   * If the scope has a `name` matching an already-registered scope,
   * the existing scope is replaced in-place (preserving its position
   * in the evaluation order).
   */
  register(scope: Scope): () => void {
    if (scope.name != null) {
      const existing = this.#namedScopes.get(scope.name)
      if (existing) {
        // Replace in-place — preserve evaluation order position
        const idx = this.#scopes.indexOf(existing)
        if (idx !== -1) {
          this.#scopes[idx] = scope
        }
        this.#namedScopes.set(scope.name, scope)
        return this.#createDispose(scope)
      }
      this.#namedScopes.set(scope.name, scope)
    }

    this.#scopes.push(scope)
    return this.#createDispose(scope)
  }

  #createDispose(scope: Scope): () => void {
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const idx = this.#scopes.indexOf(scope)
      if (idx !== -1) this.#scopes.splice(idx, 1)
      if (scope.name != null) {
        // Only delete from named map if this scope is still the registered one
        // (it may have been replaced by a newer scope with the same name)
        if (this.#namedScopes.get(scope.name) === scope) {
          this.#namedScopes.delete(scope.name)
        }
      }
    }
  }

  /**
   * Composed route predicate. Defaults to open (`true`) when all
   * scopes return `undefined`.
   */
  route(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeRule(this.#scopes, "route", docId, peer, true)
  }

  /**
   * Composed authorize predicate. Defaults to open (`true`) when all
   * scopes return `undefined`, matching the current Exchange default
   * of `authorize: () => true`.
   */
  authorize(docId: DocId, peer: PeerIdentityDetails): boolean {
    return composeRule(this.#scopes, "authorize", docId, peer, true)
  }

  /**
   * Composed epoch boundary predicate.
   *
   * Uses three-valued composition: any scope returning `false` vetoes
   * the reset. If no scope has an opinion, falls back to strategy-aware
   * defaults:
   * - `"authoritative"` → accept (followers don't write)
   * - `"ephemeral"` → accept (no history semantics)
   * - `"collaborative"` → accept by default (developer can override via scope)
   */
  epochBoundary(
    docId: DocId,
    peer: PeerIdentityDetails,
    strategy: MergeStrategy,
  ): boolean {
    // Evaluate scopes using the same three-valued logic as route/authorize.
    // The onEpochBoundary field uses the same (docId, peer) → boolean|undefined
    // signature, so we reuse composeRule with a dynamic default.
    let anyTrue = false
    for (const scope of this.#scopes) {
      const predicate = scope.onEpochBoundary
      if (!predicate) continue
      const result = predicate(docId, peer)
      if (result === false) return false
      if (result === true) anyTrue = true
    }
    if (anyTrue) return true

    // Strategy-aware defaults when all scopes return undefined.
    switch (strategy) {
      case "authoritative":
        return true // Followers don't write — reset is always safe.
      case "ephemeral":
        return true // No history semantics — reset is always safe.
      case "collaborative":
        return true // Accept by default; developer overrides via scope.
    }
  }

  /**
   * Composed onUnresolvedDoc — evaluate scopes in registration order.
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
    for (const scope of this.#scopes) {
      if (!scope.onUnresolvedDoc) continue
      const result = scope.onUnresolvedDoc(
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
   * Composed onDocCreated — invoke all scopes that have a handler.
   * Unlike predicates, creation is a notification, not a gate.
   */
  docCreated(
    docId: DocId,
    peer: PeerIdentityDetails,
    mode: "interpret" | "replicate",
    origin: "local" | "remote",
  ): void {
    for (const scope of this.#scopes) {
      if (!scope.onDocCreated) continue
      scope.onDocCreated(docId, peer, mode, origin)
    }
  }

  /**
   * Composed onDocDismissed — invoke all scopes that have a handler.
   * Unlike predicates, dismiss is a notification, not a gate.
   */
  docDismissed(docId: DocId, peer: PeerIdentityDetails): void {
    for (const scope of this.#scopes) {
      if (!scope.onDocDismissed) continue
      scope.onDocDismissed(docId, peer)
    }
  }

  /**
   * Remove all scopes. Used during `exchange.reset()` and
   * `exchange.shutdown()`.
   */
  clear(): void {
    this.#scopes.length = 0
    this.#namedScopes.clear()
  }

  /**
   * Returns the names of all named scopes, in registration order.
   */
  get names(): readonly string[] {
    const result: string[] = []
    for (const scope of this.#scopes) {
      if (scope.name != null) result.push(scope.name)
    }
    return result
  }
}
