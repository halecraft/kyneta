// @kyneta/wire — wire format codecs, framing, and fragmentation.
//
// Provides serialization infrastructure for @kyneta/exchange's
// 5-message protocol (establish-request, establish-response,
// discover, interest, offer).
//
// Two codecs:
// - CBOR (src/cbor.ts) — compact binary for Websocket, WebRTC
// - JSON (src/json.ts) — human-readable for SSE, HTTP, debugging

// ---------------------------------------------------------------------------
// Codec interface
// ---------------------------------------------------------------------------

export type { MessageCodec } from "./codec.js"

// ---------------------------------------------------------------------------
// CBOR codec — binary transports
// ---------------------------------------------------------------------------

export { cborCodec } from "./cbor.js"

// ---------------------------------------------------------------------------
// JSON codec — text transports
// ---------------------------------------------------------------------------

export { jsonCodec } from "./json.js"

// ---------------------------------------------------------------------------
// Wire types — discriminators and compact field names (CBOR internals)
// ---------------------------------------------------------------------------

export {
  MessageType,
  type MessageTypeValue,
  MessageTypeToString,
  StringToMessageType,
  OfferType,
  type OfferTypeValue,
  OfferTypeToString,
  StringToOfferType,
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
// Constants — protocol version, flags, transport prefixes
// ---------------------------------------------------------------------------

export {
  WIRE_VERSION,
  HEADER_SIZE,
  FrameFlags,
  MESSAGE_COMPLETE,
  FRAGMENT_HEADER,
  FRAGMENT_DATA,
  BATCH_ID_SIZE,
  FRAGMENT_HEADER_PAYLOAD_SIZE,
  FRAGMENT_DATA_MIN_SIZE,
} from "./constants.js"

// ---------------------------------------------------------------------------
// Frame — 6-byte header encoding/decoding
// ---------------------------------------------------------------------------

export {
  encodeFrame,
  encodeBatchFrame,
  decodeFrame,
  FrameDecodeError,
  type FrameDecodeErrorCode,
} from "./frame.js"

// ---------------------------------------------------------------------------
// Fragment — transport-level payload fragmentation
// ---------------------------------------------------------------------------

export {
  type TransportPayload,
  FragmentParseError,
  FragmentReassembleError,
  generateBatchId,
  batchIdToKey,
  keyToBatchId,
  wrapCompleteMessage,
  createFragmentHeader,
  createFragmentData,
  parseTransportPayload,
  fragmentPayload,
  reassembleFragments,
  shouldFragment,
  calculateFragmentationOverhead,
} from "./fragment.js"

// ---------------------------------------------------------------------------
// Reassembler — stateful fragment reassembly
// ---------------------------------------------------------------------------

export {
  FragmentReassembler,
  type ReassembleResult,
  type ReassembleError,
  type ReassemblerConfig,
  type TimerAPI,
} from "./reassembler.js"