// adapter-manager — manages adapter lifecycle and routes outbound messages.
//
// Ported from @loro-extended/repo's AdapterManager with Loro-specific
// types replaced by substrate-agnostic equivalents. The @logtape/logtape
// dependency is removed.

import type { AddressedEnvelope } from "../messages.js"
import type { AdapterContext, AnyAdapter } from "./adapter.js"

type AdapterManagerParams = {
  adapters?: AnyAdapter[]
  context: AdapterContext
  onReset: (adapter: AnyAdapter) => void
}

/**
 * Manages adapter lifecycle (initialize, start, stop) and routes
 * outbound AddressedEnvelopes to their addressees via adapters.
 *
 * Supports dynamic add/remove of adapters at runtime.
 */
export class AdapterManager {
  readonly #adapters = new Map<string, AnyAdapter>()
  readonly #context: AdapterContext
  readonly #onReset: (adapter: AnyAdapter) => void

  constructor({ adapters = [], context, onReset }: AdapterManagerParams) {
    this.#context = context
    this.#onReset = onReset

    // Initialize provided adapters synchronously
    for (const adapter of adapters) {
      this.#initializeAdapter(adapter)
    }

    // Note: Adapters are NOT started here. Call startAll() after construction
    // to start all adapters. This allows the Synchronizer to finish initialization
    // before adapters start triggering callbacks.
  }

  /**
   * Start all adapters that were provided in the constructor.
   * Should be called after the Synchronizer is fully initialized.
   */
  startAll(): void {
    for (const adapter of this.#adapters.values()) {
      void adapter._start()
    }
  }

  #initializeAdapter(adapter: AnyAdapter): void {
    adapter._initialize(this.#context)
    this.#adapters.set(adapter.adapterId, adapter)
  }

  /**
   * Get all adapters as an array.
   */
  get adapters(): AnyAdapter[] {
    return Array.from(this.#adapters.values())
  }

  /**
   * Check if an adapter exists by ID.
   */
  hasAdapter(adapterId: string): boolean {
    return this.#adapters.has(adapterId)
  }

  /**
   * Get an adapter by ID.
   */
  getAdapter(adapterId: string): AnyAdapter | undefined {
    return this.#adapters.get(adapterId)
  }

  /**
   * Add an adapter at runtime.
   * Idempotent: adding an adapter with the same adapterId is a no-op.
   */
  async addAdapter(adapter: AnyAdapter): Promise<void> {
    if (this.#adapters.has(adapter.adapterId)) {
      return
    }

    this.#initializeAdapter(adapter)
    await adapter._start()
  }

  /**
   * Remove an adapter at runtime.
   * Idempotent: removing a non-existent adapter is a no-op.
   */
  async removeAdapter(adapterId: string): Promise<void> {
    const adapter = this.#adapters.get(adapterId)
    if (!adapter) return

    // Clean up channels via callback
    this.#onReset(adapter)

    // Stop the adapter
    await adapter._stop()

    // Remove from our map
    this.#adapters.delete(adapterId)
  }

  /**
   * Send an envelope to addressed channels across all adapters.
   *
   * @returns the total number of channels to which the message was sent
   */
  send(envelope: AddressedEnvelope): number {
    let sentCount = 0

    for (const adapter of this.#adapters.values()) {
      sentCount += adapter._send(envelope)
    }

    return sentCount
  }

  /**
   * Await all pending async operations across all adapters.
   * Does NOT disconnect adapters.
   */
  async flush(): Promise<void> {
    await Promise.all(
      Array.from(this.#adapters.values()).map((adapter) => adapter.flush()),
    )
  }

  /**
   * Reset all adapters and clear the manager.
   */
  reset(): void {
    for (const adapter of this.#adapters.values()) {
      void adapter._stop()
      this.#onReset(adapter)
    }

    this.#adapters.clear()
  }

  /**
   * Gracefully shut down: flush pending operations, then stop and remove all adapters.
   */
  async shutdown(): Promise<void> {
    await this.flush()

    for (const adapter of this.#adapters.values()) {
      await adapter._stop()
      this.#onReset(adapter)
    }

    this.#adapters.clear()
  }
}