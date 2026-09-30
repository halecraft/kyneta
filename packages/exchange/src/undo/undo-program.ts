// undo-program — an undo stack's decisions, as a pure program.
//
// What joins a step, when a step closes, and the order of an undo: note the
// step, wait for the note to be stored, revert, record. Every effect is data;
// `stack.ts` executes them. The undo document is the stack's record of
// truth: the program keeps only what is not written yet (the open step) and
// what is in flight.

import type { Program } from "@kyneta/machine"
import type { CommitOptions, Edit } from "@kyneta/schema"
import { continuesStep } from "@kyneta/schema"
import type { Direction, Note, Part, Request, Step } from "./schema.js"

/** How a commit reached the stack. */
export type Via = "gesture" | "typing" | "follow"

/** The step being gathered, not yet written. */
export interface OpenStep {
  readonly via: Via
  readonly parts: readonly Part[]
  /** The last typing edit, which the next one may continue. */
  readonly edit: Edit | undefined
}

/** An undo or redo in flight. */
export type Busy =
  | {
      readonly phase: "beginning" | "noting" | "reverting"
      readonly request: Request
      readonly step: Step | undefined
    }
  | { readonly phase: "recovering" }

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
      readonly part: Part
      readonly edit: Edit | undefined
      readonly via: Via
    }
  | { readonly type: "gesture-opened" }
  | { readonly type: "gesture-closed" }
  | { readonly type: "gap-elapsed"; readonly at: number }
  | {
      readonly type: "requested"
      readonly direction: Direction
      readonly options: CommitOptions
      readonly token: number
    }
  | { readonly type: "loaded"; readonly pending: Note | undefined }
  | { readonly type: "began"; readonly step: Step | undefined }
  | { readonly type: "noted" }
  | { readonly type: "reverted"; readonly applied: boolean }
  | { readonly type: "recovered" }

export type UndoEffect =
  /** Write a new step of these parts: onto `undo`, clearing `redo`, keeping
   *  `depth`. The shell names it: an id must be unique across sessions. */
  | { readonly type: "push"; readonly parts: readonly Part[] }
  /** Wake the program with `gap-elapsed` after `ms`. */
  | { readonly type: "set-timer"; readonly ms: number }
  /** Read the top step of `direction`'s list and open its documents. */
  | { readonly type: "begin"; readonly direction: Direction }
  /** Write the note for `step`, and wait until it is stored. */
  | {
      readonly type: "note"
      readonly step: Step
      readonly direction: Direction
    }
  /** Revert `step`'s parts, last first, and record it moved. */
  | {
      readonly type: "revert"
      readonly step: Step
      readonly direction: Direction
      readonly options: CommitOptions
    }
  /** Finish the revert a crash interrupted. */
  | { readonly type: "recover"; readonly note: Note }
  | { readonly type: "resolve"; readonly token: number; readonly done: boolean }
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
      busy: { phase: "beginning", request, step: undefined },
    },
    { type: "begin", direction: request.direction },
  ]
}

function then(first: Result, step: (model: UndoModel) => Result): Result {
  const [model, ...effects] = first
  const [after, ...more] = step(model)
  return [after, ...effects, ...more]
}

export const undoProgram = (
  gap: number,
): Program<UndoInput, UndoModel, UndoEffect> => ({
  init: [initUndo(gap)],

  update(msg, model): Result {
    switch (msg.type) {
      case "commit": {
        if (msg.via === "gesture") {
          const { open } = model
          if (!model.gesture || open === undefined) return [model]
          return [
            { ...model, open: { ...open, parts: [...open.parts, msg.part] } },
          ]
        }
        const { open } = model
        if (
          open !== undefined &&
          open.via === msg.via &&
          open.edit !== undefined &&
          msg.edit !== undefined &&
          continuesStep(open.edit, msg.edit, model.gap)
        ) {
          return [
            {
              ...model,
              open: {
                ...open,
                parts: [...open.parts, msg.part],
                edit: msg.edit,
              },
            },
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
          next({
            ...m,
            queue: [
              ...m.queue,
              {
                direction: msg.direction,
                options: msg.options,
                token: msg.token,
              },
            ],
          }),
        )

      case "loaded":
        if (msg.pending === undefined) return next(model)
        return [
          { ...model, busy: { phase: "recovering" } },
          { type: "recover", note: msg.pending },
        ]

      case "recovered":
        return then(written({ ...model, busy: undefined }), next)

      case "began": {
        const busy = model.busy
        if (busy === undefined || busy.phase !== "beginning") return [model]
        if (msg.step === undefined) {
          return then(
            [
              { ...model, busy: undefined },
              { type: "resolve", token: busy.request.token, done: false },
            ],
            next,
          )
        }
        return written(
          { ...model, busy: { ...busy, phase: "noting", step: msg.step } },
          { type: "note", step: msg.step, direction: busy.request.direction },
        )
      }

      case "noted": {
        const busy = model.busy
        if (busy === undefined || busy.phase !== "noting") return [model]
        const { step } = busy
        if (step === undefined) return [model]
        return [
          { ...model, busy: { ...busy, phase: "reverting" } },
          {
            type: "revert",
            step,
            direction: busy.request.direction,
            options: busy.request.options,
          },
        ]
      }

      case "reverted": {
        const busy = model.busy
        if (busy === undefined || busy.phase !== "reverting") return [model]
        // Nothing of the step still stood: it is gone from the stack, and
        // the one below it is tried, silently.
        if (!msg.applied) {
          return written(
            {
              ...model,
              busy: { ...busy, phase: "beginning", step: undefined },
            },
            { type: "begin", direction: busy.request.direction },
          )
        }
        return then(
          written(
            { ...model, busy: undefined },
            { type: "resolve", token: busy.request.token, done: true },
          ),
          next,
        )
      }
    }
  },
})
