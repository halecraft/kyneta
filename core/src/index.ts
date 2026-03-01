/**
 * @loro-extended/kinetic
 *
 * A compiled delta-driven UI framework for Loro documents.
 *
 * Kinetic transforms natural TypeScript into code that directly consumes
 * Loro CRDT deltas for O(k) DOM updates, where k is the number of operations.
 *
 * @example
 * ```ts
 * import { div, h1, p, mount } from "@loro-extended/kinetic"
 *
 * // Write natural TypeScript with builder pattern
 * const app = div(() => {
 *   h1("My App")
 *
 *   if (doc.items.length === 0) {
 *     p("No items yet")
 *   }
 *
 *   for (const item of doc.items) {
 *     li(item.text)
 *   }
 * })
 *
 * // Mount to DOM
 * const { dispose } = mount(app, document.getElementById("root"))
 *
 * // Cleanup when done
 * dispose()
 * ```
 */

// =============================================================================
// Error types
// =============================================================================

export {
  BindingError,
  CompilerError,
  HydrationMismatchError,
  InvalidMountTargetError,
  KineticError,
  KineticErrorCode,
  ScopeDisposedError,
  type SourceLocation,
} from "./errors.js"

// =============================================================================
// Runtime
// =============================================================================

export { getRootScope, mount, rootScope } from "./runtime/mount.js"
export { Scope } from "./runtime/scope.js"

// =============================================================================
// Internal Runtime API (called by compiled code)
// =============================================================================

export {
  __bindChecked,
  __bindNumericValue,
  __bindTextValue,
  bind,
  isBinding,
} from "./runtime/binding.js"
export {
  adoptNode,
  adoptTextNode,
  type ConditionalHydrationHandler,
  createHydratableMount,
  type HydrateOptions,
  type HydrateResult,
  hydrate,
  hydrateConditionalRegion,
  hydrateListRegion,
  type ListHydrationHandler,
} from "./runtime/hydrate.js"
export { __conditionalRegion, __listRegion } from "./runtime/regions.js"
export {
  __subscribe,
  __subscribeMultiple,
  __subscribeWithValue,
  __unsubscribe,
  type SubscriptionId,
} from "./runtime/subscribe.js"

// =============================================================================
// Testing utilities
// =============================================================================

// Testing internals (for resetting state between tests)
export {
  __getActiveSubscriptionCount,
  __resetScopeIdCounter,
  __resetSubscriptionIdCounter,
} from "./runtime/index.js"
export {
  assertMaxMutations,
  assertOperationCount,
  type CountingContainerResult,
  createCountingContainer,
  createCounts,
  type DOMOperationCounts,
  getTotalMutations,
} from "./testing/counting-dom.js"

// =============================================================================
// Types
// =============================================================================

export type {
  Binding,
  Child,
  ConditionalRegionHandlers,
  Element,
  ListRegionHandlers,
  MountOptions,
  MountResult,
  Props,
  ScopeInterface,
} from "./types.js"

// =============================================================================
// Reactive Primitives (re-exported from @loro-extended/reactive)
// =============================================================================

export {
  isReactive,
  LocalRef,
  REACTIVE,
  type Reactive,
  type ReactiveSubscribe,
} from "@loro-extended/reactive"
