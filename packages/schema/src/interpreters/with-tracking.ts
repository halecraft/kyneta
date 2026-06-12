// withTracking — the read-instrumentation interpreter layer.
//
// Applied as the OUTERMOST layer (above observation), so every user-facing
// read passes through it first. When a tracking scope is active
// (`tracking.ts`), each read reports a `Dependency` (a stable handle + an
// aspect); when no scope is active, every wrapped accessor is a one-guard
// passthrough (byte-identical behavior). The reactive runtime (jj:kpywvkpr)
// consumes the captured deps and decides subscription policy — this layer
// only observes reads.
//
// Stable identity: dependency keys are derived from the carrier's object
// identity (via `carrierKey`), which is already CURSOR-STABLE — `.at(i)` is
// backed by the address table keyed on `Address.id` (sequence-helpers.ts:329),
// so the same logical element yields the same carrier object across structural
// change. Keying by carrier identity is therefore invariant under inserts/
// deletes without touching addressing internals. (`identity` aspect is folded
// into `structure` for v1: navigating a dynamic container reports a `structure`
// dep, which soundly catches moves/deletes.)
//
// Aspect inference (read-method × node-kind):
//   leaf `()`            → value        (scalar/text/counter/richtext/set)
//   composite `()`       → deep         (product/sequence/map/tree); fold suppressed
//   container navigation → structure    (sequence/movable/map .at/.length/iter/.keys/.has/.size/.entries/.values)
//
// Completeness (soundness — no missed reads): every accessor that reads the
// substrate is wrapped, OR delegates to one that is. Verified against the
// helpers: sequence `.get`/iter/`[CALL]` route through `.at` + child `[CALL]`;
// `.length` and the empty-iteration path read `reader.arrayLength` directly, so
// `.at` + `.length` + `[Symbol.iterator]` are all wrapped. Map `.has`/`.keys`/
// `.size`/`.entries`/`.values`/iter read `reader.keys`/`hasKey` directly, so all
// are wrapped.

import type { HasChangefeed } from "@kyneta/changefeed"
import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
import type {
  CounterSchema,
  MapSchema,
  MovableSequenceSchema,
  ProductSchema,
  RichTextSchema,
  ScalarSchema,
  SequenceSchema,
  SetSchema,
  SumSchema,
  TextSchema,
  TreeSchema,
} from "../schema.js"
import {
  type Aspect,
  currentScope,
  dependencyKey,
  reportRead,
  withoutTracking,
} from "../tracking.js"
import { CALL, type HasNavigation, type HasRead } from "./bottom.js"

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Carrier-identity keys (cursor-stable → key-stable across structural change)
// ---------------------------------------------------------------------------

let nextCarrierId = 1
const carrierIds = new WeakMap<object, number>()

function carrierKey(carrier: object, aspect: Aspect): string {
  let id = carrierIds.get(carrier)
  if (id === undefined) {
    id = nextCarrierId++
    carrierIds.set(carrier, id)
  }
  return dependencyKey(`n${id}`, aspect)
}

function emit(carrier: object, aspect: Aspect): void {
  reportRead({
    key: carrierKey(carrier, aspect),
    aspect,
    ref: carrier as HasChangefeed,
  })
}

// ---------------------------------------------------------------------------
// Accessor-wrapping toolkit
// ---------------------------------------------------------------------------

/** Wrap the `[CALL]` slot of a LEAF carrier — calling reports `value`. */
function wrapLeafCall(result: any): void {
  const orig = result[CALL] as (...a: unknown[]) => unknown
  result[CALL] = (...args: unknown[]): unknown => {
    if (currentScope()) emit(result, "value")
    return orig.apply(result, args)
  }
}

/**
 * Wrap the `[CALL]` slot of a COMPOSITE carrier — calling reports a single
 * `deep` dep, then folds the snapshot with reads suppressed (the `deep` dep
 * subsumes the entire subtree, so per-descendant reports are redundant).
 */
function wrapCompositeCall(result: any): void {
  const orig = result[CALL] as (...a: unknown[]) => unknown
  result[CALL] = (...args: unknown[]): unknown => {
    if (!currentScope()) return orig.apply(result, args)
    emit(result, "deep")
    return withoutTracking(() => orig.apply(result, args))
  }
}

/** Wrap a method-valued accessor so calling it first reports `aspect`. */
function wrapMethod(result: any, name: PropertyKey, aspect: Aspect): void {
  const desc = Object.getOwnPropertyDescriptor(result, name)
  if (!desc || typeof desc.value !== "function") return
  const orig = desc.value as (...a: unknown[]) => unknown
  Object.defineProperty(result, name, {
    ...desc,
    value(this: any, ...args: unknown[]): unknown {
      if (currentScope()) emit(result, aspect)
      return orig.apply(this, args)
    },
  })
}

