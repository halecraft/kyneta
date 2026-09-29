// withAddressing — stable identity for every coordinate.
//
// This transformer owns the context's `CoordinateTrie`: one node per
// coordinate navigated to, carrying its address and the schema it was
// interpreted with. It installs an `AddressedPath` root on the context (so
// all descendant paths are identity-stable), registers a `prepare` stage that
// keeps addresses in step with every change, attaches `[DELETED]` to refs via
// the `onRefCreated` hook, records each list item's, map entry's and tree
// node's carrier on its node, and attaches `[REMOVE]` to the children of
// lists, maps and sets (writable stacks only).
//
// The prepare stage has two halves:
// - `before`: a sequence change advances its list's item addresses, and
//   drops the items it deletes. Advancement reads the change's instructions,
//   not the state they produce.
// - `after`: within what the change may have rewritten (`planSubtreeEffect`),
//   a coordinate lives exactly while it still exists (`planAddressFates`).
//
// The `[REMOVE]` attachment introduces a dependency on `writable.ts` (for
// `TRANSACT`, `hasTransact`, `REMOVE`, `WritableContext`). `onRefCreated` is
// the only correct attachment point for `[REMOVE]` because it owns child
// discrimination and path structure (parent path derivation). The `[REMOVE]`
// closure dispatches at the *parent* path — the sole exception to the "every
// node dispatches at its own path" invariant.
//
// Composition ordering:
//   withCaching(withAddressing(withReadable(withNavigation(bottom))))

import type { HasChangefeed } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import { planAddressFates } from "../address-fates.js"
import type { ChangeBase } from "../change.js"
import {
  advanceAddresses,
  isSequenceChange,
  mapChange,
  sequenceChange,
} from "../change.js"
import {
  activeSchema,
  childSchema,
  coordinateExists,
} from "../coordinate-exists.js"
import { CoordinateTrie, coordinatePath } from "../coordinate-trie.js"
import { isPropertyHost } from "../guards.js"
import type {
  FlatTreeNode,
  Interpreter,
  Path,
  SumVariants,
} from "../interpret.js"
import { INTERPRETER, type RefContext } from "../interpreter-types.js"
import { AddressedPath, type IndexAddress, setDead } from "../path.js"
import type { Reader } from "../reader.js"
import {
  type CounterSchema,
  KIND,
  type MapSchema,
  type MovableSequenceSchema,
  type ProductSchema,
  type RichTextSchema,
  type ScalarSchema,
  type Schema as SchemaNode,
  type SequenceSchema,
  type SetSchema,
  type SumSchema,
  type TextSchema,
  type TreeSchema,
} from "../schema.js"
import { planSubtreeEffect } from "../subtree-effect.js"
import { currentScope, dependencyKey, reportRead } from "../tracking.js"
import {
  type HasAddressing,
  type HasNavigation,
  markAddressing,
} from "./bottom.js"
import type { WritableContext } from "./writable.js"
import {
  hasPreparePipeline,
  hasTransact,
  REMOVE,
  TRANSACT,
} from "./writable.js"

let nextDeletedId = 1
const deletedIds = new WeakMap<object, number>()

function getDeletedKey(callable: object): string {
  let id = deletedIds.get(callable)
  if (id === undefined) {
    id = nextDeletedId++
    deletedIds.set(callable, id)
  }
  return dependencyKey(`d${id}`, "value")
}

export const DELETED: unique symbol = Symbol.for("kyneta:deleted")

/**
 * A ref that tracks whether its coordinate still exists.
 *
 * Every ref below a document's root carries this: a list item or map entry
 * can be removed, a field can leave with its sum's variant, and anything can
 * go with the container holding it. The slot holds a *carrier*: a function
 * returning the boolean, which also carries its own `[CHANGEFEED]` so the
 * transition can be subscribed to. Mirrors `HasPopulated` in
 * `with-changefeed.ts`.
 */
export interface HasDeleted {
  readonly [DELETED]: (() => boolean) & HasChangefeed<boolean>
}

/**
 * Returns `true` if `value` has a `[DELETED]` property, i.e. it tracks
 * deletion.
 */
export function hasDeleted(value: unknown): value is HasDeleted {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    DELETED in (value as object)
  )
}

/**
 * Returns true if the ref's coordinate no longer exists: its key, id or list
 * item was removed, its field left with a sum's variant, or something above
 * it went. Returns false if the ref is alive, or if it is not a ref that
 * tracks deletion.
 *
 * A key set again, or a variant switched back, brings a field or map entry
 * back to life, with the same ref. A list item or tree node never comes back.
 * The document root is the one ref that carries no deletion state, having no
 * parent to be removed from.
 */
export function deleted(ref: unknown): boolean {
  if (!hasDeleted(ref)) return false
  return ref[DELETED]() === true
}

