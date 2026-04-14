/**
 * Core type definitions for Kyneta.
 *
 * These types define the user-facing API that the TypeScript Language Server
 * understands without compilation.
 */

import type { HasChangefeed } from "@kyneta/changefeed"

// =============================================================================
// Element Types
// =============================================================================

/**
 * An Element is a scope-accepting factory that produces a DOM node.
 * Elements are lazy — they're not rendered until mounted.
 *
 * The compiler transforms builder calls like `div(() => { h1("Hello") })`
 * into `(scope) => { ... return _div0 }`. The `scope` parameter is
 * load-bearing: reactive subscriptions use it to register cleanup handlers
 * and manage lifecycle.
 *
 * `ScopeInterface` is used (rather than the concrete `Scope` class) to
 * keep this type file free of runtime imports.
 */
export type Element = (scope: ScopeInterface) => Node

/**
 * Props for HTML elements.
 * Supports both static values and reactive functions.
 */
export type Props = Record<string, unknown> & {
  /** CSS class name(s) - can be static or reactive */
  class?: string | (() => string)

  /** Inline styles - can be static or reactive */
  style?: string | Record<string, string | (() => string)>

  /** Element ID */
  id?: string

  // Common HTML attributes
  href?: string
  src?: string
  alt?: string
  title?: string
  placeholder?: string
  type?: string
  name?: string
  value?: string | (() => string)
  disabled?: boolean | (() => boolean)
  checked?: boolean | (() => boolean)
  readonly?: boolean

  // Data attributes
  [key: `data-${string}`]: string | number | boolean | undefined

  // Event handlers
  onClick?: (e: MouseEvent) => void
  onInput?: (e: InputEvent) => void
  onChange?: (e: Event) => void
  onSubmit?: (e: SubmitEvent) => void
  onKeyDown?: (e: KeyboardEvent) => void
  onKeyUp?: (e: KeyboardEvent) => void
  onKeyPress?: (e: KeyboardEvent) => void
  onFocus?: (e: FocusEvent) => void
  onBlur?: (e: FocusEvent) => void
  onMouseEnter?: (e: MouseEvent) => void
  onMouseLeave?: (e: MouseEvent) => void
  onMouseDown?: (e: MouseEvent) => void
  onMouseUp?: (e: MouseEvent) => void
  onMouseMove?: (e: MouseEvent) => void
  onTouchStart?: (e: TouchEvent) => void
  onTouchEnd?: (e: TouchEvent) => void
  onTouchMove?: (e: TouchEvent) => void
  onBeforeInput?: (e: InputEvent) => void
  onCompositionStart?: (e: CompositionEvent) => void
  onCompositionEnd?: (e: CompositionEvent) => void
  onScroll?: (e: Event) => void
  onLoad?: (e: Event) => void
  onError?: (e: Event) => void
}

/**
 * Valid children for elements.
 */
export type Child =
  | string
  | number
  | boolean
  | null
  | undefined
  | Element
  | HasChangefeed
  | Node

// =============================================================================
// Element Factory Types
// =============================================================================

/**
 * Builder function for declarative element construction.
 * Called with no arguments, creates children via side effects.
 */
export type Builder = () => void

// =============================================================================
// Component Types
// =============================================================================

/**
 * A component is a function that takes optional props + optional builder
 * and returns an Element.
 *
 * Components are user-defined functions that encapsulate UI logic.
 * The compiler recognizes functions typed as ComponentFactory and
 * treats their invocations as component instantiation rather than
 * regular function calls.
 *
 * Components create their own scope for subscriptions and receive
 * a child scope from their parent when instantiated.
 *
 * @example
 * ```ts
 * // Props + builder component
 * const Card: ComponentFactory<{ title: string }> = (props, builder) => {
 *   return div(() => {
 *     h2(props.title)
 *     builder?.()
 *   })
 * }
 *
 * // Usage
 * Card({ title: "Hello" }, () => {
 *   p("Card content")
 * })
 *
 * // Props-only component
 * const Avatar: ComponentFactory<{ src: string }> = (props) => {
 *   return img({ src: props.src, class: "avatar" })
 * }
 *
 * // Builder-only component
 * const Container: ComponentFactory = (builder) => {
 *   return div({ class: "container" }, builder)
 * }
 *
 * // No-args component
 * const Spacer: ComponentFactory = () => {
 *   return div({ class: "spacer" })
 * }
 * ```
 */
