// fragment-collector — generic stateful fragment collection with FC/IS design.
//
// FragmentCollector<T> collects fragment frames and reassembles them
// into complete payloads. It is parameterized on the chunk type T:
// - Binary pipeline: FragmentCollector<Uint8Array>
// - Text pipeline:   FragmentCollector<string>
//
// Design: Functional Core / Imperative Shell
// - decideFragment() is a pure decision function — zero side effects,
//   independently testable, takes batch state + fragment metadata,
//   returns a decision describing what to do.
// - FragmentCollector is the imperative shell — executes decisions
//   by mutating state, managing timers, and enforcing limits.

// ---------------------------------------------------------------------------
// Timer API — dependency injection for deterministic testing
// ---------------------------------------------------------------------------

/**
 * Timer API for dependency injection (enables deterministic testing).
 */
export interface TimerAPI {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

const DEFAULT_TIMER_API: TimerAPI = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: id =>
    globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Operations specific to the chunk type T.
 * Injected by the caller to avoid coupling the collector to any
 * particular payload type.
 */
export interface CollectorOps<T> {
  /** Return the size of a chunk (bytes for Uint8Array, characters for string). */
  sizeOf: (chunk: T) => number
  /** Concatenate chunks in order into a single payload. */
  concatenate: (chunks: T[]) => T
}

/**
 * Configuration for the fragment collector.
 */
export interface CollectorConfig {
  /** Timeout in milliseconds before abandoning a frame (default: 10000). */
  timeoutMs: number
  /** Maximum number of concurrent in-flight frames (default: 32). */
  maxConcurrentFrames: number
  /** Maximum total size across all in-flight frames (default: 50MB for binary, 50M chars for text). */
  maxTotalSize: number
  /** Callback when a frame times out. */
  onTimeout?: (frameId: string) => void
  /** Callback when a frame is evicted due to pressure. */
  onEvicted?: (frameId: string) => void
}

const DEFAULT_CONFIG: CollectorConfig = {
  timeoutMs: 10_000,
  maxConcurrentFrames: 32,
  maxTotalSize: 50 * 1024 * 1024, // 50 MB
}

// ---------------------------------------------------------------------------
// Result and error types
// ---------------------------------------------------------------------------

/**
 * Result of adding a fragment to the collector.
 *
 * - `"complete"`: all fragments received — `data` is the reassembled payload.
 * - `"pending"`: waiting for more fragments.
 * - `"error"`: something went wrong.
 */
export type CollectorResult<T> =
  | { status: "complete"; data: T }
  | { status: "pending" }
  | { status: "error"; error: CollectorError }

/**
 * Errors that can occur during fragment collection.
 */
export type CollectorError =
  | { type: "duplicate_fragment"; frameId: string; index: number }
  | { type: "invalid_index"; frameId: string; index: number; max: number }
  | { type: "total_mismatch"; frameId: string; expected: number; got: number }
  | { type: "size_mismatch"; frameId: string; expected: number; actual: number }
  | { type: "timeout"; frameId: string }
  | { type: "evicted"; frameId: string }
  | { type: "disposed" }

// ---------------------------------------------------------------------------
// Internal batch state
// ---------------------------------------------------------------------------

/**
 * Internal state for an in-flight frame being reassembled.
 */
interface BatchState<T> {
  readonly frameId: string
  readonly expectedTotal: number
  readonly expectedTotalSize: number
  readonly receivedChunks: Map<number, T>
  receivedSize: number
  readonly startedAt: number
  timerId: unknown
}

// ---------------------------------------------------------------------------
// Pure decision function (functional core)
// ---------------------------------------------------------------------------

/**
 * Decision returned by the pure `decideFragment` function.
 *
 * The imperative shell interprets these decisions and executes
 * the corresponding side effects.
 */
export type FragmentDecision =
  | { action: "create_and_accept" }
  | { action: "accept" }
  | { action: "complete" }
  | { action: "reject_duplicate" }
  | { action: "reject_invalid_index" }
  | { action: "reject_total_mismatch" }
  | { action: "reject_size_mismatch" }

/**
 * Pure decision function — determines what to do with an incoming fragment.
 *
 * Takes the current batch state (or undefined if this is the first fragment
 * for a given frameId) and the fragment's metadata. Returns a decision
 * with zero side effects.
 *
 * @param batch - Current batch state, or undefined if no batch exists for this frameId
 * @param index - Fragment index (0-based)
 * @param total - Total number of fragments expected
 * @param totalSize - Total size of the reassembled payload
 */
export function decideFragment<T>(
  batch: BatchState<T> | undefined,
  index: number,
  total: number,
  totalSize: number,
): FragmentDecision {
  // First fragment for this frameId — create batch
  if (batch === undefined) {
    if (index < 0 || index >= total) {
      return { action: "reject_invalid_index" }
    }
    // Single fragment that completes immediately
    if (total === 1) {
      return { action: "complete" }
    }
    return { action: "create_and_accept" }
  }

  // Validate total consistency
  if (total !== batch.expectedTotal) {
    return { action: "reject_total_mismatch" }
  }

  // Validate totalSize consistency
  if (totalSize !== batch.expectedTotalSize) {
    return { action: "reject_size_mismatch" }
  }

  // Validate index range
  if (index < 0 || index >= batch.expectedTotal) {
    return { action: "reject_invalid_index" }
  }

  // Check for duplicate
  if (batch.receivedChunks.has(index)) {
    return { action: "reject_duplicate" }
  }

  // Will this fragment complete the batch?
  if (batch.receivedChunks.size + 1 === batch.expectedTotal) {
    return { action: "complete" }
  }

  return { action: "accept" }
}

// ---------------------------------------------------------------------------
// FragmentCollector<T> — imperative shell
// ---------------------------------------------------------------------------

/**
 * Generic stateful fragment collector.
 *
 * Collects fragment frames by frameId and reassembles them into
 * complete payloads. Manages timeouts, memory limits, and eviction.
 *
 * The collector is parameterized on T (the chunk type) and injected
 * with `CollectorOps<T>` for type-specific operations:
 * - Binary: `T = Uint8Array`, `sizeOf = chunk => chunk.length`, `concatenate = Uint8Array join`
 * - Text: `T = string`, `sizeOf = chunk => chunk.length`, `concatenate = chunks.join("")`
 *
 * Usage:
 * ```typescript
 * const collector = new FragmentCollector<string>(
 *   { timeoutMs: 5000 },
 *   { sizeOf: s => s.length, concatenate: chunks => chunks.join("") },
 * )
 *
 * const result = collector.addFragment("frame-1", 0, 3, 100, "hello")
 * // result.status === "pending"
 *
 * const result2 = collector.addFragment("frame-1", 2, 3, 100, "world")
 * // result2.status === "pending"
 *
 * const result3 = collector.addFragment("frame-1", 1, 3, 100, " ")
 * // result3.status === "complete", result3.data === "hello world"
 *
 * collector.dispose()
 * ```
 */
export class FragmentCollector<T> {
  readonly #config: CollectorConfig
  readonly #ops: CollectorOps<T>
  readonly #timer: TimerAPI
  readonly #batches = new Map<string, BatchState<T>>()
  #totalSize = 0
  #disposed = false

