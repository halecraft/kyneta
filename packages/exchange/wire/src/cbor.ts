// cbor — CBOR codec for encoding/decoding ChannelMsg types.
//
// Uses an internal CBOR encoder/decoder (cbor-encoding.ts) for compact
// binary encoding. CBOR handles Uint8Array natively as byte strings —
// no base64 overhead.
//
// The codec converts between kyneta's ChannelMsg types and compact wire
// objects with integer discriminators and short field names, then
// encodes/decodes those wire objects as CBOR.

import type {
  ChannelMsg,
  DismissMsg,
  EstablishMsg,
  InterestMsg,
  OfferMsg,
  PresentMsg,
} from "@kyneta/transport"
import { type CBORType, decodeCBOR, encodeCBOR } from "./cbor-encoding.js"
import type { BinaryCodec } from "./codec.js"
import {
  MergeStrategyWireToString,
  MessageType,
  PayloadEncodingToString,
  PayloadKindToString,
  StringToMergeStrategyWire,
  StringToPayloadEncoding,
  StringToPayloadKind,
  type WireDepartMsg,
  type WireDismissMsg,
  type WireEstablishMsg,
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
  type WirePresentMsg,
} from "./wire-types.js"

// ---------------------------------------------------------------------------
// CBOR ↔ plain object bridge
// ---------------------------------------------------------------------------

/**
 * Convert a plain JS object to a Map for CBOR encoding.
 *
 * CBOR's native type system represents objects as
 * `Map<string | number, CBORType>`. Recursively handles nested objects
 * and arrays. `Uint8Array` passes through directly (CBOR has native
 * byte string support).
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

// ---------------------------------------------------------------------------
// ChannelMsg → WireMessage conversion
// ---------------------------------------------------------------------------

/**
 * Convert a ChannelMsg to its compact wire representation.
 */
function toWireFormat(msg: ChannelMsg): WireMessage {
  switch (msg.type) {
    case "establish":
      return {
        t: MessageType.Establish,
        id: msg.identity.peerId,
        n: msg.identity.name,
        y: msg.identity.type,
      } satisfies WireEstablishMsg

    case "depart":
      return {
        t: MessageType.Depart,
      } satisfies WireDepartMsg

    case "present":
      return {
        t: MessageType.Present,
        docs: msg.docs.map(d => {
          const ms = StringToMergeStrategyWire[d.mergeStrategy]
          if (ms === undefined) {
            throw new Error(`Unknown merge strategy: ${d.mergeStrategy}`)
          }
          return {
            d: d.docId,
            rt: [...d.replicaType] as [string, number, number],
            ms,
            sh: d.schemaHash,
          }
        }),
      } satisfies WirePresentMsg

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
      const pk = StringToPayloadKind[msg.payload.kind]
      if (pk === undefined) {
        throw new Error(`Unknown payload kind: ${msg.payload.kind}`)
      }
      const pe = StringToPayloadEncoding[msg.payload.encoding]
      if (pe === undefined) {
        throw new Error(`Unknown payload encoding: ${msg.payload.encoding}`)
      }
      const wire: WireOfferMsg = {
        t: MessageType.Offer,
        doc: msg.docId,
        pk,
        pe,
        d: msg.payload.data,
        v: msg.version,
      }
      if (msg.reciprocate !== undefined) wire.r = msg.reciprocate
      return wire
    }

    case "dismiss":
      return {
        t: MessageType.Dismiss,
        doc: msg.docId,
      } satisfies WireDismissMsg
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
    case MessageType.Establish:
      return {
        type: "establish",
        identity: {
          peerId: wire.id,
          name: wire.n,
          type: wire.y,
        },
      } satisfies EstablishMsg

    case MessageType.Depart:
      return { type: "depart" }

    case MessageType.Present: {
      const presentWire = wire as WirePresentMsg
      return {
        type: "present",
        docs: presentWire.docs.map(d => {
          const mergeStrategy = MergeStrategyWireToString[d.ms]
          if (!mergeStrategy) {
            throw new Error(`Unknown wire merge strategy: ${d.ms}`)
          }
          return {
            docId: d.d,
            replicaType: d.rt as readonly [string, number, number],
            mergeStrategy,
            schemaHash: d.sh,
          }
        }),
      } satisfies PresentMsg
    }

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
      const kind =
        PayloadKindToString[wire.pk as keyof typeof PayloadKindToString]
      const encoding =
        PayloadEncodingToString[wire.pe as keyof typeof PayloadEncodingToString]

      if (!kind) {
        throw new Error(`Unknown wire payload kind: ${wire.pk}`)
      }
      if (!encoding) {
        throw new Error(`Unknown wire payload encoding: ${wire.pe}`)
      }

      const msg: OfferMsg = {
        type: "offer",
        docId: wire.doc,
        payload: {
          kind,
          encoding,
          data: wire.d,
        },
        version: wire.v,
      }
      if (wire.r !== undefined) msg.reciprocate = wire.r
      return msg
    }

    case MessageType.Dismiss:
      return {
        type: "dismiss",
        docId: wire.doc,
      } satisfies DismissMsg

    default:
      throw new Error(`Unknown wire message type: ${(wire as WireMessage).t}`)
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
export const cborCodec: BinaryCodec = {
  encode(input: ChannelMsg | ChannelMsg[]): Uint8Array {
    if (Array.isArray(input)) {
      const wireMessages = input.map(toWireFormat)
      return encodeCBOR(objectToMap(wireMessages))
    }
    const wire = toWireFormat(input)
    return encodeCBOR(objectToMap(wire))
  },

  decode(data: Uint8Array): ChannelMsg[] {
    try {
      const decoded = decodeCBOR(data)
      const obj = mapToObject(decoded)

      // Auto-detect: array = batch, object = single message
      if (Array.isArray(obj)) {
        return (obj as WireMessage[]).map(fromWireFormat)
      }
      return [fromWireFormat(obj as WireMessage)]
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Unknown wire")) {
        throw error
      }
      throw new Error(
        `Failed to decode CBOR: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}
