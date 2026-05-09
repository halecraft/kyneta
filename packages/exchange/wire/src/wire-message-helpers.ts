// wire-message-helpers — encode/decode pre-formed WireMessage values.
//
// The alias transformer (`alias-table.ts`) operates on `WireMessage`
// directly. These helpers handle the byte-level encoding without going
// through `toWireFormat` / `fromWireFormat` (which assume `ChannelMsg`
// shape and have no notion of alias-form).
//
// Use these from each transport's `Channel.send` / `Channel.receive`
// adjacent to the alias transformer:
//
//   const { state, wire } = applyOutboundAliasing(this.#aliasState, msg)
//   const bytes = encodeWireMessage(wire)
//   sendFn(bytes)
//
//   const wire = decodeWireMessage(bytes)
//   const { state, msg, error } = applyInboundAliasing(this.#aliasState, wire)
//   if (error) { logger.warn(error); return }
//   onChannelReceive(this.channelId, msg)

import { type CBORType, decodeCBOR, encodeCBOR } from "./cbor-encoding.js"
import { FrameDecodeError } from "./frame.js"
import type { WireMessage } from "./wire-types.js"

/**
 * Recursively convert a plain JS object to a CBOR-encodable Map.
 *
 * Mirrors the helper inside `cbor.ts` but operates on `WireMessage`
 * directly (no ChannelMsg → WireMessage conversion).
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
      if (value !== undefined) {
        map.set(key, objectToMap(value))
      }
    }
    return map
  }
  return obj as CBORType
}

function mapToObject(value: CBORType): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) return value
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {}
    for (const [key, val] of value.entries()) {
      obj[String(key)] = mapToObject(val)
    }
    return obj
  }
  if (Array.isArray(value)) return value.map(mapToObject)
  return value
}

/**
 * Encode a pre-formed `WireMessage` to bytes (binary CBOR).
 *
 * Skips the `ChannelMsg → WireMessage` step performed by `cborCodec.encode`.
 * Use when the alias transformer has already produced the wire form.
 */
export function encodeWireMessage(wire: WireMessage): Uint8Array<ArrayBuffer> {
  return encodeCBOR(objectToMap(wire))
}

/**
 * Decode bytes (binary CBOR) to a `WireMessage` without converting back to
 * `ChannelMsg`. The caller is expected to feed the result through
 * `applyInboundAliasing` (which performs alias resolution and produces
 * the channel form).
 */
export function decodeWireMessage(data: Uint8Array): WireMessage {
  try {
    const decoded = decodeCBOR(data)
    const obj = mapToObject(decoded)
    return obj as WireMessage
  } catch (error) {
    if (error instanceof FrameDecodeError) throw error
    throw new Error(
      `Failed to decode wire message: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Encode a pre-formed `WireMessage` to a JSON-safe object (text wire form).
 *
 * Skips the `ChannelMsg → WireMessage` step. The `WireMessage` shape uses
 * short field names (`t`, `d`, `sh`, `dx`, etc.) — for text-codec parity
 * with binary, the text wire form mirrors the same compact shape rather
 * than the long-name `ChannelMsg` shape.
 */
export function encodeTextWireMessage(wire: WireMessage): unknown {
  // Convert any Uint8Array payloads to base64 for JSON safety.
  return wireToJsonSafe(wire)
}

/**
 * Decode a JSON-safe value (text wire form) to a `WireMessage`.
 */
export function decodeTextWireMessage(obj: unknown): WireMessage {
  return wireFromJsonSafe(obj) as WireMessage
}

function wireToJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) {
    return { __bytes: uint8ArrayToBase64(value) }
  }
  if (Array.isArray(value)) return value.map(wireToJsonSafe)
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = wireToJsonSafe(v)
    }
    return out
  }
  return value
}

function wireFromJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(wireFromJsonSafe)
  if (typeof value === "object") {
    const v = value as Record<string, unknown>
    if (typeof v.__bytes === "string" && Object.keys(v).length === 1) {
      return base64ToUint8Array(v.__bytes)
    }
    const out: Record<string, unknown> = {}
    for (const [k, vv] of Object.entries(v)) {
      out[k] = wireFromJsonSafe(vv)
    }
    return out
  }
  return value
}

function uint8ArrayToBase64(data: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < data.length; i++) {
    const byte = data.at(i)
    if (byte === undefined) throw new Error(`Missing byte at index ${i}`)
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
