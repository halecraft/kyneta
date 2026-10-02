// create — one callable per ref, and how long a ref lives.
//
// A ref is its template's `call` bound to its state record (`bindState`),
// and so has the template's prototype (`templateFor`). A sum's ref is a
// `Proxy` over the active variant's ref.
//
// A ref lives while something holds it. A product holds its field refs; a
// list item's, record entry's or tree node's ref is held weakly by its
// coordinate (`node.ref`), as the one canonical ref `.at` hands back; and
// every ref holds its parent, so holding any ref keeps the refs above it.
// A ref its parent does not hold (the root, a list item, a record entry, a
// tree node) is anchored: it counts itself on its coordinate
// (`CoordinateTrie.anchor`), and when it is collected its coordinate and the
// field coordinates below it are pruned if nothing else needs them
// (`CoordinateTrie.prune`). A field ref and its parent hold each other, so
// they are collected together, and the anchor's one count serves both.

import { dispatchSum } from "../interpret.js"
import type { AddressedPath, Coordinate } from "../path.js"
import {
  type DiscriminatedSumSchema,
  KIND,
  type PositionalSumSchema,
  type Schema as SchemaNode,
  type SumSchema,
} from "../schema.js"
import type { WritableContext } from "../writable-context.js"
import { type RefPosition, templateFor } from "./prototype.js"
import { valueAt } from "./read.js"
import {
  bindState,
  type RefFunction,
  type RefState,
  refBase,
  STATE,
} from "./state.js"

/** The root ref of `schema` over `ctx`. */
export function createRootRef(
  ctx: WritableContext,
  schema: SchemaNode,
): RefFunction {
  const { root } = ctx.trie
  const node = ctx.trie.node(root)
  return ctx.trie.anchor(
    refAt(ctx, root, node, schema, "root", undefined),
    root,
  )
}

/** The ref of `schema` at `path`, reached from `parent`. */
export function createRefAt(
  ctx: WritableContext,
  path: AddressedPath,
  schema: SchemaNode,
  position: RefPosition,
  parent: RefFunction | undefined,
): RefFunction {
  return refAt(ctx, path, ctx.trie.node(path), schema, position, parent)
}

/**
 * The canonical ref of a list item, record entry or tree node: the one its
 * coordinate holds while something else holds it too, or a new one.
 */
export function canonicalChild(
  parent: RefFunction,
  path: AddressedPath,
  schema: SchemaNode,
  position: RefPosition,
): RefFunction {
  const { ctx } = parent[STATE]
  const node = ctx.trie.node(path)
  const held = node?.ref?.deref() as RefFunction | undefined
  if (held !== undefined) return held
  const ref = ctx.trie.anchor(
    refAt(ctx, path, node, schema, position, parent),
    path,
  )
  if (node !== undefined) node.ref = new WeakRef(ref)
  return ref
}

/** The ref of `schema` at `path`, whose coordinate is `node`, with `schema`
 *  recorded there. */
function refAt(
  ctx: WritableContext,
  path: AddressedPath,
  node: Coordinate | undefined,
  schema: SchemaNode,
  position: RefPosition,
  parent: RefFunction | undefined,
): RefFunction {
  if (node !== undefined) node.schema ??= schema
  if (schema[KIND] === "sum") {
    return createSumRef(ctx, path, schema as SumSchema, position, parent)
  }
  const template = templateFor(schema, position)
  const ref = bindState(ctx, path, parent, template.call)
  // One at a time: `defineProperties` measured half again as slow.
  for (const [key, descriptor] of template.own) {
    Object.defineProperty(ref, key, descriptor)
  }
  return ref
}

// ---------------------------------------------------------------------------
// Sums
// ---------------------------------------------------------------------------

/** What calling a sum with no variant does: it reads `undefined`. Its
 *  prototype is `refBase`, which a sum's target inherits by binding it. */
function callSum(this: RefState, key?: unknown): unknown {
  return key === STATE ? this : undefined
}
Object.setPrototypeOf(callSum, refBase)

const handlers = new WeakMap<
  SumSchema,
  Map<RefPosition, ProxyHandler<RefFunction>>
>()

/**
 * A sum's ref: a `Proxy` that resolves the active variant on every access,
 * so the ref keeps its identity while the variant changes. Its target holds
 * the state, whose `ref` is the proxy. Variant refs are made on first use,
 * at the sum's path and with its position, and kept in its state.
 */
function createSumRef(
  ctx: WritableContext,
  path: AddressedPath,
  schema: SumSchema,
  position: RefPosition,
  parent: RefFunction | undefined,
): RefFunction {
  const handler = sumHandler(schema, position)
  return bindState(
    ctx,
    path,
    parent,
    callSum,
    target => new Proxy(target, handler) as RefFunction,
  )
}

/** The handler every ref of `schema` at `position` shares. */
function sumHandler(
  schema: SumSchema,
  position: RefPosition,
): ProxyHandler<RefFunction> {
  let byPosition = handlers.get(schema)
  if (byPosition === undefined) {
    byPosition = new Map()
    handlers.set(schema, byPosition)
  }
  let handler = byPosition.get(position)
  if (handler !== undefined) return handler

  const variant = (target: RefFunction, key: string | number): RefFunction => {
    const state = target[STATE]
    state.children ??= {}
    let ref = state.children[key]
    if (ref === undefined) {
      const variantSchema =
        typeof key === "string"
          ? (schema as DiscriminatedSumSchema).variantMap[key]
          : (schema as PositionalSumSchema).variants[key]
      if (variantSchema === undefined) {
        throw new Error(`A sum has no variant ${String(key)}.`)
      }
      ref = createRefAt(
        state.ctx,
        state.path,
        variantSchema,
        position,
        state.ref,
      )
      state.children[key] = ref
    }
    return ref
  }
  const active = (target: RefFunction): object => {
    const state = target[STATE]
    return (
      dispatchSum(valueAt(state.ctx, state.path), schema, {
        byKey: key => variant(target, key),
        byIndex: index => variant(target, index),
      }) ?? target
    )
  }

  handler = {
    get: (target, prop) => Reflect.get(active(target), prop),
    has: (target, prop) => Reflect.has(active(target), prop),
    set: (target, prop, value) => Reflect.set(active(target), prop, value),
    ownKeys: target => Reflect.ownKeys(active(target)),
    getOwnPropertyDescriptor: (target, prop) =>
      Reflect.getOwnPropertyDescriptor(active(target), prop),
    apply: (target, thisArg, args) =>
      Reflect.apply(
        active(target) as (...args: unknown[]) => unknown,
        thisArg,
        args,
      ),
  }
  byPosition.set(position, handler)
  return handler
}
