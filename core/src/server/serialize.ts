/**
 * State Serialization for SSR Hydration
 *
 * This module provides utilities for serializing Loro document state
 * on the server and deserializing it on the client for hydration.
 *
 * The serialized state allows the client to:
 * 1. Reconstruct the exact document state used during SSR
 * 2. Attach subscriptions to the existing DOM
 * 3. Continue with live updates from that point
 *
 * @packageDocumentation
 */

import { loro } from "@loro-extended/change"
import type { LoroDoc } from "loro-crdt"

// =============================================================================
// Types
// =============================================================================

/**
 * Serialized state for hydration.
 */
export interface SerializedState {
  /**
   * The serialized Loro document snapshot.
   * This is a base64-encoded binary snapshot.
   */
  snapshot: string

  /**
   * Version vector of the document at serialization time.
   * Used to detect conflicts during hydration.
   */
  version: string

  /**
   * Timestamp when the state was serialized.
   * Useful for debugging and cache invalidation.
   */
  timestamp: number

  /**
   * Optional schema identifier for validation.
   */
  schemaId?: string
}

/**
 * Options for state serialization.
 */
export interface SerializeOptions {
  /**
   * Optional schema identifier to include in serialized state.
   * Helps validate that client and server use the same schema.
   */
  schemaId?: string

  /**
   * Whether to include the full snapshot or just the version.
   * Set to false for delta-based hydration (requires separate snapshot fetch).
   * @default true
   */
  includeSnapshot?: boolean
}

/**
 * Options for state deserialization.
 */
export interface DeserializeOptions {
  /**
   * Expected schema ID. If provided and doesn't match, throws an error.
   */
  expectedSchemaId?: string

  /**
   * Whether to validate the version vector.
   * @default true
   */
  validateVersion?: boolean
}

// =============================================================================
// Serialization
// =============================================================================

/**
 * Serialize a Loro document state for hydration.
 *
 * This exports the document's snapshot and version information
 * in a format suitable for embedding in HTML and sending to the client.
 *
 * @param doc - The Loro document or typed doc to serialize
 * @param options - Serialization options
 * @returns Serialized state object
 *
 * @example
 * ```ts
 * import { serializeState } from "@loro-extended/kinetic/server"
 *
 * const state = serializeState(doc)
 * const script = `<script>window.__KINETIC_STATE__ = ${JSON.stringify(state)}</script>`
 * ```
 */
export function serializeState(
  doc: LoroDoc | unknown,
  options: SerializeOptions = {},
): SerializedState {
  // Get the underlying Loro document
  const loroDoc = loro(doc as Parameters<typeof loro>[0]) as LoroDoc

  // Export the snapshot as bytes
  const snapshotBytes = loroDoc.export({ mode: "snapshot" })

  // Convert to base64
  const snapshot =
    options.includeSnapshot !== false ? bytesToBase64(snapshotBytes) : ""

  // Get version information
  const versionMap = loroDoc.version()
  const version = JSON.stringify(versionMap.toJSON())

  return {
    snapshot,
    version,
    timestamp: Date.now(),
    schemaId: options.schemaId,
  }
}

/**
 * Serialize state to a JSON string for embedding in HTML.
 *
 * @param doc - The Loro document to serialize
 * @param options - Serialization options
 * @returns JSON string of serialized state
 */
export function serializeStateToJSON(
  doc: LoroDoc | unknown,
  options: SerializeOptions = {},
): string {
  const state = serializeState(doc, options)
  return JSON.stringify(state)
}

/**
 * Generate a script tag containing the serialized state.
 *
 * This creates a script tag that assigns the state to a global variable,
 * which can then be used by the client during hydration.
 *
 * @param doc - The Loro document to serialize
 * @param options - Serialization options plus script options
 * @returns HTML script tag string
 *
 * @example
 * ```ts
 * const scriptTag = generateStateScript(doc, { varName: '__APP_STATE__' })
 * // Returns: <script>window.__APP_STATE__ = {...}</script>
 * ```
 */
export function generateStateScript(
  doc: LoroDoc | unknown,
  options: SerializeOptions & {
    /** Global variable name to use. @default '__KINETIC_STATE__' */
    varName?: string
    /** Whether to use type="application/json" instead of inline JS. @default false */
    asJson?: boolean
    /** Script ID for retrieval. @default 'kinetic-state' */
    scriptId?: string
  } = {},
): string {
  const varName = options.varName ?? "__KINETIC_STATE__"
  const scriptId = options.scriptId ?? "kinetic-state"
  const json = serializeStateToJSON(doc, options)

  if (options.asJson) {
    // Use a JSON script tag (safer, doesn't execute)
    return `<script id="${scriptId}" type="application/json">${json}</script>`
  }

  // Inline JavaScript assignment
  return `<script>window.${varName} = ${json};</script>`
}

// =============================================================================
// Deserialization
// =============================================================================

