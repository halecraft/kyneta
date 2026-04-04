// mock-data-channel — test helper implementing DataChannelLike.
//
// Provides a minimal, spy-friendly implementation for testing the
// WebRTC transport without a real RTCDataChannel or browser environment.

import { vi } from "vitest"
import type { DataChannelLike } from "../data-channel-like.js"

/**
 * A mock DataChannelLike for testing.
 *
 * Features:
 * - Configurable initial `readyState`
 * - `send` is a vitest spy
 * - `emit(type, event?)` simulates incoming events
 * - Tracks all addEventListener/removeEventListener calls
 */
export class MockDataChannel implements DataChannelLike {
  readyState: string
  binaryType = "blob"
  send = vi.fn<(data: Uint8Array) => void>()

  readonly #listeners = new Map<string, Set<(event: any) => void>>()

  constructor(initialReadyState: string = "connecting") {
    this.readyState = initialReadyState
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.#listeners.get(type)
    if (!set) {
      set = new Set()
      this.#listeners.set(type, set)
    }
    set.add(listener)
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    const set = this.#listeners.get(type)
    if (set) {
      set.delete(listener)
      if (set.size === 0) this.#listeners.delete(type)
    }
  }

  /**
   * Simulate an event firing on the data channel.
   *
   * For "message" events, pass `{ data: ... }` as the event.
   * For "open"/"close"/"error", no event payload is needed.
   */
  emit(type: string, event?: any): void {
    const set = this.#listeners.get(type)
    if (!set) return
    for (const listener of set) {
      listener(event ?? {})
    }
  }

  /**
   * Simulate the data channel opening.
   * Sets readyState to "open" and fires the "open" event.
   */
  open(): void {
    this.readyState = "open"
    this.emit("open")
  }

  /**
   * Simulate the data channel closing.
   * Sets readyState to "closed" and fires the "close" event.
   */
  close(): void {
    this.readyState = "closed"
    this.emit("close")
  }

  /**
   * Get the number of listeners registered for a given event type.
   */
  listenerCount(type: string): number {
    return this.#listeners.get(type)?.size ?? 0
  }

  /**
   * Check if any listeners are registered at all.
   */
  hasListeners(): boolean {
    for (const set of this.#listeners.values()) {
      if (set.size > 0) return true
    }
    return false
  }
}
