// undo/stack — an undo stack across documents, over an Exchange.
//
// The imperative shell of `undo-program.ts`. It listens to the local commits
// of every document in scope, feeds them to the program as parts of steps,
// and executes what the program decides: write a step, note a revert and
// wait for the note to be stored, revert a step's parts, record the move.
//
// The stack lives in a serialized document the app names (`UndoDoc`), so
// with a Store it survives a reload, and the Store's one-writer rule keeps
// two runtimes from popping one step. Without a Store it lasts the session.

import { randomHex } from "@kyneta/random"
import type {
  BoundSchema,
  CommitOptions,
  Edit,
  Op,
  Remap,
  Revertible,
  RevertibleCommit,
  StepReverted,
  Substrate,
  Version,
} from "@kyneta/schema"
import {
  applyChanges,
  base64ToUint8Array,
  diffSequence,
  editOf,
  type Footprint,
  footprintsOverlap,
  footprintUnion,
  own,
  RawPath,
  replaceChange,
  revertStep,
  samePlainValue,
  sequenceChange,
  TYPING_GAP,
  uint8ArrayToBase64,
} from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import type { Exchange } from "../exchange.js"
import { whenPersisted, writeRefusal } from "../persistence.js"
import { whenHydrated } from "../settle.js"
import { whenSettled } from "../sync.js"
import {
  type Direction,
  type Note,
  type Part,
  type Step,
  UndoDoc,
} from "./schema.js"
import {
  type UndoEffect,
  type UndoInput,
  type UndoModel,
  undoProgram,
  type Via,
} from "./undo-program.js"

export interface UndoStackParams {
  readonly exchange: Exchange
  /** The undo document. Give each stack that must not share one its own
   *  id: per tab, or per device over a shared Store. */
  readonly docId: DocId
  /** Which stack in the undo document. */
  readonly key: string
  /** The documents this stack undoes. Its own undo document never is. */
  readonly scope: (docId: DocId) => boolean
  /** How many steps each of the undo and redo lists keeps. */
  readonly depth?: number
  /** The typing pause that closes a step, in milliseconds. */
  readonly gap?: number
  readonly now?: () => number
}

export interface UndoOptions extends CommitOptions {
  /** Take the newest step that writes any of these documents, even if
   *  steps above it write others, as long as none of those overlaps it
   *  (`topStep`). The newest step when omitted. */
  readonly docs?: readonly DocId[]
}

export interface UndoStack {
  /** One step: every local commit, on a document in scope, made while
   *  `fn` runs. `fn` must be synchronous. */
  gesture<T>(fn: () => T): T
  /** Like `gesture`, but joins the step before when the typing policy says
   *  so (`continuesStep`). */
  typing(fn: () => void): void
  /** Direct writes on this document made outside a gesture, grouped by the
   *  typing policy, as an editor binding makes them. */
  follow(docId: DocId): () => void
  /** Undo the newest step still standing that writes any of
   *  `options.docs` and that no newer step overlaps. False when there is
   *  none. A part stands only if its document is held here: an undo never
   *  creates one. */
  undo(options?: UndoOptions): Promise<boolean>
  /** Redo the newest undone step still standing that writes any of
   *  `options.docs` and that no step redone before it overlaps. */
  redo(options?: UndoOptions): Promise<boolean>
  /** The step `undo` or `redo` with these `docs` tries first. Whether it
   *  still stands is known only when it is tried. A read of the undo
   *  document, so a reactive thunk that calls it is tracked. */
  top(direction: Direction, docs?: readonly DocId[]): Step | undefined
  dispose(): void
}

/** A stack as the undo document holds it. */
export interface StoredStack {
  readonly undo: readonly Step[]
  readonly redo: readonly Step[]
  readonly pending: Note | null
}

// ---------------------------------------------------------------------------
// Pure transitions of a stored stack
// ---------------------------------------------------------------------------

function listOf(stack: StoredStack, direction: Direction): readonly Step[] {
  return direction === "undo" ? stack.undo : stack.redo
}

/** Whether `step` writes any document in `docs`. Every step does when
 *  `docs` is undefined. */
