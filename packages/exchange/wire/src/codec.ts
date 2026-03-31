// codec — codec interfaces for @kyneta/wire.
//
// Two codec interfaces for two transport families:
// - BinaryCodec (Uint8Array in/out) — for binary transports (WebSocket, WebRTC)
// - TextCodec (JSON-safe objects in/out) — for text transports (SSE, HTTP)
//
// The codec handles ChannelMsg ↔ T conversion. Framing and fragmentation
// are separate concerns. Batching is a codec concern — the codec auto-detects
// on decode (inspects the structure: CBOR map vs array-of-maps, JSON object
// vs array) and the caller always gets ChannelMsg[] back. On encode, the
// caller passes either a single message or an array and the codec handles
// both. The frame layer never needs to know.

import type { ChannelMsg } from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// BinaryCodec — for binary transports
// ---------------------------------------------------------------------------

/**
 * Encode/decode `ChannelMsg` types for binary wire transport.
 *
 * Implementations handle the full message vocabulary
 * (establish-request, establish-response, discover, interest, offer).
 *
 * The codec operates on raw bytes. Framing and fragmentation are
 * separate concerns handled by the frame and fragment modules.
 *
 * Two methods, symmetric:
 * - `encode` accepts a single message or an array (batch)
 * - `decode` always returns `ChannelMsg[]`, auto-detecting single vs batch
 */
export interface BinaryCodec {
  /**
   * Encode one or more messages to bytes.
   * A single message produces a single-message payload.
   * An array produces a batch payload.
   */
  encode(input: ChannelMsg | ChannelMsg[]): Uint8Array

  /**
   * Decode bytes back to messages. Always returns an array.
   * Auto-detects single message vs batch from the payload structure.
   */
  decode(data: Uint8Array): ChannelMsg[]
}

// ---------------------------------------------------------------------------
// TextCodec — for text transports
// ---------------------------------------------------------------------------

/**
 * Encode/decode `ChannelMsg` types for text wire transport.
 *
 * The codec converts between `ChannelMsg` and JSON-safe values.
 * Binary `SubstratePayload` data is transparently base64-encoded
 * on write and base64-decoded on read.
 *
 * The text codec produces objects, not strings. The frame layer
 * is responsible for JSON serialization into the text wire format.
 *
 * Two methods, symmetric:
 * - `encode` accepts a single message or an array (batch)
 * - `decode` always returns `ChannelMsg[]`, auto-detecting single vs batch
 */
export interface TextCodec {
  /**
   * Encode one or more messages to JSON-safe value(s).
   * A single message produces a JSON-safe object.
   * An array produces a JSON-safe array of objects.
   */
  encode(input: ChannelMsg | ChannelMsg[]): unknown

  /**
   * Decode a JSON-safe value back to messages. Always returns an array.
   * If input is an object, decodes as single message → [msg].
   * If input is an array, decodes each element → [msg1, msg2, ...].
   */
  decode(obj: unknown): ChannelMsg[]
}