// biome-ignore lint/complexity/noBannedTypes: {} is intentional as the default empty-props type
export type ComponentFactory<P extends Record<string, unknown> = {}> =
  | ((props: P, builder: Builder) => Element)
  | ((props: P) => Element)
  | ((builder: Builder) => Element)
  | (() => Element)

/**
 * Element factory function signature.
 * Supports multiple calling patterns via overloads.
 *
 * @example
 * ```ts
 * // Builder pattern (enables control flow)
 * div(() => {
 *   h1("Title")
 *   if (condition) { p("Conditional") }
 * })
 *
 * // Props + builder
 * div({ class: "container" }, () => {
 *   h1("Title")
 * })
 *
 * // Props + children
 * div({ class: "container" }, "Hello", span("World"))
 *
 * // Children only
 * div("Hello", span("World"))
 * ```
 */
export interface ElementFactory {
  (builder: Builder): Element
  (props: Props, builder: Builder): Element
  (props: Props, ...children: Child[]): Element
  (...children: Child[]): Element
}

// =============================================================================
// Mount Types
// =============================================================================

/**
 * Options for mounting an element.
 */
export interface MountOptions {
  /**
   * If true, hydrate existing DOM content instead of replacing.
   * Used for SSR hydration.
   */
  hydrate?: boolean
}

/**
 * Result of mounting an element.
 */
export interface MountResult {
  /**
   * The root DOM node that was created/hydrated.
   */
  node: Node

  /**
   * Dispose all subscriptions and clean up the mounted element.
   * Call this when removing the element from the DOM.
   */
  dispose: () => void
}

// =============================================================================
// Slot Types
// =============================================================================

/**
 * Slot kind classification: how many DOM nodes a body produces.
 *
 * - **single**: Body produces exactly one DOM node (element or text)
 * - **range**: Body produces zero, multiple, or region nodes (requires markers)
 *
 * @internal
 */
export type SlotKind = "single" | "range"

// =============================================================================
// List Region Handlers
// =============================================================================

/**
 * Handlers for list region delta processing.
 * @internal
 */
export interface ListRegionHandlers<T> {
  /**
   * Called when an item is inserted.
   * Returns the DOM node to insert.
   *
   * The third parameter is the per-item scope. Reactive subscriptions
   * (valueRegion, textRegion, etc.) inside create should use this scope
   * so they are cleaned up when the item is deleted.
   */
  create: (
    item: T,
    index: number,
    scope: import("./runtime/scope.js").Scope,
  ) => Node

  /**
   * Called when an item's content needs updating (optional).
   * If not provided, items are assumed immutable.
   */
  update?: (item: T, index: number, node: Node) => void

  /**
   * Called when an item is moved (for MovableList).
   * If not provided, move is treated as delete + insert.
   */
  move?: (fromIndex: number, toIndex: number) => void

  /**
   * Optional slot kind hint from compile-time analysis.
   * When provided, optimizes insertion by avoiding runtime inspection.
   */
  slotKind?: SlotKind

  /**
   * Whether list items contain reactive content (subscriptions).
   * When false, item scopes are skipped — no `createChild()` per item.
   * Derived from `LoopNode.hasReactiveItems` at compile time.
   *
   * Defaults to true (conservative: always allocate scopes).
   */
  isReactive?: boolean
}

// =============================================================================
// Filtered List Region Handlers
// =============================================================================

/**
 * Handlers for filtered list region processing.
 *
 * Extends `ListRegionHandlers` with filter-specific metadata that enables
 * the runtime to separate external subscriptions (one shared, re-evaluates
 * all items) from item subscriptions (per-item, O(1) re-evaluation).
 *
 * @internal
 */
