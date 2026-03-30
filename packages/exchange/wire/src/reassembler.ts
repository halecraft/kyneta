// reassembler — binary fragment reassembler for @kyneta/wire.
//
// Thin wrapper around FragmentCollector<Uint8Array> that handles
// binary transport payload parsing. The collector does all the
// heavy lifting (timeouts, eviction, validation); this module
// just parses the binary wire format and delegates.

import {
  FragmentCollector,
  type CollectorConfig,
  type CollectorResult,
  type CollectorError,
  type TimerAPI,
} from "./fragment-collector.js"
import { parseTransportPayload, type TransportPayload } from "./fragment.js"
import { decodeBinaryFrame } from "./frame.js"

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of processing a transport payload through the reassembler.
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
  onTimeout?: (frameId: string) => void
  /** Callback when a batch is evicted due to memory pressure. */
  onEvicted?: (frameId: string) => void
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
 * Thin wrapper around `FragmentCollector<Uint8Array>`. Parses binary
 * transport payloads (complete vs fragment prefix) and delegates
 * fragment collection to the generic collector.
 *
 * For fragment payloads, decodes the binary frame header to extract
 * frameId, index, total, totalSize, and the chunk data, then passes
 * them to the collector.
 *
 * Usage:
 * ```typescript
 * const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
 *
 * // Feed raw transport payloads from the network
 * const result = reassembler.receiveRaw(data)
 *
 * if (result.status === "complete") {
 *   // result.data is the reassembled payload (codec-encoded bytes)
 *   // Decode with: codec.decode(result.data) → ChannelMsg[]
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
   * Process a pre-parsed transport payload.
   *
   * @param payload - Parsed transport payload (from parseTransportPayload)
   * @returns Result: complete, pending, or error
   */
  receive(payload: TransportPayload): ReassembleResult {
    switch (payload.kind) {
      case "complete":
        // Complete frame — pass through immediately
        return { status: "complete", data: payload.data }

      case "fragment": {
        // Parse the binary frame to extract fragment metadata
        try {
          const frame = decodeBinaryFrame(payload.data)

          if (frame.content.kind !== "fragment") {
            // A fragment transport payload should contain a fragment frame
            return {
              status: "error",
              error: {
                type: "parse_error",
                message: "Fragment transport payload contains a non-fragment frame",
              },
            }
          }

          const { frameId, index, total, totalSize, payload: chunk } =
            frame.content

          return this.#mapCollectorResult(
            this.#collector.addFragment(frameId, index, total, totalSize, chunk),
          )
        } catch (error) {
          return {
            status: "error",
            error: {
              type: "parse_error",
              message:
                error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
    }
  }

  /**
   * Process raw bytes as a transport payload.
   *
   * Parses the transport prefix, then delegates to `receive()`.
   *
   * @param data - Raw transport payload bytes from the network
   * @returns Result: complete, pending, or error
   */
  receiveRaw(data: Uint8Array): ReassembleResult {
    try {
      const payload = parseTransportPayload(data)
      return this.receive(payload)
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