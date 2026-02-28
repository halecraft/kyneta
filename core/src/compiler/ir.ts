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
  | "list-region"
  | "conditional-region"
  | "binding"
  | "statement"
  | "static-loop"
  | "static-conditional"

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
   * Each entry is the source text of the ref access (e.g., "doc.count", "item.text").
   * Empty array for literal and render binding times.
   */
  dependencies: string[]
}

// =============================================================================
// Content Types
// =============================================================================

/**
 * Content at any binding time (text, attribute values, etc).
 */
export type ContentNode = ContentValue

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
  /** Event name without "on" prefix (e.g., "click", "input") */
  event: string

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
}

// =============================================================================
// Control Flow Types
// =============================================================================

/**
 * A list region from a `for..of` loop over a Loro list.
 *
 * ```typescript
 * for (const item of doc.items) {
 *   li(item.text)
 * }
 * ```
 */
export interface ListRegionNode extends IRNodeBase {
  kind: "list-region"

  /** The source of the list ref being iterated (e.g., "doc.items") */
  listSource: string

  /** The loop variable name (e.g., "item") */
  itemVariable: string

  /** Optional index variable name if destructured (e.g., "i" from `for (const [i, item] of ...)`) */
  indexVariable: string | null

  /** The body of the loop - what to render for each item */
  body: ChildNode[]

  /**
   * Whether items in this list have reactive content that depends on item properties.
   * If true, each item needs its own subscriptions.
   */
  hasReactiveItems: boolean
}

/**
 * A branch in a conditional region.
 */
export interface ConditionalBranch {
  /** The condition expression (null for else branch) */
  condition: ExpressionNode | null

  /** The content to render when this branch is active */
  body: ChildNode[]

  span: SourceSpan
}

/**
 * A conditional region from an `if` statement.
 *
 * ```typescript
 * if (doc.count.get() > 0) {
 *   p("Has items")
 * } else {
 *   p("Empty")
 * }
 * ```
 */
export interface ConditionalRegionNode extends IRNodeBase {
  kind: "conditional-region"

  /**
   * The branches of this conditional.
   * - First branch has the `if` condition
   * - Middle branches have `else if` conditions
   * - Last branch may have null condition (the `else` branch)
   */
  branches: ConditionalBranch[]

  /**
   * For reactive conditions, the ref to subscribe to.
   * This may be different from the condition expression if the condition
   * uses a PlainValueRef (we subscribe to the parent container instead).
   */
  subscriptionTarget: string | null
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
 * A static (non-reactive) for...of loop.
 *
 * Unlike ListRegionNode which is for delta-driven reactive lists,
 * this represents a loop that runs once at render time.
 *
 * ```typescript
 * for (const x of [1, 2, 3]) {
 *   li(x)
 * }
 * ```
 */
export interface StaticLoopNode extends IRNodeBase {
  kind: "static-loop"

  /** The iterable expression source (e.g., "[1, 2, 3]", "someArray") */
  iterableSource: string

  /** The loop variable name */
  itemVariable: string

  /** Optional index variable name */
  indexVariable: string | null

  /** The analyzed body — elements are still discovered */
  body: ChildNode[]
}

/**
 * A static (non-reactive) conditional.
 *
 * Unlike ConditionalRegionNode which subscribes to reactive conditions,
 * this represents a conditional that evaluates once at render time.
 *
 * ```typescript
 * if (true) {
 *   p("always shown")
 * }
 * ```
 */
export interface StaticConditionalNode extends IRNodeBase {
  kind: "static-conditional"

  /** The condition expression source */
  conditionSource: string

  /** Then branch body */
  thenBody: ChildNode[]

