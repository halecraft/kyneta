// wire-types — integer discriminators and compact field names for wire encoding.
//
// The CBOR codec uses integer type discriminators and short field names
// to minimize payload size. The JSON codec uses the ChannelMsg type
// strings directly and doesn't need these mappings.
//
// Wire type ranges:
//   0x01–0x0F: Lifecycle messages (establish, depart)
//   0x10–0x1F: Sync messages (present, interest, offer, dismiss)

import type { SyncProtocol } from "@kyneta/schema"
import {
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Message type discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for each ChannelMsg type on the wire.
 *
 * These are used as the `t` field in compact wire objects for CBOR encoding.
 */
export const MessageType = {
  Establish: 0x01,
  Depart: 0x02,
  Present: 0x10,
  Interest: 0x11,
  Offer: 0x12,
  Dismiss: 0x13,
} as const

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType]

/**
 * Reverse lookup: integer discriminator → ChannelMsg type string.
 */
export const MessageTypeToString: Record<MessageTypeValue, string> = {
  [MessageType.Establish]: "establish",
  [MessageType.Depart]: "depart",
  [MessageType.Present]: "present",
  [MessageType.Interest]: "interest",
  [MessageType.Offer]: "offer",
  [MessageType.Dismiss]: "dismiss",
}

/**
 * Forward lookup: ChannelMsg type string → integer discriminator.
 */
export const StringToMessageType: Record<string, MessageTypeValue> = {
  establish: MessageType.Establish,
  depart: MessageType.Depart,
  present: MessageType.Present,
  interest: MessageType.Interest,
  offer: MessageType.Offer,
  dismiss: MessageType.Dismiss,
}

// ---------------------------------------------------------------------------
// Offer type discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for SubstratePayload.kind on the wire.
 */
export const PayloadKind = {
  Entirety: 0x00,
  Since: 0x01,
} as const

export type PayloadKindValue = (typeof PayloadKind)[keyof typeof PayloadKind]

/**
 * Reverse lookup: payload kind integer → string.
 */
export const PayloadKindToString: Record<
  PayloadKindValue,
  "entirety" | "since"
> = {
  [PayloadKind.Entirety]: "entirety",
  [PayloadKind.Since]: "since",
}

/**
 * Forward lookup: payload kind string → integer.
 */
export const StringToPayloadKind: Record<string, PayloadKindValue> = {
  entirety: PayloadKind.Entirety,
  since: PayloadKind.Since,
}

// ---------------------------------------------------------------------------
// Payload encoding discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for SubstratePayload.encoding on the wire.
 */
export const PayloadEncoding = {
  Json: 0x00,
  Binary: 0x01,
} as const

export type PayloadEncodingValue =
  (typeof PayloadEncoding)[keyof typeof PayloadEncoding]

/**
 * Reverse lookup: payload encoding integer → string.
 */
export const PayloadEncodingToString: Record<
  PayloadEncodingValue,
  "json" | "binary"
> = {
  [PayloadEncoding.Json]: "json",
  [PayloadEncoding.Binary]: "binary",
}

/**
 * Forward lookup: payload encoding string → integer.
 */
export const StringToPayloadEncoding: Record<string, PayloadEncodingValue> = {
  json: PayloadEncoding.Json,
  binary: PayloadEncoding.Binary,
}

// ---------------------------------------------------------------------------
// SyncProtocol discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for SyncProtocol on the wire.
 */
export const SyncProtocolWire = {
  Collaborative: 0x00,
  Authoritative: 0x01,
  Ephemeral: 0x02,
} as const

export type SyncProtocolWireValue =
  (typeof SyncProtocolWire)[keyof typeof SyncProtocolWire]

/**
 * Reverse lookup: wire integer → SyncProtocol object.
 */
export const SyncProtocolWireToProtocol: Record<
  SyncProtocolWireValue,
  SyncProtocol
> = {
  [SyncProtocolWire.Collaborative]: SYNC_COLLABORATIVE,
  [SyncProtocolWire.Authoritative]: SYNC_AUTHORITATIVE,
  [SyncProtocolWire.Ephemeral]: SYNC_EPHEMERAL,
}

