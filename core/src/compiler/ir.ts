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
  | "text"
  | "expression"
  | "list-region"
  | "conditional-region"
  | "binding"

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
 * Classification of expressions by reactivity.
 */
export type ExpressionKind = "static" | "reactive"

/**
 * A captured expression from the source code.
 *
 * Expressions are either static (can be evaluated once) or reactive
 * (must be re-evaluated when dependencies change).
 */
export interface ExpressionNode extends IRNodeBase {
  kind: "expression"

  /** The original source text of the expression */
  source: string

  /** Whether this expression is static or reactive */
  expressionKind: ExpressionKind

  /**
   * For reactive expressions, the refs that this expression depends on.
   * Each entry is the source text of the ref access (e.g., "doc.count", "item.text").
   */
  dependencies: string[]
}

// =============================================================================
// Content Types
// =============================================================================

/**
 * Static text content (string literal).
 */
export interface TextNode extends IRNodeBase {
  kind: "text"

  /** The text content */
  value: string
}

/**
 * Dynamic content that may be static or reactive.
 */
export type ContentNode = TextNode | ExpressionNode

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
 * An HTML element.
 *
 * Elements can have:
 * - Static or reactive attributes
 * - Static or reactive children
 * - Event handlers
 */
export interface ElementNode extends IRNodeBase {
  kind: "element"

  /** HTML tag name (e.g., "div", "span", "input") */
  tag: string

  /** Attributes on this element */
  attributes: AttributeNode[]

  /** Event handlers on this element */
  eventHandlers: EventHandlerNode[]

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
 * A two-way binding on an input element.
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

  /** The element this binding is attached to */
  element: ElementNode
}

// =============================================================================
// Union Types
// =============================================================================

/**
 * Any node that can be a child of an element or builder.
 */
export type ChildNode =
  | ElementNode
  | TextNode
  | ExpressionNode
  | ListRegionNode
  | ConditionalRegionNode
  | BindingNode

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
 * Check if a node is a text node.
 */
export function isTextNode(node: ChildNode): node is TextNode {
  return node.kind === "text"
}

/**
 * Check if a node is an expression.
 */
export function isExpressionNode(node: ChildNode): node is ExpressionNode {
  return node.kind === "expression"
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
 * Check if an expression is reactive.
 */
export function isReactiveExpression(node: ExpressionNode): boolean {
  return node.expressionKind === "reactive"
}

/**
 * Check if content is reactive.
 */
export function isReactiveContent(node: ContentNode): boolean {
  return node.kind === "expression" && node.expressionKind === "reactive"
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
 * Create a text node.
 */
export function createTextNode(value: string, span: SourceSpan): TextNode {
  return { kind: "text", value, span }
}

/**
 * Create a static expression node.
 */
export function createStaticExpression(
  source: string,
  span: SourceSpan,
): ExpressionNode {
  return {
    kind: "expression",
    source,
    expressionKind: "static",
    dependencies: [],
    span,
  }
}

/**
 * Create a reactive expression node.
 */
export function createReactiveExpression(
  source: string,
  dependencies: string[],
  span: SourceSpan,
): ExpressionNode {
  return {
    kind: "expression",
    source,
    expressionKind: "reactive",
    dependencies,
    span,
  }
}

/**
 * Create an element node.
 */
export function createElement(
  tag: string,
  attributes: AttributeNode[],
  eventHandlers: EventHandlerNode[],
  children: ChildNode[],
  span: SourceSpan,
): ElementNode {
  const isReactive =
    attributes.some(attr => isReactiveContent(attr.value)) ||
    children.some(
      child =>
        child.kind === "expression" && child.expressionKind === "reactive",
    ) ||
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
    children,
    isReactive,
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
      (child.kind === "expression" && child.expressionKind === "reactive") ||
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
      if (node.kind === "expression" && node.expressionKind === "reactive") {
        for (const dep of node.dependencies) {
          allDependencies.add(dep)
        }
      } else if (node.kind === "element") {
        for (const attr of node.attributes) {
          if (
            attr.value.kind === "expression" &&
            attr.value.expressionKind === "reactive"
          ) {
            for (const dep of attr.value.dependencies) {
              allDependencies.add(dep)
            }
          }
        }
        collectDependencies(node.children)
      } else if (node.kind === "list-region") {
        allDependencies.add(node.listSource)
        collectDependencies(node.body)
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
    if (
      prop.value.kind === "expression" &&
      prop.value.expressionKind === "reactive"
    ) {
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
