/**
 * Subscription management for reactive refs.
 *
 * Provides functions for subscribing to reactive value changes and
 * managing subscription lifecycles within scopes.
 *
 * This module uses the [CHANGEFEED] symbol from @kyneta/schema to
 * subscribe to any reactive type that implements the changefeed
 * protocol (LocalRef, schema-interpreted refs, custom reactive types).
 *
 * @packageDocumentation
 */

import {
  CHANGEFEED,
  hasChangefeed,
  type ChangeBase,
  type Changeset,
  type HasChangefeed,
} from "@kyneta/schema"
import type { Scope } from "./scope.js"

/**
 * Subscription ID for tracking and cleanup.
 */
export type SubscriptionId = number

let subscriptionIdCounter = 0

/**
 * Reset the subscription ID counter (for testing).
 */
export function resetSubscriptionIdCounter(): void {
  subscriptionIdCounter = 0
}

/**
 * Active subscriptions map.
 *
 * **For testing only.** Production code should use
 * `getActiveSubscriptions()` which returns a read-only view.
 * Tests need the mutable map for `.clear()` in `beforeEach`.
 */
export const activeSubscriptions = new Map<
  SubscriptionId,
  { ref: unknown; unsubscribe: () => void }
>()

/**
 * Get a read-only view of the active subscriptions map.
 *
 * Use this in production code instead of the raw `activeSubscriptions`
 * map. The returned `ReadonlyMap` prevents accidental mutation.
 */
export function getActiveSubscriptions(): ReadonlyMap<
  SubscriptionId,
  { ref: unknown; unsubscribe: () => void }
> {
  return activeSubscriptions
}

/**
 * Get the count of active subscriptions.
 */
export function getActiveSubscriptionCount(): number {
  return activeSubscriptions.size
}

/**
 * Subscribe to a reactive ref's changes.
 *
 * This function is called by compiled code.
 * It subscribes via the [CHANGEFEED] symbol and registers
 * cleanup with the provided scope.
 *
 * Works with any type that implements the HasChangefeed interface:
 * - LocalRef from @kyneta/core
 * - Schema-interpreted refs from @kyneta/schema
 * - Custom reactive types with [CHANGEFEED]
 *
 * @param ref - A reactive value (must have [CHANGEFEED] property)
 * @param handler - Called when the ref changes, with a change describing what happened
 * @param scope - The scope that owns this subscription
 * @returns Subscription ID for manual unsubscription (rarely needed)
 */
export function subscribe(
  ref: unknown,
  handler: (change: ChangeBase, origin?: string) => void,
  scope: Scope,
): SubscriptionId {
  const id = ++subscriptionIdCounter

  // Validate that ref has a changefeed
  if (!hasChangefeed(ref)) {
    throw new Error(
      "subscribe called with non-reactive value. " +
        "Expected a value with [CHANGEFEED] property.",
    )
  }

  // Subscribe via the [CHANGEFEED] symbol.
  // The changefeed protocol delivers Changeset batches; unwrap them
  // so callers receive individual ChangeBase objects.
  const unsubscribeFn = ref[CHANGEFEED].subscribe((changeset: Changeset) => {
    for (const change of changeset.changes) {
      handler(change, changeset.origin)
    }
  })

  // Track the subscription
  activeSubscriptions.set(id, { ref, unsubscribe: unsubscribeFn })

  // Register cleanup with the scope
  scope.onDispose(() => {
    unsubscribe(id)
  })

  return id
}

/**
 * Unsubscribe from a reactive ref.
 *
 * Usually not called directly - scopes handle cleanup automatically.
 * Use this only for manual subscription management.
 *
 * @param id - The subscription ID returned by subscribe
 * @returns true if the subscription was found and removed
 */
export function unsubscribe(id: SubscriptionId): boolean {
  const subscription = activeSubscriptions.get(id)
  if (!subscription) {
    return false
  }

  subscription.unsubscribe()
  activeSubscriptions.delete(id)
  return true
}

// =============================================================================
// Universal Read Helper
// =============================================================================

/**
 * Read the current value from a Changefeed ref.
 *
 * This is the observation morphism of the coalgebra — it extracts the
 * current state (head) from a Changefeed. Generated code calls this
 * instead of embedding `ref[CHANGEFEED].current` directly, which would
 * require importing the `CHANGEFEED` symbol into every compiled component.
 *
 * @param ref - A reactive value (must have [CHANGEFEED] property)
 * @returns The current value of the ref
 *
 * @example
 * ```typescript
 * const title: TextRef = doc.title
 * read(title) // → "Hello World"
 * ```
 */
