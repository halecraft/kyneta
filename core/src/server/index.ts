/**
 * Kinetic Server-Side Rendering
 *
 * Provides utilities for rendering Kinetic elements to HTML strings
 * on the server, and hydrating them on the client.
 *
 * @packageDocumentation
 */

// =============================================================================
// Server Rendering (to be implemented in Phase 10)
// =============================================================================

// export { renderToString } from "./render.js"
// export { serializeState } from "./serialize.js"

// =============================================================================
// Placeholder exports
// =============================================================================

/**
 * Render a Kinetic element to an HTML string.
 *
 * @param element - The element to render
 * @returns HTML string
 *
 * @example
 * ```ts
 * import { renderToString } from "@loro-extended/kinetic/server"
 * import { div, h1, p } from "@loro-extended/kinetic"
 *
 * const html = renderToString(
 *   div(() => {
 *     h1("Hello, World!")
 *     p("Server-rendered content")
 *   })
 * )
 * ```
 *
 * @remarks
 * This is a placeholder. Implementation comes in Phase 10.
 */
export function renderToString(_element: () => Node): string {
  throw new Error("SSR not yet implemented. See Phase 10 of the plan.")
}

/**
 * Options for rendering to string.
 */
export interface RenderOptions {
  /**
   * Include hydration markers in output.
   * These are HTML comments that help the client locate regions.
   * @default true
   */
  hydratable?: boolean

  /**
   * Pretty-print the output HTML.
   * @default false
   */
  pretty?: boolean
}

/**
 * Render a Kinetic element to an HTML string with options.
 *
 * @param element - The element to render
 * @param options - Rendering options
 * @returns HTML string
 *
 * @remarks
 * This is a placeholder. Implementation comes in Phase 10.
 */
export function renderToStringWithOptions(
  _element: () => Node,
  _options: RenderOptions,
): string {
  throw new Error("SSR not yet implemented. See Phase 10 of the plan.")
}

/**
 * Serialize the state needed for hydration.
 *
 * This extracts the Loro document state that needs to be sent
 * to the client for hydration.
 *
 * @param doc - The Loro document used during rendering
 * @returns Serialized state as a base64 string
 *
 * @remarks
 * This is a placeholder. Implementation comes in Phase 10.
 */
export function serializeState(_doc: unknown): string {
  throw new Error("SSR not yet implemented. See Phase 10 of the plan.")
}
