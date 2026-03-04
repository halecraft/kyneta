/**
 * HTML Code Generation from IR
 *
 * This module transforms IR nodes into JavaScript code that generates HTML strings.
 * Used for server-side rendering (SSR).
 *
 * All functions are pure - they take IR and return strings.
 *
 * Architecture: Unified accumulation-line calling convention.
 * Every codegen function returns `string[]` (code lines that accumulate into `_html`).
 * There is one generator per IR construct, not two. Statements are lines interleaved
 * with `_html +=` lines. This mirrors the DOM codegen architecture.
 *
 * Generated output pattern:
 *   () => {
 *     let _html = ""
 *     _html += `<div class="app">`
 *     const x = 1
 *     _html += `<h1>${__escapeHtml(String(x))}</h1>`
 *     _html += `</div>`
 *     return _html
 *   }
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
  LoopNode,
} from "../ir.js"
import { escapeHtml, VOID_ELEMENTS } from "../html-constants.js"

// =============================================================================
// Code Generation Options
// =============================================================================

/**
 * Options for HTML code generation.
 */
export interface HTMLCodegenOptions {
  /**
   * Include hydration markers in output.
   * @default true
   */
  hydratable?: boolean

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
  hydratable: boolean
  varPrefix: string
  indent: string
  indentLevel: number
  varCounter: number
  markerCounter: number
}

/**
 * Create initial codegen state from options.
 */
function createState(options: HTMLCodegenOptions = {}): CodegenState {
  return {
    hydratable: options.hydratable ?? true,
    varPrefix: options.varPrefix ?? "_",
    indent: options.indent ?? "  ",
    indentLevel: options.indentLevel ?? 0,
    varCounter: 0,
    markerCounter: 0,
  }
}

/**
 * Generate a unique variable name.
 */
function _genVar(state: CodegenState, hint: string = "html"): string {
  return `${state.varPrefix}${hint}${state.varCounter++}`
}

/**
 * Generate a unique marker ID.
 */
