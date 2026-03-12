/**
 * Intermediate Representation (IR) for the Kinetic compiler.
 *
 * The IR is a tree structure that represents the analyzed source code.
 * It captures the semantic meaning of builder functions in a form that
 * is easy to transform into either DOM manipulation code or HTML strings.
 *
 * The IR is:
 * - **Serializable**: Can be JSON.stringify'd for debugging/snapshots
 * - **Pure data**: No methods, just plain objects
 * - **Target-agnostic**: Same IR generates DOM or HTML output
 *
 * @packageDocumentation
 */

// =============================================================================
// Compilation Target
// =============================================================================

/**
 * Compilation target.
 *
 * - "dom": Generate DOM manipulation code (for client)
 * - "html": Generate HTML string code (for SSR)
 *
 * Defined here (rather than in transform.ts) so that IR types can
 * reference it without creating a circular dependency.
 */
export type CompileTarget = "dom" | "html"

// =============================================================================
// Base Types
// =============================================================================

/**
 * Source location for error reporting and source maps.
 */
export interface SourceSpan {
  /** Starting line (1-based) */
  startLine: number
  /** Starting column (0-based) */
  startColumn: number
  /** Ending line (1-based) */
  endLine: number
  /** Ending column (0-based) */
  endColumn: number
}

/**
 * Discriminated union tag for all IR node types.
 */
export type IRNodeKind =
  | "builder"
  | "element"
  | "content"
  | "loop"
  | "conditional"
  | "binding"
  | "statement"
  | "target-block"

/**
 * Base interface for all IR nodes.
 */
export interface IRNodeBase {
  kind: IRNodeKind
  span: SourceSpan
}

// =============================================================================
// Expression Types
// =============================================================================

/**
 * Binding time classification: when a value becomes known.
 *
 * This corresponds to partial evaluation's static/dynamic classification:
 * - **literal**: Value known at compile time (string literals)
 * - **render**: Value known at render time (static expressions)
 * - **reactive**: Value varies at runtime (reactive expressions with dependencies)
 */
export type BindingTime = "literal" | "render" | "reactive"

/**
 * Delta kind classification: what type of structured changes a reactive emits.
 *
 * This is an orthogonal property to binding time — it describes *how much*
 * structural information accompanies a change notification, not *when* the
 * change occurs.
 *
 * - **replace**: Opaque change — re-read entire value (default, like other frameworks)
 * - **text**: Character-level ops — enables surgical text node updates
 * - **sequence**: Structural sequence ops — enables O(k) list region updates
 * - **map**: Key-level changes — enables patching only changed entries
 * - **tree**: Hierarchical changes — enables structural tree updates
 * - **increment**: Counter increment/decrement — enables in-place numeric updates
 */
export type DeltaKind = "replace" | "text" | "sequence" | "map" | "tree" | "increment"

/**
 * A reactive dependency with its delta kind.
 *
 * Each dependency represents a reactive value that an expression depends on.
 * The `deltaKind` tells codegen what optimizations are possible when this
 * dependency changes.
 *
 * @example
 * ```typescript
 * // For expression: doc.title.toString()
 * const dep: Dependency = {
 *   source: "doc.title",
 *   deltaKind: "text"
 * }
 *
 * // For expression: doc.items.length
 * const dep: Dependency = {
 *   source: "doc.items",
 *   deltaKind: "sequence"
 * }
 *
 * // For expression: isOpen.get()
 * const dep: Dependency = {
 *   source: "isOpen",
 *   deltaKind: "replace"
 * }
 * ```
 */
export interface Dependency {
  /** Source expression text (e.g., "doc.title", "doc.items") */
  source: string
  /** What kind of delta this dependency emits */
  deltaKind: DeltaKind
}

/**
 * A value at a content position (text, attribute value, etc).
 *
 * Unifies the concept of "content" across all binding times. The `bindingTime`
 * field determines when the value becomes known and how it should be generated.
 *
 * - **literal**: `source` is a JSON-encoded string literal (e.g., `"Hello"`)
 * - **render**: `source` is a JavaScript expression evaluated once (e.g., `42`, `someVar`)
 * - **reactive**: `source` is a JavaScript expression with reactive dependencies (e.g., `doc.count`)
 */
export interface ContentValue extends IRNodeBase {
  kind: "content"

  /** The source text of the value (JSON string for literals, JS expression otherwise) */
  source: string

  /** When this value becomes known */
  bindingTime: BindingTime

  /**
   * For reactive content, the refs that this value depends on.
   * Each dependency includes the source text and delta kind.
   * Empty array for literal and render binding times.
   */
  dependencies: Dependency[]

  /**
   * For direct reads (e.g., `ref.get()` or `ref.toString()`), the source text
   * of the reactive ref. This enables surgical text patching when the
   * dependency has deltaKind "text".
   *
   * Undefined for non-direct reads (e.g., `ref.get().toUpperCase()`,
   * `ref.get() + other.get()`, template literals).
   */
  directReadSource?: string
}

// =============================================================================
// Content Types
// =============================================================================

/**
 * Content at any binding time (text, attribute values, etc).
 */
export type ContentNode = ContentValue

// =============================================================================
// Slot Types (Compile-Time Annotations)
// =============================================================================

/**
 * Slot kind classification: how many DOM nodes a body produces.
 *
 * Computed at compile time from IR body structure, flows to runtime via
 * handler configuration to optimize insertion strategy.
 *
 * - **single**: Body produces exactly one DOM node (element or text)
 * - **range**: Body produces zero, multiple, or region nodes (requires markers)
 *
 * @internal
 */
export type SlotKind = "single" | "range"

// =============================================================================
// Template Types (for Template Cloning)
// =============================================================================

