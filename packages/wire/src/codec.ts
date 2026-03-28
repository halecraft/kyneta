// codec — the MessageCodec interface for encoding/decoding ChannelMsg types.
//
// Two implementations exist:
// - CBOR codec (src/cbor.ts) — for binary transports (Websocket, WebRTC)
// - JSON codec (src/json.ts) — for text transports (SSE, HTTP responses)
//
// Adapters choose which codec fits their transport. The exchange layer
// never touches serialization — it hands ChannelMsg objects to channels
// and receives them back.

import type { ChannelMsg } from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// MessageCodec — the interface adapters use for serialization
// ---------------------------------------------------------------------------

/**
 * Encode/decode `ChannelMsg` types for wire transport.
 *
 * Each codec implementation handles the full message vocabulary
 * (establish-request, establish-response, discover, interest, offer).
 *
 * The codec operates on raw bytes — framing and fragmentation are
 * separate concerns handled by the frame and fragment modules.
 */
export interface MessageCodec {
  /** Encode a single message to bytes. */
  encode(msg: ChannelMsg): Uint8Array

  /** Decode bytes back to a single message. */
  decode(data: Uint8Array): ChannelMsg

  /** Encode multiple messages to bytes (for batch frames). */
  encodeBatch(msgs: ChannelMsg[]): Uint8Array

  /** Decode bytes back to multiple messages (from batch frames). */
  decodeBatch(data: Uint8Array): ChannelMsg[]
}