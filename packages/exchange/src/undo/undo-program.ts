// undo-program — an undo stack's decisions, as a pure program.
//
// What joins a step, when a step closes, and the order of an undo: note the
// step, wait for the note to be stored, plan every part, decide from the
// tallies, then apply or drop, and say what was done. Every effect is data;
// `stack.ts` executes them, the planning included, and the program decides
// from what planning answers. The undo document is the stack's record of
// truth: the program keeps only what is not written yet (the open step) and
// what is in flight.

import type { Program } from "@kyneta/machine"
import type {
  CommitOptions,
  Edit,
  Footprint,
  ReplicaType,
  Revertible,
  SyncMode,
  Tally,
} from "@kyneta/schema"
import { continuesStep, footprintUnion, settleStep } from "@kyneta/schema"
import type { Direction, Note, Part, Step } from "./schema.js"

/** An undo or redo asked for. */
export interface Request {
  readonly direction: Direction
  readonly options: CommitOptions
  /** The documents a step must write to be taken; every document when
   *  undefined. */
  readonly docs: readonly string[] | undefined
  /** Undo the step entirely, or refuse it. */
  readonly whole: boolean
  readonly token: number
}

/** How a commit reached the stack. */
export type Via = "gesture" | "typing" | "follow"

/** One document's share of the open step: its record, not yet encoded. */
export interface OpenPart {
  readonly docId: string
  readonly schemaHash: string
  readonly replicaType: ReplicaType
  readonly syncMode: SyncMode
  readonly record: unknown
  readonly footprint: Footprint
  /** The substrate's pure record algebra, bound when the commit was heard. */
  readonly algebra: Pick<Revertible, "compose" | "codec">
}

/** The step being gathered, not yet written. */
export interface OpenStep {
  readonly via: Via
  /** At most one per document: a document's commits compose into one. */
  readonly parts: readonly OpenPart[]
  /** The last typing edit, which the next one may continue. */
  readonly edit: Edit | undefined
}

/** What an undo or redo without `whole` did. */
export type Undone =
  | { readonly kind: "none"; readonly dropped: readonly Step[] }
  | {
      readonly kind: "undone"
      readonly step: Step
      /** Its parts that did not stand whole. */
      readonly stale: readonly Part[]
      /** Steps nothing of which stood, removed before it. */
      readonly dropped: readonly Step[]
    }

/** What an undo or redo with `whole` did: a step that did not stand whole
 *  is refused, and dropped, and nothing of it reverted. */
export type UndoneWhole =
  | { readonly kind: "none" }
  | { readonly kind: "undone"; readonly step: Step }
  | {
      readonly kind: "refused"
      readonly step: Step
      /** Its parts that did not stand whole. */
      readonly stale: readonly Part[]
    }

/** What became of a request, before its mode shapes the result. */
export type Settled =
  | { readonly kind: "none"; readonly dropped: readonly Step[] }
  | {
      readonly kind: "undone" | "refused"
      readonly step: Step
      readonly stale: readonly Part[]
      readonly dropped: readonly Step[]
    }

/** The result a request of this mode resolves with. */
export function shapeResult(
  whole: boolean,
  settled: Settled,
): Undone | UndoneWhole {
  if (whole) {
    if (settled.kind === "none") return { kind: "none" }
    if (settled.kind === "undone") return { kind: "undone", step: settled.step }
    return { kind: "refused", step: settled.step, stale: settled.stale }
  }
  if (settled.kind === "none") return settled
  const { step, stale, dropped } = settled
  return { kind: "undone", step, stale, dropped }
}

/** An undo or redo in flight. */
export type Busy =
  | {
      readonly phase: "beginning" | "noting" | "planning"
      readonly request: Request
      readonly step: Step | undefined
      /** Steps nothing of which stood, dropped on the way. */
      readonly dropped: readonly Step[]
    }
  | { readonly phase: "recovering"; readonly note: Note }

export interface UndoModel {
  readonly open: OpenStep | undefined
  /** Inside `gesture`: commits join the open step whatever they are. */
  readonly gesture: boolean
  readonly queue: readonly Request[]
  readonly busy: Busy | undefined
  /** Writes to the undo document since it was last compacted. */
  readonly writes: number
  /** The typing pause after which a step closes, in milliseconds. */
  readonly gap: number
}

export type UndoInput =
  | {
      readonly type: "commit"
      readonly part: OpenPart
      readonly edit: Edit | undefined
      readonly via: Via
    }
  | { readonly type: "gesture-opened" }
  | { readonly type: "gesture-closed" }
  | { readonly type: "gap-elapsed"; readonly at: number }
  | { readonly type: "requested"; readonly request: Request }
  | { readonly type: "loaded"; readonly pending: Note | undefined }
  | { readonly type: "began"; readonly step: Step | undefined }
  | { readonly type: "noted" }
  /** Each part's tally, aligned with `step.parts`. */
  | {
      readonly type: "planned"
      readonly step: Step
      readonly tallies: readonly Tally[]
    }
  | { readonly type: "recovered" }

