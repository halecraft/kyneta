// revertible — undo for a Yjs document, on Yjs's public API: the shell.
//
// It keeps a draft of each local transaction as it happens (from `prepare`,
// `afterBatch` and the event bridge), builds the record when the transaction
// ends, and reverts one: gather what it names from the document, plan purely
// (`./plan.js`), apply as one authored batch, and read back what the restores
// landed with. The record is `./record.js`, capture `./capture.js`, and what
// is read of the Y.Doc `./document.js`, whose Yjs calls `yjs-surface.test.ts`
// pins.

import {
  type BatchOutcome,
  type ChangeBase,
  findOpaqueBoundary,
  footprintOf,
  freezeTree,
  isRichTextChange,
  isSequenceChange,
  isTextChange,
  type Op,
  type Path,
  pathSchema,
  type Revertible,
  type RevertibleCommit,
  type RichTextSpan,
  type SchemaBinding,
  type Schema as SchemaNode,
  type StateCell,
  type WritableContext,
} from "@kyneta/schema"
import * as Y from "yjs"
import { yjsPathToKynetaPath } from "../change-mapping.js"
import {
  addValue,
  charMarks,
  type Draft,
  deletedItems,
  itemOf,
  kindAt,
  markWrites,
  nestedTexts,
  newDraft,
  type Stage,
  textChanges,
  valueWrites,
} from "./capture.js"
import {
  destabilize,
  gapAfter,
  idAt,
  locate,
  stabilize,
  stateOf,
  type Tree,
  typeAt,
} from "./document.js"
import {
  contentLength,
  type GatheredContainer,
  type Landed,
  planYjsRevert,
  remapOfLanded,
  type YjsGathered,
  type YjsPlan,
} from "./plan.js"
import {
  codec,
  EMPTY,
  type Id,
  type IdRun,
  idKey,
  isEmpty,
  rewriteYjsRecord,
  type Slot,
  type StablePath,
  toRuns,
  unitsOf,
  type YjsRecord,
} from "./record.js"

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export interface YjsRevertibleHost {
  /** The document, read through the substrate's slot: it throws
   *  `DocumentClosedError` once the substrate is disposed. */
  readonly doc: Y.Doc
  readonly rootMap: Y.Map<any>
  readonly schema: SchemaNode
  readonly binding: SchemaBinding | undefined
  readonly shadow: StateCell
  context(): WritableContext
}

/** A Yjs substrate's undo, plus the hooks the substrate calls. */
export interface YjsRevertible extends Revertible<YjsRecord> {
  /** Whether anything needs records: hooks do nothing otherwise. */
  readonly active: boolean
  /** An authored transaction opened. */
  opened(transaction: Y.Transaction): void
  /** An authored op, before it applies. */
  preparing(path: Path, change: ChangeBase): void
  /** The authored op `preparing` saw, after it applied. */
  prepared(path: Path, change: ChangeBase): void
  /** An authored batch ended. */
  ended(outcome: BatchOutcome): void
  /** Stop listening to the document. The substrate calls it as it is
   *  disposed, while the document is still there to stop listening to. */
  dispose(): void
  /** Events on the root map, for any transaction, before the bridge syncs σ. */
  observed(
    events: Y.YEvent<any>[],
    transaction: Y.Transaction,
    ops: readonly Op[] | null,
  ): void
}

