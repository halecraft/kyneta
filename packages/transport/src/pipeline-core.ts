// pipeline-core — pure step functions for the wire pipeline.
//
// NO side effects, NO mutation of inputs (except the stateful reassembler
// receive which is carried by reference). Each step takes immutable state
// and returns a new state alongside a list of results.
//
// Two steps form the pipeline:
//   sendStep   — ChannelMsg → alias → encode → fragment → [S]
//   receiveStep — [R] → reassemble → decode → alias → ChannelMsg

import {
  complete,
  err,
  fragmentGeneric,
  ok,
  type Reassembler,
  type Result,
  type WireCodec,
  type WireError,
  type WireMessage,
  WireValidationFailure,
} from "@kyneta/wire"
import type { AliasState } from "./alias-table.js"
import { applyInboundAliasing, applyOutboundAliasing } from "./alias-table.js"
import type { ChannelMsg } from "./messages.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Encoding = "binary" | "text"
export type PayloadOf<E extends Encoding> = {
  binary: Uint8Array<ArrayBuffer>
  text: string
}[E]

export interface PipelineState<R> {
  readonly aliasState: AliasState
  readonly reassembler: Reassembler<R>
  readonly nextFrameId: () => number
}

export interface ResolvedOpts {
  readonly threshold: number
  readonly onError?: (e: WireError, dir: "send" | "receive") => void
}

// ---------------------------------------------------------------------------
// sendStep — ChannelMsg → wire pieces
// ---------------------------------------------------------------------------

export function sendStep<S>(
  state: PipelineState<unknown>,
  sendCodec: WireCodec<S>,
  opts: ResolvedOpts,
  msg: ChannelMsg,
): { state: PipelineState<unknown>; outputs: readonly Result<S, WireError>[] } {
  const aliasResult = applyOutboundAliasing(state.aliasState, msg)
  const nextState = { ...state, aliasState: aliasResult.state }

  if (!aliasResult.result.ok) {
    return {
      state: nextState,
      outputs: [
        err({
          code: "alias-resolution-failed",
          detail: aliasResult.result.error,
        }),
      ],
    }
  }

  const wire = aliasResult.result.value
  const payload = sendCodec.encodeWire(wire)
  const payloadSize = sendCodec.sizeOf(payload)

  if (opts.threshold > 0 && payloadSize > opts.threshold) {
    const frameId = state.nextFrameId()
    const fragResult = fragmentGeneric(
      payload,
      opts.threshold,
      frameId,
      sendCodec,
    )

    if (fragResult.kind === "fragments") {
      return { state: nextState, outputs: fragResult.pieces.map(p => ok(p)) }
    }
    if (fragResult.kind === "empty-payload") {
      return {
        state: nextState,
        outputs: [
          err({ code: "empty-payload", detail: { totalSize: 0 as const } }),
        ],
      }
    }
    // too-many-fragments
    return {
      state: nextState,
      outputs: [
        err({
          code: "too-many-fragments",
          detail: { total: fragResult.total, max: fragResult.max },
        }),
      ],
    }
  }

  // No fragmentation needed — send as a single complete frame.
  const framed = sendCodec.encodeFrame(complete(sendCodec.wireVersion, payload))
  const framedSize = sendCodec.sizeOf(framed)

  if (framedSize > sendCodec.maxPayload) {
    return {
      state: nextState,
      outputs: [
        err({
          code: "frame-too-large",
          detail: { size: framedSize, limit: sendCodec.maxPayload },
        }),
      ],
    }
  }

  return { state: nextState, outputs: [ok(framed)] }
}

// ---------------------------------------------------------------------------
// receiveStep — wire piece → ChannelMsg
// ---------------------------------------------------------------------------

export function receiveStep<R>(
  state: PipelineState<R>,
  recvCodec: WireCodec<R>,
  opts: ResolvedOpts,
  piece: R,
): {
  state: PipelineState<R>
  inputs: readonly Result<ChannelMsg, WireError>[]
} {
  const reassemblyResult = state.reassembler.receive(piece)

  if (reassemblyResult.status === "pending") {
    return { state, inputs: [] }
  }

  if (reassemblyResult.status === "error") {
    return {
      state,
      inputs: [
        err({ code: "reassembly-failed", detail: reassemblyResult.error }),
      ],
    }
  }

  const frame = reassemblyResult.frame

  if (frame.content.kind !== "complete") {
    // Structurally unreachable: Reassembler only yields Complete frames.
    // If we arrive here, something is deeply wrong in the reassembler.
    return {
      state,
      inputs: [
        err({
          code: "decode-failed",
          detail: new Error(
            `invariant: reassembler yielded ${frame.content.kind} frame`,
          ),
        }),
      ],
    }
  }

  let wire: WireMessage
  try {
    wire = recvCodec.decodeWire(frame.content.payload)
  } catch (e) {
    if (e instanceof WireValidationFailure) {
      return {
        state,
        inputs: [err({ code: "invalid-wire-message", detail: e.error })],
      }
    }
    return { state, inputs: [err({ code: "decode-failed", detail: e })] }
  }

  const aliasResult = applyInboundAliasing(state.aliasState, wire)
  const nextState = { ...state, aliasState: aliasResult.state }

  if (!aliasResult.result.ok) {
    return {
      state: nextState,
      inputs: [
        err({
          code: "alias-resolution-failed",
          detail: aliasResult.result.error,
        }),
      ],
    }
  }

  return { state: nextState, inputs: [ok(aliasResult.result.value)] }
}
