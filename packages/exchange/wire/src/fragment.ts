// fragment — transport-level fragmentation for large payloads.
//
// Pure functions for fragmenting and parsing transport payloads.
// Stateful reassembly logic lives in the FragmentCollector (generic)
// and its binary/text wrappers.
//
// Two transport payload types:
// - Complete (0x00): a full frame (single or batch — self-describing)
// - Fragment (0x01): a self-describing fragment frame
//
// Fragments are fully self-describing: each carries frameId, index,
// total, and totalSize. No separate "fragment header" message is
// needed — the collector auto-creates state on first contact.

import {
  BinaryFrameType,
  FRAGMENT,
  FRAGMENT_META_SIZE,
  FRAGMENT_MIN_SIZE,
  FRAME_ID_SIZE,
  HASH_ALGO,
  HEADER_SIZE,
  MESSAGE_COMPLETE,
  WIRE_VERSION,
} from "./constants.js"

// ---------------------------------------------------------------------------
// Transport payload types
// ---------------------------------------------------------------------------

/**
 * Discriminated union for parsed transport payloads.
 *
 * Two variants:
 * - `complete`: a full frame (may contain a single message or a batch)
 * - `fragment`: a self-describing fragment with reassembly metadata
 */
export type TransportPayload =
  | { kind: "complete"; data: Uint8Array }
  | { kind: "fragment"; data: Uint8Array }

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Error thrown when parsing transport payloads fails.
 */
export class FragmentParseError extends Error {
  override readonly name = "FragmentParseError"

