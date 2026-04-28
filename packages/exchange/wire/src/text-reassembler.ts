// text-reassembler — text fragment reassembler for @kyneta/wire.
//
// Thin wrapper around FragmentCollector<string> that handles text
// frame parsing. The collector does all the heavy lifting (timeouts,
// eviction, validation); this module just parses the text wire format
// and delegates.

import {
  type CollectorConfig,
  type CollectorError,
  FragmentCollector,
  type TimerAPI,
} from "./fragment-collector.js"
import type { Frame } from "./frame-types.js"
import { complete } from "./frame-types.js"
import { decodeTextFrame, TEXT_WIRE_VERSION } from "./text-frame.js"

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of processing a text wire frame through the reassembler.
 *
 * - `"complete"`: a full frame is ready (either passed through directly
 *   or reassembled from fragments)
 * - `"pending"`: waiting for more fragments
 * - `"error"`: something went wrong
 */
export type TextReassembleResult =
  | { status: "complete"; frame: Frame<string> }
  | { status: "pending" }
  | { status: "error"; error: TextReassembleError }

/**
 * Errors that can occur during text reassembly.
 * Wraps CollectorError with an additional parse_error variant.
 */
export type TextReassembleError =
  | CollectorError
  | { type: "parse_error"; message: string }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the text reassembler.
 * Maps to CollectorConfig with text-friendly naming.
 */
export interface TextReassemblerConfig {
  /** Timeout in milliseconds before abandoning a frame (default: 10000). */
  timeoutMs?: number
  /** Maximum number of concurrent in-flight frames (default: 32). */
  maxConcurrentFrames?: number
  /** Maximum total characters across all in-flight frames (default: 50M). */
  maxTotalChars?: number
  /** Callback when a frame times out. */
  onTimeout?: (frameId: number) => void
  /** Callback when a frame is evicted due to pressure. */
  onEvicted?: (frameId: number) => void
}

// ---------------------------------------------------------------------------
// String operations for the collector
// ---------------------------------------------------------------------------

const TEXT_OPS = {
  sizeOf: (chunk: string) => chunk.length,
  concatenate: (chunks: string[]) => chunks.join(""),
} as const

// ---------------------------------------------------------------------------
// TextReassembler
// ---------------------------------------------------------------------------

/**
 * Text fragment reassembler.
 *
 * Thin wrapper around `FragmentCollector<string>`. Parses text wire
 * frames (JSON arrays with 2-char prefix) and delegates fragment
 * collection to the generic collector.
 *
 * Complete frames are passed through immediately. Fragment frames
 * are collected by frameId; when all fragments arrive, the chunks
 * are concatenated into the original payload string and wrapped
 * in a `Complete<string>` frame.
 *
 * Usage:
 * ```typescript
 * const reassembler = new TextReassembler({ timeoutMs: 5000 })
 *
 * const result = reassembler.receive('["1f",42,0,3,100,"{\\"type\\":\\"off"]')
 * // result.status === "pending"
 *
 * // ... more fragments ...
 *
 * const final = reassembler.receive('["1f",42,2,3,100,"...\\"}"]')
 * // final.status === "complete"
 * // final.frame.content.kind === "complete"
 * // final.frame.content.payload === original JSON string
 *
 * reassembler.dispose()
 * ```
 */
export class TextReassembler {
  readonly #collector: FragmentCollector<string>

  constructor(config?: TextReassemblerConfig, timer?: TimerAPI) {
    const collectorConfig: Partial<CollectorConfig> = {
      timeoutMs: config?.timeoutMs,
      maxConcurrentFrames: config?.maxConcurrentFrames,
      maxTotalSize: config?.maxTotalChars,
      onTimeout: config?.onTimeout,
      onEvicted: config?.onEvicted,
    }
    this.#collector = new FragmentCollector(collectorConfig, TEXT_OPS, timer)
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Process a text wire frame string.
   *
   * Parses the JSON array, reads the 2-char prefix to determine
   * if it's a complete frame or a fragment, and either returns
   * immediately or delegates to the collector.
   *
   * @param wire - A text wire frame string (JSON array)
   * @returns Result: complete (with Frame<string>), pending, or error
   */
  receive(wire: string): TextReassembleResult {
    try {
      const frame = decodeTextFrame(wire)

      if (frame.content.kind === "complete") {
        // Complete frame — pass through immediately
        return { status: "complete", frame }
      }

      // Fragment — delegate to collector
      const { frameId, index, total, totalSize, payload } = frame.content
      const result = this.#collector.addFragment(
        frameId,
        index,
        total,
        totalSize,
        payload,
      )

      if (result.status === "complete") {
        // All fragments collected — wrap in a complete frame
        return {
          status: "complete",
          frame: complete(TEXT_WIRE_VERSION, result.data, frame.hash),
        }
      }

      if (result.status === "pending") {
        return { status: "pending" }
      }

      // Error from collector
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
   * Clean up all resources.
   *
   * Cancels all pending timeout timers and clears state.
   * After disposal, all subsequent collector calls return errors.
   */
  dispose(): void {
    this.#collector.dispose()
  }

  /** Number of in-flight frames currently being tracked. */
  get pendingFrameCount(): number {
    return this.#collector.pendingFrameCount
  }

  /** Total characters currently being tracked across all in-flight frames. */
  get pendingSize(): number {
    return this.#collector.pendingSize
  }
}
