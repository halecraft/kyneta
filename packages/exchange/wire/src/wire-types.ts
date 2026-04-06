// wire-types — integer discriminators and compact field names for wire encoding.
//
// The CBOR codec uses integer type discriminators and short field names
// to minimize payload size. The JSON codec uses the ChannelMsg type
// strings directly and doesn't need these mappings.
//
// Wire type ranges:
//   0x01–0x0F: Connection establishment
//   0x10–0x1F: Exchange messages (present, interest, offer)

// ---------------------------------------------------------------------------
// Message type discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for each ChannelMsg type on the wire.
 *
 * These are used as the `t` field in compact wire objects for CBOR encoding.
 */
export const MessageType = {
  EstablishRequest: 0x01,
  EstablishResponse: 0x02,
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
  [MessageType.EstablishRequest]: "establish-request",
  [MessageType.EstablishResponse]: "establish-response",
  [MessageType.Present]: "present",
  [MessageType.Interest]: "interest",
  [MessageType.Offer]: "offer",
  [MessageType.Dismiss]: "dismiss",
}

/**
 * Forward lookup: ChannelMsg type string → integer discriminator.
 */
export const StringToMessageType: Record<string, MessageTypeValue> = {
  "establish-request": MessageType.EstablishRequest,
  "establish-response": MessageType.EstablishResponse,
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
// MergeStrategy discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for MergeStrategy on the wire.
 */
export const MergeStrategyWire = {
  Concurrent: 0x00,
  Sequential: 0x01,
  Ephemeral: 0x02,
} as const

export type MergeStrategyWireValue =
  (typeof MergeStrategyWire)[keyof typeof MergeStrategyWire]

/**
 * Reverse lookup: merge strategy integer → string.
 */
export const MergeStrategyWireToString: Record<
  MergeStrategyWireValue,
  "concurrent" | "sequential" | "ephemeral"
> = {
  [MergeStrategyWire.Concurrent]: "concurrent",
  [MergeStrategyWire.Sequential]: "sequential",
  [MergeStrategyWire.Ephemeral]: "ephemeral",
}

/**
 * Forward lookup: merge strategy string → integer.
 */
export const StringToMergeStrategyWire: Record<string, MergeStrategyWireValue> =
  {
    concurrent: MergeStrategyWire.Concurrent,
    sequential: MergeStrategyWire.Sequential,
    ephemeral: MergeStrategyWire.Ephemeral,
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
 *   ms  — mergeStrategy (MergeStrategyWireValue)
 *   v   — version (string, serialized)
 *   r   — reciprocate (boolean, optional)
 *   sh  — schemaHash (string, 34-char hex, required in present doc entries)
 *   pk  — payload kind (PayloadKindValue)
 *   pe  — payload encoding (PayloadEncodingValue)
 */

/** Compact wire format for establish-request / establish-response. */
export type WireEstablishMsg = {
  t: typeof MessageType.EstablishRequest | typeof MessageType.EstablishResponse
  id: string
  n?: string
  y: "user" | "bot" | "service"
}

/** Compact wire format for present. */
export type WirePresentMsg = {
  t: typeof MessageType.Present
  docs: Array<{
    d: string
    rt: [string, number, number]
    ms: MergeStrategyWireValue
    sh: string
  }>
}

/** Compact wire format for interest. */
export type WireInterestMsg = {
  t: typeof MessageType.Interest
  doc: string
  v?: string
  r?: boolean
}

/** Compact wire format for offer. */
export type WireOfferMsg = {
  t: typeof MessageType.Offer
  doc: string
  pk: PayloadKindValue
  pe: PayloadEncodingValue
  d: string | Uint8Array
  v: string
  r?: boolean
}

/** Compact wire format for dismiss. */
export type WireDismissMsg = {
  t: typeof MessageType.Dismiss
  doc: string
}

/** Union of all compact wire message types. */
export type WireMessage =
  | WireEstablishMsg
  | WirePresentMsg
  | WireInterestMsg
  | WireOfferMsg
  | WireDismissMsg
