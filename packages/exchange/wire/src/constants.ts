// constants — wire protocol constants for @kyneta/wire.
//
// Defines the binary protocol framing: version byte, type byte,
// hash algorithm byte, header size, and transport-layer prefixes
// for complete/fragment messages.
//
// Version 0 — clean slate redesign with unified Frame<T> architecture.

// ---------------------------------------------------------------------------
// Frame header
// ---------------------------------------------------------------------------

/** Current binary wire protocol version. */
export const WIRE_VERSION = 0

/**
 * Frame header size in bytes:
 * version (1) + type (1) + hashAlgo (1) + payload length (4) = 7.
 */
export const HEADER_SIZE = 7

// ---------------------------------------------------------------------------
// Binary frame type (byte 1 of header)
// ---------------------------------------------------------------------------

/**
 * Frame type byte in the binary frame header.
 *
 * - `COMPLETE`: payload is a complete message (single or batch — self-describing)
 * - `FRAGMENT`: payload is one chunk of a fragmented message, with fragment metadata
 */
export const BinaryFrameType = {
  COMPLETE: 0x00,
  FRAGMENT: 0x01,
} as const

export type BinaryFrameTypeValue =
  (typeof BinaryFrameType)[keyof typeof BinaryFrameType]

// ---------------------------------------------------------------------------
// Hash algorithm (byte 2 of header)
// ---------------------------------------------------------------------------

/**
 * Hash algorithm byte in the binary frame header.
 *
 * - `NONE`: no hash present
 * - `SHA256`: reserved for future SHA-256 content hash (32 bytes after header)
 */
export const HASH_ALGO = {
  NONE: 0x00,
  SHA256: 0x01,
} as const

export type HashAlgoValue = (typeof HASH_ALGO)[keyof typeof HASH_ALGO]

// ---------------------------------------------------------------------------
// Transport prefixes (byte 0 of each transport payload)
// ---------------------------------------------------------------------------

/**
 * Byte prefix for a complete (non-fragmented) frame.
 * Followed by the framed payload (header + encoded data).
 */
export const MESSAGE_COMPLETE = 0x00

/**
 * Byte prefix for a fragment frame.
 * Followed by the framed fragment (header + fragment metadata + chunk data).
 */
export const FRAGMENT = 0x01

// ---------------------------------------------------------------------------
// Fragment layout sizes
// ---------------------------------------------------------------------------

/** Size of a frame ID in bytes (used in binary fragment metadata). */
export const FRAME_ID_SIZE = 8

/**
 * Size of fragment metadata following the frame header:
 * frameId (8) + index (4) + total (4) + totalSize (4) = 20 bytes.
 */
export const FRAGMENT_META_SIZE = FRAME_ID_SIZE + 4 + 4 + 4

/**
 * Minimum size of a fragment frame (header + metadata + at least 1 byte):
 * 7 (header) + 20 (metadata) + 1 (data) = 28 bytes.
 */
export const FRAGMENT_MIN_SIZE = HEADER_SIZE + FRAGMENT_META_SIZE + 1
