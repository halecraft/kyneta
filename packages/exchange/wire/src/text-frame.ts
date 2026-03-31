// text-frame — text frame encoding/decoding for @kyneta/wire.
//
// Text frames use a JSON array wire format with a 2-character prefix:
//
//   Position 0: version character ('0' = version 0, '1' = version 1, ...)
//   Position 1: type + hash via case:
//     'c' = complete, no hash
//     'C' = complete, with SHA-256 hash (digest in next element)
//     'f' = fragment, no hash
//     'F' = fragment, with SHA-256 hash (digest in next element)
//
// Complete frame (no hash):   ["0c", <payload>]
// Complete frame (with hash): ["0C", "hexdigest", <payload>]
// Fragment (no hash):         ["0f", frameId, index, total, totalSize, chunk]
// Fragment (with hash):       ["0F", "hexdigest", frameId, index, total, totalSize, chunk]
//
// The payload is a JSON-safe object (single message) or array (batch).
// Fragments carry JSON substring chunks. The receiver concatenates
// chunks in index order and JSON.parse the result.

import type { ChannelMsg } from "@kyneta/exchange"
import type { TextCodec } from "./codec.js"
import { generateFrameId } from "./fragment.js"
import type { Frame } from "./frame-types.js"
import { complete, fragment } from "./frame-types.js"

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/** Current text wire protocol version. */
export const TEXT_WIRE_VERSION = 0

// ---------------------------------------------------------------------------
// Prefix encoding
// ---------------------------------------------------------------------------

/**
 * Build the 2-character prefix string from version, type, and hash presence.
 */
function buildPrefix(
  version: number,
  isFragment: boolean,
  hasHash: boolean,
): string {
  const versionChar = String(version)
  let typeChar: string
  if (isFragment) {
    typeChar = hasHash ? "F" : "f"
  } else {
    typeChar = hasHash ? "C" : "c"
  }
  return versionChar + typeChar
}

/**
 * Parsed prefix information.
 */
type PrefixInfo = {
  version: number
  isFragment: boolean
  hasHash: boolean
}

/**
 * Parse a 2-character prefix string.
 * @throws Error if the prefix is malformed
 */
