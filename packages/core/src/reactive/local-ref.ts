/**
 * Local reactive state primitive.
 *
 * `LocalRef<T>` is a simple reactive value that participates in the
 * `CHANGEFEED` protocol from `@kyneta/schema`. It uses the callable
 * pattern established by schema's readable interpreter — the ref itself
 * is a function, so `ref()` returns the current value.
 *
 * Use `state(initial)` to create a `LocalRef<T>`. The ref:
 * - Is callable: `ref()` returns current value (replaces old `.get()`)
 * - Exposes `.set(value)` for writing
 * - Implements `[CHANGEFEED]` for the reactive protocol
 * - Emits `ReplaceChange<T>` on every `.set()` call
 *
 * @example
 * ```typescript
 * import { state } from "@kyneta/core"
 * import { CHANGEFEED } from "@kyneta/schema"
 *
 * const count = state(0)
 * count()  // 0
 *
 * count[CHANGEFEED].subscribe((changeset) => {
 *   console.log("new value:", changeset.changes[0].value)
 * })
 *
 * count.set(1)  // subscriber fires with { changes: [{ type: "replace", value: 1 }] }
 * count()       // 1
 * ```
 *
 * @packageDocumentation
 */

import {
  CHANGEFEED,
  getOrCreateChangefeed,
  type Changefeed,
  type Changeset,
  type ReplaceChange,
  replaceChange,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Brand symbol for isLocalRef detection
// ---------------------------------------------------------------------------

/**
 * Internal brand symbol. Attached to every LocalRef function-object so
 * `isLocalRef` can identify them without relying on `instanceof`.
 */
const LOCAL_REF_BRAND: unique symbol = Symbol("LocalRef")

// ---------------------------------------------------------------------------
// LocalRef type
// ---------------------------------------------------------------------------

/**
 * A local reactive value. Implements the `CHANGEFEED` protocol so it
 * can be subscribed to by the Kyneta runtime (and any other consumer
 * that understands `[CHANGEFEED]`).
 *
 * The ref is callable — `ref()` returns the current value (like
 * schema's readable interpreter). `.set(value)` writes a new value
 * and notifies subscribers with a `ReplaceChange<T>`.
 */
export interface LocalRef<T> {
  /** Read the current value. */
  (): T

  /** Write a new value and notify all subscribers. */
  set(value: T): void

  /** The changefeed for this ref. */
  readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>

  /** @internal Brand for isLocalRef detection. */
  readonly [LOCAL_REF_BRAND]: true
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a local reactive value.
 *
 * This is the primary API for local state in Kyneta components.
 * Returns a callable `LocalRef<T>` — call it to read, use `.set()` to write.
 *
 * @param initial - The initial value
 * @returns A callable `LocalRef<T>` that participates in the `CHANGEFEED` protocol
 *
 * @example
 * ```typescript
 * const count = state(0)
 * count()     // 0
 * count.set(1)  // notifies subscribers
 * count()     // 1
 * ```
 */
export function state<T>(initial: T): LocalRef<T> {
  // Mutable state captured by closure
  let value: T = initial
  const subscribers = new Set<(changeset: Changeset<ReplaceChange<T>>) => void>()

  // The callable ref — arrow function that returns current value
  const ref: any = () => value

  // .set() — write and notify
  ref.set = (newValue: T): void => {
    value = newValue
    const change = replaceChange(newValue)
    const changeset: Changeset<ReplaceChange<T>> = { changes: [change] }
    for (const cb of subscribers) {
      cb(changeset)
    }
  }

  // [CHANGEFEED] — uses getOrCreateChangefeed for WeakMap-based caching
  // (ensures referential identity: ref[CHANGEFEED] === ref[CHANGEFEED])
  Object.defineProperty(ref, CHANGEFEED, {
    get(): Changefeed<T, ReplaceChange<T>> {
      return getOrCreateChangefeed(ref, () => ({
        get current(): T {
          return value
        },
        subscribe(
          callback: (changeset: Changeset<ReplaceChange<T>>) => void,
        ): () => void {
          subscribers.add(callback)
          return () => {
            subscribers.delete(callback)
          }
        },
      }))
    },
    enumerable: false,
    configurable: false,
  })

  // Brand for isLocalRef
  ref[LOCAL_REF_BRAND] = true

  return ref as LocalRef<T>
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Check if a value is a `LocalRef`.
 *
 * Uses a brand symbol rather than `instanceof` since LocalRef is now
 * a function-object created by `state()`, not a class instance.
 */
export function isLocalRef(value: unknown): value is LocalRef<unknown> {
  return (
    typeof value === "function" &&
    (value as any)[LOCAL_REF_BRAND] === true
  )
}