/**
 * Returns a callable that implements the `[CHANGEFEED]` protocol for the
 * ref's deletion state. The callable returns a boolean (true if deleted).
 * You can subscribe to it via `subscribeNode(deletedFeed(ref), ...)`.
 * Throws if the ref does not track deletion.
 *
 * The `Feed` suffix marks this as the *observable carrier* rather than the
 * plain boolean — for a boolean, call `deleted(ref)`. Reading is the routine
 * case, so it gets the shorter name; subscribing is the specialist one, so it
 * pays the suffix. Mirrors `populatedFeed` in `with-changefeed.ts`.
 *
 * A carrier is a callable, which means it is **always truthy** when present.
 * Never write `if (deletedFeed(ref))` — call it, or use `deleted(ref)`.
 */
export function deletedFeed(
  ref: unknown,
): ((() => boolean) & HasChangefeed<boolean>) | undefined {
  if (ref === null || ref === undefined) return undefined
  if (!hasDeleted(ref)) {
    throw new Error(
      "deletedFeed() requires a ref that tracks deletion (e.g. a sequence item or map entry)",
    )
  }
  return ref[DELETED]
}

// ---------------------------------------------------------------------------
// The trie's paths and schemas
// ---------------------------------------------------------------------------

/**
 * The schema at `path`: the one recorded on its node, or, for a node the
 * interpreter never reached (a raw path resolved on its way in), derived
 * from its parent's and recorded.
 */
function schemaAt(
  trie: CoordinateTrie,
  reader: Reader,
  path: AddressedPath,
): SchemaNode | undefined {
  let schema: SchemaNode | undefined
  let depth = 0
  for (const node of trie.ancestors(path)) {
    if (depth > 0 && node.schema === undefined && schema !== undefined) {
      const segment = path.segments[depth - 1]
      if (segment !== undefined) {
        node.schema = childSchema(
          schema,
          reader,
          path.slice(0, depth - 1),
          segment,
        )
      }
    }
    schema = node.schema
    depth++
  }
  return depth === path.length + 1 ? schema : undefined
}

