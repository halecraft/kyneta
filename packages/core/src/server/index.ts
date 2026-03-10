/**
 * Kinetic Server-Side Rendering
 *
 * Provides utilities for rendering Kinetic elements to HTML strings
 * on the server, and serializing state for client hydration.
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

// =============================================================================
// State Serialization
// =============================================================================

export {
  base64ToBytes,
  bytesToBase64,
  type DeserializeOptions,
  deserializeState,
  deserializeStateFromJSON,
  extractStateFromGlobal,
  extractStateFromScript,
  generateStateScript,
  hasSerializedState,
  type SerializedState,
  type SerializeOptions,
  serializeState,
  serializeStateToJSON,
} from "./serialize.js"
