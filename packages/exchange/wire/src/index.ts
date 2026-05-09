// @kyneta/wire — wire format codecs, framing, and fragmentation.
//
// Universal Frame<T> abstraction: every message is a frame. A frame
// carries a version, optional hash, and content (Complete or Fragment).
// Binary: Frame<Uint8Array>. Text: Frame<string>.
//
// Two pipelines for @kyneta/transport's 6-message protocol
// (establish, depart, present, interest, offer, dismiss):
//
// Binary pipeline (WebSocket, WebRTC):
//   BinaryCodec (CBOR) → binary frame (6B header) → binary fragmentation → FragmentReassembler
//
// Text pipeline (SSE, HTTP):
//   TextCodec (JSON) → text frame ("Vx" prefix) → text fragmentation → TextReassembler
//
// Shared: FragmentCollector<T> — generic stateful fragment collection
// with FC/IS design (pure decideFragment + imperative shell).
// Batching is orthogonal to framing — the codec handles it.

// ---------------------------------------------------------------------------
// Frame types — universal frame abstraction
// ---------------------------------------------------------------------------

export type { Complete, Fragment, Frame } from "./frame-types.js"
export { complete, fragment, isComplete, isFragment } from "./frame-types.js"

// ---------------------------------------------------------------------------
// Codec interfaces
// ---------------------------------------------------------------------------

export type { BinaryCodec, TextCodec } from "./codec.js"

// ---------------------------------------------------------------------------
// CBOR codec — binary transports
// ---------------------------------------------------------------------------

export { cborCodec } from "./cbor.js"

// ---------------------------------------------------------------------------
// Text codec — text transports (SSE, HTTP)
// ---------------------------------------------------------------------------

export { textCodec } from "./json.js"

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
// Frame — 6-byte header encoding/decoding
// ---------------------------------------------------------------------------

export {
  decodeBinaryFrame,
  encodeBinaryFrame,
  encodeComplete,
  encodeCompleteBatch,
  FrameDecodeError,
  type FrameDecodeErrorCode,
} from "./frame.js"

// ---------------------------------------------------------------------------
// Text frame — 2-char prefix encoding/decoding
// ---------------------------------------------------------------------------

export {
  decodeTextFrame,
  encodeTextComplete,
  encodeTextCompleteBatch,
  encodeTextFrame,
  fragmentTextPayload,
  TEXT_WIRE_VERSION,
  TextFrameDecodeError,
  type TextFrameDecodeErrorCode,
} from "./text-frame.js"

// ---------------------------------------------------------------------------
// Fragment — transport-level payload fragmentation
// ---------------------------------------------------------------------------

export {
  calculateFragmentationOverhead,
  createFrameIdCounter,
  fragmentPayload,
  shouldFragment,
} from "./fragment.js"

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
// Reassembler — stateful fragment reassembly (binary wrapper)
// ---------------------------------------------------------------------------

export {
  FragmentReassembler,
  type ReassembleError,
  type ReassembleResult,
  type ReassemblerConfig,
} from "./reassembler.js"

// ---------------------------------------------------------------------------
// Binary transport helpers — shared encode/decode for binary transports
// ---------------------------------------------------------------------------

export {
  decodeBinaryMessages,
  decodeBinaryWires,
  encodeBinaryAndSend,
  encodeWireFrameAndSend,
} from "./binary-transport.js"

// ---------------------------------------------------------------------------
// Text reassembler — stateful fragment reassembly (text wrapper)
// ---------------------------------------------------------------------------

export {
  type TextReassembleError,
  type TextReassembleResult,
  TextReassembler,
  type TextReassemblerConfig,
} from "./text-reassembler.js"

// ---------------------------------------------------------------------------
// Stream frame parser — byte stream → binary frames (for stream transports)
// ---------------------------------------------------------------------------

export {
  type FeedBytesResult,
  feedBytes,
  initialParserState,
  type StreamParserState,
} from "./stream-frame-parser.js"

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
// Alias table — pure ChannelMsg ⇄ WireMessage transformer
// ---------------------------------------------------------------------------

export {
  type Alias,
  type AliasResolutionError,
  type AliasState,
  applyInboundAliasing,
  applyOutboundAliasing,
  emptyAliasState,
} from "./alias-table.js"

// ---------------------------------------------------------------------------
// Wire-message helpers — bypass ChannelMsg ⇄ WireMessage conversion
// ---------------------------------------------------------------------------

export {
  decodeTextWireMessage,
  decodeWireMessage,
  encodeTextWireMessage,
  encodeWireMessage,
} from "./wire-message-helpers.js"
