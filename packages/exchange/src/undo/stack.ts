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
  Remap,
  Revertible,
  RevertibleCommit,
  Substrate,
  Version,
} from "@kyneta/schema"
import {
  base64ToUint8Array,
  batch,
  editOf,
  TYPING_GAP,
  uint8ArrayToBase64,
} from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import type { Exchange } from "../exchange.js"
import { whenPersisted } from "../persistence.js"
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
  /** How many steps to keep. */
  readonly depth?: number
  /** The typing pause that closes a step, in milliseconds. */
  readonly gap?: number
  readonly now?: () => number
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
  /** Undo the top step still standing. False when there is none. */
  undo(options?: CommitOptions): Promise<boolean>
  /** Redo the top undone step still standing. */
  redo(options?: CommitOptions): Promise<boolean>
  /** The undo document: `doc.stacks.at(key)` holds the stack, and whether
   *  its lists are empty is whether there is anything to undo or redo. */
  readonly doc: ReturnType<typeof openUndoDoc>
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

/** `step` pushed onto `undo`, `redo` cleared, `undo` kept to `depth`. */
export function pushStep(
  stack: StoredStack,
  step: Step,
  depth: number,
): StoredStack {
  return { ...stack, undo: [...stack.undo, step].slice(-depth), redo: [] }
}

/**
 * `step` moved from `from`'s list, as `redo` onto the other list (dropped
 * when nothing of it applied), with every part left rewritten by `rewrite`
 * and the note cleared.
 */
