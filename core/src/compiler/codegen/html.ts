/**
 * HTML Code Generation from IR
 *
 * This module transforms IR nodes into JavaScript code that generates HTML strings.
 * Used for server-side rendering (SSR).
 *
 * All functions are pure - they take IR and return strings.
 *
 * The generated code:
 * - Produces HTML strings via template literals
 * - Includes hydration markers for client-side rehydration
 * - Escapes dynamic content for XSS prevention
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
  ListRegionNode,
  StaticConditionalNode,
  StaticLoopNode,
} from "../ir.js"

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

/**
 * Escape a static string for HTML.
 */
function escapeStatic(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
}

// =============================================================================
// Void Elements
// =============================================================================

/**
 * HTML void elements (self-closing, no end tag).
 */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

// =============================================================================
// Content Generation
// =============================================================================

/**
 * Generate HTML for content at any binding time.
 */
function _generateContent(node: ContentNode): string {
  if (node.bindingTime === "literal") {
    // Literal - source is JSON-encoded string, extract and escape
    const value = JSON.parse(node.source)
    return JSON.stringify(escapeStatic(value))
  }

  // Render-time and reactive - both need escaping
  return escapeExpr(`String(${node.source})`)
}

// =============================================================================
// Attribute Generation
// =============================================================================

/**
 * Generate HTML for an attribute.
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
    const escaped = escapeStatic(value)
    return ` ${name}="${escaped}"`
  }

  // Dynamic attribute (render-time or reactive)
  return `\${" ${name}=\\"" + ${escapeExpr(`String(${content.source})`)} + "\\""}`
}

// =============================================================================
// Element Generation
// =============================================================================

/**
 * Generate HTML for an element node.
 */
function generateElement(node: ElementNode, state: CodegenState): string {
  const parts: string[] = []

  // Opening tag
  parts.push(`<${node.tag}`)

  // Attributes
  for (const attr of node.attributes) {
    parts.push(generateAttribute(attr))
  }

  // Event handlers are ignored in SSR (client-only)

  // Self-closing for void elements
  if (VOID_ELEMENTS.has(node.tag)) {
    parts.push(">")
    return parts.join("")
  }

  parts.push(">")

  // Children
  for (const child of node.children) {
    parts.push(generateChild(child, state))
  }

  // Closing tag
  parts.push(`</${node.tag}>`)

  return parts.join("")
}

// =============================================================================
// Body Generation Helper
// =============================================================================

/**
 * Generate HTML for a body with block body syntax and accumulation pattern.
 *
 * This is used by list regions and conditional regions. It handles:
 * - Statements (emitted verbatim)
 * - Elements (accumulated into _html)
 * - Proper interleaving of statements and HTML generation
 *
 * Returns code suitable for a block body: `let _html = ""; ...; return _html`
 */
function generateBodyHtml(body: ChildNode[], state: CodegenState): string {
  const lines: string[] = []

  lines.push(`let _html = ""`)

  for (const child of body) {
    // Statements are emitted verbatim (they execute, but don't produce HTML)
    if (child.kind === "statement") {
      lines.push(child.source)
    }
    // Static loops generate a for...of that accumulates HTML
    else if (child.kind === "static-loop") {
      lines.push(generateStaticLoopBody(child, state))
    }
    // Static conditionals generate an if statement that accumulates HTML
    else if (child.kind === "static-conditional") {
      lines.push(generateStaticConditionalBody(child, state))
    }
    // All other children produce HTML fragments
    else {
      const childHtml = generateChild(child, state)
      if (childHtml) {
        lines.push(`_html += \`${childHtml}\``)
      }
    }
  }

  lines.push(`return _html`)

  return lines.join("; ")
}

// =============================================================================
// Child Generation
// =============================================================================

/**
 * Generate HTML for a child node.
 */
function generateChild(node: ChildNode, state: CodegenState): string {
  switch (node.kind) {
    case "element":
      return generateElement(node, state)

    case "content":
      if (node.bindingTime === "literal") {
        // Literal - source is JSON-encoded string, extract and escape
        const value = JSON.parse(node.source)
        return escapeStatic(value)
      }
      // Render-time and reactive - use template literal interpolation
      return `\${${escapeExpr(`String(${node.source})`)}}`

    case "list-region":
      return generateListRegion(node, state)

    case "conditional-region":
      return generateConditionalRegion(node, state)

    case "binding":
      // Bindings render as their current value in SSR
      return `\${${escapeExpr(`String(${node.refSource}.get ? ${node.refSource}.get() : ${node.refSource})`)}}`

    case "statement":
      // Statements don't produce HTML directly - they're handled by generateBodyHtml()
      // When called from element children (not body context), we can't emit statements
      // This should not happen in well-formed IR, but return empty for safety
      return ""

    case "static-loop":
      // Static loops generate a map expression for HTML output
      return generateStaticLoopInline(node, state)

    case "static-conditional":
      // Static conditionals generate an IIFE with if statement
      return generateStaticConditionalInline(node, state)

    default:
      return ""
  }
}

