// frame — 6-byte frame header encoding/decoding for wire transport.
//
// Each message (or batch of messages) is wrapped in a frame with a
// 6-byte header before being sent over a transport. The frame structure:
//
//   ┌──────────┬──────────┬──────────────────────────────────────────┐
//   │ Version  │  Flags   │         Payload Length                   │
//   │ (1 byte) │ (1 byte) │         (4 bytes, big-endian)            │
//   ├──────────┴──────────┴──────────────────────────────────────────┤
//   │                 Payload (codec-encoded)                        │
//   └────────────────────────────────────────────────────────────────┘
//
// The codec (CBOR or JSON) is injected — the frame layer doesn't care
// which encoding is used. It only manages the binary envelope.
//
// Ported from @loro-extended/wire-format with the codec made injectable
// instead of hardcoded to CBOR.

import type { ChannelMsg } from "@kyneta/exchange"
import type { MessageCodec } from "./codec.js"
import { FrameFlags, HEADER_SIZE, WIRE_VERSION } from "./constants.js"

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/**
 * Encode a single `ChannelMsg` into a framed binary payload.
 *
 * @param codec - The codec to use for encoding (CBOR or JSON)
 * @param msg - The message to encode
 * @returns Binary frame: 6-byte header + codec-encoded payload
 */
export function encodeFrame(codec: MessageCodec, msg: ChannelMsg): Uint8Array {
  const payload = codec.encode(msg)
  return buildFrame(FrameFlags.NONE, payload)
}

/**
 * Encode multiple `ChannelMsg`s into a single batched frame.
 *
 * @param codec - The codec to use for encoding (CBOR or JSON)
 * @param msgs - The messages to encode as a batch
 * @returns Binary frame: 6-byte header (BATCH flag set) + codec-encoded payload
 */
export function encodeBatchFrame(
  codec: MessageCodec,
  msgs: ChannelMsg[],
): Uint8Array {
  const payload = codec.encodeBatch(msgs)
  return buildFrame(FrameFlags.BATCH, payload)
}

/**
 * Build a frame from flags and a pre-encoded payload.
 */
function buildFrame(flags: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + payload.length)
  const view = new DataView(frame.buffer)

  // Header
  view.setUint8(0, WIRE_VERSION)
  view.setUint8(1, flags)
  view.setUint32(2, payload.length, false) // big-endian

  // Payload
  frame.set(payload, HEADER_SIZE)

  return frame
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decode a framed binary payload back to `ChannelMsg`(s).
 *
 * Always returns an array: a single-element array for non-batch frames,
 * or a multi-element array for batch frames.
 *
 * @param codec - The codec to use for decoding (CBOR or JSON)
 * @param frame - The binary frame to decode
 * @returns Array of decoded channel messages
 * @throws Error if the frame is malformed
 */
export function decodeFrame(
  codec: MessageCodec,
  frame: Uint8Array,
): ChannelMsg[] {
  // Normalize Buffer subclasses (Bun/Node may provide these)
  const normalized =
    frame.constructor === Uint8Array ? frame : new Uint8Array(frame)

  if (normalized.length < HEADER_SIZE) {
    throw new FrameDecodeError(
      "truncated_frame",
      `Frame too short: expected at least ${HEADER_SIZE} bytes, got ${normalized.length}`,
    )
  }

  const view = new DataView(
    normalized.buffer,
    normalized.byteOffset,
    normalized.byteLength,
  )

  // Read header
  const version = view.getUint8(0)
  if (version !== WIRE_VERSION) {
    throw new FrameDecodeError(
      "unsupported_version",
      `Unsupported wire version: ${version} (expected ${WIRE_VERSION})`,
    )
  }

  const flags = view.getUint8(1)
  const payloadLength = view.getUint32(2, false) // big-endian

  const expectedLength = HEADER_SIZE + payloadLength
  if (normalized.length < expectedLength) {
    throw new FrameDecodeError(
      "truncated_frame",
      `Frame truncated: expected ${expectedLength} bytes, got ${normalized.length}`,
    )
  }

  const payload = normalized.slice(HEADER_SIZE, HEADER_SIZE + payloadLength)

  try {
    if (flags & FrameFlags.BATCH) {
      return codec.decodeBatch(payload)
    }
    return [codec.decode(payload)]
  } catch (error) {
    if (error instanceof FrameDecodeError) {
      throw error
    }
    throw new FrameDecodeError(
      "decode_failed",
      `Failed to decode frame payload: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
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