  constructor(
    config?: Partial<CollectorConfig>,
    ops?: CollectorOps<T>,
    timer?: TimerAPI,
  ) {
    this.#config = { ...DEFAULT_CONFIG, ...config }
    if (!ops) {
      throw new Error("CollectorOps<T> must be provided")
    }
    this.#ops = ops
    this.#timer = timer ?? DEFAULT_TIMER_API
  }

  // ==========================================================================
  // PUBLIC API
  // ==========================================================================

  /**
   * Add a fragment to the collector.
   *
   * Auto-creates batch state on first fragment for a given frameId.
   * Validates total/totalSize consistency across fragments.
   * Returns the reassembled payload when all fragments arrive.
   *
   * @param frameId - Identifier grouping fragments of the same payload
   * @param index - Zero-based index of this fragment
   * @param total - Total number of fragments expected
   * @param totalSize - Total size of the reassembled payload
   * @param chunk - This fragment's data chunk
   */
  addFragment(
    frameId: string,
    index: number,
    total: number,
    totalSize: number,
    chunk: T,
  ): CollectorResult<T> {
    if (this.#disposed) {
      return { status: "error", error: { type: "disposed" } }
    }

    const batch = this.#batches.get(frameId)
    const decision = decideFragment(batch, index, total, totalSize)

    return this.#executeDecision(
      decision,
      frameId,
      index,
      total,
      totalSize,
      chunk,
      batch,
    )
  }

  /**
   * Clean up all resources.
   *
   * Cancels all pending timeout timers and clears state.
   * After disposal, all subsequent calls return a "disposed" error.
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
    this.#totalSize = 0
  }

  /** Number of in-flight frames currently being tracked. */
  get pendingFrameCount(): number {
    return this.#batches.size
  }

  /** Total size currently being tracked across all in-flight frames. */
  get pendingSize(): number {
    return this.#totalSize
  }

  // ==========================================================================
  // PRIVATE — decision execution (imperative shell)
  // ==========================================================================