function touches(step: Step, docs: readonly string[] | undefined): boolean {
  return docs === undefined || step.parts.some(p => docs.includes(p.docId))
}

/** What a step writes: each document's footprint. */
type Region = ReadonlyMap<string, Footprint>

/** `region` with `footprint` added to `docId`'s. */
function joined(region: Region, docId: string, footprint: Footprint): Region {
  const known = region.get(docId)
  return new Map(region).set(
    docId,
    known === undefined ? footprint : footprintUnion(known, footprint),
  )
}

/** The footprints of `step`'s parts, per document. A typing step of many
 *  keystrokes in one text is one path. */
function regionOf(step: Step): Region {
  return step.parts.reduce<Region>(
    (region, part) => joined(region, part.docId, part.footprint),
    new Map(),
  )
}

function regionUnion(a: Region, b: Region): Region {
  let union = a
  for (const [docId, footprint] of b) union = joined(union, docId, footprint)
  return union
}

/** Whether `a` and `b` write a common document, and overlap there. Two steps
 *  whose regions do not overlap commute. */
function regionsOverlap(a: Region, b: Region): boolean {
  for (const [docId, footprint] of a) {
    const other = b.get(docId)
    if (other !== undefined && footprintsOverlap(footprint, other)) return true
  }
  return false
}

/**
 * The newest step in `steps` that writes any document in `docs` and that no
 * step after it overlaps. On `undo`, an overlapping step after it was made on
 * it; on `redo`, it was made on an overlapping step after it. Either way the
 * two must go in stack order. The walk carries the union of the steps
 * passed, since overlapping a union is overlapping one of its steps. Without
 * `docs`, the last step.
 */
export function topStep(
  steps: readonly Step[],
  docs: readonly string[] | undefined,
): Step | undefined {
  let after: Region = new Map()
  for (const step of steps.toReversed()) {
    const region = regionOf(step)
    if (touches(step, docs) && !regionsOverlap(region, after)) return step
    after = regionUnion(after, region)
  }
  return undefined
}

/** Each list kept to its newest `depth` steps. A push keeps the redo steps
 *  it does not conflict with, so the two lists together can exceed `depth`. */
export function bounded(stack: StoredStack, depth: number): StoredStack {
  return {
    ...stack,
    undo: stack.undo.slice(-depth),
    redo: stack.redo.slice(-depth),
  }
}

/**
 * `redo` without the steps that build on `seed`: each step that overlaps
 * `seed` or a step already cleared. The walk goes in redo order, from the
 * step redone first, carrying the union of what it cleared, so a step redone
 * before every cleared one it overlaps is kept. Sound for a seed taken from
 * `redo` because a step is taken only when nothing after it overlaps it.
 */
function clearDependents(redo: readonly Step[], seed: Step): Step[] {
  let cleared = regionOf(seed)
  const kept: Step[] = []
  for (const step of redo.toReversed()) {
    const region = regionOf(step)
    if (regionsOverlap(region, cleared)) cleared = regionUnion(cleared, region)
    else kept.push(step)
  }
  return kept.reverse()
}

/** `step` pushed onto `undo`, and the redo steps that build on it cleared
 *  (`clearDependents`). The others commute with it and stay. */
export function pushStep(
  stack: StoredStack,
  step: Step,
  depth: number,
): StoredStack {
  return bounded(
    {
      ...stack,
      undo: [...stack.undo, step],
      redo: clearDependents(stack.redo, step),
    },
    depth,
  )
}

/**
 * `step` moved from `from`'s list, as `redo` onto the other list (dropped
 * when nothing of it applied), every step left rewritten by `rewrite`, the
 * note cleared, and each list kept to `depth`. `redo` is already current:
 * its revert made it so. A redo step dropped takes the redo steps that build
 * on it (`clearDependents`), which could not be redone without it. An undo
 * step dropped takes nothing: what it did is already gone.
 */
