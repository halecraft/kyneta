// with-decay: `.decay()` as a decorator over any interpreter.
//
// `decayMs` is declared on schema nodes, and the fold holds the schema at every
// case, so this is where the rule can be applied without looking anything up.
// A resolver sees only a path and would have to walk the schema again to learn
// what the fold already knows.

import type { Interpreter, Path } from "../interpret.js"
import { INTERPRETER } from "../interpreter-types.js"
import type { Schema as SchemaNode } from "../schema.js"
import { Zero } from "../zero.js"

/**
 * `interp`, with every node whose schema declares `decayMs` read as its
 * structural zero once it has gone that long without a write.
 *
 * `newestAt(path)` is the newest write at or beneath `path`, or `0` when
 * nothing has been written there. A node never written does not decay: it is
 * already the zero, and `now - 0` would call it expired.
 *
 * An expired node is answered without calling `interp`, so its subtree is
 * never walked. That is also what makes container decay whole: a product or
 * map past its window reads as its structural zero, not as a mixture of
 * expired and unexpired fields.
 */
export function withDecay<Ctx>(
  interp: Interpreter<Ctx, unknown>,
  newestAt: (path: Path) => number,
  now: number,
): Interpreter<Ctx, unknown> {
  function expired(path: Path, schema: SchemaNode): boolean {
    const decayMs = (schema as { decayMs?: number }).decayMs
    if (decayMs === undefined) return false
    const newest = newestAt(path)
    return newest > 0 && now - newest > decayMs
  }

  return {
    [INTERPRETER]: true,
    scalar: (ctx, path, schema) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.scalar(ctx, path, schema),
    product: (ctx, path, schema, fields) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.product(ctx, path, schema, fields),
    sequence: (ctx, path, schema, item) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.sequence(ctx, path, schema, item),
    map: (ctx, path, schema, item) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.map(ctx, path, schema, item),
    sum: (ctx, path, schema, variants) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.sum(ctx, path, schema, variants),
    text: (ctx, path, schema) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.text(ctx, path, schema),
    counter: (ctx, path, schema) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.counter(ctx, path, schema),
    set: (ctx, path, schema, item) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.set(ctx, path, schema, item),
    tree: (ctx, path, schema, nodes, node) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.tree(ctx, path, schema, nodes, node),
    movable: (ctx, path, schema, item) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.movable(ctx, path, schema, item),
    richtext: (ctx, path, schema) =>
      expired(path, schema)
        ? Zero.structural(schema)
        : interp.richtext(ctx, path, schema),
  }
}
