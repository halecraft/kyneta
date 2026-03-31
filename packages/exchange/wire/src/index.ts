// @kyneta/wire — wire format codecs, framing, and fragmentation.
//
// Universal Frame<T> abstraction: every message is a frame. A frame
// carries a version, optional hash, and content (Complete or Fragment).
// Binary: Frame<Uint8Array>. Text: Frame<string>.
//
// Two pipelines for @kyneta/exchange's 5-message protocol
// (establish-request, establish-response, discover, interest, offer):
//
// Binary pipeline (WebSocket, WebRTC):
//   BinaryCodec (CBOR) → binary frame (7B header) → binary fragmentation → FragmentReassembler
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

export type { Frame, Complete, Fragment } from "./frame-types.js"
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
  type MessageTypeValue,
  MessageTypeToString,
  StringToMessageType,
  PayloadKind,
  type PayloadKindValue,
  PayloadKindToString,
  StringToPayloadKind,
  PayloadEncoding,
  type PayloadEncodingValue,
  PayloadEncodingToString,
  StringToPayloadEncoding,
  type WireEstablishMsg,
  type WireDiscoverMsg,
  type WireInterestMsg,
  type WireOfferMsg,
  type WireMessage,
} from "./wire-types.js"

// ---------------------------------------------------------------------------
// Constants — protocol version, transport prefixes
// ---------------------------------------------------------------------------

export {
  WIRE_VERSION,
  HEADER_SIZE,
  BinaryFrameType,
  type BinaryFrameTypeValue,
  HASH_ALGO,
  type HashAlgoValue,
  MESSAGE_COMPLETE,
  FRAGMENT,
  FRAME_ID_SIZE,
  FRAGMENT_META_SIZE,
  FRAGMENT_MIN_SIZE,
} from "./constants.js"

// ---------------------------------------------------------------------------
// Frame — 7-byte header encoding/decoding
// ---------------------------------------------------------------------------

export {
  encodeBinaryFrame,
  decodeBinaryFrame,
  encodeComplete,
  encodeCompleteBatch,
  FrameDecodeError,
  type FrameDecodeErrorCode,
} from "./frame.js"

// ---------------------------------------------------------------------------
// Text frame — 2-char prefix encoding/decoding
// ---------------------------------------------------------------------------

export {
  TEXT_WIRE_VERSION,
  encodeTextFrame,
  decodeTextFrame,
  fragmentTextPayload,
  encodeTextComplete,
  encodeTextCompleteBatch,
  TextFrameDecodeError,
  type TextFrameDecodeErrorCode,
} from "./text-frame.js"

// ---------------------------------------------------------------------------
// Fragment — transport-level payload fragmentation
// ---------------------------------------------------------------------------

export {
  type TransportPayload,
  FragmentParseError,
  generateFrameId,
  bytesToHex,
  hexToBytes,
  wrapCompleteMessage,
  wrapFragment,
  parseTransportPayload,
  fragmentPayload,
  shouldFragment,
  calculateFragmentationOverhead,
} from "./fragment.js"

// ---------------------------------------------------------------------------
// Fragment collector — generic stateful fragment collection
// ---------------------------------------------------------------------------

export {
  FragmentCollector,
  decideFragment,
  type CollectorResult,
  type CollectorError,
  type CollectorConfig,
  type CollectorOps,
  type FragmentDecision,
  type TimerAPI,
} from "./fragment-collector.js"

// ---------------------------------------------------------------------------
// Reassembler — stateful fragment reassembly (binary wrapper)
// ---------------------------------------------------------------------------

export {
  FragmentReassembler,
  type ReassembleResult,
  type ReassembleError,
  type ReassemblerConfig,
} from "./reassembler.js"

// ---------------------------------------------------------------------------
// Text reassembler — stateful fragment reassembly (text wrapper)
// ---------------------------------------------------------------------------

export {
  TextReassembler,
  type TextReassembleResult,
  type TextReassembleError,
  type TextReassemblerConfig,
} from "./text-reassembler.js"