  constructor(
    public readonly code: "unknown_prefix" | "truncated" | "empty",
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Frame ID helpers
// ---------------------------------------------------------------------------

/**
 * Generate a random frame ID as a hex string.
 *
 * Uses crypto.getRandomValues for randomness. The returned string
 * is `FRAME_ID_SIZE * 2` hex characters (16 chars for 8 bytes).
 */
export function generateFrameId(): string {
  const bytes = new Uint8Array(FRAME_ID_SIZE)
  crypto.getRandomValues(bytes)
  return bytesToHex(bytes)
}

/**
 * Convert a Uint8Array to a hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]?.toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Convert a hex string to a fixed-length Uint8Array.
 * Pads with zeros or truncates to `length` bytes.
 */
export function hexToBytes(hex: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const chars = Math.min(hex.length, length * 2)
  for (let i = 0; i < chars; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// Transport payload construction
// ---------------------------------------------------------------------------

/**
 * Wrap a complete frame with the MESSAGE_COMPLETE transport prefix.
 *
 * Used by adapters for unfragmented messages — prepends the 0x00 byte
 * so the receiver can distinguish complete frames from fragments.
 */
export function wrapCompleteMessage(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(1 + data.length)
  result[0] = MESSAGE_COMPLETE
  result.set(data, 1)
  return result
}

/**
 * Wrap a fragment frame with the FRAGMENT transport prefix.
 *
 * Used by adapters for fragmented messages — prepends the 0x01 byte
 * so the receiver can quickly distinguish fragments from complete frames.
 */
export function wrapFragment(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(1 + data.length)
  result[0] = FRAGMENT
  result.set(data, 1)
  return result
}

// ---------------------------------------------------------------------------
// Transport payload parsing
// ---------------------------------------------------------------------------

/**
 * Parse a transport payload from raw bytes.
 *
 * Inspects the first byte (prefix) to determine the payload type:
 * - 0x00: complete frame
 * - 0x01: fragment frame
 *
 * @throws FragmentParseError if parsing fails
 */
export function parseTransportPayload(data: Uint8Array): TransportPayload {
  if (data.length < 1) {
    throw new FragmentParseError("empty", "Empty transport payload")
  }

  const prefix = data[0]

  switch (prefix) {
    case MESSAGE_COMPLETE: {
      if (data.length < 1 + HEADER_SIZE) {
        throw new FragmentParseError(
          "truncated",
          `Complete payload too short: expected at least ${1 + HEADER_SIZE} bytes, got ${data.length}`,
        )
      }
      return { kind: "complete", data: data.slice(1) }
    }

    case FRAGMENT: {
      if (data.length < 1 + FRAGMENT_MIN_SIZE) {
        throw new FragmentParseError(
          "truncated",
          `Fragment payload too short: expected at least ${1 + FRAGMENT_MIN_SIZE} bytes, got ${data.length}`,
        )
      }
      return { kind: "fragment", data: data.slice(1) }
    }

    default:
      throw new FragmentParseError(
        "unknown_prefix",
        `Unknown transport payload prefix: 0x${prefix?.toString(16).padStart(2, "0")}`,
      )
  }
}

// ---------------------------------------------------------------------------
// Fragmentation
// ---------------------------------------------------------------------------

/**
 * Fragment a codec-encoded payload into multiple self-describing
 * binary fragment frames, each wrapped with the FRAGMENT transport prefix.
 *
 * Each fragment is a complete binary frame with:
 * - 7-byte header (version, type=FRAGMENT, hashAlgo=NONE, payloadLength)
 * - 20-byte fragment metadata (frameId, index, total, totalSize)
 * - chunk data
 *
 * The returned array contains one transport-prefixed fragment per chunk.
 * Unlike the old protocol, there is no separate "fragment header" message.
 *
 * @param frameData - The complete binary frame data to fragment (header + payload)
 * @param maxChunkSize - Maximum size of each fragment's data chunk (not including frame header or metadata)
 * @returns Array of transport-prefixed fragment payloads
 */
export function fragmentPayload(
  frameData: Uint8Array,
  maxChunkSize: number,
): Uint8Array<ArrayBuffer>[] {
  if (maxChunkSize <= 0) {
    throw new Error("maxChunkSize must be positive")
  }

  const frameId = generateFrameId()
  const frameIdBytes = hexToBytes(frameId, FRAME_ID_SIZE)
  const totalSize = frameData.length
  const fragmentCount = Math.ceil(totalSize / maxChunkSize)
  const result: Uint8Array<ArrayBuffer>[] = []

  for (let i = 0; i < fragmentCount; i++) {
    const chunkStart = i * maxChunkSize
    const chunkEnd = Math.min(chunkStart + maxChunkSize, totalSize)
    const chunk = frameData.slice(chunkStart, chunkEnd)

    // Build the fragment frame: header + metadata + chunk
    const fragFrame = buildFragmentFrame(
      frameIdBytes,
      i,
      fragmentCount,
      totalSize,
      chunk,
    )

    // Wrap with FRAGMENT transport prefix
    result.push(wrapFragment(fragFrame))
  }

  return result
}

/**
 * Build a self-describing binary fragment frame.
 *
 * Layout: 7B header + 20B metadata + chunk data
 */
function buildFragmentFrame(
  frameIdBytes: Uint8Array,
  index: number,
  total: number,
  totalSize: number,
  chunk: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(HEADER_SIZE + FRAGMENT_META_SIZE + chunk.length)
  const view = new DataView(frame.buffer)

  // 7-byte header
  view.setUint8(0, WIRE_VERSION)
  view.setUint8(1, BinaryFrameType.FRAGMENT)
  view.setUint8(2, HASH_ALGO.NONE)
  view.setUint32(3, chunk.length, false)

  // 20-byte fragment metadata
  let offset = HEADER_SIZE
  frame.set(frameIdBytes, offset)
  offset += FRAME_ID_SIZE
  view.setUint32(offset, index, false)
  offset += 4
  view.setUint32(offset, total, false)
  offset += 4
  view.setUint32(offset, totalSize, false)
  offset += 4

  // Chunk data
  frame.set(chunk, offset)

  return frame
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Check if a payload should be fragmented based on size.
 *
 * @param payloadSize - Size of the payload in bytes
 * @param threshold - Size threshold for fragmentation
 * @returns true if the payload exceeds the threshold
 */
export function shouldFragment(
  payloadSize: number,
  threshold: number,
): boolean {
  return payloadSize > threshold
}

/**
 * Calculate the overhead of fragmentation for a given payload size.
 *
 * @param payloadSize - Size of the original payload
 * @param maxChunkSize - Maximum size of each fragment's data chunk
 * @returns Total overhead in bytes (per-fragment headers + metadata)
 */
export function calculateFragmentationOverhead(
  payloadSize: number,
  maxChunkSize: number,
): number {
  const fragmentCount = Math.ceil(payloadSize / maxChunkSize)
  // Per fragment: 1 (transport prefix) + 7 (header) + 20 (metadata) = 28 bytes
  const perFragmentOverhead = 1 + HEADER_SIZE + FRAGMENT_META_SIZE
  return fragmentCount * perFragmentOverhead
}
