// revertible — undo for a Loro document, from its own history.
//
// A record is one local commit's frontiers: the document's version before it
// and the commit's last op. Loro keeps every op, so the commit's inverse is
// `diff(after, before)`, computed at undo time, after a reload as well.
//
// What happened since is read by content: the document forked at `after`
// (`forkAt`) against the document now. A text or list's inverse is rebased
// over the shortest edit between the two (`diffString`, `diffSequence`,
// then `rebaseChange`); a map key or a tree node's parent is restored only
// while it still holds what the commit left there (`planValueRestores`); a
// counter always reverts. Content rather than op identity, because a revert
// that restores deleted text inserts new ops: by identity the older step's
// text would be gone, by content it is back where it was.
//
// A revert that restores a deleted container re-creates it (Loro cannot
// undelete), so it returns a remap from the old container ids to the new
// ones. `rewrite` turns that into aliases on the records left behind.
//
// The revert is applied with `applyDiff`, not through Kyneta's own write
// path: `changeToDiff` filters out the create that restores a deleted tree
// node. The substrate's event bridge announces the commit as a local write.
//
// A shallow snapshot cuts `diff` off: a record older than it reverts to null.

import {
  type ChangeBase,
  type CommitOptions,
  diffSequence,
  diffString,
  isRichTextChange,
  isSequenceChange,
  jsonRecordCodec,
  type Op,
  type Owned,
  type OwnedRichTextInstruction,
  planValueRestores,
  type Remap,
  type Revertible,
  type RevertibleCommit,
  rebaseChange,
  richTextChange,
  type SequenceInstruction,
  samePlainValue,
  sequenceChange,
  trustAsOwned,
} from "@kyneta/schema"
import type {
  Container,
  ContainerID,
  Delta,
  Diff,
  LoroDoc,
  OpId,
  TreeDiff,
  TreeDiffItem,
  TreeID,
} from "loro-crdt"
import {
  applyDiffGroup,
  hasKind,
  isLoroContainer,
  listDiffDeltas,
  mapDiffUpdated,
} from "./loro-guards.js"

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** A container or tree node re-created by a revert, standing in for the
 *  one it replaced. Container ids and tree ids never collide: a container id
 *  starts with `cid:`. */
export interface Alias {
  readonly from: string
  readonly to: string
}

