// write — every write operation of each kind, and `[TRANSACT]` and `[PATH]`.
//
// A write builds its change and dispatches it at the ref's own path; the
// writable context does the rest (`ctx.dispatch`, `ctx.prepare`). Every value
// a write carries is owned first (`own`), so the op keeps a value rather than
// a view of the caller's object.

import type { TreeInstruction } from "../change.js"
import {
  incrementChange,
  mapChange,
  mapClearChange,
  own,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  textChange,
  treeChange,
  trustAsOwned,
} from "../change.js"
import { completeValue } from "../complete.js"
import { subtreeIds } from "../forest.js"
import { isPlainObject, samePlainValue } from "../guards.js"
import type { FlatTreeNode } from "../interpret.js"
import { PATH, TRANSACT } from "../interpreters/writable.js"
import { RawPath } from "../path.js"
import { KIND, type Schema as SchemaNode } from "../schema.js"
import { hasTreeNodeAllocation, TREE_NODE_ALLOCATE } from "../substrate.js"
import { getter, method } from "./read.js"
import { stateOf } from "./state.js"

/**
 * Position a cursor at `index`, then apply `op`: the positional primitive
 * every indexed write (insert, delete, format) is built from.
 */
export const at = <T>(index: number, op: T): (T | { retain: number })[] =>
  index > 0 ? [{ retain: index }, op] : [op]

/** The write members of a ref of `schema`. */
export function writeMembers(schema: SchemaNode): PropertyDescriptorMap {
  const members: PropertyDescriptorMap = {
    [TRANSACT]: getter(function (this: unknown) {
      return stateOf(this, "[TRANSACT]").ctx
    }),
    [PATH]: getter(function (this: unknown) {
      return stateOf(this, "[PATH]").path
    }),
  }
  switch (schema[KIND]) {
    case "scalar":
    case "product":
      members.set = method(function set(this: unknown, value: unknown): void {
        const { ctx, path } = stateOf(this, "set")
        ctx.dispatch(path, replaceChange(own(value)))
      })
      break
    case "counter":
      members.increment = method(function increment(
        this: unknown,
        n = 1,
      ): void {
        const { ctx, path } = stateOf(this, "increment")
        ctx.dispatch(path, incrementChange(n))
      })
      members.decrement = method(function decrement(
        this: unknown,
        n = 1,
      ): void {
        const { ctx, path } = stateOf(this, "decrement")
        ctx.dispatch(path, incrementChange(-n))
      })
      break
    case "text":
      Object.assign(members, textMembers())
      break
    case "richtext":
      Object.assign(members, richTextMembers())
      break
    case "sequence":
    case "movable":
      Object.assign(members, listMembers())
      break
    case "map":
      Object.assign(members, recordMembers())
      break
    case "set":
      Object.assign(members, setMembers())
      break
    case "tree":
      Object.assign(members, treeMembers(schema.item))
      break
  }
  return members
}

function textMembers(): PropertyDescriptorMap {
  return {
    insert: method(function insert(
      this: unknown,
      index: number,
      content: string,
    ): void {
      const { ctx, path } = stateOf(this, "insert")
      ctx.dispatch(path, textChange(at(index, { insert: content })))
    }),
    delete: method(function (this: unknown, index: number, length: number) {
      const { ctx, path } = stateOf(this, "delete")
      ctx.dispatch(path, textChange(at(index, { delete: length })))
    }),
    update: method(function update(this: unknown, content: string): void {
      const { ctx, path } = stateOf(this, "update")
      const current = ctx.reader.read(path)
      const length = typeof current === "string" ? current.length : 0
      ctx.dispatch(
        path,
        textChange([
          ...(length > 0 ? [{ delete: length }] : []),
          { insert: content },
        ]),
      )
    }),
  }
}

function richTextMembers(): PropertyDescriptorMap {
  return {
    insert: method(function insert(
      this: unknown,
      index: number,
      content: string,
      marks?: Record<string, unknown>,
    ): void {
      const { ctx, path } = stateOf(this, "insert")
      ctx.dispatch(
        path,
        richTextChange(
          at(
            index,
            marks
              ? { insert: content, marks: own(marks) }
              : { insert: content },
          ),
        ),
      )
    }),
    delete: method(function (this: unknown, index: number, length: number) {
      const { ctx, path } = stateOf(this, "delete")
      ctx.dispatch(path, richTextChange(at(index, { delete: length })))
    }),
    update: method(function update(this: unknown, content: string): void {
      const { ctx, path } = stateOf(this, "update")
      const current = ctx.reader.read(path)
      const length = Array.isArray(current)
        ? (current as { text: string }[]).reduce(
            (sum, span) => sum + span.text.length,
            0,
          )
        : 0
      ctx.dispatch(
        path,
        richTextChange([
          ...(length > 0 ? [{ delete: length }] : []),
          { insert: content },
        ]),
      )
    }),
    mark: method(function mark(
      this: unknown,
      start: number,
      end: number,
      key: string,
      value: unknown,
    ): void {
      const { ctx, path } = stateOf(this, "mark")
      ctx.dispatch(
        path,
        richTextChange(
          at(start, { format: end - start, marks: own({ [key]: value }) }),
        ),
      )
    }),
    unmark: method(function unmark(
      this: unknown,
      start: number,
      end: number,
      key: string,
    ): void {
      const { ctx, path } = stateOf(this, "unmark")
      ctx.dispatch(
        path,
        richTextChange(
          at(start, { format: end - start, marks: own({ [key]: null }) }),
        ),
      )
    }),
  }
}

