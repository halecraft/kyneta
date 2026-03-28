// json — JSON codec for encoding/decoding ChannelMsg types.
//
// Uses JSON serialization for text transports (SSE, HTTP responses).
// Human-readable — uses the ChannelMsg type strings directly
// ("establish-request", "discover", etc.) without integer discriminators.
//
// SubstratePayload with encoding "binary" has its Uint8Array data
// transparently base64-encoded on the way out and base64-decoded on
// the way in. SubstratePayload with encoding "json" passes through
// as-is (the data is already a string).

import type {
  ChannelMsg,
  DiscoverMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  InterestMsg,
  OfferMsg,
} from "@kyneta/exchange"
import type { MessageCodec } from "./codec.js"

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Encode a Uint8Array to a base64 string.
 *
 * Uses the built-in btoa() which is available in browsers, Node 16+,
 * Bun, and Deno.
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  // Convert Uint8Array to binary string, then base64
  let binary = ""
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!)
  }
  return btoa(binary)
}

/**
 * Decode a base64 string back to a Uint8Array.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

// ---------------------------------------------------------------------------
// JSON wire format types
// ---------------------------------------------------------------------------

/**
 * JSON wire representation of a SubstratePayload.
 *
 * When encoding is "binary", the data field is base64-encoded.
 * When encoding is "json", the data field is the original string.
 */
type JsonPayload = {
  encoding: "json" | "binary"
  data: string
}

/**
 * JSON wire representation of an OfferMsg.
 * The payload.data is always a string (base64 for binary).
 */
type JsonOfferMsg = {
  type: "offer"
  docId: string
  offerType: "snapshot" | "delta"
  payload: JsonPayload
  version: string
  reciprocate?: boolean
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/**
 * Convert a ChannelMsg to a JSON-safe object.
 *
 * Most message types are already JSON-safe. The only special case is
 * OfferMsg with a binary SubstratePayload — the Uint8Array data needs
 * base64 encoding.
 */
function toJsonSafe(msg: ChannelMsg): unknown {
  if (msg.type !== "offer") {
    // All non-offer messages are already JSON-safe
    return msg
  }

  // Offer message — handle SubstratePayload encoding
  const offer = msg as OfferMsg
  const jsonPayload: JsonPayload = {
    encoding: offer.payload.encoding,
    data:
      offer.payload.encoding === "binary"
        ? uint8ArrayToBase64(offer.payload.data as Uint8Array)
        : (offer.payload.data as string),
  }

  const result: JsonOfferMsg = {
    type: "offer",
    docId: offer.docId,
    offerType: offer.offerType,
    payload: jsonPayload,
    version: offer.version,
  }
  if (offer.reciprocate !== undefined) {
    result.reciprocate = offer.reciprocate
  }
  return result
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

/**
 * Convert a parsed JSON object back to a ChannelMsg.
 *
 * Reverses the base64 encoding for binary SubstratePayload data.
 */
function fromJsonSafe(obj: Record<string, unknown>): ChannelMsg {
  const type = obj.type as string

  switch (type) {
    case "establish-request":
      return obj as unknown as EstablishRequestMsg

    case "establish-response":
      return obj as unknown as EstablishResponseMsg

    case "discover":
      return obj as unknown as DiscoverMsg

    case "interest":
      return obj as unknown as InterestMsg

    case "offer": {
      const jsonOffer = obj as unknown as JsonOfferMsg
      const payload = jsonOffer.payload

      // Reverse the base64 encoding for binary payloads
      const data: string | Uint8Array =
        payload.encoding === "binary"
          ? base64ToUint8Array(payload.data)
          : payload.data

      const msg: OfferMsg = {
        type: "offer",
        docId: jsonOffer.docId,
        offerType: jsonOffer.offerType,
        payload: {
          encoding: payload.encoding,
          data,
        },
        version: jsonOffer.version,
      }
      if (jsonOffer.reciprocate !== undefined) {
        msg.reciprocate = jsonOffer.reciprocate
      }
      return msg
    }

    default:
      throw new Error(`Unknown JSON message type: ${type}`)
  }
}

// ---------------------------------------------------------------------------
// JSON MessageCodec implementation
// ---------------------------------------------------------------------------

/**
 * JSON codec for text transports (SSE, HTTP responses).
 *
 * Uses ChannelMsg type strings directly — human-readable on the wire.
 * Binary SubstratePayload data is transparently base64-encoded.
 */
export const jsonCodec: MessageCodec = {
  encode(msg: ChannelMsg): Uint8Array {
    const json = JSON.stringify(toJsonSafe(msg))
    return encoder.encode(json)
  },

  decode(data: Uint8Array): ChannelMsg {
    const json = decoder.decode(data)
    try {
      const obj = JSON.parse(json) as Record<string, unknown>
      return fromJsonSafe(obj)
    } catch (error) {
      throw new Error(
        `Failed to decode JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },

  encodeBatch(msgs: ChannelMsg[]): Uint8Array {
    const json = JSON.stringify(msgs.map(toJsonSafe))
    return encoder.encode(json)
  },

  decodeBatch(data: Uint8Array): ChannelMsg[] {
    const json = decoder.decode(data)
    try {
      const arr = JSON.parse(json) as Record<string, unknown>[]
      return arr.map(fromJsonSafe)
    } catch (error) {
      throw new Error(
        `Failed to decode JSON batch: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}