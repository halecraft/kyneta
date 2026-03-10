/**
 * Subscription management for reactive refs.
 *
 * Provides functions for subscribing to reactive value changes and
 * managing subscription lifecycles within scopes.
 *
 * This module is Loro-agnostic — it uses the [REACTIVE] symbol from
 * @loro-extended/reactive to subscribe to any reactive type (LocalRef,
 * Loro refs, custom reactive types).
 *
 * @packageDocumentation
 */

import {
  isReactive,
  REACTIVE,
  type ReactiveDelta,
} from "@loro-extended/reactive"
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
 * It subscribes via the [REACTIVE] symbol and registers
 * cleanup with the provided scope.
 *
 * Works with any type that implements the Reactive interface:
 * - LocalRef from @loro-extended/reactive
 * - Loro typed refs (TextRef, ListRef, etc.) from @loro-extended/change
 * - Custom reactive types
 *
 * @param ref - A reactive value (must have [REACTIVE] property)
 * @param handler - Called when the ref changes, with a delta describing the change
 * @param scope - The scope that owns this subscription
 * @returns Subscription ID for manual unsubscription (rarely needed)
 */
export function subscribe(
  ref: unknown,
  handler: (delta: ReactiveDelta) => void,
  scope: Scope,
): SubscriptionId {
  const id = ++subscriptionIdCounter

  // Validate that ref is reactive
  if (!isReactive(ref)) {
    throw new Error(
      "subscribe called with non-reactive value. " +
        "Expected a value with [REACTIVE] property.",
    )
  }

  // Subscribe via the [REACTIVE] symbol
  // The ref's [REACTIVE] implementation handles translation to ReactiveDelta
  const unsubscribeFn = ref[REACTIVE](ref, handler)

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

/**
 * Subscribe to a reactive ref and call handler immediately with current value.
 *
 * This is useful for reactive expressions where you want to:
 * 1. Set the initial value
 * 2. Update on changes
 *
 * The delta is ignored — this function always re-reads the value via getValue().
 * This is the fallback for expressions where delta-based patching isn't possible.
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

  // Subscribe to changes — ignore the delta and re-read the value
  return subscribe(
    ref,
    (_delta: ReactiveDelta) => {
      onValue(getValue())
    },
    scope,
  )
}

/**
 * Subscribe to multiple refs and call handler when any changes.
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
  // Wrap the void handler to accept and ignore the delta
  const wrappedHandler = (_delta: ReactiveDelta) => handler()
  return refs.map(ref => subscribe(ref, wrappedHandler, scope))
}