/** Wrap a getter-valued accessor so reading it first reports `aspect`. */
function wrapGetter(result: any, name: PropertyKey, aspect: Aspect): void {
  const desc = Object.getOwnPropertyDescriptor(result, name)
  if (!desc || typeof desc.get !== "function") return
  const origGet = desc.get
  Object.defineProperty(result, name, {
    ...desc,
    get(this: any): unknown {
      if (currentScope()) emit(result, aspect)
      return origGet.call(this)
    },
  })
}

// ---------------------------------------------------------------------------
// withTracking — the transformer
// ---------------------------------------------------------------------------

/**
 * Read-instrumentation transformer. Wraps each carrier's read/navigation
 * surface to report dependencies when a tracking scope is active. Must be
 * applied OUTERMOST (above observation) so the carrier already carries
 * `[CHANGEFEED]` at runtime and every read routes through here first.
 *
 * Carrier identity is preserved (mutates the carrier produced by `base`),
 * so caching/addressing/changefeed all keep working.
 */
export function withTracking<A extends HasNavigation & HasRead>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A> {
  return {
    [INTERPRETER]: true,

    scalar(ctx: RefContext, path: Path, schema: ScalarSchema): A {
      const result = base.scalar(ctx, path, schema) as any
      wrapLeafCall(result)
      return result as A
    },

    text(ctx: RefContext, path: Path, schema: TextSchema): A {
      const result = base.text(ctx, path, schema) as any
      wrapLeafCall(result)
      return result as A
    },

    counter(ctx: RefContext, path: Path, schema: CounterSchema): A {
      const result = base.counter(ctx, path, schema) as any
      wrapLeafCall(result)
      return result as A
    },

    richtext(ctx: RefContext, path: Path, schema: RichTextSchema): A {
      const result = base.richtext(ctx, path, schema) as any
      wrapLeafCall(result)
      return result as A
    },

    // Sets are leaf-shaped: every read (`()`, `.has`, `.size`, iteration) is
    // a value read of the whole set (it fires SetChange on its own node).
    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ): A {
      const result = base.set(ctx, path, schema, item) as any
      wrapLeafCall(result)
      wrapMethod(result, "has", "value")
      wrapMethod(result, Symbol.iterator, "value")
      wrapGetter(result, "size", "value")
      return result as A
    },

    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ): A {
      const result = base.product(ctx, path, schema, fields) as any
      // Products have static fields — navigation reports nothing; only the
      // whole-value `()` read is a (deep) dependency. Field getters return
      // child carriers, which report their own reads.
      wrapCompositeCall(result)
      return result as A
    },

    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ): A {
      const result = base.sequence(ctx, path, schema, item) as any
      wrapCompositeCall(result)
      wrapMethod(result, "at", "structure")
      wrapMethod(result, Symbol.iterator, "structure")
      wrapGetter(result, "length", "structure")
      return result as A
    },

    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ): A {
      const result = base.movable(ctx, path, schema, item) as any
      wrapCompositeCall(result)
      wrapMethod(result, "at", "structure")
      wrapMethod(result, Symbol.iterator, "structure")
      wrapGetter(result, "length", "structure")
      return result as A
    },

    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ): A {
      const result = base.map(ctx, path, schema, item) as any
      wrapCompositeCall(result)
      // All of these read the substrate directly (reader.keys / hasKey),
      // so each must report — they do not all route through `.at`.
      wrapMethod(result, "at", "structure")
      wrapMethod(result, "has", "structure")
      wrapMethod(result, "keys", "structure")
      wrapMethod(result, "entries", "structure")
      wrapMethod(result, "values", "structure")
      wrapMethod(result, Symbol.iterator, "structure")
      wrapGetter(result, "size", "structure")
      return result as A
    },

    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A>[],
      node: (id: string) => A,
    ): A {
      const result = base.tree(ctx, path, schema, nodes, node) as any
      wrapCompositeCall(result)
      wrapMethod(result, "node", "structure")
      wrapMethod(result, Symbol.iterator, "structure")
      wrapGetter(result, "roots", "structure")
      wrapGetter(result, "size", "structure")
      return result as A
    },

    // Sum is structurally transparent: the dispatched variant carrier is
    // built through the full stack (including this layer) and reports its
    // own reads. Pass through, like withReadable.
    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ): A {
      return base.sum(ctx, path, schema, variants)
    },
  }
}
