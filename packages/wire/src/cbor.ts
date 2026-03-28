// cbor — CBOR codec for encoding/decoding ChannelMsg types.
//
// Uses @levischuck/tiny-cbor for compact binary encoding. CBOR handles
// Uint8Array natively as byte strings — no base64 overhead.
//
// The codec converts between kyneta's ChannelMsg types and compact wire
// objects with integer discriminators and short field names, then
// encodes/decodes those wire objects as CBOR.

import { type CBORType, decodeCBOR, encodeCBOR } from "@levischuck/tiny-cbor"
import type {
  ChannelMsg,
  DiscoverMsg,
  EstablishRequestMsg,
  EstablishResponseMsg,
  InterestMsg,
  OfferMsg,
} from "@kyneta/exchange"
import type { MessageCodec } from "./codec.js"
import {
  MessageType,
  OfferType,
  OfferTypeToString,
  PayloadEncoding,
  PayloadEncodingToString,
  StringToOfferType,
  StringToPayloadEncoding,
  type WireDiscoverMsg,
  type WireEstablishMsg,
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
} from "./wire-types.js"

// ---------------------------------------------------------------------------
// CBOR ↔ plain object bridge
// ---------------------------------------------------------------------------

/**
 * Convert a plain JS object to a Map for CBOR encoding.
 *
 * `@levischuck/tiny-cbor` works with CBOR's native type system where
 * objects are represented as `Map<string | number, CBORType>`.
 * Recursively handles nested objects and arrays. `Uint8Array` passes
 * through directly (CBOR has native byte string support).
 */
function objectToMap(obj: unknown): CBORType {
  if (obj === null || obj === undefined) {
    return obj as CBORType
  }
  if (obj instanceof Uint8Array) {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(objectToMap)
  }
  if (typeof obj === "object") {
    const map = new Map<string | number, CBORType>()
    for (const [key, value] of Object.entries(obj)) {
      // Skip undefined values — they shouldn't appear on the wire
      if (value !== undefined) {
        map.set(key, objectToMap(value))
      }
    }
    return map
  }
  return obj as CBORType
}

/**
 * Convert a CBOR Map back to a plain JS object.
 *
 * Recursively handles nested Maps and arrays. `Uint8Array` passes
 * through directly.
 */
function mapToObject(value: CBORType): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (value instanceof Uint8Array) {
    return value
  }
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {}
    for (const [key, val] of value.entries()) {
      obj[String(key)] = mapToObject(val)
    }
    return obj
  }
  if (Array.isArray(value)) {
    return value.map(mapToObject)
  }
  return value
}

/**
 * Normalize a Uint8Array subclass (like Buffer) to a plain Uint8Array.
 *
 * The `@levischuck/tiny-cbor` library performs strict prototype checks
 * and only accepts plain Uint8Array, not subclasses like Buffer.
 * Bun and Node.js Websocket implementations may return Buffer instances.
 */
function normalizeUint8Array(data: Uint8Array): Uint8Array {
  if (data.constructor === Uint8Array) {
    return data
  }
  return new Uint8Array(data)
}

// ---------------------------------------------------------------------------
// ChannelMsg → WireMessage conversion
// ---------------------------------------------------------------------------

/**
 * Convert a ChannelMsg to its compact wire representation.
 */
function toWireFormat(msg: ChannelMsg): WireMessage {
  switch (msg.type) {
    case "establish-request":
      return {
        t: MessageType.EstablishRequest,
        id: msg.identity.peerId,
        n: msg.identity.name,
        y: msg.identity.type,
      } satisfies WireEstablishMsg

    case "establish-response":
      return {
        t: MessageType.EstablishResponse,
        id: msg.identity.peerId,
        n: msg.identity.name,
        y: msg.identity.type,
      } satisfies WireEstablishMsg

    case "discover":
      return {
        t: MessageType.Discover,
        docs: msg.docIds,
      } satisfies WireDiscoverMsg

    case "interest": {
      const wire: WireInterestMsg = {
        t: MessageType.Interest,
        doc: msg.docId,
      }
      if (msg.version !== undefined) wire.v = msg.version
      if (msg.reciprocate !== undefined) wire.r = msg.reciprocate
      return wire
    }

    case "offer": {
      const wire: WireOfferMsg = {
        t: MessageType.Offer,
        doc: msg.docId,
        ot: StringToOfferType[msg.offerType]!,
        pe: StringToPayloadEncoding[msg.payload.encoding]!,
        d: msg.payload.data,
        v: msg.version,
      }
      if (msg.reciprocate !== undefined) wire.r = msg.reciprocate
      return wire
    }
  }
}

