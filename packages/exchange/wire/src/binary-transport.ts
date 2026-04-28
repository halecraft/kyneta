// binary-transport — shared encode/decode helpers for binary transports.
//
// The encode→fragment→send and receive→reassemble→decode patterns are
// identical across all binary transports (WebSocket, WebRTC). These
// helpers extract the shared pipeline so each transport is a one-liner.
//
// FC/IS design:
// - encodeBinaryAndSend: pure planning (what bytes to produce) +
//   injected sendFn (the effectful operation)
// - decodeBinaryMessages: pure decode, returns messages or null,
//   throws on error (caller decides error handling)
//
// Separated from frame.ts to avoid circular imports — frame.ts is
// imported by reassembler.ts, and decodeBinaryMessages needs
// FragmentReassembler.

import type { ChannelMsg } from "@kyneta/transport"
import { cborCodec } from "./cbor.js"
import { fragmentPayload } from "./fragment.js"
import { decodeBinaryFrame, encodeComplete } from "./frame.js"
import type { FragmentReassembler } from "./reassembler.js"

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
