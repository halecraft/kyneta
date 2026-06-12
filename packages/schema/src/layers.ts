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
//   import { interpret, readable, writable, observation } from "@kyneta/schema"
//
//   const doc = interpret(schema, ctx)
//     .with(readable)
//     .with(writable)
//     .with(observation)
//     .done()

import type {
  ChangefeedBrand,
  InterpreterLayer,
  ReadableBrand,
  WritableBrand,
} from "./interpret.js"
import type { RefContext } from "./interpreter-types.js"
import { withAddressing } from "./interpreters/with-addressing.js"
import { withCaching } from "./interpreters/with-caching.js"
import { withChangefeed } from "./interpreters/with-changefeed.js"
import { withNavigation } from "./interpreters/with-navigation.js"
import { withReadable } from "./interpreters/with-readable.js"
import { withTracking } from "./interpreters/with-tracking.js"
import type { WritableContext } from "./interpreters/writable.js"
import { withWritable } from "./interpreters/writable.js"

// ---------------------------------------------------------------------------
// navigation — structural addressing only
// ---------------------------------------------------------------------------

/**
 * Navigation layer: structural addressing (product field getters,
 * sequence/map `.at()`, `.length`, `.keys()`, etc.).
 *
 * Composes `withNavigation(base)` in a single layer.
 *
 * Context: `RefContext` → `RefContext` (no widening).
 *
 * ```ts
 * interpret(schema, ctx).with(navigation).done()
 * // equivalent to:
 * interpret(schema, withNavigation(bottomInterpreter), ctx)
 * ```
 */
export const navigation: InterpreterLayer<RefContext, RefContext> = {
  name: "navigation",
  transform(base) {
    return withNavigation(base)
  },
}

// ---------------------------------------------------------------------------
// addressing — stable identity for all composite nodes
// ---------------------------------------------------------------------------

/**
 * Addressing layer: stable identity for all composite refs.
 *
 * Composes `withAddressing(base)` in a single layer. Installs an
 * `AddressedPath` root on the context so all descendant paths are
 * identity-stable. Hooks into `prepare` for eager address advancement
 * (sequences) and tombstoning (maps).
 *
 * Context: `RefContext` → `RefContext` (no widening).
 *
 * Typically composed inside `readable`, but exported standalone for
 * users who compose manually.
 */
export const addressing: InterpreterLayer<RefContext, RefContext> = {
  name: "addressing",
  transform(base) {
    return withAddressing(base)
  },
}

// ---------------------------------------------------------------------------
// readable — navigation + reading + identity-preserving caching
// ---------------------------------------------------------------------------

/**
 * Readable layer: navigation + reading + identity-preserving caching.
 *
 * Composes `withCaching(withReadable(withNavigation(base)))` in a single
 * layer.
 *
 * Context: `RefContext` → `RefContext` (no widening).
 *
 * ```ts
 * interpret(schema, ctx).with(readable).done()
 * // equivalent to:
 * interpret(schema, withCaching(withReadable(withNavigation(bottomInterpreter))), ctx)
 * ```
 */
export const readable: InterpreterLayer<RefContext, RefContext, ReadableBrand> =
  {
    name: "readable",
    transform(base) {
      return withCaching(withAddressing(withReadable(withNavigation(base))))
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
 * interpret(schema, withWritable(withCaching(withReadable(withNavigation(bottomInterpreter)))), ctx)
 * ```
 */
export const writable: InterpreterLayer<
  RefContext,
  WritableContext,
  WritableBrand
> = {
  name: "writable",
  transform(base) {
    return withWritable(base)
  },
}

// ---------------------------------------------------------------------------
// observation — compositional observation protocol
// ---------------------------------------------------------------------------

/**
 * Observation layer: compositional observation protocol (`[CHANGEFEED]`,
 * `subscribeDescendants`).
 *
 * Wraps `withChangefeed(base)`. Accepts `RefContext` — works on both
 * read-only and read-write stacks. On read-only stacks, produces
 * valid Moore machines (`.current` works, `.subscribe` never fires).
 *
 * ```ts
 * interpret(schema, ctx)
 *   .with(readable)
 *   .with(writable)
 *   .with(observation)
 *   .done()
 * // equivalent to:
 * interpret(
 *   schema,
 *   withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottomInterpreter))))),
 *   ctx,
 * )
 * ```
 */
export const observation: InterpreterLayer<
  RefContext,
  RefContext,
  ChangefeedBrand
> = {
  name: "observation",
  transform(base) {
    return withChangefeed(base)
  },
}

// ---------------------------------------------------------------------------
// tracking — read-dependency capture for reactive scopes
// ---------------------------------------------------------------------------

/**
 * Tracking layer: read-instrumentation for the reactive runtime
 * (`@kyneta/reactive`). Applied OUTERMOST (above observation) so every
 * user-facing read routes through it first; when no tracking scope is
 * active it is a one-guard passthrough.
 *
 * Carries no brand (`unknown`) — `& unknown` is identity, so it does not
 * change `.done()` tier resolution. Composes on any read-capable stack.
 *
 * ```ts
 * interpret(schema, ctx)
 *   .with(readable).with(writable).with(observation).with(tracking)
 *   .done()
 * ```
 */
export const tracking: InterpreterLayer<RefContext, RefContext> = {
  name: "tracking",
  transform(base) {
    return withTracking(base as any) as any
  },
}
