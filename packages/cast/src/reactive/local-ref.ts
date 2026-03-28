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
 * import { state } from "@kyneta/cast"
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
  type Changefeed,
  type Changeset,
  getOrCreateChangefeed,
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
 * The ref-specific members of a `LocalRef<T>` (excluding the value type `T`).
 *
 * Separated from `LocalRef<T>` so that the intersection `T & LocalRefBase<T>`
 * gives `LocalRef<T>` the methods of `T` (e.g., `LocalRef<string>` gains
 * `.toLowerCase()`, `.includes()`, etc.) while preserving the callable and
 * reactive protocol members.
 */
export interface LocalRefBase<T> {
  /** Read the current value. */
  (): T

  /** Write a new value and notify all subscribers. */
  set(value: T): void

  /** The changefeed for this ref. */
  readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>

  /** @internal Brand for isLocalRef detection. */
  readonly [LOCAL_REF_BRAND]: true
}

/**
 * Widen a type from literal/nullable to its base type for intersection.
 *
 * Without widening, `LocalRef<0>` = `0 & LocalRefBase<0>` which constrains
 * `.set()` to only accept `0`. And `LocalRef<null>` = `null & ...` = `never`.
 *
 * This maps:
 * - String literals (`"hello"`) → `string`
 * - Number literals (`42`) → `number`
 * - Boolean literals (`true`) → `boolean`
 * - `null` / `undefined` → `{}` (empty object — intersection with `{}` is a no-op for objects)
 * - Object types → unchanged
 *
 * The widened type is ONLY used for the `T &` intersection that exposes
 * value-type methods. The `LocalRefBase<T>` still uses the original `T`
 * for `(): T` and `set(value: T)`.
 */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T extends symbol
          ? symbol
          : T extends null | undefined
            ? // biome-ignore lint/complexity/noBannedTypes: fallback for null/undefined primitives
              {}
            : T

/**
 * A local reactive value. Implements the `CHANGEFEED` protocol so it
 * can be subscribed to by the Kyneta runtime (and any other consumer
 * that understands `[CHANGEFEED]`).
 *
 * The ref is callable — `ref()` returns the current value (like
 * schema's readable interpreter). `.set(value)` writes a new value
 * and notifies subscribers with a `ReplaceChange<T>`.
 *
 * The `Widen<T> &` intersection gives `LocalRef<T>` all of `T`'s methods.
 * For example, `LocalRef<string>` has `.toLowerCase()`, `.includes()`,
 * etc. At runtime the ref doesn't have these methods — the Kyneta
 * compiler inserts `()` reads at the ref/value boundary before the
 * code runs.
 *
 * `Widen<T>` maps literal types to base types (e.g., `"hello"` → `string`,
 * `42` → `number`) and `null`/`undefined` to `{}` to prevent the
 * intersection from collapsing to `never`.
 */
export type LocalRef<T> = Widen<T> & LocalRefBase<T>

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
  const subscribers = new Set<
    (changeset: Changeset<ReplaceChange<T>>) => void
  >()

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
  return typeof value === "function" && (value as any)[LOCAL_REF_BRAND] === true
}