/**
 * Kind of dynamic hole in a template.
 *
 * - **text**: Dynamic text content position
 * - **attribute**: Dynamic attribute value
 * - **event**: Event handler attachment point
 * - **binding**: Two-way binding attachment point
 * - **region**: List or conditional region mount point
 */
export type TemplateHoleKind =
  | "text"
  | "attribute"
  | "event"
  | "binding"
  | "region"
  | "component"

/**
 * A dynamic hole in a template.
 *
 * Holes represent positions in the static HTML where runtime code needs to:
 * - Insert dynamic text content
 * - Set dynamic attribute values
 * - Attach event handlers
 * - Set up two-way bindings
 * - Mount list or conditional regions
 *
 * The `path` array describes how to navigate from the template root to this hole
 * using `firstChild` and `nextSibling` operations.
 */
export interface TemplateHole {
  /** Walk path from template root: indices into children arrays at each level */
  path: number[]

  /** What kind of dynamic content this hole represents */
  kind: TemplateHoleKind

  /** For attribute holes: the attribute name */
  attributeName?: string

  /** For event holes: the event name (without "on" prefix) */
  eventName?: string

  /** For event holes: the handler function source expression */
  handlerSource?: string

  /** For binding holes: the binding type */
  bindingType?: "value" | "checked"

  /** For binding holes: the ref source expression */
  refSource?: string

  /** For region holes: the original IR node (LoopNode or ConditionalNode) */
  regionNode?: LoopNode | ConditionalNode

  /** For text/attribute holes: the original ContentNode for codegen */
  contentNode?: ContentNode

  /** For component holes: the original ElementNode with factorySource */
  elementNode?: ElementNode
}

/**
 * A template extracted from IR for template cloning.
 *
 * Represents a static HTML string with holes where dynamic content goes.
 * Used by both:
 * - **Client**: `template.innerHTML = html; template.content.cloneNode(true)`
 * - **SSR**: HTML string generation with interpolations
 *
 * The holes are ordered by document position (depth-first pre-order),
 * enabling efficient single-pass tree walking to grab all hole references.
 */
export interface TemplateNode {
  /** Static HTML string (use as template.innerHTML) */
  html: string

  /** Ordered list of dynamic holes with walk paths */
  holes: TemplateHole[]

  /** Counter used for generating unique region marker IDs */
  markerIdCounter: number
}

// =============================================================================
// Tree Merge Types
// =============================================================================

/**
 * Result of a tree merge operation.
 *
 * Discriminated union expressing success or failure with structured reasons.
 */
export type MergeResult<T> =
  | { success: true; value: T }
  | { success: false; reason: MergeFailureReason }

/**
 * Structured failure reasons for tree merge operations.
 *
 * Provides detailed information about why a merge failed, useful for
 * debugging and optimization metrics.
 */
export type MergeFailureReason =
  | { kind: "different-kinds"; aKind: IRNodeKind; bKind: IRNodeKind }
  | { kind: "different-tags"; aTag: string; bTag: string }
  | { kind: "different-child-counts"; aCount: number; bCount: number }
  | { kind: "different-attribute-sets"; aAttrs: string[]; bAttrs: string[] }
  | {
      kind: "different-event-handlers"
      aHandlers: string[]
      bHandlers: string[]
    }
  | {
      kind: "incompatible-binding-times"
      aTime: BindingTime
      bTime: BindingTime
    }
  | { kind: "different-dependencies"; aDeps: string[]; bDeps: string[] }
  | { kind: "different-statement-sources"; aSource: string; bSource: string }
  | { kind: "region-not-mergeable" }
  | {
      kind: "child-merge-failed"
      index: number
      childReason: MergeFailureReason
    }

// =============================================================================
// Attribute Types
// =============================================================================

/**
 * An attribute on an element.
 */
export interface AttributeNode {
  /** Attribute name (e.g., "class", "id", "data-foo") */
  name: string

  /** Attribute value - either static text or an expression */
  value: ContentNode
}

/**
 * An event handler on an element.
 */
export interface EventHandlerNode {
  /** Event name without "on" prefix, lowercased (e.g., "click", "input") */
  event: string

  /**
   * Original prop name from the source (e.g., "onKeyDown", "onClick").
   *
   * Preserved because the lowercased `event` field loses casing information
   * needed when reconstructing prop names for component calls. For HTML
   * elements, `addEventListener(event, ...)` uses the lowercase form. For
   * components, the codegen emits `{ onKeyDown: handler }` and needs the
   * original casing — reconstructing from lowercase produces `onKeydown`
   * (wrong) instead of `onKeyDown` (correct).
   */
  propName: string

  /** The handler function source */
  handlerSource: string

  span: SourceSpan
}

// =============================================================================
// Element Types
// =============================================================================

/**
 * A two-way binding on an element attribute.
 */
export interface ElementBinding {
  /** The attribute being bound (e.g., "value", "checked") */
  attribute: string

  /** The ref source (e.g., "doc.title") */
  refSource: string

  /** The type of binding */
  bindingType: "value" | "checked"

  span: SourceSpan
}

/**
 * An HTML element.
 *
 * Elements can have:
 * - Static or reactive attributes
 * - Static or reactive children
 * - Event handlers
 * - Two-way bindings
 */
export interface ElementNode extends IRNodeBase {
  kind: "element"

  /** HTML tag name (e.g., "div", "span", "input") */
  tag: string

  /** Attributes on this element */
  attributes: AttributeNode[]

  /** Event handlers on this element */
  eventHandlers: EventHandlerNode[]

  /** Two-way bindings on this element */
  bindings: ElementBinding[]

