// layers — pre-built InterpreterLayer instances for fluent composition.
//
// These layers wrap the existing interpreter transformers into the
// InterpreterLayer interface used by the InterpretBuilder fluent API.
//
// Separated from interpret.ts to avoid circular runtime imports:
// interpret.ts ← bottom.ts (type-only), but layers.ts imports both
// interpret.ts (types) and interpreters/* (runtime values).
//
// Usage:
//   import { interpret, readable, writable, changefeed } from "@kyneta/schema"
//
//   const doc = interpret(schema, ctx)
//     .with(readable)
//     .with(writable)
//     .with(changefeed)
//     .done()

import type { InterpreterLayer } from "./interpret.js"
import type { RefContext } from "./interpreter-types.js"
import type { WritableContext } from "./interpreters/writable.js"

import { withReadable } from "./interpreters/with-readable.js"
import { withCaching } from "./interpreters/with-caching.js"
import { withWritable } from "./interpreters/writable.js"
import { withChangefeed } from "./interpreters/with-changefeed.js"

// ---------------------------------------------------------------------------
// readable — reading + navigation + identity-preserving caching
// ---------------------------------------------------------------------------

/**
 * Readable layer: reading + navigation + identity-preserving caching.
 *
 * Composes `withCaching(withReadable(base))` in a single layer.
 *
 * Context: `RefContext` → `RefContext` (no widening).
 *
 * ```ts
 * interpret(schema, ctx).with(readable).done()
 * // equivalent to:
 * interpret(schema, withCaching(withReadable(bottomInterpreter)), ctx)
 * ```
 */
export const readable: InterpreterLayer<RefContext, RefContext> = {
  name: "readable",
  transform(base) {
    return withCaching(withReadable(base))
  },
}

// ---------------------------------------------------------------------------
// writable — mutation methods
// ---------------------------------------------------------------------------

/**
 * Writable layer: mutation methods (`.set()`, `.insert()`, `.increment()`, etc.)
 *
 * Wraps `withWritable(base)`. Widens context from `RefContext` to
 * `WritableContext`.
 *
 * ```ts
 * interpret(schema, ctx).with(readable).with(writable).done()
 * // equivalent to:
 * interpret(schema, withWritable(withCaching(withReadable(bottomInterpreter))), ctx)
 * ```
 */
export const writable: InterpreterLayer<RefContext, WritableContext> = {
  name: "writable",
  transform(base) {
    return withWritable(base)
  },
}

// ---------------------------------------------------------------------------
// changefeed — compositional observation protocol
// ---------------------------------------------------------------------------

/**
 * Changefeed layer: compositional observation protocol (`[CHANGEFEED]`,
 * `subscribeTree`).
 *
 * Wraps `withChangefeed(base)`. Requires `WritableContext` (must come
 * after `writable`).
 *
 * ```ts
 * interpret(schema, ctx)
 *   .with(readable)
 *   .with(writable)
 *   .with(changefeed)
 *   .done()
 * // equivalent to:
 * interpret(
 *   schema,
 *   withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter)))),
 *   ctx,
 * )
 * ```
 */
export const changefeed: InterpreterLayer<WritableContext, WritableContext> = {
  name: "changefeed",
  transform(base) {
    return withChangefeed(base)
  },
}