/**
 * Core type definitions for Kinetic.
 *
 * These types define the user-facing API that the TypeScript Language Server
 * understands without compilation.
 */

import type {
  CounterRef,
  ListRef,
  MovableListRef,
  PlainValueRef,
  RecordRef,
  StructRef,
  TextRef,
  TreeRef,
} from "@loro-extended/change"

/**
 * Union of all typed ref types that can be used with bind().
 */
type AnyTypedRef =
  | TextRef
  | CounterRef
  | ListRef<any>
  | MovableListRef<any>
  | RecordRef<any>
  | StructRef<any>
  | TreeRef<any>

// =============================================================================
// Element Types
// =============================================================================

/**
 * An Element is a function that produces a DOM node when called.
 * Elements are lazy — they're not rendered until mounted.
 */
export type Element = () => Node

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
  | Binding<unknown>
  | Node

// =============================================================================
// Binding Types
// =============================================================================

/**
 * A Binding connects a Loro ref to a DOM input for two-way data flow.
 * Created with `bind(ref)`.
 */
export interface Binding<T> {
  readonly __brand: "kinetic:binding"
  readonly ref: PlainValueRef<T> | AnyTypedRef
}

/**
 * Create a two-way binding for a Loro ref.
 * Use with input elements to sync value with CRDT state.
 *
 * @example
 * ```ts
 * input({ type: "text", value: bind(doc.title) })
 * ```
 */
export type BindFunction = <T>(
  ref: PlainValueRef<T> | AnyTypedRef,
) => Binding<T>

// =============================================================================
// Element Factory Types
// =============================================================================

/**
 * Builder function for declarative element construction.
 * Called with no arguments, creates children via side effects.
 */
export type Builder = () => void

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
// Runtime Internal Types (used by compiled code)
// =============================================================================

/**
 * Handlers for list region delta processing.
 * @internal
 */
export interface ListRegionHandlers<T> {
  /**
   * Called when an item is inserted.
   * Returns the DOM node to insert.
   */
  create: (item: T, index: number) => Node

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
}

/**
 * Handlers for conditional region branch switching.
 * @internal
 */
export interface ConditionalRegionHandlers {
  /** Create the "true" branch content */
  whenTrue: () => Node

  /** Create the "false" branch content (optional) */
  whenFalse?: () => Node
}

/**
 * Scope for tracking subscriptions and nested regions.
 * @internal
 */
export interface ScopeInterface {
  /** Unique identifier for this scope */
  readonly id: string

  /** Whether this scope has been disposed */
  readonly disposed: boolean

  /** Add a cleanup function to be called on dispose */
  onDispose(cleanup: () => void): void

  /** Create a child scope */
  createChild(): ScopeInterface

  /** Dispose this scope and all children */
  dispose(): void
}
