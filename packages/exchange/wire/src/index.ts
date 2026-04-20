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
  type WireInterestMsg,
  type WireMessage,
  type WireOfferMsg,
  type WirePresentMsg,
} from "./wire-types.js"

// ---------------------------------------------------------------------------
// Constants — protocol version, transport prefixes
// ---------------------------------------------------------------------------

export {
  BinaryFrameType,
  type BinaryFrameTypeValue,
  FRAGMENT,
  FRAGMENT_META_SIZE,
  FRAGMENT_MIN_SIZE,
  FRAME_ID_SIZE,
  HASH_ALGO,
  type HashAlgoValue,
  HEADER_SIZE,
  MESSAGE_COMPLETE,
  WIRE_VERSION,
} from "./constants.js"

// ---------------------------------------------------------------------------
// Frame — 7-byte header encoding/decoding
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
  bytesToHex,
  calculateFragmentationOverhead,
  FragmentParseError,
  fragmentPayload,
  generateFrameId,
  hexToBytes,
  parseTransportPayload,
  shouldFragment,
  type TransportPayload,
  wrapCompleteMessage,
  wrapFragment,
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
  encodeBinaryAndSend,
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