function parsePrefix(prefix: string): PrefixInfo {
  if (typeof prefix !== "string" || prefix.length !== 2) {
    throw new TextFrameDecodeError(
      "invalid_prefix",
      `Expected 2-character prefix string, got: ${JSON.stringify(prefix)}`,
    )
  }

  const versionChar = prefix[0]!
  const typeChar = prefix[1]!

  const version = Number.parseInt(versionChar, 10)
  if (Number.isNaN(version)) {
    throw new TextFrameDecodeError(
      "invalid_prefix",
      `Invalid version character: ${JSON.stringify(versionChar)}`,
    )
  }

  let isFragment: boolean
  let hasHash: boolean

  switch (typeChar) {
    case "c":
      isFragment = false
      hasHash = false
      break
    case "C":
      isFragment = false
      hasHash = true
      break
    case "f":
      isFragment = true
      hasHash = false
      break
    case "F":
      isFragment = true
      hasHash = true
      break
    default:
      throw new TextFrameDecodeError(
        "invalid_prefix",
        `Unknown type character: ${JSON.stringify(typeChar)}`,
      )
  }

  return { version, isFragment, hasHash }
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
  const { version, hash, content } = frame
  const hasHash = hash !== null

  if (content.kind === "complete") {
    const prefix = buildPrefix(version, false, hasHash)
    // Parse the payload string to embed as native JSON value.
    // The payload is a JSON-serialized object or array from the codec.
    const payloadValue = JSON.parse(content.payload)
    if (hasHash) {
      return JSON.stringify([prefix, hash, payloadValue])
    }
    return JSON.stringify([prefix, payloadValue])
  }

  // Fragment
  const { frameId, index, total, totalSize, payload } = content
  const prefix = buildPrefix(version, true, hasHash)
  if (hasHash) {
    return JSON.stringify([
      prefix,
      hash,
      frameId,
      index,
      total,
      totalSize,
      payload,
    ])
  }
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

  const prefixInfo = parsePrefix(arr[0] as string)
  const { version, isFragment, hasHash } = prefixInfo

  if (version !== TEXT_WIRE_VERSION) {
    throw new TextFrameDecodeError(
      "unsupported_version",
      `Unsupported text wire version: ${version} (expected ${TEXT_WIRE_VERSION})`,
    )
  }

  if (!isFragment) {
    // Complete frame
    let hash: string | null = null
    let payloadValue: unknown

    if (hasHash) {
      // ["0C", hash, payload]
      if (arr.length < 3) {
        throw new TextFrameDecodeError(
          "truncated",
          `Complete frame with hash requires at least 3 elements, got ${arr.length}`,
        )
      }
      hash = arr[1] as string
      payloadValue = arr[2]
    } else {
      // ["0c", payload]
      payloadValue = arr[1]
    }

    // Re-serialize the payload to string (Frame<string> carries string payloads)
    const payload = JSON.stringify(payloadValue)
    return complete(version, payload, hash)
  }

  // Fragment frame
  let hash: string | null = null
  let offset = 1 // skip prefix

  if (hasHash) {
    // ["0F", hash, frameId, index, total, totalSize, chunk]
    const minElements = 7
    if (arr.length < minElements) {
      throw new TextFrameDecodeError(
        "truncated",
        `Fragment frame with hash requires at least ${minElements} elements, got ${arr.length}`,
      )
    }
    hash = arr[offset] as string
    offset++
  } else {
    // ["0f", frameId, index, total, totalSize, chunk]
    const minElements = 6
    if (arr.length < minElements) {
      throw new TextFrameDecodeError(
        "truncated",
        `Fragment frame requires at least ${minElements} elements, got ${arr.length}`,
      )
    }
  }

  const frameId = arr[offset] as string
  const index = arr[offset + 1] as number
  const total = arr[offset + 2] as number
  const totalSize = arr[offset + 3] as number
  const chunk = arr[offset + 4] as string

  if (typeof frameId !== "string") {
    throw new TextFrameDecodeError(
      "invalid_structure",
      "Fragment frameId must be a string",
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

  return fragment(version, frameId, index, total, totalSize, chunk, hash)
}

// ---------------------------------------------------------------------------
// Text fragmentation
// ---------------------------------------------------------------------------

/**
 * Fragment a JSON payload string into multiple text frame strings.
 *
 * Each returned string is a complete, self-describing text fragment
 * frame (valid JSON) that can be sent independently. The receiver
 * collects fragments by frameId and concatenates the chunks in index
 * order to reconstruct the original payload string.
 *
 * @param payload - The JSON string to fragment (e.g. from JSON.stringify(codec.encode(msg)))
 * @param maxChunkSize - Maximum character length of each chunk
 * @returns Array of text frame JSON strings, one per fragment
 */
export function fragmentTextPayload(
  payload: string,
  maxChunkSize: number,
): string[] {
  if (maxChunkSize <= 0) {
    throw new Error("maxChunkSize must be positive")
  }

  const frameId = generateFrameId()
  const totalSize = payload.length
  const total = Math.ceil(totalSize / maxChunkSize)
  const result: string[] = []

  for (let i = 0; i < total; i++) {
    const chunkStart = i * maxChunkSize
    const chunkEnd = Math.min(chunkStart + maxChunkSize, totalSize)
    const chunk = payload.slice(chunkStart, chunkEnd)

    const frame = fragment(
      TEXT_WIRE_VERSION,
      frameId,
      i,
      total,
      totalSize,
      chunk,
    )

    result.push(encodeTextFrame(frame))
  }

  return result
}

// ---------------------------------------------------------------------------
// Convenience — encode from ChannelMsg
// ---------------------------------------------------------------------------

/**
 * Encode a single `ChannelMsg` as a complete text frame string.
 *
 * Composes codec.encode → JSON.stringify → encodeTextFrame.
 */
export function encodeTextComplete(codec: TextCodec, msg: ChannelMsg): string {
  const payload = JSON.stringify(codec.encode(msg))
  return encodeTextFrame(complete(TEXT_WIRE_VERSION, payload))
}

/**
 * Encode a batch of `ChannelMsg` as a complete text frame string.
 *
 * The batch is codec-encoded as an array payload. The frame layer
 * doesn't distinguish single from batch — the payload is self-describing.
 */
export function encodeTextCompleteBatch(
  codec: TextCodec,
  msgs: ChannelMsg[],
): string {
  const payload = JSON.stringify(codec.encode(msgs))
  return encodeTextFrame(complete(TEXT_WIRE_VERSION, payload))
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
