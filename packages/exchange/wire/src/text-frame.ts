// text-frame — text frame encoding/decoding for @kyneta/wire.
//
// Text frames use a JSON array wire format with a 2-character prefix:
//
//   Position 0: version character ('0' = version 0, '1' = version 1, ...)
//   Position 1: type character:
//     'c' = complete
//     'f' = fragment
//
// Complete frame:   ["1c", <payload>]
// Fragment frame:   ["1f", frameId, index, total, totalSize, chunk]
//
// The payload is a JSON-safe object (single message) or array (batch).
// Fragments carry JSON substring chunks. The receiver concatenates
// chunks in index order and JSON.parse the result.

import type { WireCodec } from "./fragment-generic.js"
import type { Frame } from "./frame-types.js"
import { complete, fragment } from "./frame-types.js"
import {
  decodeTextWireMessage,
  encodeTextWireMessage,
} from "./wire-message-helpers.js"

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const TEXT_WIRE_VERSION = 1

// ---------------------------------------------------------------------------
// Prefix encoding
// ---------------------------------------------------------------------------

function buildPrefix(version: number, isFragment: boolean): string {
  const versionChar = String(version)
  return versionChar + (isFragment ? "f" : "c")
}

/**
 * Parsed prefix information.
 */
type PrefixInfo = {
  version: number
  isFragment: boolean
}

/** @throws TextFrameDecodeError if the prefix is malformed */
function parsePrefix(prefix: string): PrefixInfo {
  if (typeof prefix !== "string" || prefix.length !== 2) {
    throw new TextFrameDecodeError(
      "invalid_prefix",
      `Expected 2-character prefix string, got: ${JSON.stringify(prefix)}`,
    )
  }

  const versionChar = prefix.charAt(0)
  const typeChar = prefix.charAt(1)

  const version = Number.parseInt(versionChar, 10)
  if (Number.isNaN(version)) {
    throw new TextFrameDecodeError(
      "invalid_prefix",
      `Invalid version character: ${JSON.stringify(versionChar)}`,
    )
  }

  switch (typeChar) {
    case "c":
      return { version, isFragment: false }
    case "f":
      return { version, isFragment: true }
    default:
      throw new TextFrameDecodeError(
        "invalid_prefix",
        `Unknown type character: ${JSON.stringify(typeChar)}`,
      )
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Encode a `Frame<string>` into its text wire representation.
 *
 * For complete frames, the payload is JSON-parsed to embed as a
 * native JSON value (not a string within a string). This means
 * the payload string must be valid JSON.
 *
 * For fragment frames, the payload is a raw substring chunk —
 * it's embedded as a JSON string element in the array.
 */
export function encodeTextFrame(frame: Frame<string>): string {
  const { version, content } = frame

  if (content.kind === "complete") {
    const prefix = buildPrefix(version, false)
    const payloadValue = JSON.parse(content.payload)
    return JSON.stringify([prefix, payloadValue])
  }

  // Fragment
  const { frameId, index, total, totalSize, payload } = content
  const prefix = buildPrefix(version, true)
  return JSON.stringify([prefix, frameId, index, total, totalSize, payload])
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a text wire frame back to a `Frame<string>`.
 *
 * For complete frames, the payload is re-serialized to a JSON string
 * so that `Frame<string>` always carries a string payload.
 *
 * For fragment frames, the payload is a JSON substring chunk (string).
 *
 * @throws TextFrameDecodeError if the frame is malformed
 */
export function decodeTextFrame(wire: string): Frame<string> {
  let arr: unknown[]
  try {
    const parsed = JSON.parse(wire)
    if (!Array.isArray(parsed) || parsed.length < 2) {
      throw new TextFrameDecodeError(
        "invalid_structure",
        "Text frame must be a JSON array with at least 2 elements",
      )
    }
    arr = parsed
  } catch (error) {
    if (error instanceof TextFrameDecodeError) throw error
    throw new TextFrameDecodeError(
      "invalid_json",
      `Failed to parse text frame JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const { version, isFragment } = parsePrefix(arr[0] as string)

  if (version !== TEXT_WIRE_VERSION) {
    throw new TextFrameDecodeError(
      "unsupported_version",
      `Unsupported text wire version: ${version} (expected ${TEXT_WIRE_VERSION})`,
    )
  }

  if (!isFragment) {
    // Complete frame: ["Vc", payload]
    const payloadValue = arr[1]
    const payload = JSON.stringify(payloadValue)
    return complete(version, payload, null)
  }

  // Fragment frame: ["Vf", frameId, index, total, totalSize, chunk]
  if (arr.length < 6) {
    throw new TextFrameDecodeError(
      "truncated",
      `Fragment frame requires at least 6 elements, got ${arr.length}`,
    )
  }

  const frameId = arr[1] as number
  const index = arr[2] as number
  const total = arr[3] as number
  const totalSize = arr[4] as number
  const chunk = arr[5] as string

  if (typeof frameId !== "number") {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Fragment frameId must be a number",
    )
  }
  if (
    typeof index !== "number" ||
    typeof total !== "number" ||
    typeof totalSize !== "number"
  ) {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Fragment index/total/totalSize must be numbers",
    )
  }
  if (typeof chunk !== "string") {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Fragment chunk must be a string",
    )
  }

  return fragment(version, frameId, index, total, totalSize, chunk, null)
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Error codes for text frame decode failures.
 */
export type TextFrameDecodeErrorCode =
  | "invalid_json"
  | "invalid_prefix"
  | "invalid_structure"
  | "unsupported_version"
  | "truncated"
  | "doc-id-too-long"
  | "schema-hash-too-long"
  | "doc-id-form-conflict"
  | "schema-hash-form-conflict"

/**
 * Error thrown when text frame decoding fails.
 */
export class TextFrameDecodeError extends Error {
  override readonly name = "TextFrameDecodeError"

  constructor(
    public readonly code: TextFrameDecodeErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Text codec record
// ---------------------------------------------------------------------------

export const TEXT_CODEC: WireCodec<string> = {
  wireVersion: TEXT_WIRE_VERSION,
  maxPayload: 0x7fffffff,
  sizeOf: (s: string) => s.length,
  concatenate: (chunks: readonly string[]) => chunks.join(""),
  slice: (s: string, start: number, end: number) => s.slice(start, end),
  encodeFrame: encodeTextFrame,
  decodeFrame: decodeTextFrame,
  encodeWire: encodeTextWireMessage,
  decodeWire: decodeTextWireMessage,
}