  /** Children of this element */
  children: ChildNode[]

  /**
   * Whether this element has any reactive content (attributes or children).
   * Computed during analysis for quick filtering.
   */
  isReactive: boolean

  /**
   * For component invocations: the source expression to call.
   * When present, this node represents a component call (not an HTML element).
   * The codegen emits `factorySource(scope.createChild())` instead of `createElement(tag)`.
   *
   * When absent (undefined), this is a regular HTML element.
   *
   * @example
   * // For `MyComponent({ title: "Hi" })`, factorySource = "MyComponent"
   * // For `div(() => {...})`, factorySource = undefined
   */
  factorySource?: string
}

// =============================================================================
// Control Flow Types
// =============================================================================

/**
 * A loop node — unified representation for both render-time and reactive loops.
 *
 * Replaces the former `StaticLoopNode` (render-time) and `ListRegionNode` (reactive).
 * The `iterableBindingTime` field determines codegen strategy:
 * - `"render"`: inline `for...of` loop, runs once at render time
 * - `"reactive"`: `listRegion` call, delta-driven updates
 *
 * ```typescript
 * // Render-time loop (iterableBindingTime: "render")
 * for (const x of [1, 2, 3]) { li(x) }
 *
 * // Reactive loop (iterableBindingTime: "reactive")
 * for (const item of doc.items) { li(item.text) }
 * ```
 */
export interface LoopNode extends IRNodeBase {
  kind: "loop"

  /** The iterable expression source (e.g., "doc.items", "[1, 2, 3]") */
  iterableSource: string

  /** Binding time of the iterable — determines codegen strategy */
  iterableBindingTime: BindingTime

  /** The loop variable name (e.g., "item") */
  itemVariable: string

  /** Optional index variable name if destructured (e.g., "i" from `for (const [i, item] of ...)`) */
  indexVariable: string | null

  /** The body of the loop - what to render for each item */
  body: ChildNode[]

  /**
   * Whether items have reactive content that depends on item properties.
   * Computed via computeHasReactiveItems(body) at IR creation time.
   * If true, each item needs its own subscriptions.
   */
  hasReactiveItems: boolean

  /**
   * Slot kind for the body - computed at IR creation time.
   * Determines whether create handler returns single node or fragment.
   */
  bodySlotKind: SlotKind

  /**
   * For reactive iterables, the subscription dependencies.
   * Empty array for render-time loops.
   */
  dependencies: Dependency[]
}

/**
 * A branch in a conditional region.
 */
export interface ConditionalBranch {
  /** The condition expression (null for else branch) */
  condition: ContentValue | null

  /** The content to render when this branch is active */
  body: ChildNode[]

  /**
   * Slot kind for this branch's body - computed at IR creation time.
   */
  slotKind: SlotKind

  span: SourceSpan
}

/**
 * A conditional from an `if` statement.
 *
 * Unified type parameterized by binding time via subscriptionTarget:
 * - subscriptionTarget === null → render-time conditional (inline if)
 * - subscriptionTarget !== null → reactive conditional (conditionalRegion)
 *
 * ```typescript
 * // Render-time conditional (subscriptionTarget: null)
 * if (true) { p("always shown") }
 *
 * // Reactive conditional (subscriptionTarget: "doc.count")
 * if (doc.count.get() > 0) {
 *   p("Has items")
 * } else {
 *   p("Empty")
 * }
 * ```
 */
export interface ConditionalNode extends IRNodeBase {
  kind: "conditional"

  /**
   * The branches of this conditional.
   * - First branch has the `if` condition
   * - Middle branches have `else if` conditions
   * - Last branch may have null condition (the `else` branch)
   */
  branches: ConditionalBranch[]

  /**
   * For reactive conditions, the dependency to subscribe to.
   * Null for render-time conditionals.
   */
  subscriptionTarget: Dependency | null
}

// =============================================================================
// Binding Types
// =============================================================================

/**
 * A standalone two-way binding node.
 *
 * Note: Bindings are typically stored on ElementNode.bindings.
 * This node type exists for cases where a binding needs to be
 * represented as a child node.
 *
 * ```typescript
 * input({ type: "text", value: bind(doc.title) })
 * ```
 */
export interface BindingNode extends IRNodeBase {
  kind: "binding"

  /** The ref being bound (e.g., "doc.title") */
  refSource: string

  /** The type of binding based on element/attribute */
  bindingType: "value" | "checked"
}

// =============================================================================
// Statement Types
// =============================================================================

/**
 * An arbitrary TypeScript statement that should be emitted verbatim.
 *
 * This captures statements that aren't UI-specific constructs but need
 * to be preserved in the generated code (e.g., variable declarations,
 * console.log calls, etc.).
 *
 * ```typescript
 * for (const itemRef of doc.items) {
 *   const item = itemRef.get()  // ← This becomes a StatementNode
 *   li(item)
 * }
 * ```
 */
export interface StatementNode extends IRNodeBase {
  kind: "statement"

  /** The original source text of the statement */
  source: string
}

/**
 * A labeled block that targets a specific compilation target.
 *
 * Used for `client: { ... }` and `server: { ... }` blocks inside
 * builder functions. The filter-before-codegen architecture strips
 * non-matching blocks and unwraps matching blocks before codegen
 * ever sees the IR, so codegens remain target-unaware.
 *
 * ```typescript
 * div(() => {
 *   client: { requestAnimationFrame(loop) }  // DOM only
 *   server: { console.log("SSR render") }     // HTML only
 *   h1("Hello")                               // both targets
 * })
 * ```
 */
export interface TargetBlockNode extends IRNodeBase {
  kind: "target-block"

  /** Which compilation target this block is for */
  target: CompileTarget

