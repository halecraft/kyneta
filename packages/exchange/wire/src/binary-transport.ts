// binary-transport — shared encode/decode helpers for binary transports.
//
// The encode→fragment→send and receive→reassemble→decode patterns are
// identical across all binary transports (WebSocket, WebRTC). These
// helpers extract the shared pipeline so each transport is a one-liner.
//
// Two flavors:
// - `encodeBinaryAndSend` / `decodeBinaryMessages` — `ChannelMsg`-based
//   (legacy path; uses `cborCodec.encode/decode`).
// - `encodeWireFrameAndSend` / `decodeBinaryWires` — `WireMessage`-based
//   (alias-aware path; the transport calls the alias transformer to
//   produce/consume `WireMessage` and these helpers handle framing).

import type { ChannelMsg } from "@kyneta/transport"
import { cborCodec } from "./cbor.js"
import { WIRE_VERSION } from "./constants.js"
import { fragmentPayload } from "./fragment.js"
import { complete } from "./frame-types.js"
import { decodeBinaryFrame, encodeBinaryFrame, encodeComplete } from "./frame.js"
import type { FragmentReassembler } from "./reassembler.js"
import { decodeWireMessage, encodeWireMessage } from "./wire-message-helpers.js"
import type { WireMessage } from "./wire-types.js"

// ---------------------------------------------------------------------------
// Outbound — encode + fragment + send
// ---------------------------------------------------------------------------

/**
 * Encode a ChannelMsg, optionally fragment, and call sendFn for each piece.
 *
 * This is the shared outbound pipeline for all binary transports
 * (WebSocket, WebRTC). The caller provides the send function —
 * the transport-specific effectful operation.
 *
 * @param msg                - The channel message to encode
 * @param sendFn             - Transport-specific send (e.g. `data => socket.send(data)`)
 * @param fragmentThreshold  - Fragment payloads larger than this (bytes). 0 disables.
 * @param nextFrameId        - Callback returning a unique frame ID for fragment grouping
 */
export function encodeBinaryAndSend(
  msg: ChannelMsg,
  sendFn: (data: Uint8Array<ArrayBuffer>) => void,
  fragmentThreshold: number,
  nextFrameId: () => number,
): void {
  const frame = encodeComplete(cborCodec, msg)
  if (fragmentThreshold > 0 && frame.length > fragmentThreshold) {
    const fragments = fragmentPayload(frame, fragmentThreshold, nextFrameId())
    for (const frag of fragments) {
      sendFn(frag)
    }
  } else {
    sendFn(frame)
  }
}

// ---------------------------------------------------------------------------
// Inbound — reassemble + decode
// ---------------------------------------------------------------------------

/**
 * Feed raw transport bytes through the reassembler and decode to ChannelMsg[].
 *
 * Returns the decoded messages when reassembly is complete, or `null`
 * if the reassembler is still collecting fragments. Throws on reassembly
 * or decode errors — the caller decides how to handle them.
 *
 * This is the shared inbound pipeline for all binary transports.
 *
 * @param bytes - Raw binary data from the transport
 * @param reassembler - The transport's FragmentReassembler instance
 * @returns Decoded messages, or null if pending more fragments
 * @throws On reassembly error or decode failure
 */
export function decodeBinaryMessages(
  bytes: Uint8Array,
  reassembler: FragmentReassembler,
): ChannelMsg[] | null {
  const result = reassembler.receiveRaw(bytes)
  if (result.status === "complete") {
    const frame = decodeBinaryFrame(result.data)
    return cborCodec.decode(frame.content.payload)
  }
  if (result.status === "error") {
    throw new Error(`Fragment reassembly error: ${result.error.type}`)
  }
  return null // pending
}

// ---------------------------------------------------------------------------
// Wire-message helpers — alias-aware path
// ---------------------------------------------------------------------------

/**
 * Encode a pre-formed `WireMessage`, frame it, optionally fragment, and
 * call `sendFn` for each piece.
 *
 * Use when the alias transformer has already produced the wire form.
 * Mirror of `encodeBinaryAndSend` for the alias-aware path.
 */
export function encodeWireFrameAndSend(
  wire: WireMessage,
  sendFn: (data: Uint8Array<ArrayBuffer>) => void,
  fragmentThreshold: number,
  nextFrameId: () => number,
): void {
  const payload = encodeWireMessage(wire)
  const frame = encodeBinaryFrame(complete(WIRE_VERSION, payload))
  if (fragmentThreshold > 0 && frame.length > fragmentThreshold) {
    const fragments = fragmentPayload(frame, fragmentThreshold, nextFrameId())
    for (const frag of fragments) {
      sendFn(frag)
    }
  } else {
    sendFn(frame)
  }
}

/**
 * Feed raw transport bytes through the reassembler and decode to
 * `WireMessage[]` (without alias resolution). The caller passes each
 * result through `applyInboundAliasing` to obtain `ChannelMsg`s.
 *
 * Returns the decoded wire messages when reassembly is complete, or
 * `null` if still pending.
 */
export function decodeBinaryWires(
  bytes: Uint8Array,
  reassembler: FragmentReassembler,
): WireMessage[] | null {
  const result = reassembler.receiveRaw(bytes)
  if (result.status === "complete") {
    const frame = decodeBinaryFrame(result.data)
    // The CBOR payload may be a single message or an array (batch).
    // We could detect via the inner CBOR shape, but for the alias-aware
    // path we expect single messages per frame (transports fragment per
    // message). Fall back to single-message decode.
    return [decodeWireMessage(frame.content.payload)]
  }
  if (result.status === "error") {
    throw new Error(`Fragment reassembly error: ${result.error.type}`)
  }
  return null
}