  #executeDecision(
    decision: FragmentDecision,
    frameId: string,
    index: number,
    total: number,
    totalSize: number,
    chunk: T,
    batch: BatchState<T> | undefined,
  ): CollectorResult<T> {
    switch (decision.action) {
      case "reject_duplicate":
        return {
          status: "error",
          error: { type: "duplicate_fragment", frameId, index },
        }

      case "reject_invalid_index":
        return {
          status: "error",
          error: { type: "invalid_index", frameId, index, max: total - 1 },
        }

      case "reject_total_mismatch": {
        if (batch === undefined) {
          throw new Error(
            `FragmentCollector bug: reject_total_mismatch for frameId=${frameId} but batch is undefined`,
          )
        }
        return {
          status: "error",
          error: {
            type: "total_mismatch",
            frameId,
            expected: batch.expectedTotal,
            got: total,
          },
        }
      }

      case "reject_size_mismatch": {
        if (batch === undefined) {
          throw new Error(
            `FragmentCollector bug: reject_size_mismatch for frameId=${frameId} but batch is undefined`,
          )
        }
        return {
          status: "error",
          error: {
            type: "size_mismatch",
            frameId,
            expected: batch.expectedTotalSize,
            actual: totalSize,
          },
        }
      }

      case "create_and_accept": {
        // Enforce max concurrent frames — evict oldest if at capacity
        if (this.#batches.size >= this.#config.maxConcurrentFrames) {
          this.#evictOldest()
        }

        const newBatch = this.#createBatch(frameId, total, totalSize)
        this.#addChunkToBatch(newBatch, index, chunk)
        return { status: "pending" }
      }

      case "accept": {
        if (batch === undefined) {
          throw new Error(
            `FragmentCollector bug: accept for frameId=${frameId} but batch is undefined`,
          )
        }
        this.#addChunkToBatch(batch, index, chunk)

        // Enforce memory limit — evict oldest until under the cap
        while (this.#totalSize > this.#config.maxTotalSize) {
          const evicted = this.#evictOldest()
          if (!evicted) break

          // If we evicted the current batch, return error
          if (!this.#batches.has(frameId)) {
            return {
              status: "error",
              error: { type: "evicted", frameId },
            }
          }
        }

        return { status: "pending" }
      }

      case "complete": {
        if (batch === undefined) {
          // Single-fragment complete (total === 1)
          return { status: "complete", data: chunk }
        }

        // Add the final chunk, then reassemble
        this.#addChunkToBatch(batch, index, chunk)
        return this.#completeBatch(frameId, batch)
      }
    }
  }

  // ==========================================================================
  // PRIVATE — batch lifecycle
  // ==========================================================================

  #createBatch(
    frameId: string,
    expectedTotal: number,
    expectedTotalSize: number,
  ): BatchState<T> {
    const batch: BatchState<T> = {
      frameId,
      expectedTotal,
      expectedTotalSize,
      receivedChunks: new Map(),
      receivedSize: 0,
      startedAt: Date.now(),
      timerId: undefined,
    }

    // Set up timeout timer
    batch.timerId = this.#timer.setTimeout(() => {
      this.#handleTimeout(frameId)
    }, this.#config.timeoutMs)

    this.#batches.set(frameId, batch)
    return batch
  }

  #addChunkToBatch(batch: BatchState<T>, index: number, chunk: T): void {
    const chunkSize = this.#ops.sizeOf(chunk)
    batch.receivedChunks.set(index, chunk)
    batch.receivedSize += chunkSize
    this.#totalSize += chunkSize
  }

  #completeBatch(frameId: string, batch: BatchState<T>): CollectorResult<T> {
    // Cancel timeout timer
    if (batch.timerId !== undefined) {
      this.#timer.clearTimeout(batch.timerId)
    }

    // Remove from tracking
    this.#batches.delete(frameId)
    this.#totalSize -= batch.receivedSize

    // Validate total size
    if (
      batch.expectedTotalSize > 0 &&
      batch.receivedSize !== batch.expectedTotalSize
    ) {
      return {
        status: "error",
        error: {
          type: "size_mismatch",
          frameId,
          expected: batch.expectedTotalSize,
          actual: batch.receivedSize,
        },
      }
    }

    // Concatenate chunks in index order
    const ordered: T[] = []
    for (let i = 0; i < batch.expectedTotal; i++) {
      const chunk = batch.receivedChunks.get(i)
      if (chunk === undefined) {
        throw new Error(
          `FragmentCollector bug: missing chunk at index ${i} for frameId=${frameId} (expected ${batch.expectedTotal} chunks, received ${batch.receivedChunks.size})`,
        )
      }
      ordered.push(chunk)
    }

    const data = this.#ops.concatenate(ordered)
    return { status: "complete", data }
  }

  // ==========================================================================
  // PRIVATE — timeout handling
  // ==========================================================================

  #handleTimeout(frameId: string): void {
    const batch = this.#batches.get(frameId)
    if (!batch) return

    // Clean up
    this.#batches.delete(frameId)
    this.#totalSize -= batch.receivedSize

    // Notify
    this.#config.onTimeout?.(frameId)
  }

  // ==========================================================================
  // PRIVATE — eviction
  // ==========================================================================

  /**
   * Evict the oldest batch (by startedAt) to free capacity.
   * @returns true if a batch was evicted
   */
  #evictOldest(): boolean {
    let oldest: { frameId: string; batch: BatchState<T> } | undefined

    for (const [frameId, batch] of this.#batches) {
      if (!oldest || batch.startedAt < oldest.batch.startedAt) {
        oldest = { frameId, batch }
      }
    }

    if (!oldest) return false

    // Cancel timeout timer
    if (oldest.batch.timerId !== undefined) {
      this.#timer.clearTimeout(oldest.batch.timerId)
    }

    // Remove batch
    this.#batches.delete(oldest.frameId)
    this.#totalSize -= oldest.batch.receivedSize

    // Notify
    this.#config.onEvicted?.(oldest.frameId)

    return true
  }
}
