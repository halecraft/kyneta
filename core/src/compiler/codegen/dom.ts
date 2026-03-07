/**
 * DOM Code Generation from IR
 *
 * This module transforms IR nodes into JavaScript code that creates and manipulates DOM.
 * All functions are pure - they take IR and return strings.
 *
 * The generated code:
 * - Uses direct DOM APIs (createElement, appendChild, etc.)
 * - Calls runtime functions (subscribe, listRegion, conditionalRegion)
 * - Manages scopes for cleanup
 *
 * @packageDocumentation
 */

import type {
  AttributeNode,
  BuilderNode,
  ChildNode,
  ConditionalNode,
  ContentNode,
  ElementNode,
  EventHandlerNode,
  LoopNode,
  StatementNode,
  TemplateHole,
} from "../ir.js"
import { computeSlotKind } from "../ir.js"
import {
  extractTemplate,
  generateTemplateDeclaration,
  generateWalkCode,
  planWalk,
  simpleHash,
} from "../template.js"

// =============================================================================
// Code Generation Result
// =============================================================================

/**
 * Result of code generation, including module-level declarations.
 *
 * This allows codegen to return both the function body and any declarations
 * that should be hoisted to module scope (e.g., template elements).
 */
export interface CodegenResult {
  /** The generated function body code */
  code: string

  /** Module-level declarations to hoist (e.g., template elements) */
  moduleDeclarations: string[]
}

// =============================================================================
// Code Generation Options
// =============================================================================

/**
 * Options for DOM code generation.
 */
export interface DOMCodegenOptions {
  /**
   * The variable name for the scope parameter.
   * @default "scope"
   */
  scopeVar?: string

  /**
   * Prefix for generated variable names.
   * @default "_"
   */
  varPrefix?: string

  /**
   * Indentation string.
   * @default "  "
   */
  indent?: string

  /**
   * Current indentation level.
   * @default 0
   */
  indentLevel?: number

  /**
   * Starting offset for the template counter.
   *
   * When multiple builders are compiled in the same file (e.g., a
   * component definition + its usage), each needs unique template
   * variable names. The caller passes the running total so each
   * builder starts where the previous one left off.
   *
   * @default 0
   */
  templateCounterOffset?: number
}

// =============================================================================
// Code Generation State
// =============================================================================

/**
 * Internal state for code generation.
 */
interface CodegenState {
  scopeVar: string
  varPrefix: string
  indent: string
  indentLevel: number
  varCounter: number
  /** Template deduplication cache: htmlHash → templateVarName */
  templateCache: Map<string, string>
  /** Template counter for generating unique names */
  templateCounter: number
  /** Collected template declarations to hoist to module scope */
  templateDeclarations: string[]
}

/**
 * Create initial codegen state from options.
 */
function createState(options: DOMCodegenOptions = {}): CodegenState {
  return {
    scopeVar: options.scopeVar ?? "scope",
    varPrefix: options.varPrefix ?? "_",
    indent: options.indent ?? "  ",
    indentLevel: options.indentLevel ?? 0,
    varCounter: 0,
    templateCache: new Map(),
    templateCounter: options.templateCounterOffset ?? 0,
    templateDeclarations: [],
  }
}

/**
 * Generate a unique variable name.
 */
function genVar(state: CodegenState, hint: string = "el"): string {
  return `${state.varPrefix}${hint}${state.varCounter++}`
}

/**
 * Get current indentation string.
 */
function getIndent(state: CodegenState): string {
  return state.indent.repeat(state.indentLevel)
}

/**
 * Create a child state with increased indentation.
 */
function indented(state: CodegenState): CodegenState {
  return { ...state, indentLevel: state.indentLevel + 1 }
}

// =============================================================================
// Reactive Content Subscription Helper
// =============================================================================

/**
 * Generate subscription code for reactive content.
 *
 * This is the shared logic for reactive text content subscriptions, used by
 * both `generateChild` and `generateBodyWithReturn`. The caller is responsible
 * for creating the text node and handling placement (appendChild vs return).
 *
 * Handles three cases:
 * 1. Direct TextRef read (node.directReadSource && deltaKind === "text"):
 *    → emit textRegion(textVar, directReadSource, scopeVar)
 * 2. Single dependency:
 *    → emit subscribeWithValue(dep, getter, setter, scopeVar)
 * 3. Multiple dependencies:
 *    → emit subscribeMultiple([deps], callback, scopeVar)
 *
 * @param node - The reactive content node
 * @param textVar - The variable name of the text node
 * @param state - The codegen state
 * @returns Array of code lines for the subscription
 */