export function moveStep(
  stack: StoredStack,
  from: Direction,
  step: Step,
  redo: Step | undefined,
  rewrite: (part: Part) => Part,
): StoredStack {
  const source = from === "undo" ? stack.undo : stack.redo
  const target = from === "undo" ? stack.redo : stack.undo
  const each = (steps: readonly Step[]) =>
    steps.map(s => ({ ...s, parts: s.parts.map(rewrite) }))
  const left = each(source.filter(s => s.id !== step.id))
  const right = each(redo === undefined ? target : [...target, redo])
  return from === "undo"
    ? { undo: left, redo: right, pending: null }
    : { undo: right, redo: left, pending: null }
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

function openUndoDoc(exchange: Exchange, docId: DocId) {
  return exchange.get(docId, UndoDoc)
}

export async function createUndoStack(
  params: UndoStackParams,
): Promise<UndoStack> {
  const { exchange, key, scope } = params
  const depth = params.depth ?? 100
  const now = params.now ?? Date.now
  const program = undoProgram(params.gap ?? TYPING_GAP)
  const doc = openUndoDoc(exchange, params.docId)
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
  const write = (stack: StoredStack) => {
    batch(doc, (d: any) => d.stacks.set(key, stack))
  }
  if (!doc.stacks.has(key)) write({ undo: [], redo: [], pending: null })

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
    const entry = exchange.runtime.getEntry(docId)
    if (entry?.mode !== "interpret" || entry.readyInfo.replica !== substrate)
      return
    const { readyInfo } = entry
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
    const entry = exchange.runtime.getEntry(docId)
    if (entry?.mode !== "interpret") return
    const substrate = entry.readyInfo.replica
    const revertible = substrate.revertible
    if (revertible === undefined) return
    const existing = attached.get(docId)
    if (existing?.substrate === substrate) return
    existing?.stop()
    const stop = revertible.subscribeCommits(commit =>
      onCommit(docId, substrate, revertible, commit),
    )
    attached.set(docId, { substrate, stop })
  }
  const scan = () => {
    for (const docId of exchange.documents.keys()) attach(docId)
  }
  scan()
  const stopScanning = exchange.documents.subscribe(scan)

  // --- Opening what a step names -----------------------------------------

  /** Make sure the document a part names is open and loaded. */
  async function open(part: Part, settle: boolean): Promise<void> {
    let entry = exchange.runtime.getEntry(part.docId)
    if (entry?.mode !== "interpret") {
      const bound = exchange.capabilities.resolveSchema(
        part.schemaHash,
        part.replicaType,
        part.syncMode,
      )
      if (bound === undefined) {
        throw new Error(
          `undo: no schema is registered for document "${part.docId}" ` +
            `(${part.schemaHash}). Register it in ExchangeParams.schemas.`,
        )
      }
      // Widened: `get`'s precise return type recurses too deeply for a
      // schema known only at runtime (TS2589).
      const widened = exchange as unknown as {
        get(docId: DocId, bound: BoundSchema): unknown
      }
      widened.get(part.docId, bound)
      entry = exchange.runtime.getEntry(part.docId)
    }
    if (entry?.mode !== "interpret") {
      throw new Error(`undo: document "${part.docId}" cannot be opened`)
    }
    if (settle) await whenSettled(entry.ref)
    else await whenHydrated(entry.ref)
    attach(part.docId)
  }

  const openAll = async (step: Step, settle: boolean) => {
    for (const part of step.parts) await open(part, settle)
  }

  /** A document's undo, read from the Runtime each time: a rebuilt
   *  document has a new substrate. */
  const revertibleOf = (docId: string): Revertible => {
    const entry = exchange.runtime.getEntry(docId)
    const revertible =
      entry?.mode === "interpret"
        ? entry.readyInfo.replica.revertible
        : undefined
    if (revertible === undefined) {
      throw new Error(`undo: document "${docId}" is not open or not revertible`)
    }
    return revertible
  }

  // --- Reverting ----------------------------------------------------------

  /** A part's record, decoded, rewritten and encoded again. */
  const rewritePart = (part: Part, docId: string, remap: Remap): Part => {
    if (part.docId !== docId || remap.size === 0) return part
    const revertible = revertibleOf(docId)
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
    attempt: (part: Part, record: unknown) => ReturnType<Revertible["revert"]>,
  ): boolean => {
    const waiting = [...step.parts]
    const done: Part[] = []
    const remaps: { docId: string; remap: Remap }[] = []
    reverting = true
    try {
      for (let part = waiting.pop(); part !== undefined; part = waiting.pop()) {
        const revertible = revertibleOf(part.docId)
        const record = revertible.codec.decode(base64ToUint8Array(part.record))
        const result = attempt(part, record)
        if (result === null) continue
        done.push({
          ...part,
          record: uint8ArrayToBase64(revertible.codec.encode(result.redo)),
        })
        const { docId } = part
        const { remap } = result
        remaps.push({ docId, remap })
        waiting.splice(
          0,
          waiting.length,
          ...waiting.map(p => rewritePart(p, docId, remap)),
        )
        done.splice(
          0,
          done.length,
          ...done.map(p => rewritePart(p, docId, remap)),
        )
      }
    } finally {
      reverting = false
    }
    const redo = done.length > 0 ? { id: step.id, parts: done } : undefined
    write(
      moveStep(read(), direction, step, redo, part =>
        remaps.reduce(
          (p, { docId, remap }) => rewritePart(p, docId, remap),
          part,
        ),
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
        const stack = read()
        const list = effect.direction === "undo" ? stack.undo : stack.redo
        const step = list.at(-1)
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
        const positions: Record<string, string> = {}
        for (const part of effect.step.parts) {
          positions[part.docId] ??= uint8ArrayToBase64(
            revertibleOf(part.docId).position(),
          )
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
          (part, record) =>
            revertibleOf(part.docId).revert(record, effect.options),
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
    const list = note.direction === "undo" ? stack.undo : stack.redo
    const step = list.find(s => s.id === note.step)
    if (step === undefined) {
      write({ ...stack, pending: null })
      return
    }
    await openAll(step, true)
    settleStep(note.direction, step, (part, record) => {
      const revertible = revertibleOf(part.docId)
      const noted = note.positions[part.docId]
      const position =
        noted === undefined ? undefined : base64ToUint8Array(noted)
      return position !== undefined && revertible.authoredSince(position)
        ? revertible.recovered(record, position)
        : revertible.revert(record, {})
    })
  }

  dispatch({ type: "loaded", pending: read().pending ?? undefined })

  const request = (direction: Direction, options: CommitOptions) =>
    new Promise<boolean>(resolve => {
      const token = nextToken++
      resolvers.set(token, resolve)
      dispatch({ type: "requested", direction, options, token })
    })

  return {
    doc,

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
