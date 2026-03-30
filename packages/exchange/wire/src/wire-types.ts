// wire-types — integer discriminators and compact field names for wire encoding.
//
// The CBOR codec uses integer type discriminators and short field names
// to minimize payload size. The JSON codec uses the ChannelMsg type
// strings directly and doesn't need these mappings.
//
// Wire type ranges:
//   0x01–0x0F: Connection establishment
//   0x10–0x1F: Exchange messages (discover, interest, offer)

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
  Discover: 0x10,
  Interest: 0x11,
  Offer: 0x12,
} as const

export type MessageTypeValue =
  (typeof MessageType)[keyof typeof MessageType]

/**
 * Reverse lookup: integer discriminator → ChannelMsg type string.
 */
export const MessageTypeToString: Record<MessageTypeValue, string> = {
  [MessageType.EstablishRequest]: "establish-request",
  [MessageType.EstablishResponse]: "establish-response",
  [MessageType.Discover]: "discover",
  [MessageType.Interest]: "interest",
  [MessageType.Offer]: "offer",
}

/**
 * Forward lookup: ChannelMsg type string → integer discriminator.
 */
export const StringToMessageType: Record<string, MessageTypeValue> = {
  "establish-request": MessageType.EstablishRequest,
  "establish-response": MessageType.EstablishResponse,
  discover: MessageType.Discover,
  interest: MessageType.Interest,
  offer: MessageType.Offer,
}

// ---------------------------------------------------------------------------
// Offer type discriminators
// ---------------------------------------------------------------------------

/**
 * Integer discriminators for OfferMsg.offerType on the wire.
 */
export const OfferType = {
  Snapshot: 0x00,
  Delta: 0x01,
} as const

export type OfferTypeValue = (typeof OfferType)[keyof typeof OfferType]

/**
 * Reverse lookup: offer type integer → string.
 */
export const OfferTypeToString: Record<OfferTypeValue, "snapshot" | "delta"> = {
  [OfferType.Snapshot]: "snapshot",
  [OfferType.Delta]: "delta",
}

/**
 * Forward lookup: offer type string → integer.
 */
export const StringToOfferType: Record<string, OfferTypeValue> = {
  snapshot: OfferType.Snapshot,
  delta: OfferType.Delta,
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
// Compact wire object types (CBOR)
// ---------------------------------------------------------------------------

/**
 * Compact field names used in CBOR wire objects:
 *
 *   t   — message type discriminator (MessageTypeValue)
 *   id  — peerId (string)
 *   n   — name (string, optional)
 *   y   — peer type ("user" | "bot" | "service")
 *   docs — docIds (string[])
 *   doc — docId (string)
 *   v   — version (string, serialized)
 *   r   — reciprocate (boolean, optional)
 *   ot  — offer type (OfferTypeValue)
 *   pe  — payload encoding (PayloadEncodingValue)
 *   d   — payload data (string | Uint8Array)
 */

/** Compact wire format for establish-request / establish-response. */
export type WireEstablishMsg = {
  t: typeof MessageType.EstablishRequest | typeof MessageType.EstablishResponse
  id: string
  n?: string
  y: "user" | "bot" | "service"
}

/** Compact wire format for discover. */
export type WireDiscoverMsg = {
  t: typeof MessageType.Discover
  docs: string[]
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
  ot: OfferTypeValue
  pe: PayloadEncodingValue
  d: string | Uint8Array
  v: string
  r?: boolean
}

/** Union of all compact wire message types. */
export type WireMessage =
  | WireEstablishMsg
  | WireDiscoverMsg
  | WireInterestMsg
  | WireOfferMsg