function generateReactiveContentSubscription(
  node: ContentNode,
  textVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  if (node.dependencies.length === 0) {
    return lines
  }

  // Check for direct TextRef read optimization
  if (
    node.directReadSource &&
    node.dependencies.length === 1 &&
    node.dependencies[0].deltaKind === "text"
  ) {
    // Direct read of a TextRef — use textRegion for surgical updates
    lines.push(
      `${ind}textRegion(${textVar}, ${node.directReadSource}, ${state.scopeVar})`,
    )
  } else if (node.dependencies.length === 1) {
    // Single dependency - use subscribeWithValue
    const dep = node.dependencies[0]
    lines.push(
      `${ind}subscribeWithValue(${dep.source}, () => ${node.source}, (v) => {`,
    )
    lines.push(`${ind}${state.indent}${textVar}.textContent = String(v)`)
    lines.push(`${ind}}, ${state.scopeVar})`)
  } else {
    // Multiple dependencies - use subscribeMultiple with initial render
    const depSources = node.dependencies.map(d => d.source).join(", ")
    // Set initial value
    lines.push(`${ind}${textVar}.textContent = String(${node.source})`)
    // Subscribe to all dependencies
    lines.push(`${ind}subscribeMultiple([${depSources}], () => {`)
    lines.push(
      `${ind}${state.indent}${textVar}.textContent = String(${node.source})`,
    )
    lines.push(`${ind}}, ${state.scopeVar})`)
  }

  return lines
}

// =============================================================================
// Content Generation
// =============================================================================

/**
 * Generate code for content at any binding time.
 */
function generateContent(
  node: ContentNode,
  _state: CodegenState,
): { code: string; isLiteral: boolean; value?: string } {
  if (node.bindingTime === "literal") {
    // source is already a JSON-encoded string literal
    // Extract the actual string value for the return type
    const value = JSON.parse(node.source)
    return { code: node.source, isLiteral: true, value }
  }
  // For "render" and "reactive" binding times, source is a JS expression
  return { code: node.source, isLiteral: false }
}

// =============================================================================
// Attribute Generation
// =============================================================================

/**
 * Generate the correct DOM update expression for an attribute.
 *
 * Maps attribute names to the correct DOM API: property-based setters for
 * well-known attributes (`value`, `checked`, `disabled`, `class`, `style`,
 * `data-*`), and `setAttribute` for everything else.
 *
 * This is the single source of truth for attribute update expressions,
 * used by `generateAttributeSet`, `generateAttributeSubscription`, and
 * `generateHoleSetup` (template cloning path). Having one function
 * prevents the cloning path from diverging (e.g., using `setAttribute`
 * where the non-cloning path uses `.value =`).
 *
 * @param elementVar - Variable name of the DOM element
 * @param attrName - Attribute name (e.g., "value", "class", "data-foo")
 * @param valueExpr - JavaScript expression for the attribute value
 * @returns A single JavaScript statement string (without trailing semicolon)
 */
function generateAttributeUpdateCode(
  elementVar: string,
  attrName: string,
  valueExpr: string,
): string {
  if (attrName === "class") {
    return `${elementVar}.className = ${valueExpr}`
  } else if (attrName === "style") {
    return `Object.assign(${elementVar}.style, ${valueExpr})`
  } else if (attrName === "value") {
    return `${elementVar}.value = ${valueExpr}`
  } else if (attrName === "checked") {
    return `${elementVar}.checked = ${valueExpr}`
  } else if (attrName === "disabled") {
    return `${elementVar}.disabled = ${valueExpr}`
  } else if (attrName.startsWith("data-")) {
    const dataKey = camelCase(attrName.slice(5))
    return `${elementVar}.dataset.${dataKey} = ${valueExpr}`
  } else {
    return `${elementVar}.setAttribute(${JSON.stringify(attrName)}, ${valueExpr})`
  }
}

/**
 * Check if a reactive attribute should use inputTextRegion for delta-aware
 * subscription instead of a naive subscribe.
 *
 * The condition is: `value` attribute + single dependency with deltaKind
 * "text" + directReadSource set (i.e., the expression is a direct read
 * like `ref.toString()` or `ref.get()`).
 */
function isInputTextRegionCandidate(attr: AttributeNode): boolean {
  return (
    attr.name === "value" &&
    attr.value.bindingTime === "reactive" &&
    !!attr.value.directReadSource &&
    attr.value.dependencies.length === 1 &&
    attr.value.dependencies[0].deltaKind === "text"
  )
}

/**
 * Generate code to set an attribute.
 */
function generateAttributeSet(
  elementVar: string,
  attr: AttributeNode,
  state: CodegenState,
): string[] {
  // Skip static set when inputTextRegion will handle initialization
  if (isInputTextRegionCandidate(attr)) {
    return []
  }

  const lines: string[] = []
  const ind = getIndent(state)
  const content = generateContent(attr.value, state)

  // For literal style, use setAttribute (the value is a plain string)
  if (attr.name === "style" && attr.value.bindingTime === "literal") {
    lines.push(
      `${ind}${elementVar}.setAttribute("style", ${content.code})`,
    )
  } else {
    lines.push(`${ind}${generateAttributeUpdateCode(elementVar, attr.name, content.code)}`)
  }

  return lines
}

/**
 * Generate subscription for reactive attribute.
 */