// ---------------------------------------------------------------------------
// WireMessage → ChannelMsg conversion
// ---------------------------------------------------------------------------

/**
 * Convert a compact wire representation back to a ChannelMsg.
 */
function fromWireFormat(wire: WireMessage): ChannelMsg {
  switch (wire.t) {
    case MessageType.EstablishRequest:
      return {
        type: "establish-request",
        identity: {
          peerId: wire.id,
          name: wire.n,
          type: wire.y,
        },
      } satisfies EstablishRequestMsg

    case MessageType.EstablishResponse:
      return {
        type: "establish-response",
        identity: {
          peerId: wire.id,
          name: wire.n,
          type: wire.y,
        },
      } satisfies EstablishResponseMsg

    case MessageType.Discover:
      return {
        type: "discover",
        docIds: wire.docs,
      } satisfies DiscoverMsg

    case MessageType.Interest: {
      const msg: InterestMsg = {
        type: "interest",
        docId: wire.doc,
      }
      if (wire.v !== undefined) msg.version = wire.v
      if (wire.r !== undefined) msg.reciprocate = wire.r
      return msg
    }

    case MessageType.Offer: {
      const offerType = OfferTypeToString[wire.ot as keyof typeof OfferTypeToString]
      const encoding = PayloadEncodingToString[wire.pe as keyof typeof PayloadEncodingToString]

      if (!offerType) {
        throw new Error(`Unknown wire offer type: ${wire.ot}`)
      }
      if (!encoding) {
        throw new Error(`Unknown wire payload encoding: ${wire.pe}`)
      }

      const msg: OfferMsg = {
        type: "offer",
        docId: wire.doc,
        offerType,
        payload: {
          encoding,
          data: wire.d,
        },
        version: wire.v,
      }
      if (wire.r !== undefined) msg.reciprocate = wire.r
      return msg
    }

    default:
      throw new Error(
        `Unknown wire message type: ${(wire as WireMessage).t}`,
      )
  }
}

// ---------------------------------------------------------------------------
// CBOR MessageCodec implementation
// ---------------------------------------------------------------------------

/**
 * CBOR codec for binary transports (Websocket, WebRTC).
 *
 * Uses compact integer discriminators and short field names to minimize
 * payload size. `Uint8Array` data in `SubstratePayload` is encoded
 * natively as CBOR byte strings — no base64 overhead.
 */
export const cborCodec: MessageCodec = {
  encode(msg: ChannelMsg): Uint8Array {
    const wire = toWireFormat(msg)
    return encodeCBOR(objectToMap(wire))
  },

  decode(data: Uint8Array): ChannelMsg {
    const normalized = normalizeUint8Array(data)
    try {
      const decoded = decodeCBOR(normalized)
      const wire = mapToObject(decoded) as WireMessage
      return fromWireFormat(wire)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown wire")) {
        throw error
      }
      throw new Error(
        `Failed to decode CBOR: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },

  encodeBatch(msgs: ChannelMsg[]): Uint8Array {
    const wireMessages = msgs.map(toWireFormat)
    return encodeCBOR(objectToMap(wireMessages))
  },

  decodeBatch(data: Uint8Array): ChannelMsg[] {
    const normalized = normalizeUint8Array(data)
    try {
      const decoded = decodeCBOR(normalized)
      const wireMessages = mapToObject(decoded) as WireMessage[]
      return wireMessages.map(fromWireFormat)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown wire")) {
        throw error
      }
      throw new Error(
        `Failed to decode CBOR batch: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}