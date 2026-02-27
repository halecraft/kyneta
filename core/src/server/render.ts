/**
 * Server-Side Rendering for Kinetic
 *
 * This module provides functions to render Kinetic elements to HTML strings
 * on the server. The key insight is that SSR doesn't need a DOM - we generate
 * JavaScript code that produces HTML strings directly via template literals.
 *
 * Architecture:
 * 1. Source code with builder patterns is compiled to HTML-generating code
 * 2. The generated code is a function that takes a context (with Loro doc)
 * 3. Executing the function produces an HTML string with hydration markers
 *
 * @packageDocumentation
 */

import type { LoroDoc } from "loro-crdt"

// =============================================================================
// Types
// =============================================================================

/**
 * Context for server-side rendering.
 */
export interface SSRContext {
  /**
   * The Loro document containing the data to render.
   */
  doc: LoroDoc | unknown

  /**
   * Counter for generating unique hydration marker IDs.
   * @internal
   */
  _markerId?: number
}

/**
 * Options for rendering to string.
 */
export interface RenderToStringOptions {
  /**
   * Include hydration markers in output.
   * These are HTML comments that help the client locate regions.
   * @default true
   */
  hydratable?: boolean

  /**
   * Pretty-print the output HTML with indentation.
   * @default false
   */
  pretty?: boolean

  /**
   * Initial indentation level for pretty printing.
   * @default 0
   */
  indentLevel?: number
}

/**
 * A compiled SSR render function.
 *
 * This is the output of compiling a Kinetic component for SSR.
 * It takes a context containing the Loro document and returns HTML.
 */
export type SSRRenderFunction = (ctx: SSRContext) => string

// =============================================================================
// HTML Escaping
// =============================================================================

/**
 * Map of characters to their HTML entity equivalents.
 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#x27;",
}

/**
 * Regex for matching characters that need escaping.
 */