function generateAttributeSubscription(
  elementVar: string,
  attr: AttributeNode,
  state: CodegenState,
): string[] {
  if (attr.value.bindingTime !== "reactive") {
    return []
  }

  const lines: string[] = []
  const ind = getIndent(state)
  const deps = attr.value.dependencies

  if (deps.length === 0) return []

  // Check for delta-aware inputTextRegion dispatch
  if (isInputTextRegionCandidate(attr)) {
    lines.push(
      `${ind}inputTextRegion(${elementVar}, ${attr.value.directReadSource}, ${state.scopeVar})`,
    )
    return lines
  }

  // Generate the update code using the shared helper
  const updateCode = generateAttributeUpdateCode(elementVar, attr.name, attr.value.source)

  if (deps.length === 1) {
    // Single dependency - use subscribe
    const dep = deps[0]
    lines.push(`${ind}subscribe(${dep.source}, () => {`)
    lines.push(`${ind}${state.indent}${updateCode}`)
    lines.push(`${ind}}, ${state.scopeVar})`)
  } else {
    // Multiple dependencies - use subscribeMultiple
    const depSources = deps.map(d => d.source).join(", ")
    lines.push(`${ind}subscribeMultiple([${depSources}], () => {`)
    lines.push(`${ind}${state.indent}${updateCode}`)
    lines.push(`${ind}}, ${state.scopeVar})`)
  }

  return lines
}

// =============================================================================
// Event Handler Generation
// =============================================================================

/**
 * Generate code to attach an event handler.
 */
function generateEventHandler(
  elementVar: string,
  handler: EventHandlerNode,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  lines.push(
    `${ind}${elementVar}.addEventListener(${JSON.stringify(handler.event)}, ${handler.handlerSource})`,
  )

  return lines
}

// =============================================================================
// Element Generation
// =============================================================================

/**
 * Generate code for an element node.
 *
 * Returns { code: string[], varName: string } where code is the lines to execute
 * and varName is the variable holding the created element.
 *
 * For components (factorySource is present), emits a component call instead of createElement.
 */
function generateElement(
  node: ElementNode,
  state: CodegenState,
): { code: string[]; varName: string } {
  const lines: string[] = []
  const ind = getIndent(state)
  const elementVar = genVar(state, node.tag)

  // Check if this is a component call
  if (node.factorySource) {
    // Component: call the factory function
    // The factory returns an Element (a function), which we call with a child scope
    //
    // Component signature: (props?) => (scope) => Node
    // Usage: MyComponent({ title: "Hi" }) becomes MyComponent({ title: "Hi" })(scope.createChild())
    const hasProps = node.attributes.length > 0 || node.eventHandlers.length > 0

    if (hasProps) {
      // Build props object
      const propsEntries: string[] = []
      for (const attr of node.attributes) {
        propsEntries.push(`${attr.name}: ${attr.value.source}`)
      }
      for (const handler of node.eventHandlers) {
        propsEntries.push(`${handler.propName}: ${handler.handlerSource}`)
      }
      const propsArg = `{ ${propsEntries.join(", ")} }`
      lines.push(
        `${ind}const ${elementVar} = ${node.factorySource}(${propsArg})(${state.scopeVar}.createChild())`,
      )
    } else {
      // No props: MyComponent()
      lines.push(
        `${ind}const ${elementVar} = ${node.factorySource}()(${state.scopeVar}.createChild())`,
      )
    }

    // Note: Component children (builder pattern) are not yet supported.
    // Components are expected to manage their own children internally.
    // Future enhancement: pass children as builder callback.

    return { code: lines, varName: elementVar }
  }

  // Regular HTML element: create with createElement
  lines.push(
    `${ind}const ${elementVar} = document.createElement(${JSON.stringify(node.tag)})`,
  )

  // Set static attributes
  for (const attr of node.attributes) {
    lines.push(...generateAttributeSet(elementVar, attr, state))
  }

  // Set up reactive attribute subscriptions
  for (const attr of node.attributes) {
    lines.push(...generateAttributeSubscription(elementVar, attr, state))
  }

  // Attach event handlers
  for (const handler of node.eventHandlers) {
    lines.push(...generateEventHandler(elementVar, handler, state))
  }

  // Set up two-way bindings
  for (const binding of node.bindings) {
    lines.push(...generateBinding(elementVar, binding, state))
  }

  // Generate children
  for (const child of node.children) {
    const childResult = generateChild(child, elementVar, state)
    lines.push(...childResult.code)
  }

  return { code: lines, varName: elementVar }
}

// =============================================================================
// Binding Generation
// =============================================================================

/**
 * Generate code for a two-way binding.
 */
function generateBinding(
  elementVar: string,
  binding: import("../ir.js").ElementBinding,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  if (binding.bindingType === "checked") {
    // Checkbox binding
    lines.push(
      `${ind}bindChecked(${elementVar}, ${binding.refSource}, ${state.scopeVar})`,
    )
  } else if (binding.attribute === "value") {
    // Determine if numeric or text based on element type
    // For now, assume text - we could enhance this with element type info
    lines.push(
      `${ind}bindTextValue(${elementVar}, ${binding.refSource}, ${state.scopeVar})`,
    )
  }

  return lines
}

// =============================================================================
// Child Generation
// =============================================================================

