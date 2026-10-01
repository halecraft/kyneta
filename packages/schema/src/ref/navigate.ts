// navigate — a ref's structural members: a product's fields, and the
// children of lists, records and trees.
//
// Navigation reveals child refs without reading values. A field ref is kept by
// its parent; a list item's, record entry's or tree node's ref is the
// coordinate's canonical one (`canonicalChild`), held weakly, so `at(k)`
// hands back the same ref for as long as something holds it.

import type { ForestNode } from "../forest.js"
import { nestForest } from "../forest.js"
import type { FlatTreeNode } from "../interpret.js"
import { rawField } from "../path.js"
import { childOf } from "../plain-access.js"
import {
  KIND,
  type ProductSchema,
  type Schema as SchemaNode,
} from "../schema.js"
import { canonicalChild, createRefAt } from "./create.js"
import { getter, method, valueAt } from "./read.js"
import { type RefFunction, stateOf } from "./state.js"
import { report } from "./track.js"

// ---------------------------------------------------------------------------
// Product fields — own, enumerable accessors, shared per product schema
// ---------------------------------------------------------------------------

const fieldsByProduct = new WeakMap<ProductSchema, PropertyDescriptorMap>()

/**
 * The accessors a product ref defines as its own enumerable properties, so
 * `Object.keys(ref)` lists the fields. The getter functions are made once per
 * product schema and shared by every ref of it.
 *
 * A field's ref is made on first access and kept by its parent: two variants
 * of a sum can declare one field name with different schemas, so a field ref
 * is per parent, never per coordinate. A discriminant reads as its raw value,
 * which keeps TypeScript's narrowing (`ref.type === "text"`) working and the
 * discriminant read-only.
 */
export function fieldDescriptors(schema: ProductSchema): PropertyDescriptorMap {
  let descriptors = fieldsByProduct.get(schema)
  if (descriptors !== undefined) return descriptors
  descriptors = {}
  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    descriptors[key] = {
      get:
        key === schema.discriminantKey
          ? discriminant(key)
          : field(key, fieldSchema as SchemaNode),
      enumerable: true,
      configurable: true,
    }
  }
  fieldsByProduct.set(schema, descriptors)
  return descriptors
}

function field(key: string, schema: SchemaNode): (this: unknown) => unknown {
  return function (this: unknown): unknown {
    const state = stateOf(this, key)
    let ref = state.children?.[key]
    if (ref === undefined) {
      ref = createRefAt(
        state.ctx,
        state.path.field(key),
        schema,
        "field",
        this as RefFunction,
      )
      state.children ??= {}
      state.children[key] = ref
    }
    return ref
  }
}

