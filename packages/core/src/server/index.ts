/**
 * Kinetic Server-Side Rendering
 *
 * Provides utilities for rendering Kinetic elements to HTML strings
 * on the server.
 *
 * @packageDocumentation
 */

// =============================================================================
// Render Functions
// =============================================================================

export {
  closeMarker,
  createRenderFunction,
  escapeHtml,
  executeRender,
  generateMarkerId,
  isVoidElement,
  openMarker,
  type RenderToStringOptions,
  renderAttribute,
  renderAttributes,
  renderCloseTag,
  renderConditional,
  renderElement,
  renderList,
  renderOpenTag,
  renderToDocument,
  renderToString,
  type SSRContext,
  type SSRRenderFunction,
} from "./render.js"

