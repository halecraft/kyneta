// reassembler — stateful fragment reassembly with timeouts and memory limits.
//
// The FragmentReassembler is the imperative shell around the pure
// reassembly functions in fragment.ts. It manages:
// - Batch state tracking via Map<string, BatchState>
// - Per-batch timeout timers (default 10s)
// - Memory limits across all in-flight batches (default 50MB)
// - Max concurrent batches (default 32)
// - Oldest-first eviction when limits are exceeded
//
// Design: Functional Core / Imperative Shell
// - Pure data transformation in fragment.ts (reassembleFragments, parseTransportPayload)
// - Stateful concerns (timers, tracking, eviction) here
//
// Ported from @loro-extended/wire-format's reassembler.ts — domain-agnostic,
// operates purely on raw Uint8Array transport payloads.

import {
  batchIdToKey,
  type FragmentReassembleError,
  parseTransportPayload,
  reassembleFragments,
  type TransportPayload,
} from "./fragment.js"

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result of processing a transport payload through the reassembler.
 *
 * - `"complete"`: a full message is ready (either a complete message or
 *   a fully reassembled fragmented batch)
 * - `"pending"`: waiting for more fragments
 * - `"error"`: something went wrong (duplicate, invalid index, timeout, etc.)
 */
export type ReassembleResult =
  | { status: "complete"; data: Uint8Array }
  | { status: "pending" }
  | { status: "error"; error: ReassembleError }

/**
 * Errors that can occur during reassembly.
 */
export type ReassembleError =
  | { type: "duplicate_fragment"; batchId: Uint8Array; index: number }
  | { type: "invalid_index"; batchId: Uint8Array; index: number; max: number }
  | { type: "timeout"; batchId: Uint8Array }
  | { type: "size_mismatch"; expected: number; actual: number }
  | { type: "evicted"; batchId: Uint8Array }
  | { type: "parse_error"; message: string }
  | { type: "reassemble_error"; message: string }

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the fragment reassembler.
 */
export interface ReassemblerConfig {
  /** Timeout in milliseconds before abandoning a batch (default: 10000). */
  timeoutMs: number
  /** Maximum number of concurrent batches to track (default: 32). */
  maxConcurrentBatches: number
  /** Maximum total bytes across all in-flight batches (default: 50MB). */
  maxTotalReassemblyBytes: number
  /** Callback when a batch times out. */
  onTimeout?: (batchId: Uint8Array) => void
  /** Callback when a batch is evicted due to memory pressure. */
  onEvicted?: (batchId: Uint8Array) => void
}

/**
 * Timer API for dependency injection (enables deterministic testing).
 */
export interface TimerAPI {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/**
 * Internal state for an in-flight batch being reassembled.
 */
interface BatchState {
  batchId: Uint8Array
  expectedCount: number
  totalSize: number
  receivedFragments: Map<number, Uint8Array>
  receivedBytes: number
  startedAt: number
  timerId: unknown
}

/** Default configuration values. */
const DEFAULT_CONFIG: ReassemblerConfig = {
  timeoutMs: 10_000,
  maxConcurrentBatches: 32,
  maxTotalReassemblyBytes: 50 * 1024 * 1024, // 50 MB
}

/** Default timer API using global setTimeout/clearTimeout. */
const DEFAULT_TIMER_API: TimerAPI = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
}

// ---------------------------------------------------------------------------
// FragmentReassembler
// ---------------------------------------------------------------------------

/**
 * Stateful fragment reassembler.
 *
 * Tracks in-flight batches, manages timeout timers, and enforces
 * memory limits. Delegates to pure functions for parsing and
 * reassembly.
 *
 * Usage:
 * ```typescript
 * const reassembler = new FragmentReassembler({ timeoutMs: 5000 })
 *
 * // Feed raw transport payloads from the network
 * const result = reassembler.receiveRaw(data)
 *
 * if (result.status === "complete") {
 *   // result.data is the reassembled framed payload
 *   const messages = decodeFrame(codec, result.data)
 * }
 *
 * // Clean up when done
 * reassembler.dispose()
 * ```
 */
export class FragmentReassembler {
  readonly #config: ReassemblerConfig
  readonly #timer: TimerAPI
  readonly #batches = new Map<string, BatchState>()
  #totalBytes = 0
  #disposed = false

