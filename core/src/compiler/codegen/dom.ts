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
} from "../ir.js"
import { computeSlotKind, mergeConditionalBodies } from "../ir.js"

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
 * Generate code to set an attribute.
 */
function generateAttributeSet(
  elementVar: string,
  attr: AttributeNode,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const content = generateContent(attr.value, state)

  // Special handling for common attributes
  if (attr.name === "class") {
    lines.push(`${ind}${elementVar}.className = ${content.code}`)
  } else if (attr.name === "style" && attr.value.bindingTime !== "literal") {
    // Style can be object or string
    lines.push(`${ind}Object.assign(${elementVar}.style, ${content.code})`)
  } else if (attr.name === "value") {
    lines.push(`${ind}${elementVar}.value = ${content.code}`)
  } else if (attr.name === "checked") {
    lines.push(`${ind}${elementVar}.checked = ${content.code}`)
  } else if (attr.name === "disabled") {
    lines.push(`${ind}${elementVar}.disabled = ${content.code}`)
  } else if (attr.name.startsWith("data-")) {
    // Data attributes
    const dataKey = attr.name.slice(5) // Remove "data-"
    lines.push(
      `${ind}${elementVar}.dataset.${camelCase(dataKey)} = ${content.code}`,
    )
  } else {
    // Generic attribute
    lines.push(
      `${ind}${elementVar}.setAttribute(${JSON.stringify(attr.name)}, ${content.code})`,
    )
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

  // Generate the update code
  let updateCode: string
  if (attr.name === "class") {
    updateCode = `${elementVar}.className = ${attr.value.source}`
  } else if (attr.name === "style") {
    updateCode = `Object.assign(${elementVar}.style, ${attr.value.source})`
  } else if (attr.name === "value") {
    updateCode = `${elementVar}.value = ${attr.value.source}`
  } else if (attr.name === "checked") {
    updateCode = `${elementVar}.checked = ${attr.value.source}`
  } else if (attr.name === "disabled") {
    updateCode = `${elementVar}.disabled = ${attr.value.source}`
  } else {
    updateCode = `${elementVar}.setAttribute(${JSON.stringify(attr.name)}, ${attr.value.source})`
  }

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
 */
function generateElement(
  node: ElementNode,
  state: CodegenState,
): { code: string[]; varName: string } {
  const lines: string[] = []
  const ind = getIndent(state)
  const elementVar = genVar(state, node.tag)

  // Create the element
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

  // Reactive conditional: try dissolution first, fallback to conditionalRegion
  const elseBranch = node.branches.find(b => b.condition === null)
  if (elseBranch) {
    const mergeResult = mergeConditionalBodies(node.branches)
    if (mergeResult.success) {
      // Dissolution successful - emit pure Applicative code
      // No marker, no conditionalRegion call, just direct elements with ternaries
      for (const child of mergeResult.value) {
        const childResult = generateChild(child, parentVar, state)
        lines.push(...childResult.code)
      }
      return lines
    }
  }

  // Fallback: standard reactive conditional with conditionalRegion
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
 * This is the newer API that supports template cloning optimizations.
 * Currently returns empty moduleDeclarations; template cloning will
 * populate this in a future update.
 */
export function generateElementFactoryWithResult(
  node: BuilderNode,
  options: DOMCodegenOptions = {},
): CodegenResult {
  const code = generateElementFactory(node, options)

  // TODO: When template cloning is fully integrated, this will:
  // 1. Extract template from IR
  // 2. Generate template declaration
  // 3. Generate cloneNode-based code instead of createElement
  // 4. Return template declarations in moduleDeclarations

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