/** Whether the coordinate at `path` holds removable children. */
function isContainer(
  trie: CoordinateTrie,
  reader: Reader,
  path: AddressedPath,
): boolean {
  const schema = schemaAt(trie, reader, path)
  if (schema === undefined) return false
  switch (activeSchema(schema, reader, path)[KIND]) {
    case "sequence":
    case "movable":
    case "map":
    case "set":
      return true
    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// The prepare stage
// ---------------------------------------------------------------------------

/** The key this layer registers its prepare stage under. */
const ADDRESSING_STAGE: unique symbol = Symbol("kyneta:addressing-stage")

/**
 * Advance a list's item addresses through a sequence change, and drop the
 * items it deleted, with everything below them.
 */
function advance(
  trie: CoordinateTrie,
  path: AddressedPath,
  change: ChangeBase,
): void {
  if (!isSequenceChange(change)) return
  const table = trie.node(path)?.sequenceTable
  if (table === undefined) return
  const live = [...table.byIndex.values()] as IndexAddress[]
  const removed = new Set(advanceAddresses(live, change.instructions))
  table.byIndex.clear()
  for (const address of live) {
    if (!removed.has(address)) table.byIndex.set(address.index, address)
  }
  for (const address of removed) trie.drop(path.child(address))
}

/**
 * Settle every coordinate the change may have rewritten: those that no
 * longer exist die (fields, map entries) or are dropped (list items, tree
 * nodes), dead ones that exist again revive, and each keeps a current schema.
 */
function settle(
  trie: CoordinateTrie,
  reader: Reader,
  path: AddressedPath,
  change: ChangeBase,
): void {
  const scope = trie.within(path, planSubtreeEffect(change))
  if (scope.length === 0) return
  const fates = planAddressFates(
    {
      path,
      schema: schemaAt(trie, reader, path),
      dead: trie.node(path)?.address?.dead ?? false,
    },
    scope.flatMap(([at, node]) => {
      const segment = at.segments[at.length - 1]
      return segment === undefined
        ? []
        : [
            {
              path: at,
              segment,
              schema: node.schema,
              dead: node.address?.dead ?? false,
            },
          ]
    }),
    (schema, parentPath, segment) =>
      coordinateExists(schema, reader, parentPath, segment),
    (schema, parentPath, segment) =>
      childSchema(schema, reader, parentPath, segment),
  )

  for (const at of fates.die) {
    const node = trie.node(at)
    if (node?.address !== undefined) setDead(node.address, true)
    if (node !== undefined) node.read = undefined
  }
  for (const at of fates.drop) trie.drop(at)
  for (const at of fates.rekind) {
    const node = trie.node(at)
    if (node === undefined) continue
    trie.clearSequence(at)
    node.read = undefined
  }
  for (const [at, schema] of fates.schemas) {
    const node = trie.node(at)
    if (node !== undefined) node.schema = schema
  }
  for (const at of fates.revive) {
    const address = trie.node(at)?.address
    if (address !== undefined) setDead(address, false)
  }
}

// ---------------------------------------------------------------------------
// withAddressing — the interpreter transformer
// ---------------------------------------------------------------------------

/**
 * Transformer that gives every coordinate a stable identity.
 *
 * Takes an `Interpreter<RefContext, A extends HasNavigation>` and returns
 * an `Interpreter<RefContext, A & HasAddressing>`. The carrier identity is
 * preserved.
 *
 * On first invocation per context, installs:
 * 1. `ctx.rootPath` — the root path of a fresh `CoordinateTrie`
 * 2. `ctx.onRefCreated` — a hook that attaches `[DELETED]` and `[REMOVE]`
 *    and records container children's carriers on their nodes
 * 3. The layer's `prepare` stage, on a writable stack
 *
 * Every case records the schema it was called with on its coordinate's
 * node, the first time it is called there. A sum's variants share the sum's
 * path, and the sum's case runs first, so a sum's node records the sum.
 */
export function withAddressing<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasAddressing> {
  // One trie per context, created by whichever case runs first.
  const trieByCtx = new WeakMap<object, CoordinateTrie>()

  function trieOf(ctx: RefContext): CoordinateTrie {
    let trie = trieByCtx.get(ctx)
    if (trie === undefined) {
      trie = new CoordinateTrie()
      trieByCtx.set(ctx, trie)
      install(ctx, trie)
    }
    return trie
  }

  /** Record `schema` on the coordinate at `path`, if nothing is there yet. */
  function record(ctx: RefContext, path: Path, schema: SchemaNode): void {
    const trie = trieOf(ctx)
    const node = trie.node(coordinatePath(ctx, path))
    if (node !== undefined && node.schema === undefined) node.schema = schema
  }

  function install(ctx: RefContext, trie: CoordinateTrie): void {
    const mutableCtx = ctx as {
      rootPath?: Path
      onRefCreated?: (path: Path, ref: unknown) => void
    }
    mutableCtx.rootPath = trie.root

    if (hasPreparePipeline(ctx)) {
      ctx.addPrepareStage(ADDRESSING_STAGE, {
        before: (path, change) =>
          advance(trie, coordinatePath(ctx, path), change),
        after: (path, change) =>
          settle(trie, ctx.reader, coordinatePath(ctx, path), change),
      })
    }

    // Chain onRefCreated if one already exists (defensive)
    const existingHook = mutableCtx.onRefCreated
    mutableCtx.onRefCreated = (path: Path, ref: unknown) => {
      existingHook?.(path, ref)

      // Every path in an addressing stack must be addressed.
      // A RawPath here means ctx.rootPath wasn't set before child
      // path derivation — a timing bug in interpretImpl.
      if (!(path instanceof AddressedPath)) {
        throw new Error(
          `withAddressing: onRefCreated received a non-addressed path "${path.format()}". ` +
            `This indicates ctx.rootPath was not set before child path derivation.`,
        )
      }

      const lastAddr = path.lastAddress()
      if (!lastAddr) return // empty path (e.g. annotated reuse) — skip

      // A list item's, map entry's or tree node's carrier lives on its node.
      // A field's carrier is memoized by its parent carrier instead: two
      // variants of a sum can declare fields of one name with different
      // schemas, and a carrier kept by coordinate would serve one variant's
      // to the other.
      if (lastAddr.kind !== "field") {
        const node = trie.node(path)
        if (node !== undefined) node.ref = ref
      }

      // Attach `[DELETED]` changefeed if the ref is an object
      if (isPropertyHost(ref)) {
        const deletedCf = {
          get current() {
            return lastAddr.dead
          },
          subscribe(cb: (cs: any) => void) {
            if (!lastAddr.listeners) lastAddr.listeners = new Set()
            const handler = () => cb({ changes: [], origin: "deleted" })
            lastAddr.listeners.add(handler)
            return () => {
              lastAddr.listeners?.delete(handler)
              if (lastAddr.listeners?.size === 0) {
                lastAddr.listeners = undefined
              }
            }
          },
        }

        const callable = function (this: unknown) {
          if (currentScope()) {
            reportRead({
              key: getDeletedKey(callable),
              aspect: "value",
              // The dependency tracker records refs as opaque handles;
              // this one is a function carrying `[CHANGEFEED]`, which the
              // `ref` field's type does not describe.
              ref: callable as any,
            })
          }
          return deletedCf.current
          // The callable is built as a plain function and then has
          // `[CHANGEFEED]` attached by `defineProperty` below. Its declared
          // type includes that slot; the function expression alone cannot,
          // because the property does not exist until the next statement.
        } as any

        Object.defineProperty(callable, CHANGEFEED, {
          value: deletedCf,
          enumerable: false,
          configurable: false,
          writable: false,
        })

        Object.defineProperty(ref, DELETED, {
          value: callable,
          enumerable: false,
          configurable: true,
          writable: false,
        })
      }

      const parentPath = path.slice(0, path.length - 1)

      // Attach [REMOVE] for container children on writable stacks.
      // Only attach when: (1) ref has [TRANSACT] (writable stack),
      // (2) ref is a property host, and (3) its parent's schema is a list,
      // map or set. The address kind cannot decide alone: a tree node is an
      // entry address too, and removing one is a tree delete, not a map
      // delete.
      if (isPropertyHost(ref) && hasTransact(ref)) {
        if (isContainer(trie, ctx.reader, parentPath)) {
          Object.defineProperty(ref, REMOVE, {
            value() {
              if (lastAddr.dead) {
                const detail =
                  lastAddr.kind === "index"
                    ? "The item this ref pointed to has been removed."
                    : `The entry "${lastAddr.key}" this ref pointed to has been removed.`
                throw new Error(`Cannot remove a dead ref. ${detail}`)
              }
              if (!hasTransact(ref)) {
                throw new Error(
                  "Cannot remove a ref that carries no writable context.",
                )
              }
              const wctx: WritableContext = ref[TRANSACT]
              if (lastAddr.kind === "index") {
                const index = lastAddr.index
                wctx.dispatch(
                  parentPath,
                  sequenceChange([
                    ...(index > 0 ? [{ retain: index }] : []),
                    { delete: 1 },
                  ]),
                )
              } else {
                // key-based (map/set entry)
                wctx.dispatch(parentPath, mapChange(undefined, [lastAddr.key]))
              }
            },
            enumerable: false,
            configurable: true,
            writable: false,
          })
        }
      }
    }
  }

  return {
    [INTERPRETER]: true,
    scalar(ctx: RefContext, path: Path, schema: ScalarSchema) {
      record(ctx, path, schema)
      return addressed(base.scalar(ctx, path, schema))
    },

    product(
      ctx: RefContext,
      path: Path,
      schema: ProductSchema,
      fields: Readonly<Record<string, () => A>>,
    ) {
      record(ctx, path, schema)
      return addressed(base.product(ctx, path, schema, fields))
    },

    sequence(
      ctx: RefContext,
      path: Path,
      schema: SequenceSchema,
      item: (index: number) => A,
    ) {
      record(ctx, path, schema)
      return addressed(base.sequence(ctx, path, schema, item))
    },

    map(
      ctx: RefContext,
      path: Path,
      schema: MapSchema,
      item: (key: string) => A,
    ) {
      record(ctx, path, schema)
      return addressed(base.map(ctx, path, schema, item))
    },

    sum(
      ctx: RefContext,
      path: Path,
      schema: SumSchema,
      variants: SumVariants<A>,
    ) {
      record(ctx, path, schema)
      return addressed(base.sum(ctx, path, schema, variants))
    },

    text(ctx: RefContext, path: Path, schema: TextSchema) {
      record(ctx, path, schema)
      return addressed(base.text(ctx, path, schema))
    },

    counter(ctx: RefContext, path: Path, schema: CounterSchema) {
      record(ctx, path, schema)
      return addressed(base.counter(ctx, path, schema))
    },

    set(
      ctx: RefContext,
      path: Path,
      schema: SetSchema,
      item: (key: string) => A,
    ) {
      record(ctx, path, schema)
      return addressed(base.set(ctx, path, schema, item))
    },

    tree(
      ctx: RefContext,
      path: Path,
      schema: TreeSchema,
      nodes: () => readonly FlatTreeNode<A>[],
      node: (id: string) => A,
    ) {
      record(ctx, path, schema)
      return addressed(base.tree(ctx, path, schema, nodes, node))
    },

    movable(
      ctx: RefContext,
      path: Path,
      schema: MovableSequenceSchema,
      item: (index: number) => A,
    ) {
      record(ctx, path, schema)
      return addressed(base.movable(ctx, path, schema, item))
    },

    richtext(ctx: RefContext, path: Path, schema: RichTextSchema) {
      record(ctx, path, schema)
      return addressed(base.richtext(ctx, path, schema))
    },
  }
}

/** Claim the addressing brand for a carrier this layer passed through. */
function addressed<A>(carrier: A): A & HasAddressing {
  markAddressing(carrier)
  return carrier
}
