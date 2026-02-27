/**
 * Subscription management for Loro refs.
 *
 * Provides functions for subscribing to Loro container changes and
 * managing subscription lifecycles within scopes.
 *
 * @packageDocumentation
 */

import { loro } from "@loro-extended/change"
import type { Container, LoroDoc, LoroEventBatch } from "loro-crdt"
import type { Scope } from "./scope.js"

/**
 * A subscribable Loro object (container or doc).
 */
type Subscribable = Container | LoroDoc

/**
 * Subscription ID for tracking and cleanup.
 */
export type SubscriptionId = number

let subscriptionIdCounter = 0

/**
 * Reset the subscription ID counter (for testing).
 * @internal
 */
export function __resetSubscriptionIdCounter(): void {
  subscriptionIdCounter = 0
}

/**
 * Active subscriptions map for debugging and testing.
 * @internal
 */
export const __activeSubscriptions = new Map<
  SubscriptionId,
  { ref: unknown; unsubscribe: () => void }
>()

/**
 * Get the count of active subscriptions.
 * @internal - For testing
 */
export function __getActiveSubscriptionCount(): number {
  return __activeSubscriptions.size
}

/**
 * Subscribe to a Loro ref's changes.
 *
 * This is an internal function called by compiled code.
 * It subscribes to the underlying Loro container and registers
 * cleanup with the provided scope.
 *
 * @param ref - A typed ref (TextRef, ListRef, etc.) or the underlying Loro container
 * @param handler - Called when the ref changes
 * @param scope - The scope that owns this subscription
 * @returns Subscription ID for manual unsubscription (rarely needed)
 *
 * @internal - Called by compiled code
 */
export function __subscribe(
  ref: unknown,
  handler: (event: LoroEventBatch) => void,
  scope: Scope,
): SubscriptionId {
  const id = ++subscriptionIdCounter

  // Get the underlying Loro container
  // loro() handles both TypedRefs and raw Loro containers
  const container = loro(ref as Parameters<typeof loro>[0]) as Subscribable

  // Subscribe to the container
  const unsubscribe = container.subscribe(handler)

  // Track the subscription
  __activeSubscriptions.set(id, { ref, unsubscribe })

  // Register cleanup with the scope
  scope.onDispose(() => {
    __unsubscribe(id)
  })

  return id
}

/**
 * Unsubscribe from a Loro ref.
 *
 * Usually not called directly - scopes handle cleanup automatically.
 * Use this only for manual subscription management.
 *
 * @param id - The subscription ID returned by __subscribe
 * @returns true if the subscription was found and removed
 *
 * @internal
 */
export function __unsubscribe(id: SubscriptionId): boolean {
  const subscription = __activeSubscriptions.get(id)
  if (!subscription) {
    return false
  }

  subscription.unsubscribe()
  __activeSubscriptions.delete(id)
  return true
}

/**
 * Subscribe to a Loro ref and call handler immediately with current value.
 *
 * This is useful for reactive expressions where you want to:
 * 1. Set the initial value
 * 2. Update on changes
 *
 * @param ref - A typed ref
 * @param getValue - Function to get the current value from the ref
 * @param onValue - Called with the value (initial and on changes)
 * @param scope - The scope that owns this subscription
 * @returns Subscription ID
 *
 * @internal - Called by compiled code
 */
export function __subscribeWithValue<T>(
  ref: unknown,
  getValue: () => T,
  onValue: (value: T) => void,
  scope: Scope,
): SubscriptionId {
  // Call immediately with current value
  onValue(getValue())

  // Subscribe to changes
  return __subscribe(
    ref,
    () => {
      onValue(getValue())
    },
    scope,
  )
}

/**
 * Subscribe to multiple refs and call handler when any changes.
 *
 * @param refs - Array of typed refs
 * @param handler - Called when any ref changes
 * @param scope - The scope that owns these subscriptions
 * @returns Array of subscription IDs
 *
 * @internal - Called by compiled code
 */
export function __subscribeMultiple(
  refs: unknown[],
  handler: () => void,
  scope: Scope,
): SubscriptionId[] {
  return refs.map(ref => __subscribe(ref, handler, scope))
}
