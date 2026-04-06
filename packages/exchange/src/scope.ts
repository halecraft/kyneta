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

import type { DocId, PeerIdentityDetails } from "@kyneta/transport"
import type {
  Disposition,
  OnDocDismissed,
  OnUnresolvedDoc,
} from "./exchange.js"

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
 * The `onUnresolvedDoc` and `onDocDismissed` fields reuse the existing
 * types from `exchange.ts` — no wrapper types needed.
 */
export interface Scope {
  /** Optional name for debuggability, introspection, and replacement. */
  name?: string
  route?: RulePredicate
  authorize?: RulePredicate
  onUnresolvedDoc?: (
    ...args: Parameters<OnUnresolvedDoc>
  ) => Disposition | undefined
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
