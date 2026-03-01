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
// Hydration API
// =============================================================================

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

// =============================================================================
// Runtime API (re-exported from /runtime subpath)
// =============================================================================

// Compiled code imports from @loro-extended/kinetic/runtime directly.
// These are re-exported here for convenience.
export {
  conditionalRegion,
  listRegion,
  subscribe,
  subscribeMultiple,
  subscribeWithValue,
  unsubscribe,
  type SubscriptionId,
} from "./runtime/index.js"

// =============================================================================
// Loro Bindings (re-exported from /loro subpath)
// =============================================================================

// bind() is the primary API for two-way bindings in user code.
// Re-exported here for convenience so users don't need to import from /loro.
export { bind, isBinding } from "./loro/index.js"

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
  state,
} from "@loro-extended/reactive"
