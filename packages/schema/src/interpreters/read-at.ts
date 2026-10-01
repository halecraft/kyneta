// read-at — the one rule for what a value read returns.
//
// On a writable stack a read is σ's own value at the path, frozen in place
// (`freezeTree`). A write copies a frozen node before changing it
// (`applyChange`), so the read never changes, and it keeps its identity until
// a write copies it: with no write in between, `ref() === ref()`, and after a
// write at P only P, its ancestors and what the change rewrote read as new
// objects. A read never navigates, so it builds no refs.
//
// On a read-only stack the value may be the caller's own data, which a read
// must not freeze, and nothing completed it on the way in, so a read copies
// it, completed and frozen.
//
// A dead ref reads `undefined`, whatever its type says: its coordinate is
// gone, and a list item's may now hold another item.

import { freezeTree, frozenClone } from "../clone.js"
import { completeValue } from "../complete.js"
import type { RefContext } from "../interpreter-types.js"
import type { Path, Segment } from "../path.js"
import { childOf } from "../plain-access.js"
import type { Schema as SchemaNode } from "../schema.js"
import { hasPreparePipeline } from "./writable.js"

/**
 * σ at `path` as it stands, unfrozen and uncopied, or `undefined` when the
 * path names a coordinate that is gone. For coercions (`Symbol.toPrimitive`)
 * that return primitives only.
 */
export function valueAt(ctx: RefContext, path: Path): unknown {
  return isDead(path) ? undefined : ctx.reader.read(path)
}

/** The value at `path`, which has `schema`. */
export function readAt(
  ctx: RefContext,
  path: Path,
  schema: SchemaNode,
): unknown {
  if (isDead(path)) return undefined
  return asRead(ctx, schema, ctx.reader.read(path))
}

/**
 * The value of the child at `segment` below `path`, read from the parent's
 * value, so no ref is built for it and only the child is frozen. `schema` is
 * the child's. A missing child is `undefined`.
 */
export function readChildAt(
  ctx: RefContext,
  path: Path,
  segment: Segment,
  schema: SchemaNode,
): unknown {
  const value = childOf(valueAt(ctx, path), segment)
  return value === undefined ? undefined : asRead(ctx, schema, value)
}

/**
 * Whether a segment of `path` is dead. A dead list item's address keeps its
 * last index, which another item may hold now, so σ at its coordinate is not
 * its value.
 */
function isDead(path: Path): boolean {
  return path.segments.some(segment => segment.dead === true)
}

function asRead(ctx: RefContext, schema: SchemaNode, value: unknown): unknown {
  return hasPreparePipeline(ctx)
    ? freezeTree(value)
    : frozenClone(completeValue(schema, value))
}
