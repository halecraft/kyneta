// reassembler — binary fragment reassembler for @kyneta/wire.
//
// Thin wrapper around FragmentCollector<Uint8Array> that handles
// binary frame decoding. The collector does all the heavy lifting
// (timeouts, eviction, validation); this module just decodes the
// binary wire format and delegates.

import {
  type CollectorConfig,
  type CollectorError,
  type CollectorResult,
  FragmentCollector,
  type TimerAPI,
} from "./fragment-collector.js"
import { decodeBinaryFrame } from "./frame.js"

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of processing a binary frame through the reassembler.
 *
 * - `"complete"`: a full message is ready (either a complete message or
 *   a fully reassembled fragmented payload)
 * - `"pending"`: waiting for more fragments
 * - `"error"`: something went wrong (duplicate, invalid index, timeout, etc.)
 */
export type ReassembleResult =
  | { status: "complete"; data: Uint8Array }
  | { status: "pending" }
  | { status: "error"; error: ReassembleError }

/**
 * Errors that can occur during reassembly.
 * Wraps CollectorError with an additional parse_error variant.
 */
export type ReassembleError =
  | CollectorError
  | { type: "parse_error"; message: string }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the fragment reassembler.
 * Maps to CollectorConfig with binary-friendly naming.
 */
export interface ReassemblerConfig {
  /** Timeout in milliseconds before abandoning a batch (default: 10000). */
  timeoutMs?: number
  /** Maximum number of concurrent batches to track (default: 32). */
  maxConcurrentBatches?: number
  /** Maximum total bytes across all in-flight batches (default: 50MB). */
  maxTotalReassemblyBytes?: number
  /** Callback when a batch times out. */
  onTimeout?: (frameId: number) => void
  /** Callback when a batch is evicted due to memory pressure. */
  onEvicted?: (frameId: number) => void
}

// ---------------------------------------------------------------------------
// Uint8Array operations for the collector
// ---------------------------------------------------------------------------

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  let totalLength = 0
  for (const chunk of chunks) {
    totalLength += chunk.length
  }
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

const BINARY_OPS = {
  sizeOf: (chunk: Uint8Array) => chunk.length,
  concatenate: concatUint8Arrays,
} as const

// ---------------------------------------------------------------------------
// FragmentReassembler
// ---------------------------------------------------------------------------

/**
 * Binary fragment reassembler.
 *
 * Thin wrapper around `FragmentCollector<Uint8Array>`. Decodes binary
 * frames to determine if they are complete or fragmented, then either
 * returns immediately or delegates fragment collection to the generic
 * collector.
 *
 * Usage:
 * ```typescript
 * const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
 *
 * // Feed raw binary frames from the network
 * const result = reassembler.receiveRaw(data)
 *
 * if (result.status === "complete") {
 *   // result.data is the raw frame bytes
 *   // decodeBinaryMessages will decode them downstream
 * }
 *
 * // Clean up when done
 * reassembler.dispose()
 * ```
 */
export class FragmentReassembler {
  readonly #collector: FragmentCollector<Uint8Array>

  constructor(config?: ReassemblerConfig, timer?: TimerAPI) {
    const collectorConfig: Partial<CollectorConfig> = {
      timeoutMs: config?.timeoutMs,
      maxConcurrentFrames: config?.maxConcurrentBatches,
      maxTotalSize: config?.maxTotalReassemblyBytes,
      onTimeout: config?.onTimeout,
      onEvicted: config?.onEvicted,
    }
    this.#collector = new FragmentCollector(collectorConfig, BINARY_OPS, timer)
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Process raw binary frame bytes.
   *
   * Decodes the binary frame header to determine if it's a complete
   * frame or a fragment. Complete frames are returned immediately
   * (as raw bytes — `decodeBinaryMessages` expects raw frame bytes
   * and calls `decodeBinaryFrame` itself). Fragments are collected
   * until all pieces arrive, then the reassembled payload is returned.
   *
   * @param data - Raw binary frame bytes from the network
   * @returns Result: complete, pending, or error
   */
  receiveRaw(data: Uint8Array): ReassembleResult {
    try {
      const frame = decodeBinaryFrame(data)

      if (frame.content.kind === "complete") {
        // Complete frame — return the raw frame bytes as-is.
        // decodeBinaryMessages downstream will re-decode them.
        return { status: "complete", data }
      }

      // Fragment — extract metadata and delegate to collector
      const { frameId, index, total, totalSize, payload } = frame.content

      return this.#mapCollectorResult(
        this.#collector.addFragment(frameId, index, total, totalSize, payload),
      )
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
   * Cancels all pending timeout timers and clears batch state.
   * After disposal, all subsequent calls to the collector return errors.
   */
  dispose(): void {
    this.#collector.dispose()
  }

  /** Number of in-flight batches currently being tracked. */
  get pendingBatchCount(): number {
    return this.#collector.pendingFrameCount
  }

  /** Total bytes currently being tracked across all in-flight batches. */
  get pendingBytes(): number {
    return this.#collector.pendingSize
  }

  // ==========================================================================
  // PRIVATE — result mapping
  // ==========================================================================

  /**
   * Map a CollectorResult to a ReassembleResult.
   * The shapes are compatible — this is a pass-through.
   */
  #mapCollectorResult(result: CollectorResult<Uint8Array>): ReassembleResult {
    return result
  }
}