function genMarkerId(state: CodegenState, type: string): string {
  return `kinetic:${type}:${state.markerCounter++}`
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
// HTML Escaping
// =============================================================================

/**
 * Generate code that escapes HTML content.
 *
 * Returns an expression that escapes the given value.
 */
function escapeExpr(value: string): string {
  return `__escapeHtml(${value})`
}

// =============================================================================
// Attribute Generation
// =============================================================================

/**
 * Generate HTML for an attribute.
 *
 * Returns a string fragment to be embedded inside an opening tag template literal.
 */
function generateAttribute(attr: AttributeNode): string {
  const name = attr.name
  const content = attr.value

  // Boolean attributes
  if (name === "disabled" || name === "checked" || name === "readonly") {
    if (content.bindingTime === "literal") {
      // Extract the actual string value from JSON-encoded source
      const value = JSON.parse(content.source)
      return value === "true" || value === name ? ` ${name}` : ""
    }
    // Dynamic boolean - need ternary
    return `\${${content.source} ? " ${name}" : ""}`
  }

  // Regular attributes
  if (content.bindingTime === "literal") {
    // Extract the actual string value from JSON-encoded source
    const value = JSON.parse(content.source)
    const escaped = escapeHtml(value)
    return ` ${name}="${escaped}"`
  }

  // Dynamic attribute (render-time or reactive)
  return `\${" ${name}=\\"" + ${escapeExpr(`String(${content.source})`)} + "\\""}`
}

// =============================================================================
// Unified Accumulation-Line Generators
// =============================================================================

/**
 * Emit accumulation lines for a single child node.
 *
 * Every IR node kind is handled here. Statements emit their source verbatim.
 * HTML-producing nodes emit `_html += \`...\`` lines.
 *
 * @param node - The child node to emit
 * @param state - Codegen state
 * @param indent - Indentation prefix for each emitted line
 * @returns Array of code lines
 */
function emitChild(
  node: ChildNode,
  state: CodegenState,
  indent: string = "",
): string[] {
  switch (node.kind) {
    case "statement":
      return [`${indent}${node.source}`]

    case "element":
      return emitElement(node, state, indent)

    case "content":
      return emitContent(node, indent)

    case "loop":
      return emitLoop(node, state, indent)

    case "conditional":
      return emitConditional(node, state, indent)

    case "binding":
      // Bindings render as their current value in SSR
      return [
        `${indent}_html += \`\${${escapeExpr(`String(${node.refSource}.get ? ${node.refSource}.get() : ${node.refSource})`)}}\``,
      ]

    default:
      return []
  }
}

/**
 * Emit accumulation lines for a content node.
 */
function emitContent(node: ContentNode, indent: string = ""): string[] {
  if (node.bindingTime === "literal") {
    // Literal - source is JSON-encoded string, extract and escape
    const value = JSON.parse(node.source)
    const escaped = escapeHtml(value)
    return [`${indent}_html += ${JSON.stringify(escaped)}`]
  }
  // Render-time and reactive - use template literal interpolation with escaping
  return [
    `${indent}_html += \`\${${escapeExpr(`String(${node.source})`)}}\``,
  ]
}

/**
 * Emit accumulation lines for an element node.
 *
 * Opening tag, children (via emitChildren), closing tag — all as `_html +=` lines.
 * Statements in children are naturally interleaved.
 */
function emitElement(
  node: ElementNode,
  state: CodegenState,
  indent: string = "",
): string[] {
  const lines: string[] = []

  // Component: call the factory and concatenate the result.
  // Components are transparent at the HTML level — their SSR output is
  // indistinguishable from inline elements. No <ComponentName> tags.
  if (node.factorySource) {
    const propsEntries: string[] = []
    for (const attr of node.attributes) {
      propsEntries.push(`${attr.name}: ${attr.value.source}`)
    }
    // Event handlers are skipped — SSR doesn't wire events
    const propsArg =
      propsEntries.length > 0 ? `{ ${propsEntries.join(", ")} }` : ""
    lines.push(
      `${indent}_html += ${node.factorySource}(${propsArg})()`,
    )
    return lines
  }

  // Opening tag with attributes
  const tagParts: string[] = []
  tagParts.push(`<${node.tag}`)
  for (const attr of node.attributes) {
    tagParts.push(generateAttribute(attr))
  }

  // Event handlers are ignored in SSR (client-only)

  // Self-closing for void elements
  if (VOID_ELEMENTS.has(node.tag)) {
    tagParts.push(">")
    lines.push(`${indent}_html += \`${tagParts.join("")}\``)
    return lines
  }

  tagParts.push(">")
  lines.push(`${indent}_html += \`${tagParts.join("")}\``)

  // Children
  lines.push(...emitChildren(node.children, state, indent))

  // Closing tag
  lines.push(`${indent}_html += \`</${node.tag}>\``)

  return lines
}

/**
 * Emit accumulation lines for all children in a body.
 *
 * This is the unified child iteration — every child goes through `emitChild`.
 *
 * @param body - The child nodes to walk
 * @param state - Codegen state
 * @param indent - Indentation prefix for each line
 * @returns Array of code lines
 */
function emitChildren(
  body: ChildNode[],
  state: CodegenState,
  indent: string = "",
): string[] {
  const lines: string[] = []
  for (const child of body) {
    lines.push(...emitChild(child, state, indent))
  }
  return lines
}

// =============================================================================
// Loop Generation
// =============================================================================

/**
 * Emit accumulation lines for a loop (both reactive and render-time).
 *
 * All loops produce `for...of` loops that accumulate into `_html`.
 * Reactive loops additionally emit hydration marker comments.
 */
function emitLoop(
  node: LoopNode,
  state: CodegenState,
  indent: string = "",
): string[] {
  const lines: string[] = []

  const isReactive = node.iterableBindingTime === "reactive"

  // Hydration markers (only for reactive loops)
  if (state.hydratable && isReactive) {
    const markerId = genMarkerId(state, "list")
    lines.push(`${indent}_html += \`<!--${markerId}-->\``)
  }

  // Loop variable pattern
  const loopVar = node.indexVariable
    ? `[${node.indexVariable}, ${node.itemVariable}]`
    : node.itemVariable

  // Iterable source — reactive loops use spread to get PlainValueRef objects
  const iterableExpr = isReactive
    ? `[...${node.iterableSource}]`
    : node.iterableSource

  // Emit for...of loop
  lines.push(`${indent}for (const ${loopVar} of ${iterableExpr}) {`)

  // Loop body children
  lines.push(...emitChildren(node.body, state, indent + "  "))

  lines.push(`${indent}}`)

  // Hydration markers (end, only for reactive loops)
  if (state.hydratable && isReactive) {
    lines.push(`${indent}_html += \`<!--/kinetic:list-->\``)
  }

  return lines
}

// =============================================================================
// Conditional Generation
// =============================================================================

/**
 * Emit accumulation lines for a conditional (both reactive and render-time).
 *
 * Produces `if/else-if/else` blocks that accumulate into `_html`.
 * Reactive conditionals additionally emit hydration markers.
 */
function emitConditional(
  node: ConditionalNode,
  state: CodegenState,
  indent: string = "",
): string[] {
  const lines: string[] = []

  const isReactive = node.subscriptionTarget !== null

  // Hydration markers (only for reactive conditionals)
  if (state.hydratable && isReactive) {
    const markerId = genMarkerId(state, "if")
    lines.push(`${indent}_html += \`<!--${markerId}-->\``)
  }

  // Generate if/else-if/else chain
  for (let i = 0; i < node.branches.length; i++) {
    const branch = node.branches[i]
    const isFirst = i === 0
    const isElse = branch.condition === null

    if (isElse) {
      lines.push(`${indent}} else {`)
    } else if (isFirst) {
      lines.push(`${indent}if (${branch.condition!.source}) {`)
    } else {
      lines.push(`${indent}} else if (${branch.condition!.source}) {`)
    }

    // Branch body children
    lines.push(...emitChildren(branch.body, state, indent + "  "))
  }

  lines.push(`${indent}}`)

  // Hydration markers (end, only for reactive conditionals)
  if (state.hydratable && isReactive) {
    lines.push(`${indent}_html += \`<!--/kinetic:if-->\``)
  }

  return lines
}

// =============================================================================
// Builder Generation
// =============================================================================

/**
 * Generate HTML accumulation lines for a builder node.
 *
 * This is the main entry point for HTML code generation.
 * Returns an array of code lines that accumulate HTML into `_html`.
 *
 * The lines include:
 * - `let _html = ""`
 * - Opening tag as `_html += \`<tag ...>\``
 * - Children via `emitChildren` (statements, elements, loops, etc.)
 * - Closing tag as `_html += \`</tag>\``
 * - `return _html`
 */
export function generateHTML(
  node: BuilderNode,
  options: HTMLCodegenOptions = {},
): string[] {
  const state = createState(options)

  const lines: string[] = []

  lines.push(`let _html = ""`)

  // Opening tag with props
  const tagParts: string[] = []
  tagParts.push(`<${node.factoryName}`)
  for (const prop of node.props) {
    tagParts.push(generateAttribute(prop))
  }
  // Event handlers are ignored in SSR
  tagParts.push(">")
  lines.push(`_html += \`${tagParts.join("")}\``)

  // Children
  lines.push(...emitChildren(node.children, state))

  // Closing tag (unless void element)
  if (!VOID_ELEMENTS.has(node.factoryName)) {
    lines.push(`_html += \`</${node.factoryName}>\``)
  }

  lines.push(`return _html`)

  return lines
}

/**
 * Generate a complete render function for SSR.
 *
 * Returns a function that can be called to produce HTML.
 * Uses block body with accumulation pattern.
 */
export function generateRenderFunction(
  node: BuilderNode,
  options: HTMLCodegenOptions = {},
): string {
  const state = createState(options)
  const ind = getIndent(state)
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  const htmlLines = generateHTML(node, options)

  const lines: string[] = []
  lines.push(`${ind}() => {`)
  for (const line of htmlLines) {
    lines.push(`${innerInd}${line}`)
  }
  lines.push(`${ind}}`)

  return lines.join("\n")
}

// =============================================================================
// Escape Function Generation
// =============================================================================

/**
 * Generate the __escapeHtml helper function.
 *
 * This should be included in the generated module.
 */
export function generateEscapeHelper(): string {
  return `function __escapeHtml(str) {
  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;'
  };
  return String(str).replace(/[&<>"']/g, (c) => escapeMap[c]);
}`
}