export type UndoEffect =
  /** Encode these parts and write them as a new step: onto `undo`, clearing
   *  the redo steps it conflicts with, keeping `depth`. The shell names it:
   *  an id must be unique across sessions. */
  | { readonly type: "push"; readonly parts: readonly OpenPart[] }
  /** Wake the program with `gap-elapsed` after `ms`. */
  | { readonly type: "set-timer"; readonly ms: number }
  /** Read the step of `direction`'s list a request for `docs` takes
   *  (`topStep`), and open its documents. */
  | {
      readonly type: "begin"
      readonly direction: Direction
      readonly docs: readonly string[] | undefined
    }
  /** Write the note for `step`, and wait until it is stored. */
  | {
      readonly type: "note"
      readonly step: Step
      readonly direction: Direction
      readonly whole: boolean
    }
  /** Plan every part of `step` against its document now, keep the plans,
   *  and answer `planned`. */
  | { readonly type: "plan"; readonly step: Step }
  /** Apply the plans of `step` that stand, and move it to the other list
   *  as its redo, in one write. */
  | {
      readonly type: "apply"
      readonly step: Step
      readonly direction: Direction
      readonly options: CommitOptions
    }
  /** Remove `step` from `direction`'s list, reverting nothing. */
  | {
      readonly type: "drop"
      readonly step: Step
      readonly direction: Direction
    }
  /** Finish the revert a crash interrupted, or plan it again when it never
   *  happened. */
  | { readonly type: "recover"; readonly note: Note }
  | {
      readonly type: "resolve"
      readonly token: number
      readonly result: Undone | UndoneWhole
    }
  | { readonly type: "compact" }

/** Writes between compactions of the undo document. */
export const COMPACT_EVERY = 200

export function initUndo(gap: number): UndoModel {
  return {
    open: undefined,
    gesture: false,
    queue: [],
    busy: undefined,
    writes: 0,
    gap,
  }
}

type Result = [UndoModel, ...UndoEffect[]]

/** Close the open step: write it if it has parts. */
function close(model: UndoModel): Result {
  const { open } = model
  if (open === undefined || open.parts.length === 0) {
    return [{ ...model, open: undefined }]
  }
  return written(
    { ...model, open: undefined },
    { type: "push", parts: open.parts },
  )
}

/** Count a write, and compact every `COMPACT_EVERY`. */
function written(model: UndoModel, ...effects: UndoEffect[]): Result {
  const writes = model.writes + 1
  return writes >= COMPACT_EVERY
    ? [{ ...model, writes: 0 }, ...effects, { type: "compact" }]
    : [{ ...model, writes }, ...effects]
}

/** Start the next queued request, if nothing is in flight. */
function next(model: UndoModel): Result {
  const [request, ...rest] = model.queue
  if (model.busy !== undefined || request === undefined) return [model]
  return [
    {
      ...model,
      queue: rest,
      busy: { phase: "beginning", request, step: undefined, dropped: [] },
    },
    { type: "begin", direction: request.direction, docs: request.docs },
  ]
}

function then(first: Result, step: (model: UndoModel) => Result): Result {
  const [model, ...effects] = first
  const [after, ...more] = step(model)
  return [after, ...effects, ...more]
}

/**
 * `parts` with `part` joined: appended when its document has no part yet,
 * composed into that document's part otherwise. Null when it cannot join:
 * the two records do not compose (something foreign came between them), or
 * come from different backends (the document was replaced by one of another
 * kind).
 */
function joinPart(
  parts: readonly OpenPart[],
  part: OpenPart,
): readonly OpenPart[] | null {
  const i = parts.findIndex(p => p.docId === part.docId)
  const open = parts[i]
  if (open === undefined) return [...parts, part]
  if (open.algebra.compose !== part.algebra.compose) return null
  const record = part.algebra.compose(open.record, part.record)
  if (record === null) return null
  return parts.with(i, {
    ...part,
    record,
    footprint: footprintUnion(open.footprint, part.footprint),
  })
}

/** The parts of `step` that did not stand whole. */
function staleParts(step: Step, tallies: readonly Tally[]): Part[] {
  return step.parts.filter((_, i) => {
    const tally = tallies[i]
    return tally === undefined || tally.kept < tally.total
  })
}

