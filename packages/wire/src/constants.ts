// constants — wire protocol constants for @kyneta/wire.
//
// Defines the binary protocol framing: version byte, flags, header size,
// and transport-layer prefixes for complete/fragmented messages.
//
// Ported from @loro-extended/wire-format with Loro-specific message
// type constants removed (those live in wire-types.ts instead).

// ---------------------------------------------------------------------------
// Frame header
// ---------------------------------------------------------------------------

/** Current wire protocol version. */
export const WIRE_VERSION = 2

/** Frame header size in bytes: version (1) + flags (1) + payload length (4). */
export const HEADER_SIZE = 6

// ---------------------------------------------------------------------------
// Frame flags (byte 1 of header)
// ---------------------------------------------------------------------------

/**
 * Bit flags for the frame header's flags byte.
 *
 * - `NONE`: single message payload
 * - `BATCH`: payload is a CBOR/JSON array of messages
 * - `COMPRESSED`: reserved for future compression support
 */
export const FrameFlags = {
  NONE: 0x00,
  BATCH: 0x01,
  COMPRESSED: 0x02,
} as const

// ---------------------------------------------------------------------------
// Transport prefixes (byte 0 of each transport payload)
// ---------------------------------------------------------------------------

/**
 * Byte prefix for a complete (non-fragmented) message.
 * Followed by the framed payload (header + encoded data).
 */
export const MESSAGE_COMPLETE = 0x00

/**
 * Byte prefix for a fragment header.
 * Followed by: batchId (8 bytes) + count (4 bytes BE) + totalSize (4 bytes BE).
 */
export const FRAGMENT_HEADER = 0x01

/**
 * Byte prefix for fragment data.
 * Followed by: batchId (8 bytes) + index (4 bytes BE) + data (remaining bytes).
 */
export const FRAGMENT_DATA = 0x02

// ---------------------------------------------------------------------------
// Fragment layout sizes
// ---------------------------------------------------------------------------

/** Size of a batch ID in bytes. */
export const BATCH_ID_SIZE = 8

/**
 * Size of the fragment header payload (excluding the 1-byte prefix):
 * batchId (8) + count (4) + totalSize (4) = 16 bytes.
 */
export const FRAGMENT_HEADER_PAYLOAD_SIZE = BATCH_ID_SIZE + 4 + 4

/**
 * Minimum size of a fragment data payload (excluding the 1-byte prefix):
 * batchId (8) + index (4) + at least 1 byte of data = 13 bytes.
 */
export const FRAGMENT_DATA_MIN_SIZE = BATCH_ID_SIZE + 4 + 1