// reassembler-generic — substrate-agnostic fragment reassembler.
//
// Unifies binary and text reassembly into one class parameterized
// by SubstrateOps<T>.
//
// Internal flow:
//   ops.decodeFrame(wire) → if Complete pass through;
//   if Fragment delegate to FragmentCollector<T>;
//   on completion synthesize Complete<T> with ops.wireVersion.
//
// Single config shape — no per-substrate naming drift.

import type { CollectorError, TimerAPI } from "./fragment-collector.js"
import { FragmentCollector } from "./fragment-collector.js"
import type { SubstrateOps } from "./fragment-generic.js"
import type { Frame } from "./frame-types.js"
import { complete } from "./frame-types.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the generic reassembler.
 * Single shape; no per-substrate naming drift.
 */
export interface ReassemblerConfig {
  /** Timeout in milliseconds before abandoning a batch (default: 10000). */
  readonly timeoutMs?: number
  /** Maximum number of concurrent in-flight frame groups (default: 32). */
  readonly maxConcurrentFrames?: number
  /** Maximum total size across all in-flight groups (default: 50M). */
  readonly maxTotalSize?: number
  /** Callback when a batch times out. */
  readonly onTimeout?: (frameId: number) => void
  /** Callback when a batch is evicted due to pressure. */
  readonly onEvicted?: (frameId: number) => void
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of processing a wire piece through the reassembler.
 *
 * - `"complete"`: a full frame is ready
 * - `"pending"`: waiting for more fragments
 * - `"error"`: something went wrong
 */
export type ReassembleResult<T> =
  | { readonly status: "complete"; readonly frame: Frame<T> }
  | { readonly status: "pending" }
  | { readonly status: "error"; readonly error: ReassembleError }

/**
 * Errors that can occur during reassembly.
 * Wraps CollectorError with an additional parse_error variant.
 */
export type ReassembleError =
  | CollectorError
  | { readonly type: "parse_error"; readonly message: string }

// ---------------------------------------------------------------------------
// Reassembler<T>
// ---------------------------------------------------------------------------

/**
 * Substrate-agnostic fragment reassembler.
 *
 * Wraps `FragmentCollector<T>` with frame decode/encode logic.
 * Complete frames pass through; fragment frames are collected
 * and reassembled into a synthetic Complete frame.
 *
 * Usage:
 * ```typescript
 * const reassembler = new Reassembler(BINARY_CODEC, { timeoutMs: 5000 })
 * const result = reassembler.receive(wirePiece)
 * if (result.status === "complete") { ... }
 * reassembler.dispose()
 * ```
 */
export class Reassembler<T> {
  readonly #ops: SubstrateOps<T>
  readonly #collector: FragmentCollector<T>
  #disposed = false

  constructor(
    ops: SubstrateOps<T>,
    config?: ReassemblerConfig,
    timer?: TimerAPI,
  ) {
    this.#ops = ops
    this.#collector = new FragmentCollector(
      {
        timeoutMs: config?.timeoutMs,
        maxConcurrentFrames: config?.maxConcurrentFrames,
        maxTotalSize: config?.maxTotalSize,
        onTimeout: config?.onTimeout,
        onEvicted: config?.onEvicted,
      },
      {
        sizeOf: ops.sizeOf,
        concatenate: (chunks: T[]) => ops.concatenate(chunks),
      },
      timer,
    )
  }

  /**
   * Process a wire piece (substrate-native wire form).
   *
   * Decodes the piece to determine if it's a complete frame or a
   * fragment. Complete frames are returned immediately as `Frame<T>`.
   * Fragments are collected until all pieces arrive, then the
   * reassembled payload is wrapped in a synthesized Complete frame.
   */
  receive(wire: T): ReassembleResult<T> {
    if (this.#disposed) {
      return {
        status: "error",
        error: { type: "parse_error", message: "Reassembler disposed" },
      }
    }

    try {
      const frame = this.#ops.decodeFrame(wire)

      if (frame.content.kind === "complete") {
        return { status: "complete", frame }
      }

      const { frameId, index, total, totalSize, payload } = frame.content
      const result = this.#collector.addFragment(
        frameId,
        index,
        total,
        totalSize,
        payload,
      )

      if (result.status === "complete") {
        return {
          status: "complete",
          frame: complete(this.#ops.wireVersion, result.data, frame.hash),
        }
      }

      if (result.status === "pending") {
        return { status: "pending" }
      }

      return { status: "error", error: result.error }
    } catch (error) {
      return {
        status: "error",
        error: {
          type: "parse_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  /**
   * Reset the reassembler to its initial state.
   *
   * Clears all pending timeout timers and batch state without disposing.
   * After reset, the reassembler is ready to accept new frames.
   */
  reset(): void {
    this.#collector.reset()
  }

  /**
   * Clean up all resources.
   *
   * Cancels all pending timeout timers and clears state.
   * After disposal, subsequent receive calls return errors.
   */
  dispose(): void {
    this.#disposed = true
    this.#collector.dispose()
  }

  /** Number of in-flight frame groups currently being tracked. */
  get pendingFrameCount(): number {
    return this.#collector.pendingFrameCount
  }

  /** Total size currently being tracked across all in-flight groups. */
  get pendingSize(): number {
    return this.#collector.pendingSize
  }
}
