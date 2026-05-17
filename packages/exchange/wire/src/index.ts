// @kyneta/wire — wire format primitives: framing, fragmentation, codecs.
//
// Pure leaf package — no runtime dependency on @kyneta/transport.
//
// Universal Frame<T> abstraction: every message is a frame. A frame
// carries a version, optional hash, and content (Complete or Fragment).
// Binary: Frame<Uint8Array>. Text: Frame<string>.
//
// Shared: FragmentCollector<T> — generic stateful fragment collection
// (pure decideFragment + imperative shell).

// ---------------------------------------------------------------------------
// Frame types — universal frame abstraction
// ---------------------------------------------------------------------------

export type { Complete, Fragment, Frame } from "./frame-types.js"
export { complete, fragment, isComplete, isFragment } from "./frame-types.js"

// ---------------------------------------------------------------------------
// Wire types — discriminators and compact field names (CBOR internals)
// ---------------------------------------------------------------------------

export {
  MessageType,
  MessageTypeToString,
  type MessageTypeValue,
  PayloadEncoding,
  PayloadEncodingToString,
  type PayloadEncodingValue,
  PayloadKind,
  PayloadKindToString,
  type PayloadKindValue,
  StringToMessageType,
  StringToPayloadEncoding,
  StringToPayloadKind,
  SyncProtocolWire,
  SyncProtocolWireToProtocol,
  type SyncProtocolWireValue,
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

// ---------------------------------------------------------------------------
// Constants — protocol version, frame layout
// ---------------------------------------------------------------------------

export {
  BinaryFrameType,
  type BinaryFrameTypeValue,
  DOC_ID_MAX_UTF8_BYTES,
  FRAGMENT_META_SIZE,
  FRAGMENT_MIN_SIZE,
  HEADER_SIZE,
  SCHEMA_HASH_MAX_UTF8_BYTES,
  WIRE_VERSION,
} from "./constants.js"

// ---------------------------------------------------------------------------
// Frame — 6-byte header encoding/decoding (binary substrate)
// ---------------------------------------------------------------------------

export {
  BINARY_CODEC,
  decodeBinaryFrame,
  encodeBinaryFrame,
  FrameDecodeError,
  type FrameDecodeErrorCode,
} from "./frame.js"

// ---------------------------------------------------------------------------
// Text frame — 2-char prefix encoding/decoding (text substrate)
// ---------------------------------------------------------------------------

export {
  decodeTextFrame,
  encodeTextFrame,
  TEXT_CODEC,
  TEXT_WIRE_VERSION,
  TextFrameDecodeError,
  type TextFrameDecodeErrorCode,
} from "./text-frame.js"

// ---------------------------------------------------------------------------
// Fragment generic — substrate-agnostic fragmentation and codec interfaces
// ---------------------------------------------------------------------------

export {
  createFrameIdCounter,
  FRAGMENT_TOTAL_MAX,
  type FragmentResult,
  fragmentGeneric,
  type SubstrateOps,
  type WireCodec,
} from "./fragment-generic.js"

// ---------------------------------------------------------------------------
// Fragment collector — generic stateful fragment collection
// ---------------------------------------------------------------------------

export {
  type CollectorConfig,
  type CollectorError,
  type CollectorOps,
  type CollectorResult,
  decideFragment,
  FragmentCollector,
  type FragmentDecision,
  type TimerAPI,
} from "./fragment-collector.js"

// ---------------------------------------------------------------------------
// Reassembler generic — substrate-agnostic fragment reassembly
// ---------------------------------------------------------------------------

export {
  type ReassembleError,
  type ReassembleResult,
  Reassembler,
  type ReassemblerConfig,
} from "./reassembler-generic.js"

// ---------------------------------------------------------------------------
// Identifier validation — UTF-8 byte length caps
// ---------------------------------------------------------------------------

export {
  type IdentifierValidationError,
  utf8ByteLength,
  validateDocId,
  validateSchemaHash,
} from "./validate-identifiers.js"

// ---------------------------------------------------------------------------
// Alias error types — lifted for WireError's alias-resolution-failed variant
// ---------------------------------------------------------------------------

export type { Alias, AliasResolutionError } from "./alias-error.js"

// ---------------------------------------------------------------------------
// Wire-message helpers — bypass ChannelMsg ⇄ WireMessage conversion
// ---------------------------------------------------------------------------

export {
  decodeTextWireMessage,
  decodeWireMessage,
  encodeTextWireMessage,
  encodeWireMessage,
} from "./wire-message-helpers.js"

// ---------------------------------------------------------------------------
// Wire-message validation — runtime shape checks for decoded WireMessage
// ---------------------------------------------------------------------------

export {
  validateWireMessage,
  type WireValidationError,
  WireValidationFailure,
} from "./validate-wire-message.js"

// ---------------------------------------------------------------------------
// Wire error — discriminated union of all wire-pipeline errors
// ---------------------------------------------------------------------------

export type { WireError } from "./wire-error.js"

// ---------------------------------------------------------------------------
// Result type — discriminated union for fallible operations
// ---------------------------------------------------------------------------

export { type Err, err, type Ok, ok, type Result } from "./result.js"
