/**
 * DOM Code Generation from IR
 *
 * This module transforms IR nodes into JavaScript code that creates and manipulates DOM.
 * All functions are pure - they take IR and return strings.
 *
 * The generated code:
 * - Uses direct DOM APIs (createElement, appendChild, etc.)
 * - Calls runtime functions (__subscribe, __listRegion, __conditionalRegion)
 * - Manages scopes for cleanup
 *
 * @packageDocumentation
 */

import type {
  AttributeNode,
  BuilderNode,
  ChildNode,
  ConditionalRegionNode,
  ContentNode,
  ElementNode,
  EventHandlerNode,
  ListRegionNode,
  StatementNode,
  StaticConditionalNode,
  StaticLoopNode,
} from "../ir.js"

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

  // Subscribe to the first dependency (most common case)
  // TODO: Handle multiple dependencies with __subscribeMultiple
  const dep = deps[0]

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

  lines.push(`${ind}__subscribe(${dep}, () => {`)
  lines.push(`${ind}${state.indent}${updateCode}`)
  lines.push(`${ind}}, ${state.scopeVar})`)

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
      `${ind}__bindChecked(${elementVar}, ${binding.refSource}, ${state.scopeVar})`,
    )
  } else if (binding.attribute === "value") {
    // Determine if numeric or text based on element type
    // For now, assume text - we could enhance this with element type info
    lines.push(
      `${ind}__bindTextValue(${elementVar}, ${binding.refSource}, ${state.scopeVar})`,
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

        // Initial value + subscription
        if (node.dependencies.length > 0) {
          const dep = node.dependencies[0]
          lines.push(
            `${ind}__subscribeWithValue(${dep}, () => ${node.source}, (v) => {`,
          )
          lines.push(`${ind}${state.indent}${textVar}.textContent = String(v)`)
          lines.push(`${ind}}, ${state.scopeVar})`)
        }
      }
      break
    }

    case "list-region": {
      lines.push(...generateListRegion(node, parentVar, state))
      break
    }

    case "conditional-region": {
      lines.push(...generateConditionalRegion(node, parentVar, state))
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

    case "static-loop": {
      // Generate a regular for...of loop that runs once at render time
      lines.push(...generateStaticLoop(node, parentVar, state))
      break
    }

    case "static-conditional": {
      // Generate a regular if statement that runs once at render time
      lines.push(...generateStaticConditionalNode(node, parentVar, state))
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
        if (domNode.dependencies.length > 0) {
          const dep = domNode.dependencies[0]
          lines.push(
            `${ind}__subscribeWithValue(${dep}, () => ${domNode.source}, (v) => {`,
          )
          lines.push(`${ind}${state.indent}${textVar}.textContent = String(v)`)
          lines.push(`${ind}}, ${state.scopeVar})`)
        }
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
 * Optimization is possible when:
 * 1. All statements come before any DOM-producing nodes (no interleaving)
 * 2. There is exactly one DOM-producing node
 * 3. The DOM node is a simple type (element, text, or expression)
 */
function checkCanOptimizeDirectReturn(body: ChildNode[]): {
  leadingStatements: StatementNode[]
  domNode: ElementNode | ContentNode
} | null {
  const leadingStatements: StatementNode[] = []
  let domNode: ChildNode | null = null
  let seenDomNode = false

  for (const child of body) {
    if (child.kind === "statement") {
      if (seenDomNode) {
        // Statement after a DOM node - interleaving detected, can't optimize
        return null
      }
      leadingStatements.push(child)
    } else {
      if (seenDomNode) {
        // Multiple DOM nodes - can't optimize
        return null
      }
      // Check if it's a simple DOM-producing type
      if (child.kind === "element" || child.kind === "content") {
        domNode = child
        seenDomNode = true
      } else {
        // Complex node type (list-region, conditional-region, etc.) - can't optimize
        return null
      }
    }
  }

  if (!domNode) {
    // No DOM node found (only statements) - can't optimize
    return null
  }

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
function generateListRegion(
  node: ListRegionNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  lines.push(`${ind}__listRegion(${parentVar}, ${node.listSource}, {`)

  // Generate create handler
  const params = node.indexVariable
    ? `(${node.itemVariable}, ${node.indexVariable})`
    : `(${node.itemVariable}, _index)`

  lines.push(`${innerInd}create: ${params} => {`)

  // Generate body using shared helper
  const bodyState = indented(innerState)
  lines.push(...generateBodyWithReturn(node.body, bodyState))

  lines.push(`${innerInd}},`)
  lines.push(`${ind}}, ${state.scopeVar})`)

  return lines
}

// =============================================================================
// Conditional Region Generation
// =============================================================================

/**
 * Generate code for a conditional region.
 */
function generateConditionalRegion(
  node: ConditionalRegionNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const markerVar = genVar(state, "marker")

  // Create marker comment
  lines.push(`${ind}const ${markerVar} = document.createComment("kinetic:if")`)
  lines.push(`${ind}${parentVar}.appendChild(${markerVar})`)

  // Generate condition function
  const conditionExpr = node.branches[0].condition
  if (!conditionExpr) {
    // No condition - shouldn't happen for valid conditional regions
    return lines
  }

  const subscriptionTarget =
    node.subscriptionTarget ?? conditionExpr.dependencies[0]

  if (!subscriptionTarget) {
    // Static conditional - use __staticConditionalRegion
    lines.push(...generateStaticConditional(node, markerVar, state))
    return lines
  }

  // Reactive conditional
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  lines.push(
    `${ind}__conditionalRegion(${markerVar}, ${subscriptionTarget}, () => ${conditionExpr.source}, {`,
  )

  // Generate whenTrue handler
  lines.push(`${innerInd}whenTrue: () => {`)
  lines.push(...generateBranchBody(node.branches[0].body, indented(innerState)))
  lines.push(`${innerInd}},`)

  // Generate whenFalse handler (if else branch exists)
  const elseBranch = node.branches.find(b => b.condition === null)
  if (elseBranch) {
    lines.push(`${innerInd}whenFalse: () => {`)
    lines.push(...generateBranchBody(elseBranch.body, indented(innerState)))
    lines.push(`${innerInd}},`)
  }

  lines.push(`${ind}}, ${state.scopeVar})`)

  return lines
}

/**
 * Generate code for a static conditional (non-reactive).
 */
function generateStaticConditional(
  node: ConditionalRegionNode,
  markerVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  const conditionExpr = node.branches[0].condition
  if (!conditionExpr) return lines

  lines.push(
    `${ind}__staticConditionalRegion(${markerVar}, ${conditionExpr.source}, {`,
  )

  // Generate whenTrue handler
  lines.push(`${innerInd}whenTrue: () => {`)
  lines.push(...generateBranchBody(node.branches[0].body, indented(innerState)))
  lines.push(`${innerInd}},`)

  // Generate whenFalse handler (if else branch exists)
  const elseBranch = node.branches.find(b => b.condition === null)
  if (elseBranch) {
    lines.push(`${innerInd}whenFalse: () => {`)
    lines.push(...generateBranchBody(elseBranch.body, indented(innerState)))
    lines.push(`${innerInd}},`)
  }

  lines.push(`${ind}}, ${state.scopeVar})`)

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
 * Unlike list regions which use __listRegion for delta-driven updates,
 * static loops run once at render time and create elements directly.
 */
function generateStaticLoop(
  node: StaticLoopNode,
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
// Static Conditional Node Generation
// =============================================================================

/**
 * Generate code for a static conditional node (non-reactive if).
 *
 * Unlike conditional regions which use __conditionalRegion for reactive updates,
 * static conditionals run once at render time and create elements directly.
 */
function generateStaticConditionalNode(
  node: StaticConditionalNode,
  parentVar: string,
  state: CodegenState,
): string[] {
  const lines: string[] = []
  const ind = getIndent(state)
  const innerState = indented(state)

  // Generate if statement
  lines.push(`${ind}if (${node.conditionSource}) {`)

  // Generate then body
  for (const child of node.thenBody) {
    const childResult = generateChild(child, parentVar, innerState)
    lines.push(...childResult.code)
  }

  // Generate else body if present
  if (node.elseBody && node.elseBody.length > 0) {
    lines.push(`${ind}} else {`)
    for (const child of node.elseBody) {
      const childResult = generateChild(child, parentVar, innerState)
      lines.push(...childResult.code)
    }
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

// =============================================================================
// Utilities
// =============================================================================

/**
 * Convert kebab-case to camelCase.
 */
function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}
