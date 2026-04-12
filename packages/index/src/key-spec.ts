// key-spec — key extraction helpers for secondary indexes.
//
// A KeySpec<V> bundles two things:
// 1. A partitioning function: (key, value) → string[] of group keys
// 2. An optional watch function: subscribes to value changes that may
//    alter the group keys, returning an unsubscribe function
//
// The `field` helper handles scalar and compound keys with per-accessor
// `subscribeNode` watches. The `keys` helper handles record fan-out
// with `subscribeNode` watches.

import { subscribeNode } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Key extraction specification for secondary indexes.
 */
export interface KeySpec<V> {
  /** Given an entry, return the group key(s) it belongs to. */
  groupKeys: (key: string, value: V) => string[]
  /** Optional: subscribe to value changes that may alter the group keys. Returns unsubscribe. */
  watch?: (key: string, value: V, onRegroup: () => void) => () => void
}

// ---------------------------------------------------------------------------
// field — scalar and compound key extraction
// ---------------------------------------------------------------------------

/**
 * Create a KeySpec for scalar or compound key extraction.
 *
 * Each accessor is a function from value to a ref whose current value
 * (obtained by calling the ref) is a string. For compound keys, values
 * are joined with `\0`.
 *
 * ```ts
 * // Scalar FK
 * field(ref => ref.ownerId)
 *
 * // Compound key
 * field(ref => ref.ownerId, ref => ref.status)
 * ```
 */
export function field<V>(...accessors: Array<(value: V) => any>): KeySpec<V> {
  if (accessors.length === 0) {
    throw new Error("[key-spec] field() requires at least one accessor")
  }

  if (accessors.length === 1) {
    // Single accessor — simple scalar key
    const accessor = accessors[0]
    return {
      groupKeys: (_key: string, value: V): string[] => {
        return [String(accessor(value)())]
      },
      watch: (_key: string, value: V, onRegroup: () => void): (() => void) => {
        return subscribeNode(accessor(value), onRegroup)
      },
    }
  }

  // Multiple accessors — compound key with \0 separator
  return {
    groupKeys: (_key: string, value: V): string[] => {
      return [accessors.map(a => String(a(value)())).join("\0")]
    },
    watch: (_key: string, value: V, onRegroup: () => void): (() => void) => {
      const unsubs = accessors.map(a => subscribeNode(a(value), onRegroup))
      return () => {
        for (const unsub of unsubs) {
          unsub()
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// keys — record fan-out key extraction
// ---------------------------------------------------------------------------

/**
 * Create a KeySpec for record fan-out — each key of a record ref
 * becomes a group key.
 *
 * ```ts
 * keys(ref => ref.tags)
 * // entry with tags { "urgent": ..., "bug": ... } → groups ["urgent", "bug"]
 * ```
 *
 * Uses `subscribeNode` (NOT `subscribe`) to watch structural changes
 * to the record — mutations to values inside the record do NOT fire.
 */
export function keys<V>(accessor: (value: V) => any): KeySpec<V> {
  return {
    groupKeys: (_key: string, value: V): string[] => {
      return [...accessor(value).keys()]
    },
    watch: (_key: string, value: V, onRegroup: () => void): (() => void) => {
      return subscribeNode(accessor(value), onRegroup)
    },
  }
}