/**
 * Generate code for a child node.
 *
 * This handles all child types: elements, text, expressions, regions.
 */
function generateChild(
  node: ChildNode,
  parentVar: string,
  state: CodegenState,
): { code: string[] } {
  const lines: string[] = []
  const ind = getIndent(state)

  switch (node.kind) {
    case "element": {
      const result = generateElement(node, state)
      lines.push(...result.code)
      lines.push(`${ind}${parentVar}.appendChild(${result.varName})`)
      break
    }

    case "content": {
      const textVar = genVar(state, "text")

      if (node.bindingTime === "literal") {
        // Literal - source is JSON-encoded string
        lines.push(
          `${ind}const ${textVar} = document.createTextNode(${node.source})`,
        )
        lines.push(`${ind}${parentVar}.appendChild(${textVar})`)
      } else if (node.bindingTime === "render") {
        // Render-time - evaluate once
        lines.push(
          `${ind}const ${textVar} = document.createTextNode(String(${node.source}))`,
        )
        lines.push(`${ind}${parentVar}.appendChild(${textVar})`)
      } else {
        // Reactive - needs subscription
        lines.push(`${ind}const ${textVar} = document.createTextNode("")`)
        lines.push(`${ind}${parentVar}.appendChild(${textVar})`)

        // Generate subscription code using shared helper
        lines.push(...generateReactiveContentSubscription(node, textVar, state))
      }
      break
    }

    case "loop": {
      if (node.iterableBindingTime === "reactive") {
        lines.push(...generateReactiveLoop(node, parentVar, state))
      } else {
        lines.push(...generateRenderLoop(node, parentVar, state))
      }
      break
    }

    case "conditional": {
      lines.push(...generateConditional(node, parentVar, state))
      break
    }

    case "binding": {
      // Bindings are handled as part of element generation
      // This case handles standalone binding nodes if they occur
      break
    }

    case "statement": {
      // Emit statement source verbatim
      // Statements don't produce DOM nodes, they just execute
      lines.push(`${ind}${node.source}`)
      break
    }
  }

  return { code: lines }
}

// =============================================================================
// Body Generation Helper
// =============================================================================

/**
 * Generate code for a body that must return a DOM node.
 *
 * This is used by list regions (create callback) and conditional regions
 * (whenTrue/whenFalse callbacks). It handles:
 * - Empty body → return empty text node
 * - Single element with leading statements only → return element directly
 * - Multiple elements or interleaved statements → wrap in fragment, return fragment
 *
 * Returning elements directly (instead of always using fragments) is important
 * because DocumentFragment nodes become empty after insertion and lose their
 * parentNode reference, breaking subsequent removal operations.
 */
function generateBodyWithReturn(
  body: ChildNode[],
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  if (body.length === 0) {
    // Empty body
    lines.push(`${ind}return document.createTextNode("")`)
    return lines
  }

  // Check if we can use the direct-return optimization:
  // - All statements must come before any DOM-producing node (no interleaving)
  // - There must be exactly one DOM-producing node
  // - The DOM-producing node must be a simple type (element, text, expression)
  const canOptimize = checkCanOptimizeDirectReturn(body)

  if (canOptimize) {
    const { leadingStatements, domNode } = canOptimize

    // Emit leading statements first
    for (const stmt of leadingStatements) {
      lines.push(`${ind}${stmt.source}`)
    }

    if (domNode.kind === "element") {
      // Generate element and return it directly
      const result = generateElement(domNode, state)
      lines.push(...result.code)
      lines.push(`${ind}return ${result.varName}`)
    } else if (domNode.kind === "content") {
      // For content, create a text node
      const textVar = genVar(state, "text")
      if (domNode.bindingTime === "literal") {
        // Literal - source is JSON-encoded string
        lines.push(
          `${ind}const ${textVar} = document.createTextNode(${domNode.source})`,
        )
      } else if (domNode.bindingTime === "render") {
        // Render-time - evaluate once
        lines.push(
          `${ind}const ${textVar} = document.createTextNode(String(${domNode.source}))`,
        )
      } else {
        // Reactive - create text node, will be updated via subscription
        lines.push(`${ind}const ${textVar} = document.createTextNode("")`)
        // Generate subscription code using shared helper
        lines.push(
          ...generateReactiveContentSubscription(domNode, textVar, state),
        )
      }
      lines.push(`${ind}return ${textVar}`)
    }

    return lines
  }

  // Multiple DOM nodes, interleaved statements, or complex structure: use fragment
  return generateBodyWithFragment(body, state)
}

/**
 * Check if a body can use the direct-return optimization.
 *
 * Returns the leading statements and single DOM node if optimization is possible,
 * or null if the fragment approach is required.
 *
 * Delegates to computeSlotKind for body analysis, then verifies no interleaving.
 *
 * Optimization is possible when:
 * 1. computeSlotKind returns "single" (exactly one DOM node)
 * 2. All statements come before the DOM node (no interleaving)
 */