export function moveStep(
  stack: StoredStack,
  from: Direction,
  step: Step,
  redo: Step | undefined,
  rewrite: (part: Part) => Part,
  depth: number,
): StoredStack {
  const each = (steps: readonly Step[]) =>
    steps.map(s => ({ ...s, parts: s.parts.map(rewrite) }))
  const to: Direction = from === "undo" ? "redo" : "undo"
  const rest = listOf(stack, from).filter(s => s.id !== step.id)
  const left = each(
    from === "redo" && redo === undefined ? clearDependents(rest, step) : rest,
  )
  const right = [
    ...each(listOf(stack, to)),
    ...(redo === undefined ? [] : [redo]),
  ]
  const moved =
    from === "undo"
      ? { undo: left, redo: right, pending: null }
      : { undo: right, redo: left, pending: null }
  return bounded(moved, depth)
}

/**
 * The ops that take the stack at `at` from `before` to `after`: each list's
 * shortest edit (`diffSequence`) and the note, if it changed. A write is as
 * large as what changed, not as large as the stack.
 */
export function stackOps(
  at: RawPath,
  before: StoredStack,
  after: StoredStack,
): Op[] {
  const ops: Op[] = []
  for (const list of ["undo", "redo"] as const) {
    const instructions = diffSequence(before[list], after[list], samePlainValue)
    if (instructions.length === 0) continue
    // Each inserted step is owned: one read from the document is frozen, and
    // shared as it is; anything else is copied.
    const owned = instructions.map(i =>
      "insert" in i ? { insert: i.insert.map(step => own(step)) } : i,
    )
    ops.push({ path: at.field(list), change: sequenceChange(owned) })
  }
  if (!samePlainValue(before.pending, after.pending)) {
    ops.push({
      path: at.field("pending"),
      change: replaceChange(own(after.pending)),
    })
  }
  return ops
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

/** Which documents the stack starts and stops listening to. */
export interface Following {
  readonly attach: readonly DocId[]
  readonly detach: readonly DocId[]
}

/**
 * What the stack does about the documents `docIds` names, each once: listen
 * to one that is open, and let go of one that is not. Pure; `isOpen` reads
 * the Runtime. `attach` itself keeps what is out of scope out, and listens
 * again to a document whose substrate changed.
 */
export function followChanges(
  docIds: Iterable<DocId>,
  isOpen: (docId: DocId) => boolean,
): Following {
  const attach: DocId[] = []
  const detach: DocId[] = []
  for (const docId of new Set(docIds)) {
    if (isOpen(docId)) attach.push(docId)
    else detach.push(docId)
  }
  return { attach, detach }
}

export async function createUndoStack(
  params: UndoStackParams,
): Promise<UndoStack> {
  const { exchange, key, scope } = params
  const depth = params.depth ?? 100
  const now = params.now ?? Date.now
  const program = undoProgram(params.gap ?? TYPING_GAP)
  const doc = exchange.get(params.docId, UndoDoc)
  await whenHydrated(doc)

  const stackRef = () => {
    const ref = doc.stacks.at(key)
    if (ref === undefined) throw new Error(`undo stack "${key}" is missing`)
    return ref
  }
  const read = (): StoredStack => {
    const value = stackRef()()
    return {
      undo: value.undo as unknown as readonly Step[],
      redo: value.redo as unknown as readonly Step[],
      pending: value.pending as unknown as Note | null,
    }
  }
  const top = (direction: Direction, docs?: readonly DocId[]) =>
    topStep(listOf(read(), direction), docs)
  const at = RawPath.empty.field("stacks").entry(key)
  /** Write the stack's move from what it holds to `next`, in one batch. */
  const write = (next: StoredStack) => {
    applyChanges(doc, stackOps(at, read(), next))
  }
  if (!doc.stacks.has(key)) {
    doc.stacks.set(key, { undo: [], redo: [], pending: null })
  }

  // --- The program loop ---------------------------------------------------

  let model: UndoModel = program.init[0]
  const inbox: UndoInput[] = []
  let running = false
  const dispatch = (msg: UndoInput): void => {
    inbox.push(msg)
    if (running) return
    running = true
    try {
      for (let m = inbox.shift(); m !== undefined; m = inbox.shift()) {
        const [next, ...effects] = program.update(m, model)
        model = next
        for (const effect of effects) execute(effect)
      }
    } finally {
      running = false
    }
  }

  /**
   * A document open here now and accepting writes, with its undo. Read from
   * the Runtime each time: a promoted or reloaded document has a new
   * substrate, and a destroyed one is gone. A part stands only if its
   * document is this when the part is used. A revert writes natively, below
   * the document's refusal, so a document that refuses writes (unloading,
   * closed, another seat's) is not reached at all.
   */
  const interpreted = (docId: DocId) => {
    const instance = exchange.runtime.instanceOf(docId)
    if (instance?.tier !== "interpret") return undefined
    if (writeRefusal(instance.ref) !== undefined) return undefined
    const substrate = instance.readyInfo.replica
    const { revertible } = substrate
    if (revertible === undefined) return undefined
    const ref: object = instance.ref
    return { ref, readyInfo: instance.readyInfo, substrate, revertible }
  }

  // --- Capture ------------------------------------------------------------

  const attached = new Map<
    DocId,
    { readonly substrate: Substrate<Version>; readonly stop: () => void }
  >()
  const followed = new Set<DocId>()
  let via: Via | undefined
  let reverting = false
  const commits: UndoInput[] = []
  let draining = false

  const drain = () => {
    const pending = commits.splice(0)
    for (const msg of pending) dispatch(msg)
  }

  const onCommit = (
    docId: DocId,
    substrate: Substrate<Version>,
    revertible: Revertible,
    commit: RevertibleCommit<unknown>,
  ) => {
    if (reverting) return
    const mode = via ?? (followed.has(docId) ? "follow" : undefined)
    if (mode === undefined) return
    const open = interpreted(docId)
    if (open?.substrate !== substrate) return
    const { readyInfo } = open
    const [only] = commit.ops
    const edit: Edit | undefined =
      commit.ops.length === 1 && only !== undefined
        ? editOf(only, now())
        : undefined
    commits.push({
      type: "commit",
      via: mode,
      edit,
      part: {
        docId,
        schemaHash: readyInfo.schemaHash,
        replicaType: readyInfo.replicaFactory.replicaType,
        syncMode: readyInfo.syncMode,
        record: uint8ArrayToBase64(revertible.codec.encode(commit.record)),
        footprint: commit.footprint,
      },
    })
    // A direct write outside a gesture is heard inside its own commit, where
    // nothing may write: record it once the commit is done.
    if (via === undefined && !draining) {
      draining = true
      queueMicrotask(() => {
        draining = false
        drain()
      })
    }
  }

  const attach = (docId: DocId) => {
    if (docId === params.docId || !scope(docId)) return
    const open = interpreted(docId)
    if (open === undefined) return
    const { substrate, revertible } = open
    const existing = attached.get(docId)
    if (existing?.substrate === substrate) return
    existing?.stop()
    const stop = revertible.subscribeCommits(commit =>
      onCommit(docId, substrate, revertible, commit),
    )
    attached.set(docId, { substrate, stop })
  }
  const detach = (docId: DocId) => {
    attached.get(docId)?.stop()
    attached.delete(docId)
  }
  const apply = (follow: Following) => {
    for (const docId of follow.attach) attach(docId)
    for (const docId of follow.detach) detach(docId)
  }
  const isOpen = (docId: DocId) => interpreted(docId) !== undefined
  /** Listen to exactly the documents in scope that are open: a destroyed
   *  document's substrate, and through it its document, is let go. Walks
   *  every document: at construction, and at each gesture, where `scope`
   *  may answer differently than it did. */
  const scan = () => {
    apply(
      followChanges([...exchange.documents.keys(), ...attached.keys()], isOpen),
    )
  }
  scan()
  // Afterwards, only the documents a change names.
  const stopScanning = exchange.documents.subscribe(changeset =>
    apply(
      followChanges(
        changeset.changes.map(change => change.docId),
        isOpen,
      ),
    ),
  )

  // --- Opening what a step names -----------------------------------------

  /**
   * Open and load the document a part names, if this exchange holds it. One
   * it does not hold (destroyed, here or by another runtime on the store) is
   * never created: the part does not stand.
   */
  async function open(part: Part, settle: boolean): Promise<void> {
    const ref = await openHeld(part)
    if (ref === undefined) return
    try {
      if (settle) await whenSettled(ref)
      else await whenHydrated(ref)
    } catch (error) {
      // A load that ended with the document gone (another caller's `open`
      // found nothing, or it was destroyed meanwhile): the part does not
      // stand.
      if (interpreted(part.docId)?.ref === ref) throw error
      return
    }
    attach(part.docId)
  }

  /**
   * The document a part names, through `exchange.open`, the one door for
   * every part: it returns a held document, cancels an unload not yet
   * released, and loads one from the Store. `undefined` when this exchange
   * does not hold it. The schema is the registered one, or for a document
   * created on the Runtime before an Exchange wrapped it, the held one's.
   */
  async function openHeld(part: Part): Promise<object | undefined> {
    const held = exchange.runtime.instanceOf(part.docId)
    const bound =
      exchange.capabilities.resolveSchema(
        part.schemaHash,
        part.replicaType,
        part.syncMode,
      ) ?? (held?.tier === "interpret" ? held.bound : undefined)
    if (bound === undefined) {
      throw new Error(
        `undo: no schema is registered for document "${part.docId}" ` +
          `(${part.schemaHash}). Register it in ExchangeParams.schemas.`,
      )
    }
    // Widened: `open`'s precise return type recurses too deeply for a
    // schema known only at runtime (TS2589).
    const widened = exchange as unknown as {
      open(docId: DocId, bound: BoundSchema): Promise<object | undefined>
    }
    return widened.open(part.docId, bound)
  }

  const openAll = async (step: Step, settle: boolean) => {
    for (const part of step.parts) await open(part, settle)
  }

  // --- Reverting ----------------------------------------------------------

  /** A part's record, decoded, rewritten and encoded again. `docId` has
   *  just reverted, so it is open, unless the revert's own writes destroyed
   *  it; its parts then stand no more, and are left as they are. */
  const rewritePart = (part: Part, docId: string, remap: Remap): Part => {
    if (part.docId !== docId || remap.size === 0) return part
    const revertible = interpreted(docId)?.revertible
    if (revertible === undefined) return part
    const record = revertible.codec.decode(base64ToUint8Array(part.record))
    return {
      ...part,
      record: uint8ArrayToBase64(
        revertible.codec.encode(revertible.rewrite(record, remap)),
      ),
    }
  }

  /**
   * Revert `step`'s parts last first, each through `attempt`, and record the
   * move. Each revert's remap reaches every part still waiting, in this step
   * and the rest of the stack, before the next one reverts.
   */
  const settleStep = (
    direction: Direction,
    step: Step,
    attempt: (
      revertible: Revertible,
      part: Part,
      record: unknown,
    ) => ReturnType<Revertible["revert"]>,
  ): boolean => {
    const rewrite = (part: Part, by: Part, remap: Remap) =>
      rewritePart(part, by.docId, remap)
    reverting = true
    let reverted: StepReverted<Part>
    try {
      reverted = revertStep(
        step.parts,
        part => {
          const revertible = interpreted(part.docId)?.revertible
          if (revertible === undefined) return null
          const record = revertible.codec.decode(
            base64ToUint8Array(part.record),
          )
          const result = attempt(revertible, part, record)
          if (result === null) return null
          const redo = uint8ArrayToBase64(revertible.codec.encode(result.redo))
          return { redo: { ...part, record: redo }, remap: result.remap }
        },
        rewrite,
      )
    } finally {
      reverting = false
    }
    const { remaps } = reverted
    const redo =
      reverted.redo.length > 0
        ? { id: step.id, parts: [...reverted.redo] }
        : undefined
    write(
      moveStep(
        read(),
        direction,
        step,
        redo,
        part =>
          remaps.reduce((p, { by, remap }) => rewrite(p, by, remap), part),
        depth,
      ),
    )
    return redo !== undefined
  }

  // --- Effects ------------------------------------------------------------

  const resolvers = new Map<number, (done: boolean) => void>()
  let nextToken = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  function execute(effect: UndoEffect): void {
    switch (effect.type) {
      case "push":
        write(
          pushStep(read(), { id: randomHex(8), parts: effect.parts }, depth),
        )
        return
      case "set-timer":
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = undefined
          dispatch({ type: "gap-elapsed", at: now() })
        }, effect.ms)
        return
      case "begin": {
        const step = top(effect.direction, effect.docs)
        if (step === undefined) {
          dispatch({ type: "began", step: undefined })
          return
        }
        openAll(step, false).then(
          () => dispatch({ type: "began", step }),
          error => {
            console.error(error)
            dispatch({ type: "began", step: undefined })
          },
        )
        return
      }
      case "note": {
        // Only open documents: a part of one that is not does not stand.
        const positions: Record<string, string> = {}
        for (const part of effect.step.parts) {
          const revertible = interpreted(part.docId)?.revertible
          if (revertible === undefined) continue
          positions[part.docId] ??= uint8ArrayToBase64(revertible.position())
        }
        write({
          ...read(),
          pending: {
            step: effect.step.id,
            direction: effect.direction,
            positions,
          },
        })
        whenPersisted(doc).then(
          () => dispatch({ type: "noted" }),
          () => dispatch({ type: "noted" }),
        )
        return
      }
      case "revert": {
        const applied = settleStep(
          effect.direction,
          effect.step,
          (revertible, _part, record) =>
            revertible.revert(record, effect.options),
        )
        dispatch({ type: "reverted", applied })
        return
      }
      case "recover":
        recover(effect.note).then(
          () => dispatch({ type: "recovered" }),
          error => {
            console.error(error)
            write({ ...read(), pending: null })
            dispatch({ type: "recovered" })
          },
        )
        return
      case "resolve": {
        const resolve = resolvers.get(effect.token)
        resolvers.delete(effect.token)
        resolve?.(effect.done)
        return
      }
      case "compact":
        exchange.compact(params.docId).catch(() => {})
        return
    }
  }

  /**
   * Finish a revert a crash interrupted. A document that has authored
   * anything since its noted position was reverted (nothing else authors
   * between the note and the revert); one that has not is reverted now.
   */
  async function recover(note: Note): Promise<void> {
    const stack = read()
    const step = listOf(stack, note.direction).find(s => s.id === note.step)
    if (step === undefined) {
      write({ ...stack, pending: null })
      return
    }
    await openAll(step, true)
    settleStep(note.direction, step, (revertible, part, record) => {
      const noted = note.positions[part.docId]
      const position =
        noted === undefined ? undefined : base64ToUint8Array(noted)
      return position !== undefined && revertible.authoredSince(position)
        ? revertible.recovered(record, position)
        : revertible.revert(record, {})
    })
  }

  dispatch({ type: "loaded", pending: read().pending ?? undefined })

  const request = (direction: Direction, { docs, ...options }: UndoOptions) =>
    new Promise<boolean>(resolve => {
      const token = nextToken++
      resolvers.set(token, resolve)
      dispatch({
        type: "requested",
        request: { direction, options, docs, token },
      })
    })

  return {
    top,

    gesture<T>(fn: () => T): T {
      scan()
      dispatch({ type: "gesture-opened" })
      via = "gesture"
      try {
        return fn()
      } finally {
        via = undefined
        drain()
        dispatch({ type: "gesture-closed" })
      }
    },

    typing(fn: () => void): void {
      scan()
      via = "typing"
      try {
        fn()
      } finally {
        via = undefined
        drain()
      }
    },

    follow(docId: DocId): () => void {
      followed.add(docId)
      attach(docId)
      return () => {
        followed.delete(docId)
      }
    },

    undo: (options = {}) => request("undo", options),
    redo: (options = {}) => request("redo", options),

    dispose() {
      stopScanning()
      for (const { stop } of attached.values()) stop()
      attached.clear()
      if (timer !== undefined) clearTimeout(timer)
      // An undo still waiting will not run.
      for (const resolve of resolvers.values()) resolve(false)
      resolvers.clear()
    },
  }
}
