// prototype — what a ref does, built once per schema node and position.
//
// Everything that depends only on the schema is computed here, once, into a
// template: a prototype, the function a ref binds, and the ref's own
// properties. Each coordinate then costs one bound function and one state
// record (`create.ts`). Each concern's module contributes its members by kind:
// reading (`read.ts`), navigation (`navigate.ts`), writing (`write.ts`),
// observation (`observe.ts`) and deletion and removal (`address.ts`), and
// every member reports its own reads to a tracking scope (`track.ts`).
//
// Members reach the ref's state through `this` (`stateOf`), so a member taken
// off its ref and called on its own throws an error naming it.

import { NATIVE } from "../native.js"
import { POSITION } from "../position.js"
import {
  KIND,
  type RichTextSchema,
  type Schema as SchemaNode,
  type TextSchema,
} from "../schema.js"
import { addressMembers } from "./address.js"
import { fieldDescriptors, LENGTH, navigateMembers } from "./navigate.js"
import { observeMembers } from "./observe.js"
import { getter, readAspect, readMembers, readRef } from "./read.js"
import { lazySlots, type RefState, refBase, STATE, stateOf } from "./state.js"
import { writeMembers } from "./write.js"

/**
 * Where a ref sits: the document's root, a declared field, a tree node, or a
 * container child that `[REMOVE]` can take out (a list item or record entry;
 * a set has no member refs). `[DELETED]` and `[REMOVE]` depend on it.
 */
export type RefPosition = "root" | "field" | "child" | "removable"

/** What every ref of one schema node at one position shares. */
export interface RefTemplate {
  /**
   * What calling the ref does: `ref()` reads, and `ref(STATE)` is its state.
   * Its own prototype is the refs' prototype, and a function bound to it
   * inherits that, so a ref is `call` bound to its state.
   */
  readonly call: (this: RefState, key?: unknown) => unknown
  /**
   * The ref's own properties: a product's fields, enumerable so
   * `Object.keys(ref)` lists them, and a list's `length`, which the bound
   * function's own `length` (its parameter count) would otherwise shadow.
   */
  readonly own: readonly (readonly [string, PropertyDescriptor])[]
}

const templates = new WeakMap<SchemaNode, Map<RefPosition, RefTemplate>>()

/**
 * The template of every ref of `schema` at `position`. Cached per schema
 * node and position: one schema node can sit in several positions (a struct
 * that is both a record's item and a field). Its prototype inherits
 * `refBase`.
 */
export function templateFor(
  schema: SchemaNode,
  position: RefPosition,
): RefTemplate {
  let byPosition = templates.get(schema)
  if (byPosition === undefined) {
    byPosition = new Map()
    templates.set(schema, byPosition)
  }
  let template = byPosition.get(position)
  if (template === undefined) {
    const prototype = Object.create(refBase, {
      ...readMembers(schema),
      ...navigateMembers(schema),
      ...writeMembers(schema),
      ...observeMembers(),
      ...addressMembers(position),
      ...nativeMembers(schema),
    }) as object
    const aspect = readAspect(schema)
    const call = function (this: RefState, key?: unknown): unknown {
      return key === STATE ? this : readRef(this.ref, this, aspect)
    }
    Object.setPrototypeOf(call, prototype)
    template = { call, own: ownProperties(schema) }
    byPosition.set(position, template)
  }
  return template
}

function ownProperties(
  schema: SchemaNode,
): readonly (readonly [string, PropertyDescriptor])[] {
  switch (schema[KIND]) {
    case "product":
      return Object.entries(fieldDescriptors(schema))
    case "sequence":
    case "movable":
      return [["length", LENGTH]]
    default:
      return []
  }
}

/**
 * `[NATIVE]`, which asks the substrate on each access, so it names what backs
 * the node now (a plain document's root is replaced when a write copies it);
 * and `[POSITION]` on a text, made on first access.
 */
function nativeMembers(schema: SchemaNode): PropertyDescriptorMap {
  const members: PropertyDescriptorMap = {
    [NATIVE]: getter(function (this: unknown): unknown {
      const { ctx, path } = stateOf(this, "[NATIVE]")
      return ctx.nativeResolver?.(schema, path)
    }),
  }
  if (schema[KIND] === "text" || schema[KIND] === "richtext") {
    const text = schema as TextSchema | RichTextSchema
    members[POSITION] = getter(function (this: unknown): unknown {
      const state = stateOf(this, "[POSITION]")
      const slots = lazySlots(state)
      slots.position ??= state.ctx.positionResolver?.(text, state.path)
      return slots.position
    })
  }
  return members
}