export interface LoroRecord {
  readonly before: readonly OpId[]
  readonly after: readonly OpId[]
  readonly aliases: readonly Alias[]
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Where a container or tree node lives now, through every alias. */
function aliasOf<I extends string>(id: I, aliases: readonly Alias[]): I {
  const seen = new Set<string>()
  let to: string = id
  for (;;) {
    seen.add(to)
    const from = to
    const hop = aliases.find(a => a.from === from)
    // The alias stands in for an id of the same kind.
    if (hop === undefined || seen.has(hop.to)) return to as I
    to = hop.to
  }
}

/** `record` with an alias for every container and node of `remap`. */
function rewriteLoroRecord(record: LoroRecord, remap: Remap): LoroRecord {
  const added: Alias[] = []
  for (const [from, to] of remap) {
    if (record.aliases.some(a => a.from === from)) continue
    added.push({ from, to })
  }
  return added.length === 0
    ? record
    : { ...record, aliases: [...record.aliases, ...added] }
}

/** A text diff as a rich-text change: Loro attributes are Kyneta marks. */
function textToChange(diff: readonly Delta<string>[]): ChangeBase {
  // Loro builds each diff fresh, so its attributes are unshared.
  const instructions: OwnedRichTextInstruction[] = diff.map(d => {
    if (d.insert !== undefined) {
      return d.attributes && Object.keys(d.attributes).length > 0
        ? { insert: d.insert, marks: trustAsOwned(d.attributes) }
        : { insert: d.insert }
    }
    if (d.delete !== undefined) return { delete: d.delete }
    return d.attributes && Object.keys(d.attributes).length > 0
      ? { format: d.retain ?? 0, marks: trustAsOwned(d.attributes) }
      : { retain: d.retain ?? 0 }
  })
  return richTextChange(instructions)
}

function changeToText(change: ChangeBase): Delta<string>[] {
  if (!isRichTextChange(change)) return []
  return change.instructions.map(i => {
    if ("insert" in i) {
      return i.marks === undefined
        ? { insert: i.insert }
        : { insert: i.insert, attributes: { ...i.marks } }
    }
    if ("delete" in i) return { delete: i.delete }
    if ("format" in i) return { retain: i.format, attributes: { ...i.marks } }
    return { retain: i.retain }
  }) as Delta<string>[]
}

/** A list diff as a sequence change. Items stay as Loro gave them, so a
 *  container in an insert is re-created by `applyDiff`. */
function listToChange(diff: readonly Delta<unknown[]>[]): ChangeBase {
  // Loro builds each diff fresh.
  const instructions: SequenceInstruction<Owned<unknown>>[] = diff.map(d => {
    if (d.insert !== undefined) {
      return { insert: d.insert.map(item => trustAsOwned(item)) }
    }
    if (d.delete !== undefined) return { delete: d.delete }
    return { retain: d.retain ?? 0 }
  })
  return sequenceChange(instructions)
}

function changeToList(change: ChangeBase): Delta<unknown[]>[] {
  if (!isSequenceChange(change)) return []
  return change.instructions.map(i => {
    if ("insert" in i) return { insert: [...(i.insert as unknown[])] }
    if ("delete" in i) return { delete: i.delete }
    return { retain: i.retain }
  }) as Delta<unknown[]>[]
}

/** A value, with any container as the plain value it holds. */
function plain(value: unknown): unknown {
  return hasKind(value) && "toJSON" in value
    ? (value as { toJSON(): unknown }).toJSON()
    : value
}

/** A container restored by a revert, and where it lands. */
type Restore =
  | {
      readonly kind: "container"
      readonly old: Container
      readonly parent: ContainerID
      readonly key: string | number
    }
  | {
      readonly kind: "node"
      readonly tree: ContainerID
      readonly target: TreeID
      readonly parent: TreeID | undefined
      readonly index: number
    }

/** What a group of diffs re-creates, and where each lands: a container
 *  inserted into a list or set as a map value, or a tree node created. */
function restoresOf(
  group: readonly (readonly [ContainerID, unknown])[],
): Restore[] {
  const out: Restore[] = []
  for (const [parent, diff] of group) {
    if (isTreeDiff(diff)) {
      for (const item of diff.diff) {
        if (item.action !== "create") continue
        out.push({
          kind: "node",
          tree: parent,
          target: item.target,
          parent: item.parent,
          index: item.index,
        })
      }
      continue
    }
    const updated = mapDiffUpdated(diff)
    if (updated !== undefined) {
      for (const [key, value] of Object.entries(updated)) {
        if (isLoroContainer(value)) {
          out.push({
            kind: "container",
            old: value as unknown as Container,
            parent,
            key,
          })
        }
      }
      continue
    }
    let index = 0
    for (const d of listDiffDeltas(diff) ?? []) {
      if (Array.isArray(d.insert)) {
        d.insert.forEach((item: unknown, k: number) => {
          if (isLoroContainer(item)) {
            out.push({
              kind: "container",
              old: item as unknown as Container,
              parent,
              key: index + k,
            })
          }
        })
        index += d.insert.length
      } else if (typeof d.retain === "number") index += d.retain
    }
  }
  return out
}

/** What undo reads of a Loro tree and its nodes. */
interface TreeNodeLike {
  readonly id: TreeID
  readonly data: unknown
  parent(): { id: TreeID } | undefined
  children(): TreeNodeLike[] | undefined
  isDeleted(): boolean
}
interface TreeLike {
  getNodeByID(id: TreeID): TreeNodeLike | undefined
  roots(): TreeNodeLike[]
}

function isTreeDiff(diff: unknown): diff is TreeDiff {
  return (
    diff !== null &&
    typeof diff === "object" &&
    (diff as { type?: unknown }).type === "tree"
  )
}

// ---------------------------------------------------------------------------
// Codec and position
// ---------------------------------------------------------------------------

const codec = jsonRecordCodec<LoroRecord>()

interface Position {
  readonly peer: `${number}`
  readonly counter: number
  readonly frontiers: readonly OpId[]
}

const decodePosition = (bytes: Uint8Array): Position =>
  JSON.parse(new TextDecoder().decode(bytes)) as Position

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export interface LoroRevertibleHost {
  readonly doc: LoroDoc
  /** Commit `work` natively, carrying `options` to the bridge's
   *  announcement. */
  commitNative(work: () => void, options: CommitOptions): void
}

/** A Loro substrate's undo, plus the hooks the substrate calls. */
export interface LoroRevertible extends Revertible<LoroRecord> {
  /** A local commit is about to happen (from the pre-commit hook). */
  committing(meta: {
    peer: `${number}`
    counter: number
    length: number
    deps: OpId[]
  }): void
  /** A local commit happened; `ops` are what it did, in Kyneta's terms.
   *  An aborted batch's commit records nothing. */
  committed(tail: OpId, ops: readonly Op[], aborted: boolean): void
}

export function createLoroRevertible(host: LoroRevertibleHost): LoroRevertible {
  const { doc } = host
  const listeners = new Set<(commit: RevertibleCommit<LoroRecord>) => void>()
  const pending = new Map<string, LoroRecord>()
  let reverting: { record: LoroRecord | null } | undefined

  const tailKey = (id: OpId) => `${id.peer}:${id.counter}`
  const containerIn = (
    source: LoroDoc,
    cid: ContainerID,
  ): Container | undefined => {
    if (!source.hasContainer(cid)) return undefined
    const container = source.getContainerById(cid)
    const deleted =
      container !== undefined &&
      "isDeleted" in container &&
      (container as { isDeleted(): boolean }).isDeleted()
    return deleted ? undefined : container
  }

  interface Plan {
    readonly group: [ContainerID, unknown][]
    readonly restores: Restore[]
  }

  /**
   * Gather what `record` concerns, at `after` and now, and decide the
   * revert. Null when nothing of it still stands, or `diff` cannot reach it.
   */
  function planRevert(record: LoroRecord): Plan | null {
    let inverse: [ContainerID, Diff][]
    let then: LoroDoc
    try {
      inverse = doc.diff([...record.after], [...record.before], false)
      then = doc.forkAt([...record.after])
    } catch {
      // Behind a shallow snapshot's start.
      return null
    }
    const group: [ContainerID, unknown][] = []

    for (const [cid, diff] of inverse) {
      const to = aliasOf(cid, record.aliases)
      const now = containerIn(doc, to)
      const was = then.getContainerById(cid)
      if (now === undefined) {
        // Gone: either re-created by a restore in this same group, which
        // `applyDiff` fills from these diffs, or gone for good, which a diff
        // to it leaves as it is.
        group.push([to, diff])
        continue
      }
      if (was === undefined) continue

      if (diff.type === "text") {
        const since = diffString(
          (was as unknown as { toString(): string }).toString(),
          (now as unknown as { toString(): string }).toString(),
        )
        // Built here, of plain retain/insert/delete instructions.
        const over = richTextChange(since as OwnedRichTextInstruction[])
        const change = rebaseChange(textToChange(diff.diff), over)
        const text = change === null ? [] : changeToText(change)
        if (text.length > 0) group.push([to, { type: "text", diff: text }])
        continue
      }

      if (diff.type === "list") {
        const items = (list: Container) =>
          ((list as unknown as { toArray(): unknown[] }).toArray() ?? []).map(
            plain,
          )
        const over = sequenceChange(
          trustAsOwned(
            diffSequence(items(was), items(now), samePlainValue),
          ) as SequenceInstruction<Owned<unknown>>[],
        )
        const change = rebaseChange(listToChange(diff.diff), over)
        const list = change === null ? [] : changeToList(change)
        if (list.length > 0) group.push([to, { type: "list", diff: list }])
        continue
      }

      if (diff.type === "map") {
        const get = (map: Container, key: string) =>
          plain((map as unknown as { get(key: string): unknown }).get(key))
        const kept = planValueRestores(
          Object.entries(diff.updated).map(([key, previous]) => ({
            key,
            wrote: get(was, key),
            previous,
            current: get(now, key),
          })),
        )
        if (kept.length === 0) continue
        group.push([
          to,
          {
            type: "map",
            updated: Object.fromEntries(kept.map(p => [p.key, p.previous])),
          },
        ])
        continue
      }

      if (diff.type === "tree") {
        const nowTree = now as unknown as TreeLike
        const thenTree = was as unknown as TreeLike
        const alias = <I extends string>(id: I | undefined) =>
          id === undefined ? undefined : aliasOf(id, record.aliases)
        const items: TreeDiffItem[] = []
        for (const item of diff.diff) {
          // A node an earlier revert re-created answers to its new id.
          const target = aliasOf(item.target, record.aliases)
          const node = nowTree.getNodeByID(target)
          if (item.action === "create") {
            if (node === undefined || node.isDeleted()) {
              items.push({ ...item, target, parent: alias(item.parent) })
            }
            continue
          }
          if (node === undefined || node.isDeleted()) continue
          if (item.action === "delete") {
            items.push({ ...item, target, oldParent: alias(item.oldParent) })
            continue
          }
          const placed = alias(thenTree.getNodeByID(item.target)?.parent()?.id)
          if (node.parent()?.id !== placed) continue
          items.push({
            ...item,
            target,
            parent: alias(item.parent),
            oldParent: alias(item.oldParent),
          })
        }
        if (items.length > 0) group.push([to, { type: "tree", diff: items }])
        continue
      }

      // A counter commutes: its inverse always applies.
      group.push([to, diff])
    }

    return group.length === 0 ? null : { group, restores: restoresOf(group) }
  }

  /** Pair each restored container, and those inside it, with its new id. */
  function remapOf(restores: readonly Restore[]): Remap {
    const remap = new Map<string, string>()
    const pair = (old: unknown, fresh: unknown) => {
      if (!isLoroContainer(old) || !isLoroContainer(fresh)) return
      if (old.id === fresh.id) return
      remap.set(old.id, fresh.id)
      const kind = old.kind()
      if (kind === "Map") {
        const o = old as unknown as {
          keys(): string[]
          get(k: string): unknown
        }
        const f = fresh as unknown as { get(k: string): unknown }
        for (const key of o.keys()) pair(o.get(key), f.get(key))
      } else if (kind === "List" || kind === "MovableList") {
        const o = old as unknown as { length: number; get(i: number): unknown }
        const f = fresh as unknown as { get(i: number): unknown }
        for (let i = 0; i < o.length; i++) pair(o.get(i), f.get(i))
      }
    }
    for (const restore of restores) {
      if (restore.kind === "container") {
        const container = containerIn(doc, restore.parent) as unknown as
          | { get(key: string | number): unknown }
          | undefined
        pair(restore.old, container?.get(restore.key))
        continue
      }
      // A re-created node is the one now at the place its create named.
      const tree = containerIn(doc, restore.tree) as unknown as
        | TreeLike
        | undefined
      if (tree === undefined) continue
      const siblings =
        restore.parent === undefined
          ? tree.roots()
          : (tree.getNodeByID(restore.parent)?.children() ?? [])
      const fresh = siblings[restore.index]
      if (fresh === undefined || fresh.id === restore.target) continue
      remap.set(restore.target, fresh.id)
      pair(tree.getNodeByID(restore.target)?.data, fresh.data)
    }
    return remap
  }

  return {
    committing(meta) {
      if (listeners.size === 0 && reverting === undefined) return
      const tail = { peer: meta.peer, counter: meta.counter + meta.length - 1 }
      pending.set(tailKey(tail), {
        before: meta.deps,
        after: [tail],
        aliases: [],
      })
    },

    committed(tail, ops, aborted) {
      const record = pending.get(tailKey(tail))
      pending.delete(tailKey(tail))
      if (record === undefined) return
      if (reverting !== undefined) {
        reverting.record = record
        return
      }
      if (aborted || ops.length === 0) return
      for (const listener of [...listeners]) listener({ record, ops })
    },

    subscribeCommits(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    revert(record, options) {
      const plan = planRevert(record)
      if (plan === null) return null
      reverting = { record: null }
      try {
        host.commitNative(() => applyDiffGroup(doc, plan.group), options)
        const redo = reverting.record
        if (redo === null) return null
        return { redo, remap: remapOf(plan.restores) }
      } finally {
        reverting = undefined
      }
    },

    recovered(record, position) {
      const from = decodePosition(position)
      const counter = (doc.version().get(from.peer) ?? 0) - 1
      const after = [{ peer: from.peer, counter }]
      // What the revert restored is where the record's inverse puts it.
      let inverse: [ContainerID, Diff][] = []
      try {
        inverse = doc.diff([...record.after], [...record.before], false)
      } catch {}
      const restores = restoresOf(
        inverse.map(([cid, diff]) => [
          aliasOf(cid, record.aliases),
          isTreeDiff(diff)
            ? {
                ...diff,
                diff: diff.diff.map(item =>
                  item.action === "create"
                    ? {
                        ...item,
                        parent:
                          item.parent === undefined
                            ? undefined
                            : aliasOf(item.parent, record.aliases),
                      }
                    : item,
                ),
              }
            : diff,
        ]),
      )
      return {
        redo: { before: from.frontiers, after, aliases: [] },
        remap: remapOf(restores),
      }
    },

    rewrite: rewriteLoroRecord,

    position() {
      const peer = doc.peerIdStr
      const position: Position = {
        peer,
        counter: doc.version().get(peer) ?? 0,
        frontiers: doc.frontiers(),
      }
      return new TextEncoder().encode(JSON.stringify(position))
    },

    authoredSince(position) {
      const from = decodePosition(position)
      return (doc.version().get(from.peer) ?? 0) > from.counter
    },

    codec,
  }
}
