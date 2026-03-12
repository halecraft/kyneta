/**
 * Local reactive state primitive.
 *
 * `LocalRef<T>` is a simple reactive value that participates in the
 * `CHANGEFEED` protocol from `@kyneta/schema`. It replaces the old
 * `LocalRef` from `@loro-extended/reactive` which used the two-symbol
 * `REACTIVE`+`SNAPSHOT` design.
 *
 * Use `state(initial)` to create a `LocalRef<T>`. The ref:
 * - Exposes `.get()` / `.set(value)` for reading and writing
 * - Implements `[CHANGEFEED]` for the reactive protocol
 * - Emits `ReplaceChange<T>` on every `.set()` call
 *
 * @example
 * ```typescript
 * import { state } from "@kyneta/core"
 * import { CHANGEFEED } from "@kyneta/schema"
 *
 * const count = state(0)
 * count.get()  // 0
 *
 * count[CHANGEFEED].subscribe((change) => {
 *   console.log("new value:", change.value)
 * })
 *
 * count.set(1)  // subscriber fires with { type: "replace", value: 1 }
 * count.get()   // 1
 * ```
 *
 * @packageDocumentation
 */

import {
  CHANGEFEED,
  getOrCreateChangefeed,
  type Changefeed,
  type ReplaceChange,
  replaceChange,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// LocalRef
// ---------------------------------------------------------------------------

/**
 * A local reactive value. Implements the `CHANGEFEED` protocol so it
 * can be subscribed to by the Kinetic runtime (and any other consumer
 * that understands `[CHANGEFEED]`).
 *
 * Emits `ReplaceChange<T>` — the simplest change type — on every
 * `.set()` call. The change carries the new value.
 */
export class LocalRef<T> {
  /** Current value — mutated in place by `.set()`. */
  #value: T

  /** Set of active subscriber callbacks. */
  #subscribers = new Set<(change: ReplaceChange<T>) => void>()

  constructor(initial: T) {
    this.#value = initial
  }

  /**
   * Read the current value.
   */
  get(): T {
    return this.#value
  }

  /**
   * Write a new value and notify all subscribers.
   *
   * Subscribers are called synchronously, in insertion order.
   * Each receives a `ReplaceChange<T>` with the new value.
   */
  set(value: T): void {
    this.#value = value
    const change = replaceChange(value)
    for (const cb of this.#subscribers) {
      cb(change)
    }
  }

  /**
   * The changefeed for this ref.
   *
   * Uses `getOrCreateChangefeed` from `@kyneta/schema` for
   * WeakMap-based caching — ensures referential identity:
   * `ref[CHANGEFEED] === ref[CHANGEFEED]`.
   */
  get [CHANGEFEED](): Changefeed<T, ReplaceChange<T>> {
    return getOrCreateChangefeed(this, () => {
      // Capture `this` for the closure — the changefeed object is
      // cached per-instance by the WeakMap, so `self` is stable.
      const self = this
      return {
        get current(): T {
          return self.#value
        },
        subscribe(
          callback: (change: ReplaceChange<T>) => void,
        ): () => void {
          self.#subscribers.add(callback)
          return () => {
            self.#subscribers.delete(callback)
          }
        },
      }
    })
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a local reactive value.
 *
 * This is the primary API for local state in Kinetic components.
 *
 * @param initial - The initial value
 * @returns A `LocalRef<T>` that participates in the `CHANGEFEED` protocol
 *
 * @example
 * ```typescript
 * const count = state(0)
 * count.get()   // 0
 * count.set(1)  // notifies subscribers
 * count.get()   // 1
 * ```
 */
export function state<T>(initial: T): LocalRef<T> {
  return new LocalRef(initial)
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Check if a value is a `LocalRef`.
 */
export function isLocalRef(value: unknown): value is LocalRef<unknown> {
  return value instanceof LocalRef
}