export interface FilteredListRegionHandlers<T> extends ListRegionHandlers<T> {
  /**
   * Evaluate the filter predicate for an item at a given index.
   * Returns true if the item should be visible (rendered), false if hidden.
   */
  predicate: (item: T, index: number) => boolean

  /**
   * External reactive refs (one shared subscription each).
   * When any external ref changes, the predicate is re-evaluated for ALL items.
   * These are deps like `filterText`, `veggieOnly` — not derived from the loop variable.
   */
  externalRefs: unknown[]

  /**
   * Per-item reactive ref accessor.
   * Given the item ref, returns the leaf refs to subscribe to for that item.
   * When any item ref changes, the predicate is re-evaluated for THAT item only.
   * These are deps like `recipe.name`, `recipe.vegetarian` — derived from the loop variable.
   */
  itemRefs: (item: T) => unknown[]
}

// =============================================================================
// List Region Operations (Functional Core)
// =============================================================================

/**
 * Operations that can be performed on a list region.
 * These are the output of pure planning functions and input to the imperative shell.
 *
 * @internal - Used by list region runtime
 */
export type ListRegionOp<T> =
  | { kind: "insert"; index: number; item: T }
  | { kind: "delete"; index: number }
  | { kind: "batch-insert"; index: number; count: number }
  | { kind: "batch-delete"; index: number; count: number }

/**
 * Operations for filter visibility updates.
 *
 * Output of `planFilterUpdate()` (pure planning function), input to
 * the imperative shell that shows/hides items in the DOM.
 *
 * @internal - Used by filtered list region runtime
 */
export type FilterUpdateOp =
  | { kind: "show"; index: number }
  | { kind: "hide"; index: number }

// =============================================================================
// Insertion Result (Trackability Invariant)
// =============================================================================

/**
 * A slot is a runtime handle to DOM content that can be removed.
 *
 * Guarantees the trackability invariant: all inserted content can be removed.
 *
 * - **single**: A single DOM node. This is the common case with no overhead —
 *   the node is tracked directly.
 *
 * - **range**: Multiple sibling nodes (from a multi-element fragment). Start
 *   and end comment markers delimit the range for removal.
 *
 * @internal - Used by region runtime
 */
export type Slot =
  | { kind: "single"; node: Node }
  | { kind: "range"; startMarker: Comment; endMarker: Comment }

// =============================================================================
// Conditional Region Operations (Functional Core)
// =============================================================================

/**
 * Operations for conditional region updates.
 * Output of pure planning function, input to imperative executor.
 *
 * This follows the Functional Core / Imperative Shell pattern:
 * - planConditionalUpdate() returns these ops (pure)
 * - executeConditionalOp() applies them to the DOM (imperative)
 *
 * @internal - Used by conditional region runtime
 */
export type ConditionalRegionOp =
  | { kind: "noop" }
  | { kind: "insert"; branch: "true" | "false" }
  | { kind: "delete" }
  | { kind: "swap"; toBranch: "true" | "false" }

/**
 * Handlers for conditional region branch switching.
 * @internal
 */
export interface ConditionalRegionHandlers {
  /** Create the "true" branch content */
  whenTrue: () => Node

  /** Create the "false" branch content (optional) */
  whenFalse?: () => Node

  /**
   * Optional slot kind hint from compile-time analysis.
   * When provided, optimizes insertion by avoiding runtime inspection.
   */
  slotKind?: SlotKind
}

/**
 * Scope for tracking subscriptions and nested regions.
 * @internal
 */
export interface ScopeInterface {
  /** Unique identifier for this scope */
  readonly id: number

  /** Whether this scope has been disposed */
  readonly disposed: boolean

  /** Add a cleanup function to be called on dispose */
  onDispose(cleanup: () => void): void

  /** Create a child scope */
  createChild(): ScopeInterface

  /** Dispose this scope and all children */
  dispose(): void
}
