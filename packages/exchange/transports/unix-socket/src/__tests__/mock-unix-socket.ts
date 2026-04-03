// mock-unix-socket — test helper implementing UnixSocket.
//
// Provides a minimal, spy-friendly implementation for testing the
// unix socket transport without real sockets or a running server.
//
// Mirrors the MockDataChannel pattern from @kyneta/webrtc-transport.

import { vi } from "vitest"
import type { UnixSocket } from "../types.js"

/**
 * A mock UnixSocket for testing.
 *
 * Features:
 * - `write` is a vitest spy, returns configurable value (default: true)
 * - `end` is a vitest spy
 * - `emit(event, ...args)` simulates incoming events
 * - `setBackpressure(true)` makes `write` return false
 * - Tracks all registered handlers
 */
export class MockUnixSocket implements UnixSocket {
  /** Whether write() should return false (simulating kernel buffer full). */
  #backpressure = false

  write = vi.fn<(data: Uint8Array) => boolean>().mockImplementation(() => {
    return !this.#backpressure
  })

  end = vi.fn<() => void>()

  #dataHandlers: Array<(data: Uint8Array) => void> = []
  #closeHandlers: Array<() => void> = []
  #errorHandlers: Array<(error: Error) => void> = []
  #drainHandlers: Array<() => void> = []

  onData(handler: (data: Uint8Array) => void): void {
    this.#dataHandlers.push(handler)
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler)
  }

  onError(handler: (error: Error) => void): void {
    this.#errorHandlers.push(handler)
  }

  onDrain(handler: () => void): void {
    this.#drainHandlers.push(handler)
  }

  // ==========================================================================
  // Test control API
  // ==========================================================================

  /**
   * Enable or disable backpressure simulation.
   *
   * When enabled, `write()` returns `false`, signaling that the
   * kernel buffer is full. Call `emitDrain()` to simulate the
   * buffer becoming available again.
   */
  setBackpressure(enabled: boolean): void {
    this.#backpressure = enabled
  }

  /**
   * Simulate incoming data on the socket.
   */
  emitData(data: Uint8Array): void {
    for (const handler of this.#dataHandlers) {
      handler(data)
    }
  }

  /**
   * Simulate the socket closing.
   */
  emitClose(): void {
    for (const handler of this.#closeHandlers) {
      handler()
    }
  }

  /**
   * Simulate a socket error.
   */
  emitError(error: Error): void {
    for (const handler of this.#errorHandlers) {
      handler(error)
    }
  }

  /**
   * Simulate a drain event (kernel buffer available again).
   */
  emitDrain(): void {
    for (const handler of this.#drainHandlers) {
      handler()
    }
  }

  /**
   * Get the number of registered handlers for a given event type.
   */
  handlerCount(event: "data" | "close" | "error" | "drain"): number {
    switch (event) {
      case "data":
        return this.#dataHandlers.length
      case "close":
        return this.#closeHandlers.length
      case "error":
        return this.#errorHandlers.length
      case "drain":
        return this.#drainHandlers.length
    }
  }

  /**
   * Check if any handlers are registered at all.
   */
  hasHandlers(): boolean {
    return (
      this.#dataHandlers.length > 0 ||
      this.#closeHandlers.length > 0 ||
      this.#errorHandlers.length > 0 ||
      this.#drainHandlers.length > 0
    )
  }
}