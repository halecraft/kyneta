// read — what a value read returns, and the read members of each kind.
//
// A read is σ's own value at the path, frozen in place (`freezeTree`). A
// write copies a frozen node before changing it (`applyChange`), so the read
// never changes, and it keeps its identity until a write copies it: with no
// write in between, `ref() === ref()`, and after a write at P only P, its
// ancestors and what the change rewrote read as new objects. A read never
// navigates, so it builds no refs.
//
// A dead ref reads `undefined`, whatever its type says: its coordinate is
// gone, and a list item's may now hold another item.

import { freezeTree } from "../clone.js"
import { samePlainValue } from "../guards.js"
import type { Path, Segment } from "../path.js"
import { AddressedPath, rawEntry, rawIndex } from "../path.js"
import { childOf } from "../plain-access.js"
import type { Reader } from "../reader.js"
import { KIND, type Schema as SchemaNode } from "../schema.js"
import { currentScope } from "../tracking.js"
import { type RefState, stateOf } from "./state.js"
import { report } from "./track.js"

/**
 * Symbol-keyed slot a ref's read lives under: calling a ref calls it.
 *
 * Uses `Symbol.for` so multiple copies of this module share identity.
 */
export const CALL: unique symbol = Symbol.for("kyneta:call")

/**
 * σ at `path` as it stands, unfrozen and uncopied, or `undefined` when the
 * path names a coordinate that is gone. For coercions (`Symbol.toPrimitive`)
 * that return primitives only.
 */
export function valueAt(ctx: { readonly reader: Reader }, path: Path): unknown {
  return isDead(path) ? undefined : ctx.reader.read(path)
}

/** The value at `path`: σ's own, frozen. */
export function readAt(ctx: { readonly reader: Reader }, path: Path): unknown {
  if (isDead(path)) return undefined
  return freezeTree(ctx.reader.read(path))
}

/**
 * The value of the child at `segment` below `path`, read from the parent's
 * value, so no ref is built for it and only the child is frozen. A missing
 * child is `undefined`.
 */
export function readChildAt(
  ctx: { readonly reader: Reader },
  path: Path,
  segment: Segment,
): unknown {
  const value = childOf(valueAt(ctx, path), segment)
  return value === undefined ? undefined : freezeTree(value)
}

/**
 * Whether a segment of `path` is dead. A dead list item's address keeps its
 * last index, which another item may hold now, so σ at its coordinate is not
 * its value.
 */
function isDead(path: Path): boolean {
  return path instanceof AddressedPath && path.dead
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** A read-only member on a prototype. */
export function method(value: unknown): PropertyDescriptor {
  return { value, enumerable: false, configurable: true, writable: false }
}

/** A getter on a prototype. */
export function getter(get: () => unknown): PropertyDescriptor {
  return { get, enumerable: false, configurable: true }
}

/** What `()` on this kind reads: a whole subtree (`deep`) or a leaf. */
export function readAspect(schema: SchemaNode): "deep" | "value" {
  switch (schema[KIND]) {
    case "product":
    case "sequence":
    case "movable":
    case "map":
    case "tree":
      return "deep"
    default:
      return "value"
  }
}

/** `ref()`: its value, reported to a tracking scope at `aspect`. */
export function readRef(
  ref: unknown,
  state: RefState,
  aspect: "deep" | "value",
): unknown {
  report(ref, state, aspect)
  return readAt(state.ctx, state.path)
}

/** The read members of a ref of `schema`. */
export function readMembers(schema: SchemaNode): PropertyDescriptorMap {
  const aspect = readAspect(schema)
  const members: PropertyDescriptorMap = {
    [CALL]: method(function read(this: unknown): unknown {
      return readRef(this, stateOf(this, "()"), aspect)
    }),
  }
  switch (schema[KIND]) {
    case "scalar":
      members[Symbol.toPrimitive] = method(function (
        this: unknown,
        hint: string,
      ): unknown {
        const state = stateOf(this, "Symbol.toPrimitive")
        const value = valueAt(state.ctx, state.path)
        return hint === "string" ? String(value) : value
      })
      break
    case "text":
      members[Symbol.toPrimitive] = method(function (this: unknown): string {
        const state = stateOf(this, "Symbol.toPrimitive")
        const value = valueAt(state.ctx, state.path)
        return typeof value === "string" ? value : String(value ?? "")
      })
      break
    case "counter":
      members[Symbol.toPrimitive] = method(function (
        this: unknown,
        hint: string,
      ): unknown {
        const state = stateOf(this, "Symbol.toPrimitive")
        const value = valueAt(state.ctx, state.path)
        const n = typeof value === "number" ? value : 0
        return hint === "string" ? String(n) : n
      })
      break
    case "richtext":
      members[Symbol.toPrimitive] = method(function (this: unknown): string {
        const state = stateOf(this, "Symbol.toPrimitive")
        const value = valueAt(state.ctx, state.path)
        return Array.isArray(value)
          ? (value as { text: string }[]).map(span => span.text).join("")
          : ""
      })
      break
    case "sequence":
    case "movable":
      members.get = method(childGetter((index: number) => rawIndex(index)))
      break
    case "map":
      members.get = method(childGetter((key: string) => rawEntry(key)))
      break
    case "set":
      Object.assign(members, setMembers())
      break
  }
  return members
}

/**
 * `.get(k)`: the child's value read from the container's (`readChildAt`),
 * which builds no ref and freezes only that child. Inside a tracking scope it
 * reads through `.at(k)` and the child's `()` instead, so the container
 * reports `structure` and the child its own `value` or `deep`: a write to
 * one entry then re-runs only the readers of that entry. That builds the
 * child's ref, as navigating to it would.
 */
function childGetter<K extends string | number>(
  segment: (key: K) => Segment,
): (this: unknown, key: K) => unknown {
  return function get(this: unknown, key: K): unknown {
    const state = stateOf(this, "get")
    if (currentScope()) {
      const child = (this as { at(key: K): unknown }).at(key)
      return typeof child === "function" ? child() : undefined
    }
    return readChildAt(state.ctx, state.path, segment(key))
  }
}

/**
 * A set's `.has`, `.size` and iteration, over the members its `()` returns,
 * so each reports a read of the whole set. Membership is content-equal
 * (`samePlainValue`).
 */
function setMembers(): PropertyDescriptorMap {
  const members = (ref: unknown): readonly unknown[] => {
    const value = (ref as { [CALL](): unknown })[CALL]()
    return Array.isArray(value) ? value : []
  }
  return {
    has: method(function has(this: unknown, value: unknown): boolean {
      stateOf(this, "has")
      return members(this).some(member => samePlainValue(member, value))
    }),
    size: getter(function size(this: unknown): number {
      stateOf(this, "size")
      return members(this).length
    }),
    [Symbol.iterator]: method(function* (
      this: unknown,
    ): IterableIterator<unknown> {
      stateOf(this, "Symbol.iterator")
      yield* members(this)
    }),
  }
}
