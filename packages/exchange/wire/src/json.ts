// json — text codec for encoding/decoding ChannelMsg types.
//
// Implements the TextCodec interface — JSON-safe objects in/out.
// The text codec produces objects, not strings. The text frame layer
// (text-frame.ts) handles JSON serialization into the wire format.
//
// SubstratePayload with encoding "binary" has its Uint8Array data
// transparently base64-encoded on the way out and base64-decoded on
// the way in. SubstratePayload with encoding "json" passes through
// as-is (the data is already a string).
//
// Human-readable — uses the ChannelMsg type strings directly
// ("establish", "depart", "present", etc.) without integer discriminators.

import type {
  ChannelMsg,
  DismissMsg,
  EstablishMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
} from "@kyneta/transport"
import type { TextCodec } from "./codec.js"

// ---------------------------------------------------------------------------
// Base64 helpers — intentional local copy.
// @kyneta/wire does not depend on @kyneta/schema (different dependency
// subtree), so these cannot be imported from the shared base64.ts module.
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to a base64 string.
 *
 * Uses the built-in btoa() which is available in browsers, Node 16+,
 * Bun, and Deno.
 */
function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < data.length; i++) {
    const byte = data.at(i)
    if (byte === undefined) throw new Error(`Missing byte at index ${i}`)
    binary += String.fromCharCode(byte)
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
  kind: "entirety" | "since"
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
    kind: offer.payload.kind,
    encoding: offer.payload.encoding,
    data:
      offer.payload.encoding === "binary"
        ? uint8ArrayToBase64(offer.payload.data as Uint8Array)
        : (offer.payload.data as string),
  }

  const result: JsonOfferMsg = {
    type: "offer",
    docId: offer.docId,
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
function fromJsonSafe(obj: unknown): ChannelMsg {
  const record = obj as Record<string, unknown>
  const type = record.type as string

  switch (type) {
    case "establish":
      return record as unknown as EstablishMsg

    case "depart":
      return { type: "depart" }

    case "present":
      return record as unknown as PresentMsg

    case "interest":
      return record as unknown as InterestMsg

    case "dismiss":
      return record as unknown as DismissMsg

    case "offer": {
      const jsonOffer = record as unknown as JsonOfferMsg
      const payload = jsonOffer.payload

      // Reverse the base64 encoding for binary payloads
      const data: string | Uint8Array =
        payload.encoding === "binary"
          ? base64ToUint8Array(payload.data)
          : payload.data

      const msg: OfferMsg = {
        type: "offer",
        docId: jsonOffer.docId,
        payload: {
          kind: payload.kind,
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
// TextCodec implementation
// ---------------------------------------------------------------------------

/**
 * Text codec for text transports (SSE, HTTP).
 *
 * Converts `ChannelMsg` to/from JSON-safe objects. Uses human-readable
 * type strings directly — no integer discriminators.
 *
 * Binary `SubstratePayload` data is transparently base64-encoded on
 * write and base64-decoded on read. JSON `SubstratePayload` passes
 * through as-is.
 *
 * The text codec produces objects, not strings. The text frame layer
 * (`encodeTextFrame`) handles JSON serialization and framing.
 */
export const textCodec: TextCodec = {
  encode(input: ChannelMsg | ChannelMsg[]): unknown {
    if (Array.isArray(input)) {
      return input.map(toJsonSafe)
    }
    return toJsonSafe(input)
  },

  decode(obj: unknown): ChannelMsg[] {
    // Auto-detect: array = batch, object = single message
    if (Array.isArray(obj)) {
      return obj.map(fromJsonSafe)
    }
    return [fromJsonSafe(obj)]
  },
}