const HTML_ESCAPE_REGEX = /[&<>"']/g

/**
 * Escape a string for safe inclusion in HTML.
 *
 * This prevents XSS attacks by escaping special characters.
 *
 * @param str - The string to escape
 * @returns The escaped string
 *
 * @example
 * ```ts
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 * ```
 */
export function escapeHtml(str: string): string {
  return String(str).replace(HTML_ESCAPE_REGEX, char => HTML_ESCAPE_MAP[char])
}

// =============================================================================
// Hydration Markers
// =============================================================================

/**
 * Generate a unique hydration marker ID.
 *
 * @param ctx - The SSR context (mutated to increment counter)
 * @param type - The type of marker (e.g., "list", "if")
 * @returns A unique marker ID string
 */
export function generateMarkerId(ctx: SSRContext, type: string): string {
  ctx._markerId = (ctx._markerId ?? 0) + 1
  return `kinetic:${type}:${ctx._markerId}`
}

/**
 * Create an opening hydration marker comment.
 *
 * @param id - The marker ID
 * @returns HTML comment string
 */
export function openMarker(id: string): string {
  return `<!--${id}-->`
}

/**
 * Create a closing hydration marker comment.
 *
 * @param type - The type of marker (e.g., "list", "if")
 * @returns HTML comment string
 */
export function closeMarker(type: string): string {
  return `<!--/kinetic:${type}-->`
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

/**
 * Check if a tag is a void element.
 *
 * @param tag - The HTML tag name
 * @returns true if the tag is a void element
 */
export function isVoidElement(tag: string): boolean {
  return VOID_ELEMENTS.has(tag.toLowerCase())
}

// =============================================================================
// Render Helpers
// =============================================================================

/**
 * Render an HTML attribute.
 *
 * @param name - Attribute name
 * @param value - Attribute value (will be escaped)
 * @returns Rendered attribute string (e.g., ' class="foo"')
 */
export function renderAttribute(name: string, value: unknown): string {
  if (value === true) {
    return ` ${name}`
  }
  if (value === false || value === null || value === undefined) {
    return ""
  }
  return ` ${name}="${escapeHtml(String(value))}"`
}

/**
 * Render multiple HTML attributes.
 *
 * @param attrs - Object of attribute name-value pairs
 * @returns Rendered attributes string
 */
export function renderAttributes(attrs: Record<string, unknown>): string {
  let result = ""
  for (const [name, value] of Object.entries(attrs)) {
    result += renderAttribute(name, value)
  }
  return result
}

/**
 * Render an opening HTML tag.
 *
 * @param tag - The tag name
 * @param attrs - Optional attributes
 * @returns Opening tag string
 */
export function renderOpenTag(
  tag: string,
  attrs?: Record<string, unknown>,
): string {
  const attrStr = attrs ? renderAttributes(attrs) : ""
  return `<${tag}${attrStr}>`
}

/**
 * Render a closing HTML tag.
 *
 * @param tag - The tag name
 * @returns Closing tag string, or empty string for void elements
 */
export function renderCloseTag(tag: string): string {
  if (isVoidElement(tag)) {
    return ""
  }
  return `</${tag}>`
}

/**
 * Render a complete HTML element.
 *
 * @param tag - The tag name
 * @param attrs - Optional attributes
 * @param children - Optional children (already rendered HTML)
 * @returns Complete element string
 */
export function renderElement(
  tag: string,
  attrs?: Record<string, unknown>,
  children?: string,
): string {
  const open = renderOpenTag(tag, attrs)
  if (isVoidElement(tag)) {
    return open
  }
  return `${open}${children ?? ""}${renderCloseTag(tag)}`
}

// =============================================================================
// List Rendering
// =============================================================================

/**
 * Render a list region for SSR.
 *
 * @param ctx - SSR context
 * @param items - Array of items to render
 * @param renderItem - Function to render each item
 * @param hydratable - Whether to include hydration markers
 * @returns Rendered HTML string
 */
export function renderList<T>(
  ctx: SSRContext,
  items: T[],
  renderItem: (item: T, index: number, ctx: SSRContext) => string,
  hydratable: boolean = true,
): string {
  const parts: string[] = []

  if (hydratable) {
    const markerId = generateMarkerId(ctx, "list")
    parts.push(openMarker(markerId))
  }

  for (let i = 0; i < items.length; i++) {
    parts.push(renderItem(items[i], i, ctx))
  }

  if (hydratable) {
    parts.push(closeMarker("list"))
  }

  return parts.join("")
}

// =============================================================================
// Conditional Rendering
// =============================================================================

/**
 * Render a conditional region for SSR.
 *
 * @param ctx - SSR context
 * @param condition - The condition to evaluate
 * @param renderTrue - Function to render when condition is true
 * @param renderFalse - Optional function to render when condition is false
 * @param hydratable - Whether to include hydration markers
 * @returns Rendered HTML string
 */
export function renderConditional(
  ctx: SSRContext,
  condition: boolean,
  renderTrue: (ctx: SSRContext) => string,
  renderFalse?: (ctx: SSRContext) => string,
  hydratable: boolean = true,
): string {
  const parts: string[] = []

  if (hydratable) {
    const markerId = generateMarkerId(ctx, "if")
    parts.push(openMarker(markerId))
  }

  if (condition) {
    parts.push(renderTrue(ctx))
  } else if (renderFalse) {
    parts.push(renderFalse(ctx))
  }

  if (hydratable) {
    parts.push(closeMarker("if"))
  }

  return parts.join("")
}

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Execute a compiled SSR render function.
 *
 * This is a convenience wrapper that creates the SSR context and
 * executes the render function.
 *
 * @param renderFn - The compiled render function
 * @param doc - The Loro document containing the data
 * @param options - Render options
 * @returns The rendered HTML string
 *
 * @example
 * ```ts
 * // Assuming compiledRender is a compiled SSR function
 * const html = executeRender(compiledRender, loroDoc, { hydratable: true })
 * ```
 */
export function executeRender(
  renderFn: SSRRenderFunction,
  doc: LoroDoc | unknown,
  _options: RenderToStringOptions = {},
): string {
  const ctx: SSRContext = {
    doc,
    _markerId: 0,
  }

  const html = renderFn(ctx)

  // Pretty printing is handled at generation time, not here
  // This function just executes the render

  return html
}

/**
 * Create a simple SSR render function from a static template.
 *
 * This is useful for testing and simple cases where no compilation is needed.
 *
 * @param template - A function that returns HTML given a context
 * @returns An SSR render function
 */
export function createRenderFunction(
  template: (ctx: SSRContext) => string,
): SSRRenderFunction {
  return template
}

// =============================================================================
// High-Level API (wraps compilation + execution)
// =============================================================================

/**
 * Render HTML from a pre-compiled render function.
 *
 * This is the primary API for SSR. It takes a compiled render function
 * (output of the Kinetic compiler in HTML mode) and a Loro document,
 * and returns the rendered HTML string.
 *
 * @param renderFn - The compiled render function
 * @param doc - The Loro document
 * @param options - Render options
 * @returns Rendered HTML string
 *
 * @example
 * ```ts
 * import { renderToString } from "@loro-extended/kinetic/server"
 * import { compiledApp } from "./app.server.js" // compiled by Vite/build
 *
 * const html = renderToString(compiledApp, doc, { hydratable: true })
 * ```
 */
export function renderToString(
  renderFn: SSRRenderFunction,
  doc: LoroDoc | unknown,
  options: RenderToStringOptions = {},
): string {
  return executeRender(renderFn, doc, options)
}

/**
 * Render HTML and wrap it with a full HTML document structure.
 *
 * This is useful for rendering complete pages.
 *
 * @param renderFn - The compiled render function
 * @param doc - The Loro document
 * @param options - Render options plus document options
 * @returns Complete HTML document string
 */
export function renderToDocument(
  renderFn: SSRRenderFunction,
  doc: LoroDoc | unknown,
  options: RenderToStringOptions & {
    /** Document title */
    title?: string
    /** Head content (stylesheets, meta tags, etc.) */
    head?: string
    /** Script tags to include before closing body */
    scripts?: string
  } = {},
): string {
  const content = renderToString(renderFn, doc, options)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${options.title ? `<title>${escapeHtml(options.title)}</title>` : ""}
  ${options.head ?? ""}
</head>
<body>
  <div id="root">${content}</div>
  ${options.scripts ?? ""}
</body>
</html>`
}