function checkCanOptimizeDirectReturn(body: ChildNode[]): {
  leadingStatements: StatementNode[]
  domNode: ElementNode | ContentNode
} | null {
  // Use computeSlotKind to determine if body produces single node
  if (computeSlotKind(body) !== "single") {
    return null
  }

  // Find the single DOM-producing node and verify no interleaving
  const leadingStatements: StatementNode[] = []
  let domNode: ChildNode | null = null

  for (const child of body) {
    if (child.kind === "statement") {
      if (domNode) {
        // Statement after DOM node - interleaving detected
        return null
      }
      leadingStatements.push(child)
    } else {
      // This is the DOM node (computeSlotKind guarantees only one)
      domNode = child
    }
  }

  // computeSlotKind returned "single" so domNode must exist
  return {
    leadingStatements,
    domNode: domNode as ElementNode | ContentNode,
  }
}

/**
 * Generate body code using a DocumentFragment container.
 * Used when there are multiple DOM-producing nodes.
 */
function generateBodyWithFragment(
  body: ChildNode[],
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  const fragVar = genVar(state, "frag")
  lines.push(`${ind}const ${fragVar} = document.createDocumentFragment()`)

  for (const child of body) {
    const childResult = generateChild(child, fragVar, state)
    lines.push(...childResult.code)
  }

  lines.push(`${ind}return ${fragVar}`)

  return lines
}

// =============================================================================
// List Region Generation
// =============================================================================

/**
 * Generate code for a list region.
 */
function generateReactiveLoop(
  node: LoopNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  lines.push(`${ind}listRegion(${parentVar}, ${node.iterableSource}, {`)

  // Generate create handler
  const params = node.indexVariable
    ? `(${node.itemVariable}, ${node.indexVariable})`
    : `(${node.itemVariable}, _index)`

  lines.push(`${innerInd}create: ${params} => {`)

  // Generate body using shared helper
  const bodyState = indented(innerState)
  lines.push(...generateBodyWithReturn(node.body, bodyState))

  lines.push(`${innerInd}},`)

  // Emit slotKind from compile-time analysis
  lines.push(`${innerInd}slotKind: ${JSON.stringify(node.bodySlotKind)},`)

  // Emit isReactive from compile-time analysis — skips scope allocation for static items
  lines.push(`${innerInd}isReactive: ${node.hasReactiveItems},`)

  lines.push(`${ind}}, ${state.scopeVar})`)

  return lines
}

// =============================================================================
// Conditional Region Generation
// =============================================================================

/**
 * Generate code for a conditional.
 *
 * Unified generator that dispatches on binding time:
 * - subscriptionTarget === null → render-time inline if
 * - subscriptionTarget !== null → reactive conditional (dissolution or conditionalRegion)
 */
function generateConditional(
  node: ConditionalNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  // Generate condition function
  const conditionExpr = node.branches[0].condition
  if (!conditionExpr) {
    // No condition - shouldn't happen for valid conditionals
    return lines
  }

  // Render-time conditional: emit inline if statement
  if (node.subscriptionTarget === null) {
    return generateRenderConditional(node, parentVar, state)
  }

  // Reactive conditional: emit conditionalRegion
  // (Dissolvable conditionals are already resolved at the IR level by
  // dissolveConditionals — any ConditionalNode reaching here is non-dissolvable.)
  const elseBranch = node.branches.find(b => b.condition === null)
  const markerVar = genVar(state, "marker")
  lines.push(`${ind}const ${markerVar} = document.createComment("kinetic:if")`)
  lines.push(`${ind}${parentVar}.appendChild(${markerVar})`)

  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  lines.push(
    `${ind}conditionalRegion(${markerVar}, ${node.subscriptionTarget?.source}, () => ${conditionExpr.source}, {`,
  )

  // Generate whenTrue handler
  lines.push(`${innerInd}whenTrue: () => {`)
  lines.push(...generateBranchBody(node.branches[0].body, indented(innerState)))
  lines.push(`${innerInd}},`)

  // Generate whenFalse handler
  if (elseBranch) {
    lines.push(`${innerInd}whenFalse: () => {`)
    lines.push(...generateBranchBody(elseBranch.body, indented(innerState)))
    lines.push(`${innerInd}},`)
  }

  // Emit slotKind from compile-time analysis (use first branch's slotKind)
  lines.push(
    `${innerInd}slotKind: ${JSON.stringify(node.branches[0].slotKind)},`,
  )

  lines.push(`${ind}}, ${state.scopeVar})`)

  return lines
}

/**
 * Generate code for a render-time conditional (inline if statement).
 *
 * Emits a plain if/else-if/else chain that runs once at render time.
 * No markers, no runtime region calls.
 */
function generateRenderConditional(
  node: ConditionalNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)

  for (let i = 0; i < node.branches.length; i++) {
    const branch = node.branches[i]
    const isFirst = i === 0
    const isElse = branch.condition === null

    if (isElse) {
      lines.push(`${ind}} else {`)
    } else if (isFirst) {
      lines.push(`${ind}if (${branch.condition?.source}) {`)
    } else {
      lines.push(`${ind}} else if (${branch.condition?.source}) {`)
    }

    // Generate branch body
    for (const child of branch.body) {
      const childResult = generateChild(child, parentVar, innerState)
      lines.push(...childResult.code)
    }
  }

  lines.push(`${ind}}`)

  return lines
}

