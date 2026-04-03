// adapter-manager — manages transport lifecycle and routes outbound messages.
//
// Ported from @loro-extended/repo's TransportManager with Loro-specific
// types replaced by substrate-agnostic equivalents. The @logtape/logtape
// dependency is removed.

import type { AddressedEnvelope } from "../messages.js"
import type { AnyTransport, TransportContext } from "./transport.js"

type TransportManagerParams = {
  transports?: AnyTransport[]
  context: TransportContext
  onReset: (transport: AnyTransport) => void
}

/**
 * Manages transport lifecycle (initialize, start, stop) and routes
 * outbound AddressedEnvelopes to their addressees via transports.
 *
 * Supports dynamic add/remove of transports at runtime.
 */
export class TransportManager {
  readonly #transports = new Map<string, AnyTransport>()
  readonly #context: TransportContext
  readonly #onReset: (transport: AnyTransport) => void

  constructor({ transports = [], context, onReset }: TransportManagerParams) {
    this.#context = context
    this.#onReset = onReset

    // Initialize provided adapters synchronously
    for (const transport of transports) {
      this.#initializeTransport(transport)
    }

    // Note: Adapters are NOT started here. Call startAll() after construction
    // to start all transports. This allows the Synchronizer to finish initialization
    // before adapters start triggering callbacks.
  }

  /**
   * Start all transports that were provided in the constructor.
   * Should be called after the Synchronizer is fully initialized.
   */
  startAll(): void {
    for (const transport of this.#transports.values()) {
      void transport._start()
    }
  }

  #initializeTransport(transport: AnyTransport): void {
    transport._initialize(this.#context)
    this.#transports.set(transport.transportId, transport)
  }

  /**
   * Get all transports as an array.
   */
  get transports(): AnyTransport[] {
    return Array.from(this.#transports.values())
  }

  /**
   * Check if a transport exists by ID.
   */
  hasTransport(transportId: string): boolean {
    return this.#transports.has(transportId)
  }

  /**
   * Get a transport by ID.
   */
  getTransport(transportId: string): AnyTransport | undefined {
    return this.#transports.get(transportId)
  }

  /**
   * Add a transport at runtime.
   * Idempotent: adding a transport with the same transportId is a no-op.
   */
  async addTransport(transport: AnyTransport): Promise<void> {
    if (this.#transports.has(transport.transportId)) {
      return
    }

    this.#initializeTransport(transport)
    await transport._start()
  }

  /**
   * Remove a transport at runtime.
   * Idempotent: removing a non-existent transport is a no-op.
   */
  async removeTransport(transportId: string): Promise<void> {
    const transport = this.#transports.get(transportId)
    if (!transport) return

    // Clean up channels via callback
    this.#onReset(transport)

    // Stop the transport
    await transport._stop()

    // Remove from our map
    this.#transports.delete(transportId)
  }

  /**
   * Send an envelope to addressed channels across all transports.
   *
   * @returns the total number of channels to which the message was sent
   */
  send(envelope: AddressedEnvelope): number {
    let sentCount = 0

    for (const transport of this.#transports.values()) {
      sentCount += transport._send(envelope)
    }

    return sentCount
  }

  /**
   * Await all pending async operations across all transports.
   * Does NOT disconnect transports.
   */
  async flush(): Promise<void> {
    await Promise.all(
      Array.from(this.#transports.values()).map(transport => transport.flush()),
    )
  }

  /**
   * Reset all transports and clear the manager.
   */
  reset(): void {
    for (const transport of this.#transports.values()) {
      void transport._stop()
      this.#onReset(transport)
    }

    this.#transports.clear()
  }

  /**
   * Gracefully shut down: flush pending operations, then stop and remove all transports.
   */
  async shutdown(): Promise<void> {
    await this.flush()

    for (const transport of this.#transports.values()) {
      await transport._stop()
      this.#onReset(transport)
    }

    this.#transports.clear()
  }
}