export function read<T = unknown>(ref: HasChangefeed<T>): T {
  return ref[CHANGEFEED].current
}

// =============================================================================
// Value Region — Unified Fallback Region
// =============================================================================

/**
 * Wire one or more Changefeed refs to a DOM target via re-read semantics.
 *
 * This is the terminal object in the delta region algebra — a region whose
 * delta dispatch strategy is always "replace." It re-reads via `getValue()`
 * and applies via `onValue()` on every change from any ref.
 *
 * Follows the same three-phase pattern as `textRegion` and `listRegion`:
 * 1. **Initial render** — `onValue(getValue())`
 * 2. **Subscribe** — `subscribe(ref, ..., scope)` for each ref
 * 3. **Delta dispatch** — always re-evaluate: `onValue(getValue())`
 *
 * Unifies the previous `subscribeWithValue` (single ref) and
 * `subscribeMultiple` + manual init (multiple refs) into one function.
 *
 * @param refs - Array of reactive values to subscribe to
 * @param getValue - Closure evaluating the user's expression
 * @param onValue - Applies the value to the DOM target
 * @param scope - The scope that owns these subscriptions
 *
 * @example
 * ```typescript
 * // Single ref — counter display
 * valueRegion([doc.count], () => read(doc.count), (v) => {
 *   textNode.textContent = String(v)
 * }, scope)
 *
 * // Multiple refs — derived expression
 * valueRegion([doc.firstName, doc.lastName], () => `${read(doc.firstName)} ${read(doc.lastName)}`, (v) => {
 *   textNode.textContent = v
 * }, scope)
 * ```
 */
export function valueRegion<T>(
  refs: unknown[],
  getValue: () => T,
  onValue: (value: T) => void,
  scope: Scope,
): void {
  // Phase 1: Initial render
  onValue(getValue())

  // Phase 2: Subscribe to all refs
  for (const ref of refs) {
    subscribe(
      ref,
      (_change: ChangeBase) => {
        // Phase 3: Delta dispatch — always re-read
        onValue(getValue())
      },
      scope,
    )
  }
}

// =============================================================================
// Legacy Subscription Helpers (Deprecated)
// =============================================================================

/**
 * Subscribe to a reactive ref and call handler immediately with current value.
 *
 * @deprecated Use {@link valueRegion} instead.
 * `subscribeWithValue(ref, gv, ov, scope)` → `valueRegion([ref], gv, ov, scope)`
 *
 * This is useful for reactive expressions where you want to:
 * 1. Set the initial value
 * 2. Update on changes
 *
 * The change is ignored — this function always re-reads the value via getValue().
 * This is the fallback for expressions where delta-based patching isn't possible.
 *
 * Note: `getValue` is a caller-provided closure that evaluates the *user's
 * expression* (e.g. `() => doc.count.get().toString()`), not just the raw
 * ref value. `CHANGEFEED.current` returns the ref's own value, but codegen
 * expressions may transform it. The `getValue` closure serves a different
 * purpose than `.current`.
 *
 * @param ref - A reactive value
 * @param getValue - Function to get the current value from the ref
 * @param onValue - Called with the value (initial and on changes)
 * @param scope - The scope that owns this subscription
 * @returns Subscription ID
 */
export function subscribeWithValue<T>(
  ref: unknown,
  getValue: () => T,
  onValue: (value: T) => void,
  scope: Scope,
): SubscriptionId {
  // Call immediately with current value
  onValue(getValue())

  // Subscribe to changes — ignore the change and re-read the value
  return subscribe(
    ref,
    (_change: ChangeBase) => {
      onValue(getValue())
    },
    scope,
  )
}

/**
 * Subscribe to multiple refs and call handler when any changes.
 *
 * @deprecated Use {@link valueRegion} instead.
 * `subscribeMultiple(refs, handler, scope)` → `valueRegion(refs, getValue, onValue, scope)`
 *
 * @param refs - Array of reactive values
 * @param handler - Called when any ref changes
 * @param scope - The scope that owns these subscriptions
 * @returns Array of subscription IDs
 */
export function subscribeMultiple(
  refs: unknown[],
  handler: () => void,
  scope: Scope,
): SubscriptionId[] {
  // Wrap the void handler to accept and ignore the change
  const wrappedHandler = (_change: ChangeBase) => handler()
  return refs.map(ref => subscribe(ref, wrappedHandler, scope))
}