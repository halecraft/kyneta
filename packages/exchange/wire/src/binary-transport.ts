// binary-transport — shared encode/decode helpers for binary transports.
//
// The encode→fragment→send and receive→reassemble→decode patterns are
// identical across all binary transports (WebSocket, WebRTC). These
// helpers extract the shared pipeline so each transport is a one-liner.
//
// The alias-aware path: the transport calls the alias transformer to
// produce/consume `WireMessage` and these helpers handle framing.

import { WIRE_VERSION } from "./constants.js"
import { fragmentPayload } from "./fragment.js"
import { decodeBinaryFrame, encodeBinaryFrame } from "./frame.js"
import { complete } from "./frame-types.js"
import type { FragmentReassembler } from "./reassembler.js"
import type { TextReassembler } from "./text-reassembler.js"
import {
  decodeTextWireMessage,
  decodeWireMessage,
  encodeWireMessage,
} from "./wire-message-helpers.js"
import type { WireMessage } from "./wire-types.js"

// ---------------------------------------------------------------------------
// Wire-message helpers — alias-aware path
// ---------------------------------------------------------------------------

/**
 * Encode a pre-formed `WireMessage`, frame it, optionally fragment, and
 * call `sendFn` for each piece.
 *
 * Use when the alias transformer has already produced the wire form.
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

// ---------------------------------------------------------------------------
// Text transport helpers — alias-aware path
// ---------------------------------------------------------------------------

/**
 * Feed a text wire frame string through the reassembler and decode to
 * `WireMessage[]` (without alias resolution). The caller passes each
 * result through `applyInboundAliasing` to obtain `ChannelMsg`s.
 *
 * Mirror of `decodeBinaryWires` for text transports (SSE).
 *
 * Returns the decoded wire messages when reassembly is complete, or
 * `null` if still pending.
 */
export function decodeTextWires(
  reassembler: TextReassembler,
  data: string,
): WireMessage[] | null {
  const result = reassembler.receive(data)
  if (result.status === "complete") {
    const parsed = JSON.parse(result.frame.content.payload)
    return [decodeTextWireMessage(parsed)]
  }
  if (result.status === "error") {
    throw new Error(`Text reassembly error: ${result.error.type}`)
  }
  return null
}
