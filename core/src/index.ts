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
// Runtime (to be implemented in Phase 2)
// =============================================================================

// export { mount, dispose } from "./runtime/mount.js"
// export { bind } from "./runtime/binding.js"
// export { Scope } from "./runtime/scope.js"

// =============================================================================
// Element functions (to be implemented in Phase 2)
// =============================================================================

// HTML element functions will be exported here:
// export { div, span, p, h1, h2, h3, h4, h5, h6, ... } from "./runtime/elements.js"

// =============================================================================
// Types
// =============================================================================

export type { Binding, Child, Element, Props } from "./types.js"