  /** Else branch body (if present) */
  elseBody: ChildNode[] | null
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
  | ListRegionNode
  | ConditionalRegionNode
  | BindingNode
  | StatementNode
  | StaticLoopNode
  | StaticConditionalNode

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
  allDependencies: string[]

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
 * Check if a node is a list region.
 */
export function isListRegionNode(node: ChildNode): node is ListRegionNode {
  return node.kind === "list-region"
}

/**
 * Check if a node is a conditional region.
 */
export function isConditionalRegionNode(
  node: ChildNode,
): node is ConditionalRegionNode {
  return node.kind === "conditional-region"
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
 * Check if a node is a static loop.
 */
export function isStaticLoopNode(node: ChildNode): node is StaticLoopNode {
  return node.kind === "static-loop"
}

/**
 * Check if a node is a static conditional.
 */
export function isStaticConditionalNode(
  node: ChildNode,
): node is StaticConditionalNode {
  return node.kind === "static-conditional"
}

/**
 * Check if content is reactive (varies at runtime).
 */
export function isReactiveContent(node: ContentNode): boolean {
  return node.bindingTime === "reactive"
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
  dependencies: string[],
  span: SourceSpan,
): ContentValue {
  return {
    kind: "content",
    source,
    bindingTime,
    dependencies,
    span,
  }
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
 */
export function createElement(
  tag: string,
  attributes: AttributeNode[],
  eventHandlers: EventHandlerNode[],
  bindings: ElementBinding[],
  children: ChildNode[],
  span: SourceSpan,
): ElementNode {
  const isReactive =
    attributes.some(attr => isReactiveContent(attr.value)) ||
    bindings.length > 0 ||
    children.some(child => isReactiveContent(child)) ||
    children.some(child => child.kind === "element" && child.isReactive) ||
    children.some(
      child =>
        child.kind === "list-region" || child.kind === "conditional-region",
    )

  return {
    kind: "element",
    tag,
    attributes,
    eventHandlers,
    bindings,
    children,
    isReactive,
    span,
  }
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
 * Create a list region node.
 */
export function createListRegion(
  listSource: string,
  itemVariable: string,
  indexVariable: string | null,
  body: ChildNode[],
  span: SourceSpan,
): ListRegionNode {
  const hasReactiveItems = body.some(
    child =>
      isReactiveContent(child) ||
      (child.kind === "element" && child.isReactive) ||
      child.kind === "list-region" ||
      child.kind === "conditional-region",
  )

  return {
    kind: "list-region",
    listSource,
    itemVariable,
    indexVariable,
    body,
    hasReactiveItems,
    span,
  }
}

/**
 * Create a static loop node.
 */
export function createStaticLoop(
  iterableSource: string,
  itemVariable: string,
  indexVariable: string | null,
  body: ChildNode[],
  span: SourceSpan,
): StaticLoopNode {
  return {
    kind: "static-loop",
    iterableSource,
    itemVariable,
    indexVariable,
    body,
    span,
  }
}

/**
 * Create a static conditional node.
 */
export function createStaticConditional(
  conditionSource: string,
  thenBody: ChildNode[],
  elseBody: ChildNode[] | null,
  span: SourceSpan,
): StaticConditionalNode {
  return {
    kind: "static-conditional",
    conditionSource,
    thenBody,
    elseBody,
    span,
  }
}

/**
 * Create a conditional branch.
 */
export function createConditionalBranch(
  condition: ExpressionNode | null,
  body: ChildNode[],
  span: SourceSpan,
): ConditionalBranch {
  return {
    condition,
    body,
    span,
  }
}

/**
 * Create a conditional region node.
 */
export function createConditionalRegion(
  branches: ConditionalBranch[],
  subscriptionTarget: string | null,
  span: SourceSpan,
): ConditionalRegionNode {
  return {
    kind: "conditional-region",
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
  // Collect all dependencies from the tree
  const allDependencies = new Set<string>()

  function collectDependencies(nodes: ChildNode[]): void {
    for (const node of nodes) {
      if (isReactiveContent(node)) {
        for (const dep of node.dependencies) {
          allDependencies.add(dep)
        }
      } else if (node.kind === "element") {
        for (const attr of node.attributes) {
          if (isReactiveContent(attr.value)) {
            for (const dep of attr.value.dependencies) {
              allDependencies.add(dep)
            }
          }
        }
        collectDependencies(node.children)
      } else if (node.kind === "list-region") {
        allDependencies.add(node.listSource)
        collectDependencies(node.body)
      } else if (node.kind === "static-loop") {
        collectDependencies(node.body)
      } else if (node.kind === "static-conditional") {
        collectDependencies(node.thenBody)
        if (node.elseBody) {
          collectDependencies(node.elseBody)
        }
      } else if (node.kind === "conditional-region") {
        if (node.subscriptionTarget) {
          allDependencies.add(node.subscriptionTarget)
        }
        for (const branch of node.branches) {
          if (branch.condition) {
            for (const dep of branch.condition.dependencies) {
              allDependencies.add(dep)
            }
          }
          collectDependencies(branch.body)
        }
      } else if (node.kind === "binding") {
        allDependencies.add(node.refSource)
      }
    }
  }

  // Also collect from props
  for (const prop of props) {
    if (isReactiveContent(prop.value)) {
      for (const dep of prop.value.dependencies) {
        allDependencies.add(dep)
      }
    }
  }

  collectDependencies(children)

  const isReactive = allDependencies.size > 0

  return {
    kind: "builder",
    factoryName,
    props,
    eventHandlers,
    children,
    allDependencies: Array.from(allDependencies),
    isReactive,
    span,
  }
}
