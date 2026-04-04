// frame — binary frame encoding/decoding for @kyneta/wire.
//
// Every binary message is wrapped in a frame with a 7-byte header:
//
//   ┌──────────┬──────────┬──────────┬───────────────────────────────┐
//   │ Version  │   Type   │ HashAlgo │       Payload Length          │
//   │ (1 byte) │ (1 byte) │ (1 byte) │     (4 bytes, big-endian)    │
//   ├──────────┴──────────┴──────────┴───────────────────────────────┤
//   │  [if hash: digest (32B for SHA-256)]                          │
//   ├───────────────────────────────────────────────────────────────-┤
//   │  [if fragment: frameId(8B) + index(4B) + total(4B)            │
//   │                + totalSize(4B)]                                │
//   ├───────────────────────────────────────────────────────────────-┤
//   │  Payload (codec-encoded bytes)                                │
//   └───────────────────────────────────────────────────────────────-┘
//
// The frame type byte distinguishes complete frames from fragments.
// Batching is orthogonal — the payload is self-describing (CBOR array
// vs map). The frame layer never needs to know.

import type { ChannelMsg } from "@kyneta/exchange"
import type { BinaryCodec } from "./codec.js"
import {
  BinaryFrameType,
  type BinaryFrameTypeValue,
  FRAGMENT_META_SIZE,
  FRAME_ID_SIZE,
  HASH_ALGO,
  HEADER_SIZE,
  WIRE_VERSION,
} from "./constants.js"
import type { Frame } from "./frame-types.js"
import { complete, fragment as fragmentFrame } from "./frame-types.js"

// ---------------------------------------------------------------------------
// Encoding — generic
// ---------------------------------------------------------------------------

/**
 * Encode a `Frame<Uint8Array>` into its binary wire representation.
 *
 * Handles both complete and fragment frames. The payload must already
 * be codec-encoded (raw bytes). Use the convenience functions
 * `encodeComplete` / `encodeCompleteBatch` for the common case of
 * encoding from `ChannelMsg`.
 */
export function encodeBinaryFrame(frame: Frame<Uint8Array>): Uint8Array {
  const { version, hash, content } = frame

  const hashAlgo = hash !== null ? HASH_ALGO.SHA256 : HASH_ALGO.NONE
  // Future: decode hash hex string to bytes when hashAlgo !== NONE
  // For now, hash is always null so no digest bytes are written.

  if (content.kind === "complete") {
    const payload = content.payload
    const frameBytes = new Uint8Array(HEADER_SIZE + payload.length)
    const view = new DataView(frameBytes.buffer)

    view.setUint8(0, version)
    view.setUint8(1, BinaryFrameType.COMPLETE)
    view.setUint8(2, hashAlgo)
    view.setUint32(3, payload.length, false)

    frameBytes.set(payload, HEADER_SIZE)
    return frameBytes
  }

  // Fragment frame
  const { frameId, index, total, totalSize, payload } = content
  const frameIdBytes = hexToBytes(frameId, FRAME_ID_SIZE)

  const totalLen = HEADER_SIZE + FRAGMENT_META_SIZE + payload.length
  const frameBytes = new Uint8Array(totalLen)
  const view = new DataView(frameBytes.buffer)

  // Header
  view.setUint8(0, version)
  view.setUint8(1, BinaryFrameType.FRAGMENT)
  view.setUint8(2, hashAlgo)
  view.setUint32(3, payload.length, false)

  // Fragment metadata
  let offset = HEADER_SIZE
  frameBytes.set(frameIdBytes, offset)
  offset += FRAME_ID_SIZE
  view.setUint32(offset, index, false)
  offset += 4
  view.setUint32(offset, total, false)
  offset += 4
  view.setUint32(offset, totalSize, false)
  offset += 4

  // Payload
  frameBytes.set(payload, offset)

  return frameBytes
}

// ---------------------------------------------------------------------------
// Decoding — generic
// ---------------------------------------------------------------------------

/**
 * Decode a binary wire frame back to a `Frame<Uint8Array>`.
 *
 * The returned frame contains the raw codec-encoded payload. Use
 * the codec's `decode` to get `ChannelMsg[]`.
 *
 * @throws FrameDecodeError if the frame is malformed
 */