/**
 * Generate code for a branch body.
 *
 * @deprecated Use generateBodyWithReturn instead. This is kept for API compatibility
 * but delegates to the shared helper.
 */
function generateBranchBody(body: ChildNode[], state: CodegenState): string[] {
  return generateBodyWithReturn(body, state)
}

// =============================================================================
// Static Loop Generation
// =============================================================================

/**
 * Generate code for a static loop (non-reactive for...of).
 *
 * Unlike list regions which use listRegion for delta-driven updates,
 * static loops run once at render time and create elements directly.
 */
function generateRenderLoop(
  node: LoopNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)

  // Generate for...of loop
  const loopVar = node.indexVariable
    ? `[${node.indexVariable}, ${node.itemVariable}]`
    : node.itemVariable

  lines.push(`${ind}for (const ${loopVar} of ${node.iterableSource}) {`)

  // Generate body - each child is created and appended to parent
  for (const child of node.body) {
    const childResult = generateChild(child, parentVar, innerState)
    lines.push(...childResult.code)
  }

  lines.push(`${ind}}`)

  return lines
}

// =============================================================================
// Template Cloning Generation
// =============================================================================

/**
 * Get or create a template declaration for the given HTML.
 *
 * Uses the template cache in state to deduplicate identical templates.
 * Returns the template variable name.
 */
function getOrCreateTemplate(html: string, state: CodegenState): string {
  const hash = simpleHash(html)
  const existing = state.templateCache.get(hash)
  if (existing) {
    return existing
  }

  const varName = `_tmpl_${state.templateCounter++}`
  state.templateCache.set(hash, varName)
  state.templateDeclarations.push(generateTemplateDeclaration(html, varName))
  return varName
}

/**
 * Generate code to set up a single hole (wire reactivity to grabbed node).
 *
 * @param hole - The template hole to wire up
 * @param holesVar - Variable name for the holes array
 * @param state - Codegen state
 * @returns Array of code lines
 */
function generateHoleSetup(
  hole: TemplateHole,
  holesVar: string,
  holeIndex: number,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const nodeRef = `${holesVar}[${holeIndex}]`

  switch (hole.kind) {
    case "text": {
      // Dynamic text content — the grabbed node is a comment placeholder
      // (<!---->) that we replace with a real Text node so subscriptions
      // can update it via .textContent / .data.
      const contentNode = hole.contentNode
      if (!contentNode) break

      const textVar = genVar(state, "text")
      lines.push(`${ind}const ${textVar} = document.createTextNode("")`)
      lines.push(
        `${ind}${nodeRef}.parentNode.replaceChild(${textVar}, ${nodeRef})`,
      )

      if (contentNode.bindingTime === "render") {
        // Render-time - set once
        lines.push(
          `${ind}${textVar}.textContent = String(${contentNode.source})`,
        )
      } else if (contentNode.bindingTime === "reactive") {
        // Reactive - needs subscription
        lines.push(
          ...generateReactiveContentSubscription(contentNode, textVar, state),
        )
      }
      break
    }

    case "attribute": {
      // Dynamic attribute - wire subscription to the element
      const contentNode = hole.contentNode
      const attrName = hole.attributeName
      if (!contentNode || !attrName) break

      // Check for delta-aware inputTextRegion dispatch (same condition
      // as in generateAttributeSubscription, applied to the cloning path)
      const isInputTextRegion =
        attrName === "value" &&
        contentNode.bindingTime === "reactive" &&
        !!contentNode.directReadSource &&
        contentNode.dependencies.length === 1 &&
        contentNode.dependencies[0].deltaKind === "text"

      if (isInputTextRegion) {
        // inputTextRegion handles both initialization and subscription
        lines.push(
          `${ind}inputTextRegion(${nodeRef}, ${contentNode.directReadSource}, ${state.scopeVar})`,
        )
      } else if (contentNode.bindingTime === "render") {
        // Render-time - set once, using property-based setter
        lines.push(
          `${ind}${generateAttributeUpdateCode(nodeRef, attrName, contentNode.source)}`,
        )
      } else if (contentNode.bindingTime === "reactive") {
        // Reactive - needs subscription
        const deps = contentNode.dependencies
        const updateCode = generateAttributeUpdateCode(nodeRef, attrName, contentNode.source)
        if (deps.length === 1) {
          const dep = deps[0]
          lines.push(`${ind}subscribe(${dep.source}, () => {`)
          lines.push(`${ind}${state.indent}${updateCode}`)
          lines.push(`${ind}}, ${state.scopeVar})`)
        } else if (deps.length > 1) {
          const depSources = deps.map(d => d.source).join(", ")
          // Set initial value
          lines.push(`${ind}${updateCode}`)
          // Subscribe to all deps
          lines.push(`${ind}subscribeMultiple([${depSources}], () => {`)
          lines.push(`${ind}${state.indent}${updateCode}`)
          lines.push(`${ind}}, ${state.scopeVar})`)
        }
      }
      break
    }

    case "event": {
      // Event handler - attach to the grabbed element
      const eventName = hole.eventName
      const handlerSource = hole.handlerSource
      if (!eventName || !handlerSource) break
      lines.push(
        `${ind}${nodeRef}.addEventListener(${JSON.stringify(eventName)}, ${handlerSource})`,
      )
      break
    }

    case "binding": {
      // Two-way binding - wire to the grabbed element
      const bindingType = hole.bindingType
      const refSource = hole.refSource
      if (!bindingType || !refSource) break

      if (bindingType === "checked") {
        lines.push(
          `${ind}bindChecked(${nodeRef}, ${refSource}, ${state.scopeVar})`,
        )
      } else {
        lines.push(
          `${ind}bindTextValue(${nodeRef}, ${refSource}, ${state.scopeVar})`,
        )
      }
      break
    }

    case "region": {
      // Region hole - the grabbed node is the opening comment marker
      // Pass it to listRegion or conditionalRegion as mount point
      const regionNode = hole.regionNode
      if (!regionNode) break

      if (regionNode.kind === "loop") {
        lines.push(
          ...generateReactiveLoopWithMarker(regionNode, nodeRef, state),
        )
      } else if (regionNode.kind === "conditional") {
        lines.push(...generateConditionalWithMarker(regionNode, nodeRef, state))
      }
      break
    }

    case "component": {
      // Component hole — the grabbed node is a comment placeholder.
      // Generate the component element via the existing generateElement()
      // helper (which handles factorySource), then replace the placeholder.
      const elementNode = hole.elementNode
      if (!elementNode) break

      const result = generateElement(elementNode, state)
      lines.push(...result.code)
      lines.push(
        `${ind}${nodeRef}.parentNode.replaceChild(${result.varName}, ${nodeRef})`,
      )
      break
    }
  }

  return lines
}