// =============================================================================
// List Region Generation
// =============================================================================

/**
 * Generate HTML for a list region.
 *
 * Uses block body with accumulation pattern for consistency and to support
 * statements in the loop body.
 */
function generateListRegion(node: ListRegionNode, state: CodegenState): string {
  const parts: string[] = []

  // Hydration marker (start)
  if (state.hydratable) {
    const markerId = genMarkerId(state, "list")
    parts.push(`<!--${markerId}-->`)
  }

  // Map over items and generate HTML for each
  const itemVar = node.itemVariable
  const indexVar = node.indexVariable ?? "_i"

  // Generate body using shared helper with block body syntax
  const bodyCode = generateBodyHtml(node.body, state)

  // Wrap in map expression with block body
  // Use spread syntax [...listSource] to iterate, which returns refs (PlainValueRef)
  // for value shapes, enabling two-way binding patterns like itemRef.get()/set()
  parts.push(
    `\${[...${node.listSource}].map((${itemVar}, ${indexVar}) => { ${bodyCode} }).join("")}`,
  )

  // Hydration marker (end)
  if (state.hydratable) {
    parts.push(`<!--/kinetic:list-->`)
  }

  return parts.join("")
}

// =============================================================================
// Conditional Region Generation
// =============================================================================

/**
 * Generate HTML for a conditional region.
 *
 * Uses IIFE with block body for branches to support statements.
 */
function generateConditionalRegion(
  node: ConditionalRegionNode,
  state: CodegenState,
): string {
  const parts: string[] = []

  // Hydration marker
  if (state.hydratable) {
    const markerId = genMarkerId(state, "if")
    parts.push(`<!--${markerId}-->`)
  }

  // Generate ternary expression for branches using IIFE for each branch
  const branches = node.branches
  let expr = ""

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]

    if (branch.condition === null) {
      // Else branch - use IIFE with block body
      const bodyCode = generateBodyHtml(branch.body, state)
      expr += `(() => { ${bodyCode} })()`
    } else {
      // If or else-if branch - use IIFE with block body
      const bodyCode = generateBodyHtml(branch.body, state)

      if (i === branches.length - 1) {
        // Last branch with condition but no else
        expr += `(${branch.condition.source}) ? (() => { ${bodyCode} })() : ""`
      } else {
        expr += `(${branch.condition.source}) ? (() => { ${bodyCode} })() : `
      }
    }
  }

  // If no else branch was found, add empty string
  if (
    branches.length > 0 &&
    branches[branches.length - 1].condition !== null &&
    !expr.endsWith('""')
  ) {
    expr += '""'
  }

  parts.push(`\${${expr}}`)

  // Hydration marker (end)
  if (state.hydratable) {
    parts.push(`<!--/kinetic:if-->`)
  }

  return parts.join("")
}

// =============================================================================
// Static Loop Generation
// =============================================================================

/**
 * Generate code for a static loop body (used inside generateBodyHtml).
 *
 * Produces a for...of loop that accumulates HTML into the _html variable.
 */
function generateStaticLoopBody(
  node: StaticLoopNode,
  state: CodegenState,
): string {
  const loopVar = node.indexVariable
    ? `[${node.indexVariable}, ${node.itemVariable}]`
    : node.itemVariable

  // Generate for...of loop that accumulates to outer _html
  const lines: string[] = []
  lines.push(`for (const ${loopVar} of ${node.iterableSource}) {`)

  // Generate body content that accumulates to _html
  for (const child of node.body) {
    if (child.kind === "statement") {
      lines.push(`  ${child.source}`)
    } else if (child.kind === "static-loop") {
      lines.push(`  ${generateStaticLoopBody(child, state)}`)
    } else if (child.kind === "static-conditional") {
      lines.push(`  ${generateStaticConditionalBody(child, state)}`)
    } else {
      const childHtml = generateChild(child, state)
      if (childHtml) {
        lines.push(`  _html += \`${childHtml}\``)
      }
    }
  }

  lines.push(`}`)

  return lines.join("; ")
}

/**
 * Generate code for a static loop inline (used in template literal context).
 *
 * Produces a .map() expression that returns HTML strings.
 */