/** Forward lookup: SyncProtocol → wire integer discriminant. */
export function syncProtocolToWire(
  protocol: SyncProtocol,
): SyncProtocolWireValue {
  if (protocol.writerModel === "serialized")
    return SyncProtocolWire.Authoritative
  if (protocol.delivery === "delta-capable")
    return SyncProtocolWire.Collaborative
  return SyncProtocolWire.Ephemeral
}

// ---------------------------------------------------------------------------
// Compact wire object types (CBOR)
// ---------------------------------------------------------------------------

/**
 * Compact field names used in CBOR wire objects:
 *
 *   t   — message type discriminator (MessageTypeValue)
 *   id  — peerId (string)
 *   n   — name (string, optional)
 *   y   — peer type ("user" | "bot" | "service")
 *   docs — present docs array
 *   doc — docId (string)
 *   d   — docId within present entry / payload data
 *   rt  — replicaType tuple [string, number, number]
 *   ms  — syncProtocol (SyncProtocolWireValue)
 *   v   — version (string, serialized)
 *   r   — reciprocate (boolean, optional)
 *   sh  — schemaHash (string, 34-char hex, required in present doc entries)
 *   pk  — payload kind (PayloadKindValue)
 *   pe  — payload encoding (PayloadEncodingValue)
 */

/**
 * Compact CBOR shape of `WireFeatures` map. Field names are short:
 * `a` = alias, `s` = streamed, `d` = datagram. Each is optional;
 * absent ⇒ `false`. Old decoders ignore unknown fields harmlessly.
 */
export type WireFeaturesCompact = {
  a?: boolean
  s?: boolean
  d?: boolean
}

/** Compact wire format for establish. */
export type WireEstablishMsg = {
  t: typeof MessageType.Establish
  id: string
  n?: string
  y: "user" | "bot" | "service"
  f?: WireFeaturesCompact
}

/** Compact wire format for depart. */
export type WireDepartMsg = {
  t: typeof MessageType.Depart
}

/**
 * Compact wire format for present.
 *
 * Each doc entry carries either a full `d` (docId string, on first
 * reference) or — once an alias is announced — an alias-only form is
 * not used here (`present` always names docs explicitly). What MAY
 * change across `present` messages is the schema-hash form:
 *   - First reference to a schema: `sh` (full hash) and optional `sa`
 *     (alias assignment).
 *   - Subsequent reference to an already-announced schema: `shx`
 *     (alias reference) with `sh` absent.
 *
 * `a` is an optional alias *assignment* for the docId — emitted
 * unconditionally when the sender supports aliasing. Old peers ignore
 * unknown CBOR map fields harmlessly.
 *
 * Decoder invariant: exactly one of `{sh, shx}` must be present.
 */
export type WirePresentMsg = {
  t: typeof MessageType.Present
  docs: Array<{
    d: string
    /** Optional alias assignment for `d` (CBOR major type 0). */
    a?: number
    rt: [string, number, number]
    ms: SyncProtocolWireValue
    /** Full schema hash (on first reference, or always for legacy peers). */
    sh?: string
    /** Optional alias assignment for `sh` (CBOR major type 0). */
    sa?: number
    /** Alias reference to a previously-announced schema (CBOR major type 0). */
    shx?: number
    shs?: string[]
  }>
}

/**
 * Compact wire format for interest.
 *
 * Decoder invariant: exactly one of `{doc, dx}` must be present.
 */
export type WireInterestMsg = {
  t: typeof MessageType.Interest
  /** Full docId (used when no alias is in force). */
  doc?: string
  /** Alias reference to a previously-announced docId (CBOR major type 0). */
  dx?: number
  v?: string
  r?: boolean
}

/**
 * Compact wire format for offer.
 *
 * Decoder invariant: exactly one of `{doc, dx}` must be present.
 */
export type WireOfferMsg = {
  t: typeof MessageType.Offer
  doc?: string
  dx?: number
  pk: PayloadKindValue
  pe: PayloadEncodingValue
  d: string | Uint8Array
  v: string
  r?: boolean
}

/**
 * Compact wire format for dismiss.
 *
 * Decoder invariant: exactly one of `{doc, dx}` must be present.
 */
export type WireDismissMsg = {
  t: typeof MessageType.Dismiss
  doc?: string
  dx?: number
}

/** Union of all compact wire message types. */
export type WireMessage =
  | WireEstablishMsg
  | WireDepartMsg
  | WirePresentMsg
  | WireInterestMsg
  | WireOfferMsg
  | WireDismissMsg
