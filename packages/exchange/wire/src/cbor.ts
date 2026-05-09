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
  WireFeatures,
} from "@kyneta/transport"
import { type CBORType, decodeCBOR, encodeCBOR } from "./cbor-encoding.js"
import type { BinaryCodec } from "./codec.js"
import { FrameDecodeError } from "./frame.js"
import { validateDocId, validateSchemaHash } from "./validate-identifiers.js"
import {
  MessageType,
  PayloadEncodingToString,
  PayloadKindToString,
  StringToPayloadEncoding,
  StringToPayloadKind,
  SyncProtocolWireToProtocol,
  syncProtocolToWire,
  type WireDepartMsg,
  type WireDismissMsg,
  type WireEstablishMsg,
  type WireFeaturesCompact,
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
  type WirePresentMsg,
} from "./wire-types.js"

/** Convert `WireFeatures` (long names) to its compact wire form. */
function featuresToCompact(
  features: WireFeatures | undefined,
): WireFeaturesCompact | undefined {
  if (!features) return undefined
  const out: WireFeaturesCompact = {}
  if (features.alias !== undefined) out.a = features.alias
  if (features.streamed !== undefined) out.s = features.streamed
  if (features.datagram !== undefined) out.d = features.datagram
  return out
}

/** Convert compact wire features to the long-name `WireFeatures` shape. */
function featuresFromCompact(
  compact: WireFeaturesCompact | undefined,
): WireFeatures | undefined {
  if (!compact) return undefined
  const out: WireFeatures = {}
  if (compact.a !== undefined) out.alias = compact.a
  if (compact.s !== undefined) out.streamed = compact.s
  if (compact.d !== undefined) out.datagram = compact.d
  return out
}

function checkDocId(value: string): void {
  const err = validateDocId(value)
  if (err) throw new FrameDecodeError(err.code, err.message)
}

function checkSchemaHash(value: string): void {
  const err = validateSchemaHash(value)
  if (err) throw new FrameDecodeError(err.code, err.message)
}

/**
 * Validate the `{doc, dx}` invariant on interest/offer/dismiss wire forms,
 * and resolve to the docId string.
 *
 * The codec itself has no alias state — `dx`-only form requires the alias
 * transformer (`applyInboundAliasing`) to resolve. If the codec is called
 * directly on a `dx`-only message, throw a typed form-conflict error.
 */
function resolveWireDocId(
  doc: string | undefined,
  dx: number | undefined,
): string {
  const hasDoc = doc !== undefined
  const hasDx = dx !== undefined
  if (hasDoc && hasDx) {
    throw new FrameDecodeError(
      "doc-id-form-conflict",
      "Wire message must not carry both doc and dx",
    )
  }
  if (!hasDoc && !hasDx) {
    throw new FrameDecodeError(
      "doc-id-form-conflict",
      "Wire message must carry exactly one of doc or dx",
    )
  }
  if (!hasDoc) {
    throw new FrameDecodeError(
      "doc-id-form-conflict",
      "dx (alias reference) requires an alias resolver; use decodeWireMessage with the alias transformer",
    )
  }
  return doc as string
}

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
    case "establish": {
      const wire: WireEstablishMsg = {
        t: MessageType.Establish,
        id: msg.identity.peerId,
        n: msg.identity.name,
        y: msg.identity.type,
      }
      const f = featuresToCompact(msg.features)
      if (f !== undefined) wire.f = f
      return wire
    }

    case "depart":
      return {
        t: MessageType.Depart,
      } satisfies WireDepartMsg

    case "present":
      return {
        t: MessageType.Present,
        docs: msg.docs.map(d => {
          const ms = syncProtocolToWire(d.syncProtocol)
          const entry: WirePresentMsg["docs"][number] = {
            d: d.docId,
            rt: [...d.replicaType] as [string, number, number],
            ms,
            sh: d.schemaHash,
          }
          // Only include supportedHashes when it carries more than the primary hash
          if (d.supportedHashes && d.supportedHashes.length > 1) {
            entry.shs = [...d.supportedHashes]
          }
          return entry
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
    case MessageType.Establish: {
      const result: EstablishMsg = {
        type: "establish",
        identity: {
          peerId: wire.id,
          name: wire.n,
          type: wire.y,
        },
      }
      const features = featuresFromCompact(wire.f)
      if (features !== undefined) result.features = features
      return result
    }

    case MessageType.Depart:
      return { type: "depart" }

    case MessageType.Present: {
      const presentWire = wire as WirePresentMsg
      return {
        type: "present",
        docs: presentWire.docs.map(d => {
          const syncProtocol = SyncProtocolWireToProtocol[d.ms]
          if (!syncProtocol) {
            throw new Error(`Unknown wire sync protocol: ${d.ms}`)
          }
          checkDocId(d.d)
          // Exactly one of {sh, shx} must be present.
          const hasSh = d.sh !== undefined
          const hasShx = d.shx !== undefined
          if (hasSh && hasShx) {
            throw new FrameDecodeError(
              "schema-hash-form-conflict",
              "Present doc entry must not carry both sh and shx",
            )
          }
          if (!hasSh && !hasShx) {
            throw new FrameDecodeError(
              "schema-hash-form-conflict",
              "Present doc entry must carry exactly one of sh or shx",
            )
          }
          if (!hasSh) {
            // shx-only — codec cannot resolve without alias state.
            throw new FrameDecodeError(
              "schema-hash-form-conflict",
              "shx (alias reference) requires an alias resolver; use decodeWireMessage with the alias transformer",
            )
          }
          checkSchemaHash(d.sh as string)
          return {
            docId: d.d,
            replicaType: d.rt as readonly [string, number, number],
            syncProtocol,
            schemaHash: d.sh as string,
            ...(d.shs ? { supportedHashes: d.shs } : undefined),
          }
        }),
      } satisfies PresentMsg
    }

    case MessageType.Interest: {
      const docId = resolveWireDocId(wire.doc, wire.dx)
      checkDocId(docId)
      const msg: InterestMsg = { type: "interest", docId }
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

      const docId = resolveWireDocId(wire.doc, wire.dx)
      checkDocId(docId)
      const msg: OfferMsg = {
        type: "offer",
        docId,
        payload: { kind, encoding, data: wire.d },
        version: wire.v,
      }
      if (wire.r !== undefined) msg.reciprocate = wire.r
      return msg
    }

    case MessageType.Dismiss: {
      const docId = resolveWireDocId(wire.doc, wire.dx)
      checkDocId(docId)
      return { type: "dismiss", docId } satisfies DismissMsg
    }

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
  encode(input: ChannelMsg | ChannelMsg[]): Uint8Array<ArrayBuffer> {
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
      // Pass through typed decode errors and "Unknown wire" sentinel.
      if (error instanceof FrameDecodeError) throw error
      if (error instanceof Error && error.message.startsWith("Unknown wire")) {
        throw error
      }
      throw new Error(
        `Failed to decode CBOR: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  },
}