/**
 * Generate code for a reactive loop using an existing marker node.
 */
function generateReactiveLoopWithMarker(
  node: LoopNode,
  markerVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  lines.push(`${ind}listRegion(${markerVar}, ${node.iterableSource}, {`)

  // Generate create handler
  const params = node.indexVariable
    ? `(${node.itemVariable}, ${node.indexVariable})`
    : `(${node.itemVariable}, _index)`

  lines.push(`${innerInd}create: ${params} => {`)

  // Generate body using shared helper
  const bodyState = indented(innerState)
  lines.push(...generateBodyWithReturn(node.body, bodyState))

  lines.push(`${innerInd}},`)

  // Emit slotKind from compile-time analysis
  lines.push(`${innerInd}slotKind: ${JSON.stringify(node.bodySlotKind)},`)

  // Emit isReactive from compile-time analysis — skips scope allocation for static items
  lines.push(`${innerInd}isReactive: ${node.hasReactiveItems},`)

  lines.push(`${ind}}, ${state.scopeVar})`)

  return lines
}

/**
 * Generate code for a conditional using an existing marker node.
 */
function generateConditionalWithMarker(
  node: ConditionalNode,
  markerVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  const conditionExpr = node.branches[0].condition
  if (!conditionExpr) return lines

  // For render-time conditionals, we can't use markers - fall back not applicable
  if (node.subscriptionTarget === null) {
    // This shouldn't happen for template-cloned regions
    return lines
  }

  // Dissolvable conditionals are already resolved at the IR level by
  // dissolveConditionals — any ConditionalNode reaching here is non-dissolvable.
  const elseBranch = node.branches.find(b => b.condition === null)

  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  lines.push(
    `${ind}conditionalRegion(${markerVar}, ${node.subscriptionTarget?.source}, () => ${conditionExpr.source}, {`,
  )

  // Generate whenTrue handler
  lines.push(`${innerInd}whenTrue: () => {`)
  lines.push(...generateBranchBody(node.branches[0].body, indented(innerState)))
  lines.push(`${innerInd}},`)

  // Generate whenFalse handler
  if (elseBranch) {
    lines.push(`${innerInd}whenFalse: () => {`)
    lines.push(...generateBranchBody(elseBranch.body, indented(innerState)))
    lines.push(`${innerInd}},`)
  }

  // Emit slotKind
  lines.push(
    `${innerInd}slotKind: ${JSON.stringify(node.branches[0].slotKind)},`,
  )

  lines.push(`${ind}}, ${state.scopeVar})`)

  return lines
}

/**
 * Generate DOM code using template cloning.
 *
 * This is the optimized path that:
 * 1. Extracts a template from the IR
 * 2. Clones the template at runtime
 * 3. Walks the clone to grab hole references
 * 4. Wires subscriptions to the grabbed nodes
 *
 * Returns the function body code. Template declarations are collected
 * in state.templateDeclarations.
 */
