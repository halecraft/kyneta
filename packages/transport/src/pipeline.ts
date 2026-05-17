// pipeline — imperative shell wrapping the pure pipeline-core step functions.
//
// The Pipeline class owns mutable state (alias table, reassembler, frame ID
// counter) and delegates all logic to sendStep / receiveStep. It also
// routes errors through the onError callback for observability.
//
// Usage:
//   const p = new Pipeline({ send: "binary" })
//   const outputs = p.send(msg)     // → Result<Uint8Array, WireError>[]
//   const inputs  = p.receive(data) // → Result<ChannelMsg, WireError>[]
//   p.dispose()

import {
  BINARY_CODEC,
  createFrameIdCounter,
  Reassembler,
  type Result,
  TEXT_CODEC,
  type WireCodec,
  type WireError,
} from "@kyneta/wire"
import { emptyAliasState } from "./alias-table.js"
import type { ChannelMsg } from "./messages.js"
import {
  type Encoding,
  type PayloadOf,
  type PipelineState,
  type ResolvedOpts,
  receiveStep,
  sendStep,
} from "./pipeline-core.js"

const CODECS = { binary: BINARY_CODEC, text: TEXT_CODEC } as const

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WireOpts {
  readonly threshold?: number
  readonly reassemblyTimeoutMs?: number
  readonly reassemblyMaxConcurrentFrames?: number
  readonly reassemblyMaxTotalSize?: number
  readonly onError?: (e: WireError, dir: "send" | "receive") => void
  readonly nextFrameId?: () => number
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class Pipeline<S extends Encoding, R extends Encoding = S> {
  #sendCodec: WireCodec<PayloadOf<S>>
  #recvCodec: WireCodec<PayloadOf<R>>
  #opts: ResolvedOpts
  #wireOpts: WireOpts
  #state: PipelineState<PayloadOf<R>>
  #disposed = false

  constructor(config: { send: S; receive?: R; opts?: WireOpts }) {
    const recvEncoding = (config.receive ?? config.send) as R
    // Double-cast required: CODECS[config.send] yields WireCodec<Uint8Array<ArrayBuffer>> |
    // WireCodec<string>. TS can't narrow this union through the generic string-literal index
    // to WireCodec<PayloadOf<S>>. The types align structurally — BINARY_CODEC is
    // WireCodec<Uint8Array<ArrayBuffer>> = WireCodec<PayloadOf<"binary">>, TEXT_CODEC is
    // WireCodec<string> = WireCodec<PayloadOf<"text">> — but the proof requires `unknown`.
    this.#sendCodec = CODECS[config.send] as unknown as WireCodec<PayloadOf<S>>
    this.#recvCodec = CODECS[recvEncoding] as unknown as WireCodec<PayloadOf<R>>
    this.#wireOpts = config.opts ?? {}
    this.#opts = {
      threshold: this.#wireOpts.threshold ?? 0,
      onError: this.#wireOpts.onError,
    }
    this.#state = this.#buildState()
  }

  send(msg: ChannelMsg): readonly Result<PayloadOf<S>, WireError>[] {
    if (this.#disposed) throw new Error("Pipeline disposed")
    const result = sendStep(
      this.#state as PipelineState<unknown>,
      this.#sendCodec,
      this.#opts,
      msg,
    )
    // Update state (aliasState may have changed)
    this.#state = { ...this.#state, aliasState: result.state.aliasState }
    // Route errors through onError
    for (const r of result.outputs) {
      if (!r.ok && this.#opts.onError) {
        this.#opts.onError(r.error, "send")
      }
    }
    return result.outputs
  }

  receive(piece: PayloadOf<R>): readonly Result<ChannelMsg, WireError>[] {
    if (this.#disposed) throw new Error("Pipeline disposed")
    const result = receiveStep(this.#state, this.#recvCodec, this.#opts, piece)
    this.#state = result.state
    // Route errors through onError
    for (const r of result.inputs) {
      if (!r.ok && this.#opts.onError) {
        this.#opts.onError(r.error, "receive")
      }
    }
    return result.inputs
  }

  reset(): void {
    if (this.#disposed) throw new Error("Pipeline disposed")
    this.#state.reassembler.reset()
    this.#state = {
      aliasState: emptyAliasState(),
      reassembler: this.#state.reassembler,
      nextFrameId: this.#wireOpts.nextFrameId ?? createFrameIdCounter(),
    }
  }

  dispose(): void {
    this.#disposed = true
    this.#state.reassembler.dispose()
  }

  #buildState(): PipelineState<PayloadOf<R>> {
    const nextFrameId = this.#wireOpts.nextFrameId ?? createFrameIdCounter()
    const onError = this.#opts.onError
    return {
      aliasState: emptyAliasState(),
      reassembler: new Reassembler(this.#recvCodec, {
        timeoutMs: this.#wireOpts.reassemblyTimeoutMs,
        maxConcurrentFrames: this.#wireOpts.reassemblyMaxConcurrentFrames,
        maxTotalSize: this.#wireOpts.reassemblyMaxTotalSize,
        onTimeout: onError
          ? frameId =>
              onError(
                {
                  code: "reassembly-timeout",
                  detail: { frameId, partialCount: 0 },
                },
                "receive",
              )
          : undefined,
        onEvicted: onError
          ? frameId =>
              onError(
                { code: "reassembly-evicted", detail: { frameId } },
                "receive",
              )
          : undefined,
      }),
      nextFrameId,
    }
  }
}