  /** The analyzed children inside the labeled block */
  children: ChildNode[]
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any node that can be a child of an element or builder.
 */
export type ChildNode =
  | ElementNode
  | ContentValue
  | LoopNode
  | ConditionalNode
  | BindingNode
  | StatementNode
  | TargetBlockNode

// =============================================================================
// Root Types
// =============================================================================

/**
 * A builder function that was analyzed.
 *
 * This is the root of the IR tree for a single element factory call.
 *
 * ```typescript
 * div(() => {
 *   h1("Title")
 *   p("Content")
 * })
 * ```
 */
export interface BuilderNode extends IRNodeBase {
  kind: "builder"

  /** The element factory being called (e.g., "div") */
  factoryName: string

  /** Props passed to the factory (if any) */
  props: AttributeNode[]

  /** Event handlers from props */
  eventHandlers: EventHandlerNode[]

  /** The children produced by the builder function */
  children: ChildNode[]

  /**
   * All refs that are accessed anywhere in this builder.
   * Used for determining what subscriptions are needed at the top level.
   */
  allDependencies: Dependency[]

  /**
   * Whether this builder has any reactive content.
   */
  isReactive: boolean
}

// =============================================================================
// Helper Type Guards
// =============================================================================

/**
 * Check if a node is an element.
 */
export function isElementNode(node: ChildNode): node is ElementNode {
  return node.kind === "element"
}

/**
 * Check if a node is content (any binding time).
 */
export function isContentNode(node: ChildNode): node is ContentValue {
  return node.kind === "content"
}

/**
 * Check if a node is literal content (compile-time known).
 */
export function isLiteralContent(node: ChildNode): node is ContentValue {
  return node.kind === "content" && node.bindingTime === "literal"
}

/**
 * Check if a node is a loop (any binding time).
 */
export function isLoopNode(node: ChildNode): node is LoopNode {
  return node.kind === "loop"
}

/**
 * Check if a node is a conditional.
 */
export function isConditionalNode(node: ChildNode): node is ConditionalNode {
  return node.kind === "conditional"
}

/**
 * Check if a node is a binding.
 */
export function isBindingNode(node: ChildNode): node is BindingNode {
  return node.kind === "binding"
}

/**
 * Check if a node is a statement.
 */
export function isStatementNode(node: ChildNode): node is StatementNode {
  return node.kind === "statement"
}

/**
 * Check if a node is a target block.
 */
export function isTargetBlockNode(node: ChildNode): node is TargetBlockNode {
  return node.kind === "target-block"
}

/**
 * Check if a node is reactive content (varies at runtime).
 */
export function isReactiveContent(node: ChildNode): node is ContentValue {
  return node.kind === "content" && node.bindingTime === "reactive"
}

// =============================================================================
// Codegen Dispatch Predicates
// =============================================================================

/**
 * Check if a ContentValue qualifies for the `textRegion` optimization.
 *
 * The condition: reactive binding time, a direct read source (e.g.,
 * `ref.get()` or `ref.toString()`), exactly one dependency, and that
 * dependency has deltaKind "text".
 *
 * This is the single source of truth for the textRegion dispatch decision,
 * used by both codegen (`generateReactiveContentSubscription`) and import
 * collection (`collectRequiredImports`).
 */
export function isTextRegionContent(node: ContentValue): boolean {
  return (
    node.bindingTime === "reactive" &&
    !!node.directReadSource &&
    node.dependencies.length === 1 &&
    node.dependencies[0].deltaKind === "text"
  )
}

/**
 * Check if an attribute qualifies for the `inputTextRegion` optimization.
 *
 * The condition: the attribute is named "value" and its value is a
 * textRegion-qualifying ContentValue (see `isTextRegionContent`).
 *
 * This is the single source of truth for the inputTextRegion dispatch
 * decision, used by codegen (`generateAttributeSet`,
 * `generateAttributeSubscription`, `generateHoleSetup`) and import
 * collection (`collectRequiredImports`).
 */
export function isInputTextRegionAttribute(attr: AttributeNode): boolean {
  return attr.name === "value" && isTextRegionContent(attr.value)
}

// =============================================================================
// Slot Kind Computation
// =============================================================================

/**
 * Compute the slot kind for a body of child nodes.
 *
 * Returns "single" if the body produces exactly one DOM node (element or content).
 * Returns "range" for all other cases (zero nodes, multiple nodes, regions, etc).
 *
 * This analysis enables compile-time optimization: when we know a body produces
 * a single node, we can avoid fragment overhead and marker comments.
 */
export function computeSlotKind(body: ChildNode[]): SlotKind {
  // Filter out statements (they don't produce DOM nodes)
  const domProducingNodes = body.filter(node => node.kind !== "statement")

  // Empty or multiple DOM-producing nodes -> range
  if (domProducingNodes.length !== 1) {
    return "range"
  }

  const node = domProducingNodes[0]

  // Single element or content node -> single
  if (node.kind === "element" || node.kind === "content") {
    return "single"
  }

  // Regions, loops, conditionals -> range (they may produce multiple nodes)
  return "range"
}

/**
 * Whether any direct child in a body has reactive content.
 *
 * Shallow check — does not recurse into nested loops/conditionals.
 * Answers: "do items at this level need their own subscriptions?"
 *
 * A child is considered reactive if it:
 * - Is reactive content (binding time === "reactive")
 * - Is an element with reactive attributes or children
 * - Is a list region (reactive by definition)
 * - Is a conditional region (reactive by definition)
 */
export function computeHasReactiveItems(body: ChildNode[]): boolean {
  return body.some(
    child =>
      isReactiveContent(child) ||
      (child.kind === "element" && child.isReactive) ||
      (child.kind === "loop" && child.iterableBindingTime === "reactive") ||
      (child.kind === "conditional" && child.subscriptionTarget !== null),
  )
}

// =============================================================================
// Tree Merge Functions
// =============================================================================

/**
 * Merge two content values at a divergence point.
 *
 * If both values are identical, returns as-is.
 * If both have liftable binding times (literal or render), promotes to reactive
 * with ternary source expression.
 * Otherwise, returns failure.
 *
 * @param a - First content value
 * @param b - Second content value
 * @param condition - The condition expression for the ternary
 * @returns MergeResult with merged content or failure reason
 */
export function mergeContentValue(
  a: ContentValue,
  b: ContentValue,
  condition: ContentValue,
): MergeResult<ContentValue> {
  // Identical content - keep as-is
  if (
    a.source === b.source &&
    a.bindingTime === b.bindingTime &&
    JSON.stringify(a.dependencies) === JSON.stringify(b.dependencies)
  ) {
    return { success: true, value: a }
  }

  // Both literal or render-time - can promote to reactive with ternary
  if (
    (a.bindingTime === "literal" || a.bindingTime === "render") &&
    (b.bindingTime === "literal" || b.bindingTime === "render")
  ) {
    // Create ternary expression
    const ternarySource = `${condition.source} ? ${a.source} : ${b.source}`
    return {
      success: true,
      value: {
        kind: "content",
        source: ternarySource,
        bindingTime: "reactive",
        dependencies: condition.dependencies,
        span: a.span,
      },
    }
  }

  // Special case: liftable (literal/render) + reactive with ternary
  // This enables nested ternaries for N-branch merge
  // Example: merge "A" with "b ? B : C" using condition "a"
  // Results in: "a ? A : (b ? B : C)"
  if (
    (a.bindingTime === "literal" || a.bindingTime === "render") &&
    b.bindingTime === "reactive"
  ) {
    // Build nested ternary
    const ternarySource = `${condition.source} ? ${a.source} : (${b.source})`
    // Merge dependencies: condition deps + b's deps
    const mergedDeps = [
      ...condition.dependencies,
      ...b.dependencies.filter(d => !condition.dependencies.includes(d)),
    ]
    return {
      success: true,
      value: {
        kind: "content",
        source: ternarySource,
        bindingTime: "reactive",
        dependencies: mergedDeps,
        span: a.span,
      },
    }
  }

  // Reactive + liftable: reverse case (less common but possible)
  if (
    a.bindingTime === "reactive" &&
    (b.bindingTime === "literal" || b.bindingTime === "render")
  ) {
    const ternarySource = `${condition.source} ? (${a.source}) : ${b.source}`
    const mergedDeps = [
      ...condition.dependencies,
      ...a.dependencies.filter(d => !condition.dependencies.includes(d)),
    ]
    return {
      success: true,
      value: {
        kind: "content",
        source: ternarySource,
        bindingTime: "reactive",
        dependencies: mergedDeps,
        span: a.span,
      },
    }
  }

  // Two reactive with same dependencies - keep as-is (already handled above)
  // Two reactive with different dependencies - cannot merge
  if (a.bindingTime === "reactive" && b.bindingTime === "reactive") {
    return {
      success: false,
      reason: {
        kind: "incompatible-binding-times",
        aTime: a.bindingTime,
        bTime: b.bindingTime,
      },
    }
  }

  // Should not reach here, but handle as incompatible
  return {
    success: false,
    reason: {
      kind: "incompatible-binding-times",
      aTime: a.bindingTime,
      bTime: b.bindingTime,
    },
  }
}

/**
 * Recursively merge two child nodes.
 *
 * Checks structural equivalence and delegates to mergeContentValue for
 * content positions. Returns merged node or failure reason.
 *
 * @param a - First child node
 * @param b - Second child node
 * @param condition - The condition expression for ternaries
 * @returns MergeResult with merged node or failure reason
 */
export function mergeNode(
  a: ChildNode,
  b: ChildNode,
  condition: ContentValue,
): MergeResult<ChildNode> {
  // Different kinds - cannot merge
  if (a.kind !== b.kind) {
    return {
      success: false,
      reason: { kind: "different-kinds", aKind: a.kind, bKind: b.kind },
    }
  }

  // Content nodes - delegate to mergeContentValue
  if (a.kind === "content" && b.kind === "content") {
    return mergeContentValue(a, b, condition)
  }

  // Statement nodes - must have identical source
  if (a.kind === "statement" && b.kind === "statement") {
    if (a.source === b.source) {
      return { success: true, value: a }
    }
    return {
      success: false,
      reason: {
        kind: "different-statement-sources",
        aSource: a.source,
        bSource: b.source,
      },
    }
  }

  // Element nodes - check structural equivalence and recurse
  if (a.kind === "element" && b.kind === "element") {
    // Different tags - cannot merge
    if (a.tag !== b.tag) {
      return {
        success: false,
        reason: { kind: "different-tags", aTag: a.tag, bTag: b.tag },
      }
    }

    // Different child counts - cannot merge
    if (a.children.length !== b.children.length) {
      return {
        success: false,
        reason: {
          kind: "different-child-counts",
          aCount: a.children.length,
          bCount: b.children.length,
        },
      }
    }

    // Different attribute sets - cannot merge
    const aAttrNames = a.attributes.map(attr => attr.name).sort()
    const bAttrNames = b.attributes.map(attr => attr.name).sort()
    if (JSON.stringify(aAttrNames) !== JSON.stringify(bAttrNames)) {
      return {
        success: false,
        reason: {
          kind: "different-attribute-sets",
          aAttrs: aAttrNames,
          bAttrs: bAttrNames,
        },
      }
    }

    // Different event handlers - cannot merge
    const aHandlers = a.eventHandlers.map(h => h.handlerSource).sort()
    const bHandlers = b.eventHandlers.map(h => h.handlerSource).sort()
    if (JSON.stringify(aHandlers) !== JSON.stringify(bHandlers)) {
      return {
        success: false,
        reason: {
          kind: "different-event-handlers",
          aHandlers,
          bHandlers,
        },
      }
    }

    // Merge attributes
    const mergedAttributes: AttributeNode[] = []
    for (let i = 0; i < a.attributes.length; i++) {
      const attrName = aAttrNames[i]
      const aAttr = a.attributes.find(attr => attr.name === attrName)
      const bAttr = b.attributes.find(attr => attr.name === attrName)

      // Safety: we've verified attribute sets match above, so both must exist
      if (!aAttr || !bAttr) {
        return {
          success: false,
          reason: {
            kind: "different-attribute-sets",
            aAttrs: aAttrNames,
            bAttrs: bAttrNames,
          },
        }
      }

      const valueResult = mergeContentValue(aAttr.value, bAttr.value, condition)
      if (!valueResult.success) {
        return valueResult
      }

      mergedAttributes.push({
        name: aAttr.name,
        value: valueResult.value,
      })
    }

    // Merge children recursively
    const mergedChildren: ChildNode[] = []
    for (let i = 0; i < a.children.length; i++) {
      const childResult = mergeNode(a.children[i], b.children[i], condition)
      if (!childResult.success) {
        return {
          success: false,
          reason: {
            kind: "child-merge-failed",
            index: i,
            childReason: childResult.reason,
          },
        }
      }
      mergedChildren.push(childResult.value)
    }

    // Create merged element
    return {
      success: true,
      value: createElement(
        a.tag,
        mergedAttributes,
        a.eventHandlers,
        a.bindings,
        mergedChildren,
        a.span,
      ),
    }
  }

  // Loops - not mergeable (explicit case for future structured reasoning)
  if (a.kind === "loop" && b.kind === "loop") {
    return {
      success: false,
      reason: { kind: "region-not-mergeable" },
    }
  }

  // Conditionals - not mergeable (explicit case for future structured reasoning)
  if (a.kind === "conditional" && b.kind === "conditional") {
    return {
      success: false,
      reason: { kind: "region-not-mergeable" },
    }
  }

  // Bindings, statements - not mergeable
  return {
    success: false,
    reason: { kind: "region-not-mergeable" },
  }
}

/**
 * Merge conditional branch bodies.
 *
 * Walks N branch bodies in parallel, calling mergeNode for each position.
 * For N > 2, synthesizes nested ternaries.
 *
 * Returns merged body if all branches are structurally equivalent,
 * otherwise returns failure.
 *
 * @param branches - Array of conditional branches to merge
 * @returns MergeResult with merged body or failure reason
 */
export function mergeConditionalBodies(
  branches: ConditionalBranch[],
): MergeResult<ChildNode[]> {
  // Must have at least 2 branches (if and else)
  if (branches.length < 2) {
    return {
      success: false,
      reason: { kind: "region-not-mergeable" },
    }
  }

  // All branches must have same body length
  const bodyLength = branches[0].body.length
  for (let i = 1; i < branches.length; i++) {
    if (branches[i].body.length !== bodyLength) {
      return {
        success: false,
        reason: {
          kind: "different-child-counts",
          aCount: bodyLength,
          bCount: branches[i].body.length,
        },
      }
    }
  }

  // For 2 branches: simple binary merge
  if (branches.length === 2) {
    const firstCondition = branches[0].condition
    if (!firstCondition) {
      return {
        success: false,
        reason: { kind: "region-not-mergeable" },
      }
    }
    const mergedBody: ChildNode[] = []

    for (let i = 0; i < bodyLength; i++) {
      const nodeA = branches[0].body[i]
      const nodeB = branches[1].body[i]
      const result = mergeNode(nodeA, nodeB, firstCondition)

      if (!result.success) {
        return result
      }

      mergedBody.push(result.value)
    }

    return { success: true, value: mergedBody }
  }

  // For N > 2 branches: nested ternary merge
  // Build from right to left: a ? X : (b ? Y : Z)
  const mergedBody: ChildNode[] = []

  for (let nodeIndex = 0; nodeIndex < bodyLength; nodeIndex++) {
    // Start with the last (else) branch
    let current = branches[branches.length - 1].body[nodeIndex]

    // Work backwards through conditions
    for (
      let branchIndex = branches.length - 2;
      branchIndex >= 0;
      branchIndex--
    ) {
      const branch = branches[branchIndex]
      const branchCondition = branch.condition
      if (!branchCondition) {
        return {
          success: false,
          reason: { kind: "region-not-mergeable" },
        }
      }
      const nodeA = branch.body[nodeIndex]

      const result = mergeNode(nodeA, current, branchCondition)
      if (!result.success) {
        return result
      }

      current = result.value
    }

    mergedBody.push(current)
  }

  return { success: true, value: mergedBody }
}

// =============================================================================
// Factory Functions (for creating IR nodes)
// =============================================================================

/**
 * Create a source span from line/column numbers.
 */
export function createSpan(
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
): SourceSpan {
  return { startLine, startColumn, endLine, endColumn }
}

/**
 * Create a content value with specified binding time.
 */
export function createContent(
  source: string,
  bindingTime: BindingTime,
  dependencies: Dependency[],
  span: SourceSpan,
  directReadSource?: string,
): ContentValue {
  const result: ContentValue = {
    kind: "content",
    source,
    bindingTime,
    dependencies,
    span,
  }
  if (directReadSource !== undefined) {
    result.directReadSource = directReadSource
  }
  return result
}

/**
 * Create literal content (compile-time string).
 * Convenience wrapper that JSON-stringifies the value.
 */
export function createLiteral(value: string, span: SourceSpan): ContentValue {
  return createContent(JSON.stringify(value), "literal", [], span)
}

/**
 * Create an element node.
 *
 * @param tag - HTML tag name or component name
 * @param attributes - Attributes on this element
 * @param eventHandlers - Event handlers
 * @param bindings - Two-way bindings
 * @param children - Child nodes
 * @param span - Source location
 * @param factorySource - For components: the source expression to call
 */
export function createElement(
  tag: string,
  attributes: AttributeNode[],
  eventHandlers: EventHandlerNode[],
  bindings: ElementBinding[],
  children: ChildNode[],
  span: SourceSpan,
  factorySource?: string,
): ElementNode {
  const isReactive =
    attributes.some(attr => isReactiveContent(attr.value)) ||
    bindings.length > 0 ||
    children.some(child => isReactiveContent(child)) ||
    children.some(child => child.kind === "element" && child.isReactive) ||
    children.some(
      child =>
        (child.kind === "loop" && child.iterableBindingTime === "reactive") ||
        (child.kind === "conditional" && child.subscriptionTarget !== null),
    )

  const element: ElementNode = {
    kind: "element",
    tag,
    attributes,
    eventHandlers,
    bindings,
    children,
    isReactive,
    span,
  }

  if (factorySource !== undefined) {
    element.factorySource = factorySource
  }

  return element
}

/**
 * Create a statement node.
 */
export function createStatement(
  source: string,
  span: SourceSpan,
): StatementNode {
  return {
    kind: "statement",
    source,
    span,
  }
}

/**
 * Create a target block node.
 *
 * @param target - The compilation target this block is for ("dom" for client:, "html" for server:)
 * @param children - The analyzed children inside the labeled block
 * @param span - Source location
 */
export function createTargetBlock(
  target: CompileTarget,
  children: ChildNode[],
  span: SourceSpan,
): TargetBlockNode {
  return {
    kind: "target-block",
    target,
    children,
    span,
  }
}

/**
 * Create a loop node (unified for render-time and reactive loops).
 */
export function createLoop(
  iterableSource: string,
  iterableBindingTime: BindingTime,
  itemVariable: string,
  indexVariable: string | null,
  body: ChildNode[],
  dependencies: Dependency[],
  span: SourceSpan,
): LoopNode {
  return {
    kind: "loop",
    iterableSource,
    iterableBindingTime,
    itemVariable,
    indexVariable,
    body,
    hasReactiveItems: computeHasReactiveItems(body),
    bodySlotKind: computeSlotKind(body),
    dependencies,
    span,
  }
}

/**
 * Create a conditional branch.
 */
export function createConditionalBranch(
  condition: ContentNode | null,
  body: ChildNode[],
  span: SourceSpan,
): ConditionalBranch {
  return {
    condition,
    body,
    slotKind: computeSlotKind(body),
    span,
  }
}

/**
 * Create a conditional node.
 *
 * Unified factory for both render-time and reactive conditionals.
 * - subscriptionTarget === null → render-time conditional
 * - subscriptionTarget !== null → reactive conditional
 */
export function createConditional(
  branches: ConditionalBranch[],
  subscriptionTarget: Dependency | null,
  span: SourceSpan,
): ConditionalNode {
  return {
    kind: "conditional",
    branches,
    subscriptionTarget,
    span,
  }
}

/**
 * Create a builder node.
 */
export function createBuilder(
  factoryName: string,
  props: AttributeNode[],
  eventHandlers: EventHandlerNode[],
  children: ChildNode[],
  span: SourceSpan,
): BuilderNode {
  // Collect all dependencies from the tree, keyed by source to deduplicate
  const allDependenciesMap = new Map<string, Dependency>()

  function addDep(dep: Dependency): void {
    // Keep first occurrence (all occurrences should have same deltaKind)
    if (!allDependenciesMap.has(dep.source)) {
      allDependenciesMap.set(dep.source, dep)
    }
  }

  function collectDependencies(nodes: ChildNode[]): void {
    for (const node of nodes) {
      if (isReactiveContent(node)) {
        for (const dep of node.dependencies) {
          addDep(dep)
        }
      } else if (node.kind === "element") {
        for (const attr of node.attributes) {
          if (isReactiveContent(attr.value)) {
            for (const dep of attr.value.dependencies) {
              addDep(dep)
            }
          }
        }
        collectDependencies(node.children)
      } else if (node.kind === "loop") {
        for (const dep of node.dependencies) {
          addDep(dep)
        }
        collectDependencies(node.body)
      } else if (node.kind === "conditional") {
        if (node.subscriptionTarget) {
          addDep(node.subscriptionTarget)
        }
        for (const branch of node.branches) {
          if (branch.condition) {
            for (const dep of branch.condition.dependencies) {
              addDep(dep)
            }
          }
          collectDependencies(branch.body)
        }
      } else if (node.kind === "target-block") {
        // Recurse into target block children regardless of target —
        // dependencies from both client: and server: blocks inform
        // subscription setup even if one target's code is stripped later.
        collectDependencies(node.children)
      } else if (node.kind === "binding") {
        // Bindings are tracked separately, not as dependencies
        // The refSource is used for binding generation, not subscription
      }
    }
  }

  // Also collect from props
  for (const prop of props) {
    if (isReactiveContent(prop.value)) {
      for (const dep of prop.value.dependencies) {
        addDep(dep)
      }
    }
  }

  collectDependencies(children)

  const isReactive = allDependenciesMap.size > 0

  return {
    kind: "builder",
    factoryName,
    props,
    eventHandlers,
    children,
    allDependencies: Array.from(allDependenciesMap.values()),
    isReactive,
    span,
  }
}

// =============================================================================
// Target Block Filtering
// =============================================================================

/**
 * Filter target blocks from an IR tree before codegen.
 *
 * This is a pure function that recursively walks the IR tree and:
 * - **Strips** `TargetBlockNode` nodes whose target doesn't match (removes them entirely)
 * - **Unwraps** `TargetBlockNode` nodes whose target matches (splices in their children)
 *
 * After filtering, the returned `BuilderNode` contains no `TargetBlockNode` nodes
 * anywhere in the tree. Codegens, walkers, and template extraction never see them.
 *
 * @param node - The builder node to filter
 * @param target - The active compilation target ("dom" or "html")
 * @returns A new BuilderNode with target blocks resolved
 */
export function filterTargetBlocks(
  node: BuilderNode,
  target: CompileTarget,
): BuilderNode {
  return {
    ...node,
    children: filterChildren(node.children, target),
  }
}

/**
 * Recursively filter target blocks from a list of child nodes.
 */
function filterChildren(
  children: ChildNode[],
  target: CompileTarget,
): ChildNode[] {
  const result: ChildNode[] = []

  for (const child of children) {
    if (child.kind === "target-block") {
      if (child.target === target) {
        // Matching target — unwrap: splice in the filtered children
        result.push(...filterChildren(child.children, target))
      }
      // Non-matching target — strip: omit entirely
    } else {
      // Recurse into nodes that contain child arrays
      result.push(filterChildNode(child, target))
    }
  }

  return result
}

/**
 * Recursively filter target blocks inside a single non-target-block child node.
 */
function filterChildNode(
  node: ChildNode,
  target: CompileTarget,
): ChildNode {
  switch (node.kind) {
    case "element":
      return {
        ...node,
        children: filterChildren(node.children, target),
      }

    case "loop":
      return {
        ...node,
        body: filterChildren(node.body, target),
      }

    case "conditional":
      return {
        ...node,
        branches: node.branches.map(branch => ({
          ...branch,
          body: filterChildren(branch.body, target),
        })),
      }

    // Leaf nodes — no children to recurse into
    case "content":
    case "statement":
    case "binding":
      return node

    // target-block is already handled by filterChildren before this function
    // is called, so this case should never be reached.
    case "target-block":
      return node
  }
}

// =============================================================================
// Conditional Dissolution
// =============================================================================

/**
 * Dissolve dissolvable conditionals in an IR tree before codegen.
 *
 * This is a pure function that recursively walks the IR tree and replaces
 * reactive conditionals whose branches have identical structure with their
 * merged children (elements/content with ternary expressions).
 *
 * A conditional is dissolvable when:
 * 1. It has a reactive subscription target (not render-time)
 * 2. It has an else branch (all branches covered)
 * 3. `mergeConditionalBodies` succeeds (branches are structurally identical)
 *
 * After dissolution, the returned `BuilderNode` contains no dissolvable
 * `ConditionalNode` nodes. Non-dissolvable conditionals are preserved.
 * The walker, template extraction, and codegen never see dissolvable
 * conditionals — they see regular elements/content with ternary values.
 *
 * @param node - The builder node to transform
 * @returns A new BuilderNode with dissolvable conditionals replaced
 */
export function dissolveConditionals(node: BuilderNode): BuilderNode {
  return {
    ...node,
    children: dissolveChildren(node.children),
  }
}

/**
 * Recursively dissolve conditionals from a list of child nodes.
 *
 * When a dissolvable conditional is encountered, its merged children are
 * spliced into the output array (replacing the single ConditionalNode).
 * All other nodes are recursed into via `dissolveChildNode`.
 */
function dissolveChildren(children: ChildNode[]): ChildNode[] {
  const result: ChildNode[] = []

  for (const child of children) {
    if (child.kind === "conditional") {
      // Only attempt dissolution for reactive conditionals with an else branch
      if (
        child.subscriptionTarget !== null &&
        child.branches.some(b => b.condition === null)
      ) {
        const mergeResult = mergeConditionalBodies(child.branches)
        if (mergeResult.success) {
          // Dissolution successful — splice merged children in place of
          // the ConditionalNode, then recurse into each merged child
          // (they may contain nested dissolvable conditionals).
          for (const merged of mergeResult.value) {
            result.push(dissolveChildNode(merged))
          }
          continue
        }
      }
      // Not dissolvable — recurse into branch bodies
      result.push(dissolveChildNode(child))
    } else {
      // Non-conditional — recurse into sub-trees
      result.push(dissolveChildNode(child))
    }
  }

  return result
}

/**
 * Recursively dissolve conditionals inside a single child node.
 */
function dissolveChildNode(node: ChildNode): ChildNode {
  switch (node.kind) {
    case "element":
      return {
        ...node,
        children: dissolveChildren(node.children),
      }

    case "loop":
      return {
        ...node,
        body: dissolveChildren(node.body),
      }

    case "conditional":
      return {
        ...node,
        branches: node.branches.map(branch => ({
          ...branch,
          body: dissolveChildren(branch.body),
        })),
      }

    // Leaf nodes — no children to recurse into
    case "content":
    case "statement":
    case "binding":
      return node

    // target-block children are recursed into (dissolution may run
    // before or after filterTargetBlocks in the pipeline).
    case "target-block":
      return {
        ...node,
        children: dissolveChildren(node.children),
      }
  }
}