  constructor(config?: Partial<ReassemblerConfig>, timer?: TimerAPI) {
    this.#config = { ...DEFAULT_CONFIG, ...config }
    this.#timer = timer ?? DEFAULT_TIMER_API
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
    if (this.#disposed) {
      return {
        status: "error",
        error: {
          type: "parse_error",
          message: "Reassembler has been disposed",
        },
      }
    }

    switch (payload.kind) {
      case "message":
        // Complete message — pass through immediately
        return { status: "complete", data: payload.data }

      case "fragment-header":
        return this.#handleFragmentHeader(payload)

      case "fragment-data":
        return this.#handleFragmentData(payload)
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
   * After disposal, all subsequent calls return an error.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true

    for (const batch of this.#batches.values()) {
      if (batch.timerId !== undefined) {
        this.#timer.clearTimeout(batch.timerId)
      }
    }
    this.#batches.clear()
    this.#totalBytes = 0
  }

  /** Number of in-flight batches currently being tracked. */
  get pendingBatchCount(): number {
    return this.#batches.size
  }

  /** Total bytes currently being tracked across all in-flight batches. */
  get pendingBytes(): number {
    return this.#totalBytes
  }

  // ==========================================================================
  // INTERNAL — fragment header handling
  // ==========================================================================

  #handleFragmentHeader(
    header: TransportPayload & { kind: "fragment-header" },
  ): ReassembleResult {
    const key = batchIdToKey(header.batchId)

    // Ignore duplicate headers — the batch is already in progress
    if (this.#batches.has(key)) {
      return { status: "pending" }
    }

    // Enforce max concurrent batches — evict oldest if at capacity
    if (this.#batches.size >= this.#config.maxConcurrentBatches) {
      this.#evictOldestBatch()
    }

    // Create new batch state
    const batch: BatchState = {
      batchId: header.batchId,
      expectedCount: header.count,
      totalSize: header.totalSize,
      receivedFragments: new Map(),
      receivedBytes: 0,
      startedAt: Date.now(),
      timerId: undefined,
    }

    // Set up timeout timer
    batch.timerId = this.#timer.setTimeout(() => {
      this.#handleTimeout(key)
    }, this.#config.timeoutMs)

    this.#batches.set(key, batch)
    return { status: "pending" }
  }

  // ==========================================================================
  // INTERNAL — fragment data handling
  // ==========================================================================

  #handleFragmentData(
    fragment: TransportPayload & { kind: "fragment-data" },
  ): ReassembleResult {
    const key = batchIdToKey(fragment.batchId)
    const batch = this.#batches.get(key)

    if (!batch) {
      // Fragment arrived before or without its header — ignore silently.
      // This can happen during reconnection or if the header was lost.
      return { status: "pending" }
    }

    // Validate index range
    if (fragment.index < 0 || fragment.index >= batch.expectedCount) {
      return {
        status: "error",
        error: {
          type: "invalid_index",
          batchId: fragment.batchId,
          index: fragment.index,
          max: batch.expectedCount - 1,
        },
      }
    }

    // Check for duplicate fragment
    if (batch.receivedFragments.has(fragment.index)) {
      return {
        status: "error",
        error: {
          type: "duplicate_fragment",
          batchId: fragment.batchId,
          index: fragment.index,
        },
      }
    }

    // Add fragment to batch
    batch.receivedFragments.set(fragment.index, fragment.data)
    batch.receivedBytes += fragment.data.length
    this.#totalBytes += fragment.data.length

    // Enforce memory limit — evict oldest batches until under the cap
    while (this.#totalBytes > this.#config.maxTotalReassemblyBytes) {
      const evicted = this.#evictOldestBatch()
      if (!evicted) break // No more batches to evict

      // If we evicted the current batch, return error
      if (!this.#batches.has(key)) {
        return {
          status: "error",
          error: { type: "evicted", batchId: fragment.batchId },
        }
      }
    }

    // Check if batch is complete
    if (batch.receivedFragments.size === batch.expectedCount) {
      return this.#completeBatch(key, batch)
    }

    return { status: "pending" }
  }

  // ==========================================================================
  // INTERNAL — batch completion
  // ==========================================================================

  #completeBatch(key: string, batch: BatchState): ReassembleResult {
    // Cancel timeout timer
    if (batch.timerId !== undefined) {
      this.#timer.clearTimeout(batch.timerId)
    }

    // Remove from tracking
    this.#batches.delete(key)
    this.#totalBytes -= batch.receivedBytes

    // Reassemble using pure function
    try {
      const header: TransportPayload & { kind: "fragment-header" } = {
        kind: "fragment-header",
        batchId: batch.batchId,
        count: batch.expectedCount,
        totalSize: batch.totalSize,
      }
      const data = reassembleFragments(header, batch.receivedFragments)
      return { status: "complete", data }
    } catch (error) {
      const reassembleError = error as FragmentReassembleError
      if (reassembleError.code === "size_mismatch") {
        return {
          status: "error",
          error: {
            type: "size_mismatch",
            expected: batch.totalSize,
            actual: batch.receivedBytes,
          },
        }
      }
      return {
        status: "error",
        error: {
          type: "reassemble_error",
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  // ==========================================================================
  // INTERNAL — timeout handling
  // ==========================================================================

  #handleTimeout(key: string): void {
    const batch = this.#batches.get(key)
    if (!batch) return

    // Clean up batch state
    this.#batches.delete(key)
    this.#totalBytes -= batch.receivedBytes

    // Notify via callback
    this.#config.onTimeout?.(batch.batchId)
  }

  // ==========================================================================
  // INTERNAL — eviction
  // ==========================================================================

  /**
   * Evict the oldest batch (by startedAt) to free memory.
   * @returns true if a batch was evicted
   */
  #evictOldestBatch(): boolean {
    let oldest: { key: string; batch: BatchState } | undefined

    for (const [key, batch] of this.#batches) {
      if (!oldest || batch.startedAt < oldest.batch.startedAt) {
        oldest = { key, batch }
      }
    }

    if (!oldest) return false

    // Cancel timeout timer
    if (oldest.batch.timerId !== undefined) {
      this.#timer.clearTimeout(oldest.batch.timerId)
    }

    // Remove batch
    this.#batches.delete(oldest.key)
    this.#totalBytes -= oldest.batch.receivedBytes

    // Notify via callback
    this.#config.onEvicted?.(oldest.batch.batchId)

    return true
  }
}