/**
 * Deserialize state and import it into a Loro document.
 *
 * This is used on the client to restore the server state before hydration.
 *
 * @param doc - The Loro document to import into
 * @param state - The serialized state from the server
 * @param options - Deserialization options
 *
 * @example
 * ```ts
 * import { deserializeState } from "@loro-extended/kinetic/server"
 *
 * const state = window.__KINETIC_STATE__
 * deserializeState(doc, state)
 * // Now doc has the same state as on the server
 * ```
 */
export function deserializeState(
  doc: LoroDoc | unknown,
  state: SerializedState,
  options: DeserializeOptions = {},
): void {
  // Validate schema if expected
  if (options.expectedSchemaId && state.schemaId !== options.expectedSchemaId) {
    throw new Error(
      `Schema mismatch: expected "${options.expectedSchemaId}", got "${state.schemaId}"`,
    )
  }

  // Get the underlying Loro document
  const loroDoc = loro(doc as Parameters<typeof loro>[0]) as LoroDoc

  // Import the snapshot
  if (state.snapshot) {
    const snapshotBytes = base64ToBytes(state.snapshot)
    loroDoc.import(snapshotBytes)
  }

  // Optionally validate version
  if (options.validateVersion !== false && state.version) {
    const serverVersion = JSON.parse(state.version) as Record<string, number>
    const clientVersionMap = loroDoc.version().toJSON()

    // Check that the client version includes the server version
    // This ensures no data was lost during transfer
    for (const [peerId, counter] of Object.entries(serverVersion)) {
      const clientCounter = clientVersionMap.get(peerId as `${number}`)
      if (clientCounter === undefined || clientCounter < counter) {
        console.warn(
          `Version mismatch for peer ${peerId}: server=${counter}, client=${clientCounter}`,
        )
      }
    }
  }
}

/**
 * Deserialize state from a JSON string.
 *
 * @param doc - The Loro document to import into
 * @param json - JSON string of serialized state
 * @param options - Deserialization options
 */
export function deserializeStateFromJSON(
  doc: LoroDoc | unknown,
  json: string,
  options: DeserializeOptions = {},
): void {
  const state = JSON.parse(json) as SerializedState
  deserializeState(doc, state, options)
}

/**
 * Extract state from a script tag in the document.
 *
 * This is a client-side utility to retrieve state embedded during SSR.
 *
 * @param scriptId - The ID of the script tag
 * @returns The parsed serialized state, or null if not found
 *
 * @example
 * ```ts
 * const state = extractStateFromScript('kinetic-state')
 * if (state) {
 *   deserializeState(doc, state)
 * }
 * ```
 */
export function extractStateFromScript(
  scriptId: string = "kinetic-state",
): SerializedState | null {
  // This runs on the client
  if (typeof document === "undefined") {
    return null
  }

  const script = document.getElementById(scriptId)
  if (!script) {
    return null
  }

  try {
    const json = script.textContent
    if (!json) {
      return null
    }
    return JSON.parse(json) as SerializedState
  } catch {
    return null
  }
}

/**
 * Extract state from a global variable.
 *
 * @param varName - The global variable name
 * @returns The serialized state, or null if not found
 */
export function extractStateFromGlobal(
  varName: string = "__KINETIC_STATE__",
): SerializedState | null {
  if (typeof window === "undefined") {
    return null
  }

  const state = (window as unknown as Record<string, unknown>)[varName]
  if (!state || typeof state !== "object") {
    return null
  }

  return state as SerializedState
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Convert a Uint8Array to a base64 string.
 *
 * @param bytes - The bytes to encode
 * @returns Base64 encoded string
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Use btoa in browser, Buffer in Node
  if (typeof btoa === "function") {
    // Browser environment
    const binary = Array.from(bytes)
      .map(b => String.fromCharCode(b))
      .join("")
    return btoa(binary)
  } else if (typeof Buffer !== "undefined") {
    // Node environment
    return Buffer.from(bytes).toString("base64")
  }
  throw new Error("No base64 encoding method available")
}

/**
 * Convert a base64 string to a Uint8Array.
 *
 * @param base64 - The base64 string to decode
 * @returns Decoded bytes
 */
export function base64ToBytes(base64: string): Uint8Array {
  // Use atob in browser, Buffer in Node
  if (typeof atob === "function") {
    // Browser environment
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return bytes
  } else if (typeof Buffer !== "undefined") {
    // Node environment
    return new Uint8Array(Buffer.from(base64, "base64"))
  }
  throw new Error("No base64 decoding method available")
}

/**
 * Check if the current environment has a serialized state available.
 *
 * This is useful for determining whether to hydrate or do a fresh render.
 *
 * @param varName - Global variable name to check
 * @param scriptId - Script tag ID to check
 * @returns true if state is available
 */
export function hasSerializedState(
  varName: string = "__KINETIC_STATE__",
  scriptId: string = "kinetic-state",
): boolean {
  return (
    extractStateFromGlobal(varName) !== null ||
    extractStateFromScript(scriptId) !== null
  )
}
