// address — the addressing steps the writable context runs on every change,
// and the members a ref has by its position: `[DELETED]` on every ref but the
// root, `[REMOVE]` on a list item or record entry.
//
// `advance` runs before the substrate applies a change: a sequence change
// advances its list's item addresses and drops the items it deletes, reading
// the change's instructions rather than the state they produce. `settle` runs
// after: within what the change may have rewritten (`planSubtreeEffect`), a
// coordinate lives exactly while it still exists (`planAddressFates`).

import type { HasChangefeed } from "@kyneta/changefeed"
import { planAddressFates } from "../address-fates.js"
import type { ChangeBase } from "../change.js"
import { isSequenceChange, mapChange, sequenceChange } from "../change.js"
import {
  childSchema,
  coordinateExists,
  liveSchemaAt,
} from "../coordinate-exists.js"
import type { CoordinateTrie } from "../coordinate-trie.js"
import { REMOVE } from "../interpreters/writable.js"
import { AddressBase, type AddressedPath, isAddress, setDead } from "../path.js"
import type { Reader } from "../reader.js"
import type { Schema as SchemaNode } from "../schema.js"
import { planSubtreeEffect } from "../subtree-effect.js"
import { feedCarrier } from "./observe.js"
import type { RefPosition } from "./prototype.js"
import { getter, method } from "./read.js"
import { type FeedCarrier, lazySlots, stateOf } from "./state.js"

/**
 * The symbol a ref's deletion state lives under: on every ref but the
 * document's root.
 */
export const DELETED: unique symbol = Symbol.for("kyneta:deleted")

/**
 * A ref that tracks whether its coordinate still exists.
 *
 * Every ref below a document's root carries this: a list item or map entry
 * can be removed, a field can leave with its sum's variant, and anything can
 * go with the container holding it. The slot holds a *carrier*: a function
 * returning the boolean, which also carries its own `[CHANGEFEED]` so the
 * transition can be subscribed to. Mirrors `HasPopulated` (`observe.ts`).
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
 * pays the suffix. Mirrors `populatedFeed` in `observe.ts`.
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
// Members by position
// ---------------------------------------------------------------------------

/** `[DELETED]` and `[REMOVE]`, as a ref's position calls for. */
export function addressMembers(position: RefPosition): PropertyDescriptorMap {
  const members: PropertyDescriptorMap = {}
  if (position === "root") return members
  members[DELETED] = getter(function (this: unknown): FeedCarrier {
    const state = stateOf(this, "[DELETED]")
    const slots = lazySlots(state)
    if (slots.deleted !== undefined) return slots.deleted
    const address = state.path.segments.at(-1)
    if (!(address instanceof AddressBase)) {
      throw new Error("A ref's path ends in an address.")
    }
    const origin = { changes: [], origin: "deleted" } as const
    slots.deleted = feedCarrier(
      () => address.dead,
      callback => {
        address.listeners ??= new Set()
        const listener = () => callback(origin)
        address.listeners.add(listener)
        return () => {
          address.listeners?.delete(listener)
          if (address.listeners?.size === 0) address.listeners = undefined
        }
      },
      true,
    )
    return slots.deleted
  })
  if (position !== "removable") return members
  // Dispatches at the parent's path: the one write a ref makes anywhere but
  // its own path.
  members[REMOVE] = method(function remove(this: unknown): void {
    const { ctx, path } = stateOf(this, "[REMOVE]")
    const address = path.segments.at(-1)
    if (!(address instanceof AddressBase)) {
      throw new Error("A ref's path ends in an address.")
    }
    if (address.dead) {
      const detail =
        address.kind === "index"
          ? "The item this ref pointed to has been removed."
          : `The entry "${address.key}" this ref pointed to has been removed.`
      throw new Error(`Cannot remove a dead ref. ${detail}`)
    }
    const parent = path.slice(0, -1)
    if (address.kind === "index") {
      const index = address.index
      ctx.dispatch(
        parent,
        sequenceChange([
          ...(index > 0 ? [{ retain: index }] : []),
          { delete: 1 },
        ]),
      )
    } else {
      ctx.dispatch(parent, mapChange(undefined, [address.key]))
    }
  })
  return members
}

// ---------------------------------------------------------------------------
// The addressing steps
// ---------------------------------------------------------------------------

/**
 * The schema at `path`: the one saved on its node, or, for a node no case
 * has recorded (a raw path resolved on its way in), derived from `root`, the
 * document's schema, and saved. `undefined` for a coordinate not in the trie.
 */
function schemaAt(
  trie: CoordinateTrie,
  root: SchemaNode,
  reader: Reader,
  path: AddressedPath,
): SchemaNode | undefined {
  const node = trie.node(path)
  if (node === undefined) return undefined
  node.schema ??= liveSchemaAt(root, reader, path)
  return node.schema
}

/**
 * Advance a list's item addresses through a sequence change, and kill the
 * items it deleted, with everything below them (`CoordinateTrie.advance`).
 */
export function advance(
  trie: CoordinateTrie,
  path: AddressedPath,
  change: ChangeBase,
): void {
  if (isSequenceChange(change)) trie.advance(path, change.instructions)
}

/**
 * Settle every coordinate the change may have rewritten: those that no
 * longer exist die (fields, map entries) or are dropped (list items, tree
 * nodes), dead ones that exist again revive, and each keeps a current schema.
 */
export function settle(
  trie: CoordinateTrie,
  root: SchemaNode,
  reader: Reader,
  path: AddressedPath,
  change: ChangeBase,
): void {
  const scope = trie.within(path, planSubtreeEffect(change))
  if (scope.length === 0) return
  const fates = planAddressFates(
    {
      path,
      schema: schemaAt(trie, root, reader, path),
      dead: trie.node(path)?.dead ?? false,
    },
    scope.map(([at, node]) => ({
      path: at,
      segment: node,
      schema: node.schema,
      dead: node.dead,
    })),
    (schema, parentPath, segment) =>
      coordinateExists(schema, reader, parentPath, segment),
    (schema, parentPath, segment) =>
      childSchema(schema, reader, parentPath, segment),
  )

  for (const at of fates.die) {
    const node = trie.node(at)
    if (isAddress(node)) setDead(node, true)
  }
  for (const at of fates.drop) trie.drop(at)
  for (const at of fates.rekind) trie.clearList(at)
  for (const [at, schema] of fates.schemas) {
    const node = trie.node(at)
    if (node !== undefined) node.schema = schema
  }
  for (const at of fates.revive) {
    const node = trie.node(at)
    if (isAddress(node)) setDead(node, false)
  }
}