function generateDOMWithCloning(
  node: BuilderNode,
  state: CodegenState,
): string {
  const lines: string[] = []
  const ind = getIndent(state)

  // Emit top-level statements from the builder's children.
  // Statements don't produce DOM nodes, so they aren't part of the
  // template HTML. But they may define variables used by dynamic
  // hole expressions (e.g., `const x = 1` before `p(String(x))`),
  // so they must appear before the hole setup code.
  for (const child of node.children) {
    if (child.kind === "statement") {
      lines.push(`${ind}${child.source}`)
    }
  }

  // Extract template from IR
  const template = extractTemplate(node)

  // Get or create template declaration
  const tmplVar = getOrCreateTemplate(template.html, state)

  // Clone the template
  const rootVar = genVar(state, "root")
  lines.push(
    `${ind}const ${rootVar} = ${tmplVar}.content.cloneNode(true).firstChild`,
  )

  // If there are holes, walk the clone to grab references
  if (template.holes.length > 0) {
    const ops = planWalk(template.holes)
    const walkCode = generateWalkCode(ops, template.holes.length, rootVar, ind)
    lines.push(...walkCode)

    // Wire up each hole
    for (let i = 0; i < template.holes.length; i++) {
      const hole = template.holes[i]
      lines.push(...generateHoleSetup(hole, "_holes", i, state))
    }
  }

  // Handle event handlers on the root element
  for (const handler of node.eventHandlers) {
    lines.push(...generateEventHandler(rootVar, handler, state))
  }

  // Return the root element
  lines.push(`${ind}return ${rootVar}`)

  return lines.join("\n")
}

/**
 * Check if a builder node can use template cloning.
 *
 * Template cloning requires that we can extract a meaningful template.
 * Some patterns may not be suitable for cloning.
 */
function canUseTemplateCloning(node: BuilderNode): boolean {
  // For now, always use template cloning for DOM target
  // In the future, we might skip it for very simple templates
  // or templates with complex patterns that don't benefit from cloning
  return true
}

// =============================================================================
// Builder Generation
// =============================================================================

/**
 * Generate code for a builder node.
 *
 * This is the main entry point for DOM code generation.
 */
export function generateDOM(
  node: BuilderNode,
  options: DOMCodegenOptions = {},
): string {
  const state = createState(options)
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)

  // Generate the element factory
  const rootVar = genVar(state, node.factoryName)

  lines.push(
    `${ind}const ${rootVar} = document.createElement(${JSON.stringify(node.factoryName)})`,
  )

  // Set props as attributes
  for (const prop of node.props) {
    lines.push(...generateAttributeSet(rootVar, prop, innerState))
  }

  // Set up reactive prop subscriptions
  for (const prop of node.props) {
    lines.push(...generateAttributeSubscription(rootVar, prop, innerState))
  }

  // Attach event handlers
  for (const handler of node.eventHandlers) {
    lines.push(...generateEventHandler(rootVar, handler, innerState))
  }

  // Generate children
  for (const child of node.children) {
    const childResult = generateChild(child, rootVar, innerState)
    lines.push(...childResult.code)
  }

  // Return the root element
  lines.push(`${ind}return ${rootVar}`)

  return lines.join("\n")
}

/**
 * Generate a complete element factory function.
 *
 * Wraps the generated code in a function that can be called by mount().
 */
export function generateElementFactory(
  node: BuilderNode,
  options: DOMCodegenOptions = {},
): string {
  const state = createState(options)
  const ind = getIndent(state)
  const _innerState = indented(state)

  const body = generateDOM(node, {
    ...options,
    indentLevel: (options.indentLevel ?? 0) + 1,
  })

  const lines: string[] = []
  lines.push(`${ind}(${state.scopeVar}) => {`)
  lines.push(body)
  lines.push(`${ind}}`)

  return lines.join("\n")
}

/**
 * Generate an element factory function with module declarations.
 *
 * Returns a CodegenResult containing both the function code and any
 * module-level declarations (like template elements) that should be
 * hoisted to the top of the file.
 *
 * This API supports template cloning optimizations:
 * 1. Extracts template from IR
 * 2. Generates template declaration (hoisted to module scope)
 * 3. Generates cloneNode-based code instead of createElement
 * 4. Returns template declarations in moduleDeclarations
 */
export function generateElementFactoryWithResult(
  node: BuilderNode,
  options: DOMCodegenOptions = {},
): CodegenResult {
  // Create state that will collect template declarations
  const state = createState(options)
  const ind = getIndent(state)

  // Check if we can use template cloning
  if (canUseTemplateCloning(node)) {
    // Use template cloning path
    const bodyState = { ...state, indentLevel: state.indentLevel + 1 }
    const body = generateDOMWithCloning(node, bodyState)

    const lines: string[] = []
    lines.push(`${ind}(${state.scopeVar}) => {`)
    lines.push(body)
    lines.push(`${ind}}`)

    return {
      code: lines.join("\n"),
      moduleDeclarations: bodyState.templateDeclarations,
    }
  }

  // Fall back to createElement path
  const code = generateElementFactory(node, options)
  return {
    code,
    moduleDeclarations: [],
  }
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Convert kebab-case to camelCase.
 */
function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}
