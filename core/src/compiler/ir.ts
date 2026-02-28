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

  /**
   * Slot kind for the body - computed at IR creation time.
   * Determines whether create handler returns single node or fragment.
   */
  bodySlotKind: SlotKind
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
 * Check if a node is reactive content (varies at runtime).
 */
export function isReactiveContent(node: ChildNode): node is ContentValue {
  return node.kind === "content" && node.bindingTime === "reactive"
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
      const aAttr = a.attributes.find(attr => attr.name === aAttrNames[i])!
      const bAttr = b.attributes.find(attr => attr.name === aAttrNames[i])!

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

  // Regions, loops, conditionals - not mergeable
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
    const condition = branches[0].condition!
    const mergedBody: ChildNode[] = []

    for (let i = 0; i < bodyLength; i++) {
      const nodeA = branches[0].body[i]
      const nodeB = branches[1].body[i]
      const result = mergeNode(nodeA, nodeB, condition)

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
      const condition = branch.condition!
      const nodeA = branch.body[nodeIndex]

      const result = mergeNode(nodeA, current, condition)
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
    bodySlotKind: computeSlotKind(body),
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
