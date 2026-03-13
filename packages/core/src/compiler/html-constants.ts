/**
 * Shared HTML Constants and Utilities
 *
 * This module contains HTML-related constants and functions shared between:
 * - `codegen/html.ts` (SSR code generation)
 * - `server/render.ts` (SSR runtime)
 * - `compiler/template.ts` (template extraction, future)
 *
 * Centralizing these eliminates duplication and ensures consistent behavior
 * across SSR, hydration, and template cloning.
 *
 * @packageDocumentation
 */

// =============================================================================
// Void Elements
// =============================================================================

/**
 * HTML void elements (self-closing, no end tag).
 *
 * These elements cannot have children and don't require a closing tag.
 * Used by both SSR codegen and template extraction.
 *
 * @see https://html.spec.whatwg.org/multipage/syntax.html#void-elements
 */
export const VOID_ELEMENTS = new Set([
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
 * This prevents XSS attacks by escaping special characters:
 * - `&` → `&amp;`
 * - `<` → `&lt;`
 * - `>` → `&gt;`
 * - `"` → `&quot;`
 * - `'` → `&#x27;`
 *
 * @param str - The string to escape
 * @returns The escaped string
 *
 * @example
 * ```ts
 * escapeHtml('<script>alert("xss")</script>')
 * // Returns: '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
 *
 * escapeHtml("Hello & goodbye")
 * // Returns: 'Hello &amp; goodbye'
 * ```
 */
export function escapeHtml(str: string): string {
  return String(str).replace(HTML_ESCAPE_REGEX, char => HTML_ESCAPE_MAP[char])
}

// =============================================================================
// Region Markers
// =============================================================================

/**
 * Region marker types supported by Kinetic.
 */
export type RegionMarkerType = "list" | "if"

/**
 * A pair of opening and closing marker strings.
 */
export interface RegionMarkers {
  /** Opening marker: `<!--kyneta:type:id-->` */
  open: string
  /** Closing marker: `<!--/kyneta:type-->` */
  close: string
}

/**
 * Generate consistent region marker HTML comments.
 *
 * These markers are used for:
 * - SSR hydration: Client finds markers to attach subscriptions
 * - Template cloning: Marks where dynamic regions will be mounted
 *
 * The format is compatible with the hydration system in `hydrate.ts`,
 * which uses `MARKER_REGEX = /^(\/?)kyneta:(\w+)(?::(\d+))?$/`
 *
 * @param type - The region type ("list" or "if")
 * @param id - Unique marker ID (typically from a counter)
 * @returns Object with `open` and `close` marker strings
 *
 * @example
 * ```ts
 * const markers = generateRegionMarkers("list", 1)
 * // markers.open === "<!--kyneta:list:1-->"
 * // markers.close === "<!--/kyneta:list-->"
 *
 * // In template HTML:
 * // <ul><!--kyneta:list:1--><!--/kyneta:list--></ul>
 * ```
 */
export function generateRegionMarkers(
  type: RegionMarkerType,
  id: number,
): RegionMarkers {
  return {
    open: `<!--kyneta:${type}:${id}-->`,
    close: `<!--/kyneta:${type}-->`,
  }
}

/**
 * Generate a region marker ID string.
 *
 * This is the format used in the marker comments, without the comment delimiters.
 * Useful when generating code that references markers by ID.
 *
 * @param type - The region type ("list" or "if")
 * @param id - Unique marker ID
 * @returns The marker ID string (e.g., "kyneta:list:1")
 */
export function generateMarkerId(type: RegionMarkerType, id: number): string {
  return `kyneta:${type}:${id}`
}
