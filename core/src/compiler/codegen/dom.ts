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
  ExpressionNode,
  ListRegionNode,
  TextNode,
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
 * Generate code for text content.
 */
function generateTextContent(
  node: TextNode,
  _state: CodegenState,
): { code: string; isLiteral: true; value: string } {
  // Escape the text for JavaScript string literal
  const escaped = JSON.stringify(node.value)
  return { code: escaped, isLiteral: true, value: node.value }
}

/**
 * Generate code for an expression.
 */
function generateExpression(
  node: ExpressionNode,
  _state: CodegenState,
): { code: string; isLiteral: false } {
  return { code: node.source, isLiteral: false }
}

/**
 * Generate code for content (text or expression).
 */
function generateContent(
  node: ContentNode,
  state: CodegenState,
): { code: string; isLiteral: boolean; value?: string } {
  if (node.kind === "text") {
    return generateTextContent(node, state)
  }
  return generateExpression(node, state)
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
    if (
      attr.value.kind === "expression" &&
      attr.value.expressionKind === "reactive"
    ) {
      // Reactive class - needs subscription
      lines.push(`${ind}${elementVar}.className = ${content.code}`)
    } else {
      lines.push(`${ind}${elementVar}.className = ${content.code}`)
    }
  } else if (attr.name === "style" && attr.value.kind !== "text") {
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
  if (
    attr.value.kind !== "expression" ||
    attr.value.expressionKind !== "reactive"
  ) {
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

  // Generate children
  for (const child of node.children) {
    const childResult = generateChild(child, elementVar, state)
    lines.push(...childResult.code)
  }

  return { code: lines, varName: elementVar }
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

    case "text": {
      const textVar = genVar(state, "text")
      lines.push(
        `${ind}const ${textVar} = document.createTextNode(${JSON.stringify(node.value)})`,
      )
      lines.push(`${ind}${parentVar}.appendChild(${textVar})`)
      break
    }

    case "expression": {
      if (node.expressionKind === "static") {
        // Static expression - evaluate once
        const textVar = genVar(state, "text")
        lines.push(
          `${ind}const ${textVar} = document.createTextNode(String(${node.source}))`,
        )
        lines.push(`${ind}${parentVar}.appendChild(${textVar})`)
      } else {
        // Reactive expression - needs subscription
        const textVar = genVar(state, "text")
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
  }

  return { code: lines }
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

  // Generate body - need to create a single root element or fragment
  const bodyState = indented(innerState)
  const bodyInd = getIndent(bodyState)

  if (node.body.length === 1 && node.body[0].kind === "element") {
    // Single element - return it directly
    const result = generateElement(node.body[0], bodyState)
    lines.push(...result.code)
    lines.push(`${bodyInd}return ${result.varName}`)
  } else if (node.body.length > 0) {
    // Multiple children - wrap in fragment
    const fragVar = genVar(bodyState, "frag")
    lines.push(`${bodyInd}const ${fragVar} = document.createDocumentFragment()`)

    for (const child of node.body) {
      const childResult = generateChild(child, fragVar, bodyState)
      lines.push(...childResult.code)
    }

    lines.push(`${bodyInd}return ${fragVar}`)
  } else {
    // Empty body
    lines.push(`${bodyInd}return document.createTextNode("")`)
  }

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
 */
function generateBranchBody(body: ChildNode[], state: CodegenState): string[] {
  const lines: string[] = []
  const ind = getIndent(state)

  if (body.length === 1 && body[0].kind === "element") {
    // Single element - return it directly
    const result = generateElement(body[0], state)
    lines.push(...result.code)
    lines.push(`${ind}return ${result.varName}`)
  } else if (body.length > 0) {
    // Multiple children - wrap in fragment
    const fragVar = genVar(state, "frag")
    lines.push(`${ind}const ${fragVar} = document.createDocumentFragment()`)

    for (const child of body) {
      const childResult = generateChild(child, fragVar, state)
      lines.push(...childResult.code)
    }

    lines.push(`${ind}return ${fragVar}`)
  } else {
    // Empty body
    lines.push(`${ind}return document.createTextNode("")`)
  }

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