export function createYjsRevertible(host: YjsRevertibleHost): YjsRevertible {
  const tree: Tree = host
  const listeners = new Set<(commit: RevertibleCommit<YjsRecord>) => void>()
  const drafts = new Map<Y.Transaction, Draft>()
  let authored: Y.Transaction | undefined
  let reverting: { record: YjsRecord | null } | undefined

  const active = () => listeners.size > 0 || reverting !== undefined
  const draftFor = (tr: Y.Transaction): Draft => {
    let draft = drafts.get(tr)
    if (draft === undefined) {
      draft = newDraft()
      drafts.set(tr, draft)
    }
    return draft
  }

  // The ops of each transaction, for grouping.
  const draftOps = new Map<Y.Transaction, Op[]>()

  const afterTransaction = (tr: Y.Transaction): void => {
    const draft = drafts.get(tr)
    if (draft === undefined) return
    drafts.delete(tr)
    const ops = draftOps.get(tr) ?? []
    draftOps.delete(tr)
    if (!tr.local || draft.aborted) return
    const record: YjsRecord = {
      inserted: draft.inserted,
      deleted: draft.deleted,
      values: [...draft.values.values()],
      marks: draft.marks,
    }
    if (isEmpty(record)) return
    if (reverting !== undefined) {
      reverting.record = record
      return
    }
    const footprint = footprintOf(host.schema, ops)
    for (const listener of [...listeners]) listener({ record, ops, footprint })
  }
  host.doc.on("afterTransaction", afterTransaction)

  // The client's clock before the authored op `prepared` will see.
  let clockBefore = 0

  /**
   * What an op wrote, read against `pre`, σ at its path before it: its
   * values, the list runs it deleted, and its marks.
   */
  function capture(
    draft: Draft,
    path: Path,
    change: ChangeBase,
    pre: unknown,
    stage: Stage,
  ): void {
    for (const w of valueWrites(tree, path, change, pre)) {
      const at = stabilize(tree, w.path)
      if (at !== null) {
        addValue(draft, { path: at, wrote: w.wrote, previous: w.previous })
      }
    }
    const stable = stabilize(tree, path)
    if (stable === null) return
    const target = typeAt(tree, path)
    if (isSequenceChange(change) && target instanceof Y.Array) {
      draft.deleted.push(
        ...deletedItems(
          tree,
          stable,
          path,
          change,
          (pre ?? []) as unknown[],
          target,
          stage,
        ),
      )
    }
    if (isRichTextChange(change) && target instanceof Y.Text) {
      draft.marks.push(
        ...markWrites(stable, change, (pre ?? []) as RichTextSpan[], stage, i =>
          idAt(target, i),
        ),
      )
    }
  }

  const revertible: YjsRevertible = {
    get active() {
      return active()
    },

    opened(transaction) {
      authored = transaction
    },

    preparing(path, change) {
      if (!active() || authored === undefined) return
      clockBefore = stateOf(host.doc, host.doc.clientID)
      const draft = draftFor(authored)
      // Inside a `.json()` value the whole value is one register, written
      // as a whole when the batch ends: record it as one value.
      const boundary = findOpaqueBoundary(tree.schema, path, tree.binding)
      if (boundary !== null) {
        const at = path.slice(0, boundary.prefixLength + 1)
        const stableAt = stabilize(tree, at)
        if (stableAt === null) return
        const key = JSON.stringify(stableAt)
        if (!draft.boundaries.has(key)) {
          draft.boundaries.set(key, {
            path: stableAt,
            at,
            previous: readSlot(at),
          })
        }
        return
      }
      const pre = shadowAt(path)
      if (isRichTextChange(change)) {
        const stable = stabilize(tree, path)
        const key = JSON.stringify(stable)
        if (stable !== null && !draft.texts.has(key)) {
          draft.texts.set(key, (pre ?? []) as RichTextSpan[])
        }
      }
      // Capture reads coordinates as they are now, and derives paths below
      // `path`: by coordinate, since `path` is live only as far as refs were
      // made, and deriving a live path would create coordinates.
      capture(draft, path.toRaw(), change, pre, "before")
    },

    prepared(path, change) {
      if (!active() || authored === undefined) return
      const positional =
        isTextChange(change) ||
        isSequenceChange(change) ||
        isRichTextChange(change)
      if (!positional || !change.instructions.some(i => "insert" in i)) return
      const stable = stabilize(tree, path)
      if (stable === null) return
      let ids: IdRun[]
      if (isRichTextChange(change)) {
        // Marks on an insert are format items of their own, which an undo
        // must leave for the mark rule: take only the characters.
        const text = typeAt(tree, path)
        if (!(text instanceof Y.Text)) return
        const chars: Id[] = []
        let target = 0
        for (const op of change.instructions) {
          if ("insert" in op) {
            for (let k = 0; k < op.insert.length; k++) {
              const id = idAt(text, target + k)
              if (id !== null) chars.push(id)
            }
            target += op.insert.length
          } else if ("retain" in op) target += op.retain
          else if ("format" in op) target += op.format
        }
        ids = toRuns(chars)
      } else {
        const clockAfter = stateOf(host.doc, host.doc.clientID)
        if (clockAfter === clockBefore) return
        ids = [
          {
            client: host.doc.clientID,
            clock: clockBefore,
            length: clockAfter - clockBefore,
          },
        ]
      }
      if (ids.length > 0) {
        draftFor(authored).inserted.push({ container: stable, ids })
      }
    },

    ended(outcome) {
      if (authored === undefined) return
      const draft = drafts.get(authored)
      const transaction = authored
      authored = undefined
      if (draft === undefined) return
      if (outcome.aborted) {
        draft.aborted = true
        return
      }
      draftOps.set(transaction, [...outcome.ops])
      for (const { path, at, previous } of draft.boundaries.values()) {
        addValue(draft, { path, wrote: readSlot(at), previous })
      }
    },

    observed(events, transaction, ops) {
      if (!active() || !transaction.local) return
      const draft = draftFor(transaction)
      // What happened to texts: deletions for authored and direct writes
      // alike, insertions for direct writes (an authored insert is known
      // from the clock around it).
      for (const event of events) {
        const target = event.target
        if (!(target instanceof Y.Text)) continue
        const path = pathOf(event)
        if (path === null) continue
        const stable = stabilize(tree, path)
        if (stable === null) continue
        // σ still holds a direct write's before-state here; an authored
        // batch noted it as it began.
        const before =
          kindAt(tree, path) !== "richtext"
            ? null
            : (draft.texts.get(JSON.stringify(stable)) ??
              ((shadowAt(path) ?? []) as RichTextSpan[]))
        const { deleted, inserted } = textChanges(
          host.doc,
          target,
          stable,
          transaction,
          before,
        )
        draft.deleted.push(...deleted)
        if (ops !== null && inserted.length > 0) {
          draft.inserted.push({ container: stable, ids: inserted })
        }
      }
      if (ops === null) return
      // The rest of a direct write: what `prepare` gathers for an authored
      // op, read after the write, with σ still before it.
      draftOps.set(transaction, [...ops])
      for (const event of events) {
        const target = event.target
        if (!(target instanceof Y.Array)) continue
        const path = pathOf(event)
        if (path === null) continue
        const stable = stabilize(tree, path)
        if (stable === null) continue
        const ids: Id[] = []
        for (const item of event.changes.added) {
          for (let k = 0; k < item.length; k++) {
            ids.push({ client: item.id.client, clock: item.id.clock + k })
          }
        }
        ids.sort((a, b) => a.client - b.client || a.clock - b.clock)
        if (ids.length > 0) {
          draft.inserted.push({ container: stable, ids: toRuns(ids) })
        }
      }
      for (const op of ops) {
        capture(draft, op.path, op.change, shadowAt(op.path), "after")
      }
    },

    subscribeCommits(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    revert(record, options) {
      const plan = planYjsRevert(record, gather(record))
      if (plan === null) return null
      const ctx = host.context()
      reverting = { record: null }
      try {
        ctx.runBatch(() => {
          for (const { path, change } of plan.ops) ctx.dispatch(path, change)
        }, options)
        const redo = reverting.record ?? EMPTY
        return { redo, remap: remapOfLanded(landed(plan)) }
      } finally {
        reverting = undefined
      }
    },

    recovered(record, position) {
      const from = decodePosition(position)
      const now = stateOf(host.doc, from.client)
      const fresh: IdRun[] =
        now > from.clock
          ? [
              {
                client: from.client,
                clock: from.clock,
                length: now - from.clock,
              },
            ]
          : []
      const restorable = record.deleted
      const remap = new Map<string, string>()
      // One restored run is the revert's whole insertion: its ids pair up.
      if (restorable.length === 1) {
        const [run] = restorable
        const old = [...unitsOf(run.ids)]
        const next = [...unitsOf(fresh)]
        if (old.length > 0 && old.length <= next.length) {
          old.forEach((id, k) => {
            remap.set(idKey(id), idKey(next[k] as Id))
          })
        }
      }
      return {
        redo: {
          inserted: restorable.map(r => ({
            container: r.container,
            ids: fresh,
          })),
          deleted: [],
          values: record.values.map(v => ({
            ...v,
            wrote: v.previous,
            previous: v.wrote,
          })),
          marks: record.marks.map(m => ({
            ...m,
            wrote: m.previous,
            previous: m.wrote,
          })),
        },
        remap,
      }
    },

    rewrite: rewriteYjsRecord,

    position() {
      return encodePosition({
        client: host.doc.clientID,
        clock: stateOf(host.doc, host.doc.clientID),
      })
    },

    authoredSince(position) {
      const from = decodePosition(position)
      return stateOf(host.doc, from.client) > from.clock
    },

    codec,

    dispose() {
      host.doc.off("afterTransaction", afterTransaction)
      listeners.clear()
      drafts.clear()
      draftOps.clear()
    },
  }

  function pathOf(event: Y.YEvent<any>): Path | null {
    try {
      return yjsPathToKynetaPath(event.path, tree.schema, tree.binding)
    } catch {
      return null
    }
  }

  /** Read what `record` names as the document holds it now. */
  function gather(record: YjsRecord): YjsGathered {
    const deletedNow = Y.snapshot(host.doc).ds
    const alive = (id: Id) =>
      !Y.isDeleted(deletedNow, Y.createID(id.client, id.clock))
    const containers = new Map<string, GatheredContainer>()
    /** A container's key, noting its kind and length, or null if gone. */
    const container = (stable: StablePath): string | null => {
      const path = destabilize(tree, stable, deletedNow)
      if (path === null) return null
      if (!containers.has(path.key)) {
        const kind = kindAt(tree, path)
        const current = shadowAt(path)
        const length =
          kind === "text"
            ? String(current ?? "").length
            : kind === "richtext"
              ? ((current ?? []) as RichTextSpan[]).reduce(
                  (n, span) => n + span.text.length,
                  0,
                )
              : ((current ?? []) as unknown[]).length
        const spans = kind === "richtext" ? (current as RichTextSpan[]) : []
        containers.set(path.key, {
          path,
          kind,
          length,
          marks: charMarks(spans ?? []),
        })
      }
      return path.key
    }
    /** Where each id still alive in the container sits. */
    const indices = (key: string | null, ids: readonly IdRun[]) => {
      const at = key === null ? undefined : containers.get(key)
      if (at === undefined) return []
      const type = typeAt(tree, at.path)
      const out: { id: Id; index: number }[] = []
      for (const id of unitsOf(ids)) {
        if (!alive(id)) continue
        const where = locate(host.doc, id)
        if (where !== null && where.type === type) {
          out.push({ id, index: where.index })
        }
      }
      return out
    }
    return {
      containers,
      inserted: record.inserted.map(run => {
        const key = container(run.container)
        return {
          container: key,
          indices: indices(key, run.ids).map(u => u.index),
        }
      }),
      deleted: record.deleted.map(run => ({
        container: container(run.container),
        back: [...unitsOf(run.ids)].some(alive),
        gap: gapAfter(host.doc, run.after),
      })),
      marks: record.marks.map(mark => {
        const key = container(mark.container)
        return {
          container: key,
          indices: indices(key, mark.ids).map(u => u.index),
        }
      }),
      values: record.values.map(write => {
        const path = destabilize(tree, write.path, deletedNow)
        return { path, current: path === null ? null : readSlot(path) }
      }),
    }
  }

  /** What the revert gave each run it restored, read where it landed. */
  function landed(plan: YjsPlan): Landed[] {
    return plan.placed.map(({ container, run, at }) => {
      const type = typeAt(tree, container)
      const fresh: Id[] = []
      if (type instanceof Y.Text || type instanceof Y.Array) {
        for (let k = 0; k < contentLength(run.content); k++) {
          const id = idAt(type, at + k)
          if (id !== null) fresh.push(id)
        }
      }
      const itemSchema =
        type instanceof Y.Array
          ? itemOf(pathSchema(tree.schema, container, tree.binding))
          : undefined
      const nested =
        itemSchema === undefined
          ? []
          : run.nested.map(n => ({
              nested: n,
              ids:
                nestedTexts(tree, container.item(at + n.item), itemSchema).find(
                  t => JSON.stringify(t.path) === JSON.stringify(n.path),
                )?.ids ?? [],
            }))
      return { run, fresh, nested }
    })
  }

  /**
   * σ at `path`, frozen. A draft keeps what it reads until the transaction
   * ends, and the batch goes on writing σ meanwhile: a write changes an
   * unfrozen node in place, and copies a frozen one (`applyChange`).
   */
  function shadowAt(path: Path): unknown {
    return freezeTree(path.read(host.shadow.current))
  }

  function readSlot(path: Path): Slot {
    const segments = path.segments
    const last = segments.at(-1)
    if (last === undefined) return { value: shadowAt(path) }
    const parent = path.slice(0, segments.length - 1).read(host.shadow.current)
    const key = last.resolve()
    if (parent === null || typeof parent !== "object") return null
    return Object.hasOwn(parent as object, key as string)
      ? {
          value: freezeTree((parent as Record<string, unknown>)[key as string]),
        }
      : null
  }

  return revertible
}

function encodePosition(position: Id): Uint8Array {
  return new TextEncoder().encode(idKey(position))
}

function decodePosition(bytes: Uint8Array): Id {
  const [client, clock] = new TextDecoder().decode(bytes).split(":").map(Number)
  return { client, clock }
}
