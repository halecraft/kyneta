// constants — wire protocol constants for @kyneta/wire.
//
// Defines the binary protocol framing: version byte, type byte,
// header size, and fragment layout sizes.
//
// Version 1 — compact header (no hash algo byte), numeric frame IDs,
// no transport prefix layer.

// ---------------------------------------------------------------------------
// Frame header
// ---------------------------------------------------------------------------

export const WIRE_VERSION = 1

/**
 * Frame header size in bytes:
 * version (1) + type (1) + payload length (4) = 6.
 */
export const HEADER_SIZE = 6

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
// Fragment layout sizes
// ---------------------------------------------------------------------------

/**
 * Size of fragment metadata following the frame header:
 * frameId (u16: 2) + index (u16: 2) + total (u16: 2) + totalSize (u32: 4) = 10 bytes.
 */
export const FRAGMENT_META_SIZE = 2 + 2 + 2 + 4

/**
 * Minimum size of a fragment frame (header + metadata + at least 1 byte):
 * 6 (header) + 10 (metadata) + 1 (data) = 17 bytes.
 */
export const FRAGMENT_MIN_SIZE = HEADER_SIZE + FRAGMENT_META_SIZE + 1