function generateStaticLoopInline(
  node: StaticLoopNode,
  state: CodegenState,
): string {
  const loopVar = node.indexVariable
    ? `[${node.indexVariable}, ${node.itemVariable}]`
    : node.itemVariable

  // Generate body using accumulation pattern
  const bodyCode = generateBodyHtml(node.body, state)

  // Wrap in map expression with block body
  return `\${${node.iterableSource}.map((${loopVar}) => { ${bodyCode} }).join("")}`
}

// =============================================================================
// Static Conditional Generation
// =============================================================================

/**
 * Generate code for a static conditional body (used inside generateBodyHtml).
 *
 * Produces an if statement that accumulates HTML into the _html variable.
 */
function generateStaticConditionalBody(
  node: StaticConditionalNode,
  state: CodegenState,
): string {
  const lines: string[] = []

  lines.push(`if (${node.conditionSource}) {`)

  // Generate then body content
  for (const child of node.thenBody) {
    if (child.kind === "statement") {
      lines.push(`  ${child.source}`)
    } else if (child.kind === "static-loop") {
      lines.push(`  ${generateStaticLoopBody(child, state)}`)
    } else if (child.kind === "static-conditional") {
      lines.push(`  ${generateStaticConditionalBody(child, state)}`)
    } else {
      const childHtml = generateChild(child, state)
      if (childHtml) {
        lines.push(`  _html += \`${childHtml}\``)
      }
    }
  }

  // Generate else body if present
  if (node.elseBody && node.elseBody.length > 0) {
    lines.push(`} else {`)
    for (const child of node.elseBody) {
      if (child.kind === "statement") {
        lines.push(`  ${child.source}`)
      } else if (child.kind === "static-loop") {
        lines.push(`  ${generateStaticLoopBody(child, state)}`)
      } else if (child.kind === "static-conditional") {
        lines.push(`  ${generateStaticConditionalBody(child, state)}`)
      } else {
        const childHtml = generateChild(child, state)
        if (childHtml) {
          lines.push(`  _html += \`${childHtml}\``)
        }
      }
    }
  }

  lines.push(`}`)

  return lines.join("; ")
}

/**
 * Generate code for a static conditional inline (used in template literal context).
 *
 * Produces an IIFE with an if statement that returns HTML.
 */
function generateStaticConditionalInline(
  node: StaticConditionalNode,
  state: CodegenState,
): string {
  // Generate body using accumulation pattern for then branch
  const thenBodyCode = generateBodyHtml(node.thenBody, state)

  if (node.elseBody && node.elseBody.length > 0) {
    // Has else branch - use IIFE with if/else
    const elseBodyCode = generateBodyHtml(node.elseBody, state)
    return `\${(() => { if (${node.conditionSource}) { ${thenBodyCode} } else { ${elseBodyCode} } })()}`
  } else {
    // No else branch - use ternary with IIFE for then, empty string for else
    return `\${(${node.conditionSource}) ? (() => { ${thenBodyCode} })() : ""}`
  }
}

// =============================================================================
// Builder Generation
// =============================================================================

/**
 * Generate HTML code for a builder node.
 *
 * This is the main entry point for HTML code generation.
 * Returns a template literal string that produces HTML.
 */
export function generateHTML(
  node: BuilderNode,
  options: HTMLCodegenOptions = {},
): string {
  const state = createState(options)
  const ind = getIndent(state)

  const parts: string[] = []

  // Opening tag
  parts.push(`<${node.factoryName}`)

  // Props as attributes
  for (const prop of node.props) {
    parts.push(generateAttribute(prop))
  }

  // Event handlers are ignored in SSR

  parts.push(">")

  // Children
  for (const child of node.children) {
    parts.push(generateChild(child, state))
  }

  // Closing tag (unless void element)
  if (!VOID_ELEMENTS.has(node.factoryName)) {
    parts.push(`</${node.factoryName}>`)
  }

  return `${ind}\`${parts.join("")}\``
}

/**
 * Generate a complete render function for SSR.
 *
 * Returns a function that can be called to produce HTML.
 */
export function generateRenderFunction(
  node: BuilderNode,
  options: HTMLCodegenOptions = {},
): string {
  const state = createState(options)
  const ind = getIndent(state)
  const innerState = indented(state)
  const innerInd = getIndent(innerState)

  const html = generateHTML(node, {
    ...options,
    indentLevel: (options.indentLevel ?? 0) + 1,
  })

  const lines: string[] = []
  lines.push(`${ind}() => {`)
  lines.push(`${innerInd}return ${html.trim()}`)
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