export const undoProgram = (
  gap: number,
): Program<UndoInput, UndoModel, UndoEffect> => ({
  init: [initUndo(gap)],

  update(msg, model): Result {
    switch (msg.type) {
      case "commit": {
        const { open } = model
        if (msg.via === "gesture") {
          if (!model.gesture || open === undefined) return [model]
          const parts = joinPart(open.parts, msg.part)
          if (parts !== null) return [{ ...model, open: { ...open, parts } }]
          // The step closes, and the commit opens the next one, still
          // inside the gesture.
          return then(close(model), m => [
            {
              ...m,
              open: { via: "gesture", parts: [msg.part], edit: undefined },
            },
          ])
        }
        // A typing step is one document's: `Edit.path` is a path inside one
        // document, so the same path in another document is another text.
        const [only, ...more] = open?.parts ?? []
        const parts =
          open !== undefined &&
          open.via === msg.via &&
          more.length === 0 &&
          only?.docId === msg.part.docId &&
          open.edit !== undefined &&
          msg.edit !== undefined &&
          continuesStep(open.edit, msg.edit, model.gap)
            ? joinPart(open.parts, msg.part)
            : null
        if (open !== undefined && parts !== null) {
          return [
            { ...model, open: { ...open, parts, edit: msg.edit } },
            { type: "set-timer", ms: model.gap },
          ]
        }
        return then(close(model), m => [
          { ...m, open: { via: msg.via, parts: [msg.part], edit: msg.edit } },
          { type: "set-timer", ms: model.gap },
        ])
      }

      case "gesture-opened":
        return then(close(model), m => [
          {
            ...m,
            gesture: true,
            open: { via: "gesture", parts: [], edit: undefined },
          },
        ])

      case "gesture-closed":
        return close({ ...model, gesture: false })

      case "gap-elapsed": {
        const { open } = model
        if (open === undefined || open.via === "gesture") return [model]
        const since =
          open.edit === undefined ? model.gap : msg.at - open.edit.at
        return since >= model.gap ? close(model) : [model]
      }

      case "requested":
        return then(close(model), m =>
          next({ ...m, queue: [...m.queue, msg.request] }),
        )

      case "loaded":
        if (msg.pending === undefined) return next(model)
        return [
          { ...model, busy: { phase: "recovering", note: msg.pending } },
          { type: "recover", note: msg.pending },
        ]

      case "recovered":
        return then(written({ ...model, busy: undefined }), next)

      case "began": {
        const busy = model.busy
        if (busy === undefined || busy.phase !== "beginning") return [model]
        const { request } = busy
        if (msg.step === undefined) {
          return then(
            [
              { ...model, busy: undefined },
              {
                type: "resolve",
                token: request.token,
                result: shapeResult(request.whole, {
                  kind: "none",
                  dropped: busy.dropped,
                }),
              },
            ],
            next,
          )
        }
        return written(
          { ...model, busy: { ...busy, phase: "noting", step: msg.step } },
          {
            type: "note",
            step: msg.step,
            direction: request.direction,
            whole: request.whole,
          },
        )
      }

      case "noted": {
        const busy = model.busy
        if (busy === undefined || busy.phase !== "noting") return [model]
        const { step } = busy
        if (step === undefined) return [model]
        return [
          { ...model, busy: { ...busy, phase: "planning" } },
          { type: "plan", step },
        ]
      }

      case "planned": {
        const busy = model.busy
        if (busy === undefined) return [model]
        const { step, tallies } = msg

        // A crash's revert that never happened, decided as its request was.
        if (busy.phase === "recovering") {
          const { direction, whole } = busy.note
          const outcome = settleStep(tallies, whole)
          return then(
            written(
              { ...model, busy: undefined },
              outcome === "undone"
                ? { type: "apply", step, direction, options: {} }
                : { type: "drop", step, direction },
            ),
            next,
          )
        }

        if (busy.phase !== "planning" || busy.step?.id !== step.id) {
          return [model]
        }
        const { request, dropped } = busy
        const { direction, docs, whole, token } = request
        const outcome = settleStep(tallies, whole)
        // Nothing of the step stood: it is gone from the stack, the result
        // will name it, and the step taken next for the same documents is
        // tried.
        if (outcome === "dropped") {
          return written(
            {
              ...model,
              busy: {
                ...busy,
                phase: "beginning",
                step: undefined,
                dropped: [...dropped, step],
              },
            },
            { type: "drop", step, direction },
            { type: "begin", direction, docs },
          )
        }
        const stale = staleParts(step, tallies)
        return then(
          written(
            { ...model, busy: undefined },
            outcome === "undone"
              ? { type: "apply", step, direction, options: request.options }
              : { type: "drop", step, direction },
            {
              type: "resolve",
              token,
              result: shapeResult(whole, {
                kind: outcome,
                step,
                stale,
                dropped,
              }),
            },
          ),
          next,
        )
      }
    }
  },
})