export function decodeBinaryFrame(data: Uint8Array): Frame<Uint8Array> {
  // Normalize Buffer subclasses (Bun/Node may provide these)
  const frame = data.constructor === Uint8Array ? data : new Uint8Array(data)

  if (frame.length < HEADER_SIZE) {
    throw new FrameDecodeError(
      "truncated_frame",
      `Frame too short: expected at least ${HEADER_SIZE} bytes, got ${frame.length}`,
    )
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)

  const version = view.getUint8(0)
  if (version !== WIRE_VERSION) {
    throw new FrameDecodeError(
      "unsupported_version",
      `Unsupported wire version: ${version} (expected ${WIRE_VERSION})`,
    )
  }

  const type = view.getUint8(1) as BinaryFrameTypeValue
  const hashAlgo = view.getUint8(2)
  const payloadLength = view.getUint32(3, false)

  // Hash is reserved — validate but don't parse digest yet
  const hash: string | null = null
  if (hashAlgo !== HASH_ALGO.NONE && hashAlgo !== HASH_ALGO.SHA256) {
    throw new FrameDecodeError(
      "unsupported_hash",
      `Unsupported hash algorithm: 0x${hashAlgo.toString(16).padStart(2, "0")}`,
    )
  }

  if (type === BinaryFrameType.COMPLETE) {
    const expectedLength = HEADER_SIZE + payloadLength
    if (frame.length < expectedLength) {
      throw new FrameDecodeError(
        "truncated_frame",
        `Complete frame truncated: expected ${expectedLength} bytes, got ${frame.length}`,
      )
    }

    const payload = frame.slice(HEADER_SIZE, HEADER_SIZE + payloadLength)
    return complete(version, payload, hash)
  }

  if (type === BinaryFrameType.FRAGMENT) {
    const expectedLength = HEADER_SIZE + FRAGMENT_META_SIZE + payloadLength
    if (frame.length < expectedLength) {
      throw new FrameDecodeError(
        "truncated_frame",
        `Fragment frame truncated: expected ${expectedLength} bytes, got ${frame.length}`,
      )
    }

    let offset = HEADER_SIZE
    const frameIdBytes = frame.slice(offset, offset + FRAME_ID_SIZE)
    const frameId = bytesToHex(frameIdBytes)
    offset += FRAME_ID_SIZE

    const index = view.getUint32(offset, false)
    offset += 4
    const total = view.getUint32(offset, false)
    offset += 4
    const totalSize = view.getUint32(offset, false)
    offset += 4

    const payload = frame.slice(offset, offset + payloadLength)
    return fragmentFrame(
      version,
      frameId,
      index,
      total,
      totalSize,
      payload,
      hash,
    )
  }

  throw new FrameDecodeError(
    "invalid_type",
    `Unknown frame type: 0x${(type as number).toString(16).padStart(2, "0")}`,
  )
}

// ---------------------------------------------------------------------------
// Convenience — encode from ChannelMsg
// ---------------------------------------------------------------------------

/**
 * Encode a single `ChannelMsg` as a complete binary frame.
 *
 * Shorthand for `encodeBinaryFrame(complete(WIRE_VERSION, codec.encode(msg)))`.
 */
export function encodeComplete(
  codec: BinaryCodec,
  msg: ChannelMsg,
): Uint8Array {
  const payload = codec.encode(msg)
  return encodeBinaryFrame(complete(WIRE_VERSION, payload))
}

/**
 * Encode a batch of `ChannelMsg` as a complete binary frame.
 *
 * The batch is codec-encoded as a single payload. The frame layer
 * doesn't add a BATCH flag — the payload is self-describing.
 */
export function encodeCompleteBatch(
  codec: BinaryCodec,
  msgs: ChannelMsg[],
): Uint8Array {
  const payload = codec.encode(msgs)
  return encodeBinaryFrame(complete(WIRE_VERSION, payload))
}

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

/**
 * Convert a hex string to a fixed-length Uint8Array.
 * Pads or truncates to `length` bytes.
 */
function hexToBytes(hex: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const chars = Math.min(hex.length, length * 2)
  for (let i = 0; i < chars; i += 2) {
    bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16)
  }
  return bytes
}

/**
 * Convert a Uint8Array to a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]?.toString(16).padStart(2, "0")
  }
  return hex
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Error codes for frame decode failures.
 */
export type FrameDecodeErrorCode =
  | "truncated_frame"
  | "unsupported_version"
  | "unsupported_hash"
  | "invalid_type"
  | "decode_failed"

/**
 * Error thrown when frame decoding fails.
 */
export class FrameDecodeError extends Error {
  override readonly name = "FrameDecodeError"

  constructor(
    public readonly code: FrameDecodeErrorCode,
    message: string,
  ) {
    super(message)
  }
}