function listMembers(): PropertyDescriptorMap {
  return {
    push: method(function push(this: unknown, ...items: unknown[]): void {
      const { ctx, path } = stateOf(this, "push")
      const length = ctx.reader.arrayLength(path)
      ctx.dispatch(
        path,
        sequenceChange([
          { retain: length },
          { insert: items.map(item => own(item)) },
        ]),
      )
    }),
    insert: method(function insert(
      this: unknown,
      index: number,
      ...items: unknown[]
    ): void {
      const { ctx, path } = stateOf(this, "insert")
      ctx.dispatch(
        path,
        sequenceChange(at(index, { insert: items.map(item => own(item)) })),
      )
    }),
    delete: method(function (this: unknown, index: number, count = 1) {
      const { ctx, path } = stateOf(this, "delete")
      ctx.dispatch(path, sequenceChange(at(index, { delete: count })))
    }),
  }
}

function recordMembers(): PropertyDescriptorMap {
  return {
    set: method(function set(this: unknown, key: string, value: unknown) {
      const { ctx, path } = stateOf(this, "set")
      ctx.dispatch(path, mapChange(own({ [key]: value })))
    }),
    delete: method(function (this: unknown, key: string): void {
      const { ctx, path } = stateOf(this, "delete")
      ctx.dispatch(path, mapChange(undefined, [key]))
    }),
    // Dispatches the intent, not the keys this peer can see, and dispatches
    // it even when it sees none: which keys a clear reaches is the
    // substrate's merge law to decide. The ephemeral substrate also removes
    // older entries that have not arrived yet.
    clear: method(function clear(this: unknown): void {
      const { ctx, path } = stateOf(this, "clear")
      ctx.dispatch(path, mapClearChange())
    }),
  }
}

/**
 * A set's writes, by value: `add` is idempotent by content, and `delete`
 * answers whether the value was a member, as `Set.prototype.delete` does.
 */
function setMembers(): PropertyDescriptorMap {
  const membersOf = (ref: unknown, name: string) => {
    const state = stateOf(ref, name)
    const value = state.ctx.reader.read(state.path)
    return { state, members: Array.isArray(value) ? value : [] }
  }
  return {
    add: method(function add(this: unknown, value: unknown): void {
      const { ctx, path } = stateOf(this, "add")
      ctx.dispatch(path, setOpChange([own(value)]))
    }),
    delete: method(function (this: unknown, value: unknown): boolean {
      const { state, members } = membersOf(this, "delete")
      const present = members.some(m => samePlainValue(m, value))
      if (present) {
        state.ctx.dispatch(state.path, setOpChange(undefined, [value]))
      }
      return present
    }),
    clear: method(function clear(this: unknown): void {
      const { state, members } = membersOf(this, "clear")
      if (members.length > 0) {
        // A copy: the store compacts the members array in place, and the op
        // must still name what it removed.
        state.ctx.dispatch(state.path, setOpChange(undefined, [...members]))
      }
    }),
  }
}

/**
 * A tree's writes. `.create` is the only one with a substrate effect: id
 * allocation (`[TREE_NODE_ALLOCATE]`), since peers need a globally agreed id
 * from the start. Within a `batch()`, a `.delete(id)` of a node created
 * earlier in the same batch sees the topology before the batch and deletes
 * nothing.
 */
function treeMembers(item: SchemaNode): PropertyDescriptorMap {
  return {
    create: method(function create(
      this: unknown,
      opts?: {
        parent?: string | null
        index?: number
        data?: Record<string, unknown>
      },
    ): string {
      const { ctx, path } = stateOf(this, "create")
      if (!hasTreeNodeAllocation(ctx)) {
        throw new Error(
          "WritableTreeRef.create: substrate does not implement TREE_NODE_ALLOCATE",
        )
      }
      const parent = opts?.parent ?? null
      // Default index = append under the parent. Computed before allocation,
      // so a substrate (Loro) can place the node in one native call.
      const siblings = ctx.reader
        .forestTopology(path)
        .filter(n => n.parent === parent)
      const index = opts?.index ?? siblings.length
      const id = ctx[TREE_NODE_ALLOCATE](path, parent, index)
      const instructions: TreeInstruction[] = [
        { action: "create", target: id, parent, index },
      ]
      ctx.dispatch(path, treeChange(instructions))
      // The data lands as a map change at the new node's data path, separate
      // from the create instruction. A map change on a struct writes only the
      // fields it names, so the data is completed here: every field is named.
      // The node's path is located, not navigated: no ref is made for it.
      const data = completeValue(item, own(opts?.data ?? {}))
      if (isPlainObject(data)) {
        // `own` copied the caller's data, and completion adds only zeros
        // built for this call.
        ctx.dispatch(
          path.concat(RawPath.empty.node(id)),
          mapChange(trustAsOwned(data)),
        )
      }
      return id
    }),
    delete: method(function (this: unknown, id: string): void {
      const { ctx, path } = stateOf(this, "delete")
      const flat = ctx.reader.forestTopology(path).map(n => ({
        id: n.id,
        parent: n.parent,
        index: n.index,
        data: undefined,
      })) as readonly FlatTreeNode<unknown>[]
      const ids = subtreeIds(flat, id)
      if (ids.length === 0) return
      // Post-order: descendants before the target, so a peer applying them
      // one by one never sees a node whose child is already gone.
      ctx.dispatch(
        path,
        treeChange(
          [...ids].reverse().map(target => ({ action: "delete", target })),
        ),
      )
    }),
    move: method(function move(
      this: unknown,
      id: string,
      opts: { parent: string | null; index: number },
    ): void {
      const { ctx, path } = stateOf(this, "move")
      ctx.dispatch(
        path,
        treeChange([
          {
            action: "move",
            target: id,
            parent: opts.parent,
            index: opts.index,
          },
        ]),
      )
    }),
  }
}