function discriminant(key: string): (this: unknown) => unknown {
  const segment = rawField(key)
  return function (this: unknown): unknown {
    const state = stateOf(this, key)
    return childOf(valueAt(state.ctx, state.path), segment)
  }
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * A list ref's `length`, defined on each list ref itself: a function's own
 * `length` (its parameter count) would shadow a getter on the prototype.
 */
export const LENGTH: PropertyDescriptor = {
  get(this: unknown): number {
    const state = stateOf(this, "length")
    report(this, state, "structure")
    return state.ctx.reader.arrayLength(state.path)
  },
  enumerable: false,
  configurable: true,
}

/** The structural members of a ref of `schema`. */
export function navigateMembers(schema: SchemaNode): PropertyDescriptorMap {
  switch (schema[KIND]) {
    case "sequence":
    case "movable":
      return sequenceMembers(schema.item)
    case "map":
      return mapMembers(schema.item)
    case "tree":
      return treeMembers(schema.item)
    default:
      return {}
  }
}

function sequenceMembers(item: SchemaNode): PropertyDescriptorMap {
  return {
    at: method(function at(this: unknown, index: number): unknown {
      const state = stateOf(this, "at")
      report(this, state, "structure")
      const length = state.ctx.reader.arrayLength(state.path)
      if (index < 0 || index >= length) return undefined
      return canonicalChild(
        this as RefFunction,
        state.path.item(index),
        item,
        "removable",
      )
    }),
    [Symbol.iterator]: method(function* (
      this: unknown,
    ): IterableIterator<unknown> {
      const state = stateOf(this, "Symbol.iterator")
      report(this, state, "structure")
      const list = this as { at(index: number): unknown }
      const length = state.ctx.reader.arrayLength(state.path)
      for (let i = 0; i < length; i++) yield list.at(i)
    }),
  }
}

function mapMembers(item: SchemaNode): PropertyDescriptorMap {
  const keysOf = (ref: unknown, name: string): string[] => {
    const state = stateOf(ref, name)
    report(ref, state, "structure")
    return state.ctx.reader.keys(state.path)
  }
  return {
    at: method(function at(this: unknown, key: string): unknown {
      const state = stateOf(this, "at")
      report(this, state, "structure")
      if (!state.ctx.reader.hasKey(state.path, key)) return undefined
      return canonicalChild(
        this as RefFunction,
        state.path.entry(key),
        item,
        "removable",
      )
    }),
    has: method(function has(this: unknown, key: string): boolean {
      const state = stateOf(this, "has")
      report(this, state, "structure")
      return state.ctx.reader.hasKey(state.path, key)
    }),
    keys: method(function keys(this: unknown): string[] {
      return keysOf(this, "keys")
    }),
    size: getter(function size(this: unknown): number {
      return keysOf(this, "size").length
    }),
    entries: method(function* entries(
      this: unknown,
    ): IterableIterator<[string, unknown]> {
      const record = this as { at(key: string): unknown }
      for (const key of keysOf(this, "entries")) yield [key, record.at(key)]
    }),
    values: method(function* values(this: unknown): IterableIterator<unknown> {
      const record = this as { at(key: string): unknown }
      for (const key of keysOf(this, "values")) yield record.at(key)
    }),
    [Symbol.iterator]: method(function* (
      this: unknown,
    ): IterableIterator<[string, unknown]> {
      const record = this as { at(key: string): unknown }
      for (const key of keysOf(this, "Symbol.iterator")) {
        yield [key, record.at(key)]
      }
    }),
  }
}

/**
 * A tree's members. Topology comes from `reader.forestTopology`: over the
 * flat shadow, `hasKey` would answer by array index, not by node id.
 */
function treeMembers(item: SchemaNode): PropertyDescriptorMap {
  const topologyOf = (ref: unknown, name: string) => {
    const state = stateOf(ref, name)
    report(ref, state, "structure")
    return state.ctx.reader.forestTopology(state.path)
  }
  /** The forest nested, each node's `data` its canonical ref. */
  const roots = (
    ref: unknown,
    name: string,
  ): readonly ForestNode<unknown>[] => {
    const tree = ref as { node(id: string): unknown }
    const flat: FlatTreeNode<unknown>[] = topologyOf(ref, name).map(t => ({
      id: t.id,
      parent: t.parent,
      index: t.index,
      data: tree.node(t.id),
    }))
    return nestForest(flat)
  }
  return {
    node: method(function node(this: unknown, id: string): unknown {
      const state = stateOf(this, "node")
      if (!topologyOf(this, "node").some(n => n.id === id)) return undefined
      return canonicalChild(
        this as RefFunction,
        state.path.node(id),
        item,
        "child",
      )
    }),
    has: method(function has(this: unknown, id: string): boolean {
      return topologyOf(this, "has").some(n => n.id === id)
    }),
    ids: method(function ids(this: unknown): string[] {
      return topologyOf(this, "ids").map(n => n.id)
    }),
    size: getter(function size(this: unknown): number {
      return topologyOf(this, "size").length
    }),
    roots: getter(function (this: unknown): readonly ForestNode<unknown>[] {
      return roots(this, "roots")
    }),
    [Symbol.iterator]: method(function* (
      this: unknown,
    ): IterableIterator<ForestNode<unknown>> {
      function* walk(
        nodes: readonly ForestNode<unknown>[],
      ): IterableIterator<ForestNode<unknown>> {
        for (const n of nodes) {
          yield n
          yield* walk(n.children)
        }
      }
      yield* walk(roots(this, "Symbol.iterator"))
    }),
  }
}
