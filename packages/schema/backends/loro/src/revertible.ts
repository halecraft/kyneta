// revertible — undo for a Loro document, from its own history.
//
// A record is the frontiers of a run of back-to-back local commits: the
// document's version before the first and the last one's last op. Loro keeps
// every op, so the inverse is `diff(after, before)`, computed at undo time,
// after a reload as well. Two records compose only when the later was made on
// the earlier's last op and nothing else (`composeLoroRecords`).
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
// A shallow snapshot cuts `diff` off: a record older than it stands not at
// all.

import {
  addTally,
  type ChangeBase,
  type CommitOptions,
  changeUnits,
  diffSequence,
  diffString,
  EMPTY_TALLY,
  footprintOf,
  howMuchStands,
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
  type RevertPlan,
  rebaseChange,
  richTextChange,
  type Schema as SchemaNode,
  type SequenceInstruction,
  samePlainValue,
  sequenceChange,
  type Tally,
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

/** `earlier` then `later` as one record: back to back, `later` made on
 *  `earlier`'s last op and nothing else, as Loro's own undo manager joins
 *  commits only while no remote change has arrived. Null otherwise. */
export function composeLoroRecords(
  earlier: LoroRecord,
  later: LoroRecord,
): LoroRecord | null {
  const [tail, ...past] = earlier.after
  const [dep, ...more] = later.before
  if (
    tail === undefined ||
    dep === undefined ||
    past.length + more.length > 0 ||
    dep.peer !== tail.peer ||
    dep.counter !== tail.counter
  ) {
    return null
  }
  const aliases = [...earlier.aliases]
  for (const alias of later.aliases) {
    if (!aliases.some(a => a.from === alias.from)) aliases.push(alias)
  }
  return { before: earlier.before, after: later.after, aliases }
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

/**
 * A text diff without the formats that change nothing: a mark set to what
 * the character already holds at `after`, absent and null alike. Loro
 * reports one where a deleted mark's anchor outlives its text (unbolding
 * text never bold), and it names nothing the commit did.
 */
function withoutIdleFormats(
  diff: readonly Delta<string>[],
  marks: readonly Readonly<Record<string, unknown>>[],
): Delta<string>[] {
  const out: Delta<string>[] = []
  const push = (d: Delta<string>) => {
    const last = out.at(-1)
    if (
      last?.retain !== undefined &&
      d.retain !== undefined &&
      JSON.stringify(last.attributes) === JSON.stringify(d.attributes)
    ) {
      out[out.length - 1] = { ...last, retain: last.retain + d.retain }
      return
    }
    out.push(d)
  }
  let at = 0
  for (const d of diff) {
    if (d.insert !== undefined) {
      push(d)
      continue
    }
    if (d.delete !== undefined) {
      push(d)
      at += d.delete
      continue
    }
    const n = d.retain ?? 0
    const attributes = d.attributes ?? {}
    if (Object.keys(attributes).length === 0) {
      push({ retain: n })
      at += n
      continue
    }
    for (let k = 0; k < n; k++) {
      const held = marks[at + k] ?? {}
      const changed = Object.entries(attributes).filter(
        ([key, value]) => !samePlainValue(held[key] ?? null, value ?? null),
      )
      push(
        changed.length === 0
          ? { retain: 1 }
          : { retain: 1, attributes: Object.fromEntries(changed) },
      )
    }
    at += n
  }
  while (out.length > 0) {
    const last = out.at(-1)
    if (last?.retain === undefined || last.attributes !== undefined) break
    out.pop()
  }
  return out
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
// Revert planning, pure over what was gathered
// ---------------------------------------------------------------------------

/** A tree node a revert moves, deletes or re-creates, now and at `after`. */
export interface GatheredNode {
  /** Whether the node, under its current id, is there and not deleted. */
  readonly live: boolean
  readonly parent: TreeID | undefined
  /** Its parent at `after`, under its id then. */
  readonly placed: TreeID | undefined
}

/** What a container's revert decides by. */
export type GatheredState =
  /** The container is gone now. */
  | { readonly kind: "gone" }
  /** It was not there at `after`. */
  | { readonly kind: "unknown" }
  | {
      readonly kind: "text"
      readonly was: string
      readonly now: string
      /** Each character's marks at `after`. */
      readonly marks: readonly Readonly<Record<string, unknown>>[]
    }
  | {
      readonly kind: "list"
      readonly was: readonly unknown[]
      readonly now: readonly unknown[]
    }
  | {
      readonly kind: "map"
      /** The keys the inverse touches, at `after` and now. */
      readonly was: Readonly<Record<string, unknown>>
      readonly now: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: "tree"
      readonly nodes: Readonly<Record<string, GatheredNode>>
    }
  | { readonly kind: "other" }

/** One container of a record's inverse, with what was gathered of it. */
export interface LoroGathered {
  /** Where it lives now, through the record's aliases. */
  readonly to: ContainerID
  readonly diff: Diff
  readonly state: GatheredState
}

/** A revert of a Loro record: the diffs that apply, and how much of what the
 *  inverse names they keep. */
export interface LoroPlan {
  readonly tally: Tally
  readonly group: readonly (readonly [ContainerID, unknown])[]
}

/** How many units an inverse diff names: a text or list's inserted, deleted
 *  and formatted units, a map's keys, a tree's items, one for anything
 *  else (a counter). */
function inverseUnits(diff: Diff): number {
  switch (diff.type) {
    case "text":
      return changeUnits(textToChange(diff.diff))
    case "list":
      return changeUnits(listToChange(diff.diff))
    case "map":
      return Object.keys(diff.updated).length
    case "tree":
      return diff.diff.length
    default:
      return 1
  }
}

/**
 * The diffs that revert a record, decided from what was gathered of each
 * container, and its tally: per container, the units of the inverse the
 * rebased or kept diff still does. A text or list keeps the units its
 * rebase keeps (`changeUnits`); a map key, a tree item and a counter are one
 * unit each. A container gone now is re-created only by a restore in this
 * same group, which `applyDiff` fills from its diff; one gone for good, and
 * one that was not there at the time, keep nothing. A diff that would only
 * retain is left out, so a group that keeps anything writes something.
 */
export function planLoroRevert(
  aliases: readonly Alias[],
  gathered: readonly LoroGathered[],
): LoroPlan {
  const group: [ContainerID, unknown][] = []
  let tally = EMPTY_TALLY
  const count = (kept: number, total: number) => {
    tally = addTally(tally, { kept, total })
  }
  const alias = <I extends string>(id: I | undefined) =>
    id === undefined ? undefined : aliasOf(id, aliases)

  const gone: LoroGathered[] = []
  for (const entry of gathered) {
    const { to, diff, state } = entry
    if (state.kind === "gone") {
      gone.push(entry)
      continue
    }
    if (state.kind === "unknown") {
      count(0, inverseUnits(diff))
      continue
    }

    if (diff.type === "text" && state.kind === "text") {
      // Built here, of plain retain/insert/delete instructions.
      const over = richTextChange(
        diffString(state.was, state.now) as OwnedRichTextInstruction[],
      )
      const inverse = textToChange(withoutIdleFormats(diff.diff, state.marks))
      const change = rebaseChange(inverse, over)
      const kept = change === null ? 0 : changeUnits(change)
      count(kept, changeUnits(inverse))
      if (change !== null && kept > 0) {
        group.push([to, { type: "text", diff: changeToText(change) }])
      }
      continue
    }

    if (diff.type === "list" && state.kind === "list") {
      const over = sequenceChange(
        trustAsOwned(
          diffSequence(state.was, state.now, samePlainValue),
        ) as SequenceInstruction<Owned<unknown>>[],
      )
      const inverse = listToChange(diff.diff)
      const change = rebaseChange(inverse, over)
      const kept = change === null ? 0 : changeUnits(change)
      count(kept, changeUnits(inverse))
      if (change !== null && kept > 0) {
        group.push([to, { type: "list", diff: changeToList(change) }])
      }
      continue
    }

    if (diff.type === "map" && state.kind === "map") {
      const kept = planValueRestores(
        Object.entries(diff.updated).map(([key, previous]) => ({
          key,
          wrote: state.was[key],
          previous,
          current: state.now[key],
        })),
      )
      count(kept.length, inverseUnits(diff))
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

    if (diff.type === "tree" && state.kind === "tree") {
      const items: TreeDiffItem[] = []
      for (const item of diff.diff) {
        const node = state.nodes[item.target]
        const target = aliasOf(item.target, aliases)
        if (item.action === "create") {
          if (node === undefined || !node.live) {
            items.push({ ...item, target, parent: alias(item.parent) })
          }
          continue
        }
        if (node === undefined || !node.live) continue
        if (item.action === "delete") {
          items.push({ ...item, target, oldParent: alias(item.oldParent) })
          continue
        }
        // A node someone moved since stays where they put it.
        if (node.parent !== alias(node.placed)) continue
        items.push({
          ...item,
          target,
          parent: alias(item.parent),
          oldParent: alias(item.oldParent),
        })
      }
      count(items.length, inverseUnits(diff))
      if (items.length > 0) group.push([to, { type: "tree", diff: items }])
      continue
    }

    // A counter commutes: its inverse always applies.
    count(1, 1)
    group.push([to, diff])
  }

  // A gone container stands when a restore in the group re-creates it, and a
  // container it re-creates may hold another.
  const recreated = new Set<string>()
  for (let found = true; found; ) {
    found = false
    for (const restore of restoresOf(group)) {
      // A tree node's data is the map its id names.
      const id =
        restore.kind === "container"
          ? aliasOf(restore.old.id, aliases)
          : `cid:${restore.target}:Map`
      if (recreated.has(id)) continue
      recreated.add(id)
      const entry = gone.find(g => g.to === id)
      if (entry === undefined) continue
      group.push([entry.to, entry.diff])
      found = true
    }
  }
  for (const { to, diff } of gone) {
    const units = inverseUnits(diff)
    count(recreated.has(to) ? units : 0, units)
  }

  return { tally, group }
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
  /** The document, read through the substrate's slot: it throws
   *  `DocumentClosedError` once the substrate is disposed. */
  readonly doc: LoroDoc
  /** The document's schema: where a commit's ops landed, for its footprint. */
  readonly schema: SchemaNode
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

  /**
   * Read what `record` concerns, at `after` and now. Null when `diff`
   * cannot reach it: behind a shallow snapshot's start.
   */
  function gather(record: LoroRecord): LoroGathered[] | null {
    const doc = host.doc
    let inverse: [ContainerID, Diff][]
    let then: LoroDoc
    try {
      inverse = doc.diff([...record.after], [...record.before], false)
      then = doc.forkAt([...record.after])
    } catch {
      return null
    }
    return inverse.map(([cid, diff]) => {
      const to = aliasOf(cid, record.aliases)
      const now = containerIn(doc, to)
      const was = then.getContainerById(cid)
      return { to, diff, state: stateOf(diff, was, now, record.aliases) }
    })
  }

  /** What a revert of `diff` decides by, read from the container at
   *  `after` (`was`) and now. */
  function stateOf(
    diff: Diff,
    was: Container | undefined,
    now: Container | undefined,
    aliases: readonly Alias[],
  ): GatheredState {
    if (now === undefined) return { kind: "gone" }
    if (was === undefined) return { kind: "unknown" }
    switch (diff.type) {
      case "text":
        return {
          kind: "text",
          was: (was as unknown as { toString(): string }).toString(),
          now: (now as unknown as { toString(): string }).toString(),
          marks: (was as unknown as { toDelta(): Delta<string>[] })
            .toDelta()
            .flatMap(d =>
              Array.from({ length: d.insert?.length ?? 0 }, () => ({
                ...(d.attributes ?? {}),
              })),
            ),
        }
      case "list": {
        const items = (list: Container) =>
          ((list as unknown as { toArray(): unknown[] }).toArray() ?? []).map(
            plain,
          )
        return { kind: "list", was: items(was), now: items(now) }
      }
      case "map": {
        const get = (map: Container, key: string) =>
          plain((map as unknown as { get(key: string): unknown }).get(key))
        const keys = Object.keys(diff.updated)
        return {
          kind: "map",
          was: Object.fromEntries(keys.map(k => [k, get(was, k)])),
          now: Object.fromEntries(keys.map(k => [k, get(now, k)])),
        }
      }
      case "tree": {
        const nowTree = now as unknown as TreeLike
        const thenTree = was as unknown as TreeLike
        const nodes: Record<string, GatheredNode> = {}
        for (const item of diff.diff) {
          // A node an earlier revert re-created answers to its new id.
          const node = nowTree.getNodeByID(aliasOf(item.target, aliases))
          nodes[item.target] = {
            live: node !== undefined && !node.isDeleted(),
            parent: node?.parent()?.id,
            placed: thenTree.getNodeByID(item.target)?.parent()?.id,
          }
        }
        return { kind: "tree", nodes }
      }
      default:
        return { kind: "other" }
    }
  }

  /** Pair each restored container, and those inside it, with its new id. */
  function remapOf(restores: readonly Restore[]): Remap {
    const doc = host.doc
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
      const footprint = footprintOf(host.schema, ops)
      for (const listener of [...listeners])
        listener({ record, ops, footprint })
    },

    subscribeCommits(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    plan(record): RevertPlan<LoroRecord> {
      const gathered = gather(record)
      // Behind a shallow snapshot's start: a commit, none of it readable.
      if (gathered === null) {
        return { tally: { kept: 0, total: 1 }, apply: undefined }
      }
      const { tally, group } = planLoroRevert(record.aliases, gathered)
      if (howMuchStands(tally) === "none") return { tally, apply: undefined }
      return {
        tally,
        apply(options) {
          if (group.length === 0) return { redo: record, remap: new Map() }
          reverting = { record: null }
          try {
            host.commitNative(() => applyDiffGroup(host.doc, group), options)
            const redo = reverting.record
            if (redo === null)
              throw new Error("a Loro revert committed nothing")
            return { redo, remap: remapOf(restoresOf(group)) }
          } finally {
            reverting = undefined
          }
        },
      }
    },

    compose: composeLoroRecords,

    recovered(record, position) {
      const doc = host.doc
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
      const doc = host.doc
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
      return (host.doc.version().get(from.peer) ?? 0) > from.counter
    },

    codec,
  }
}
