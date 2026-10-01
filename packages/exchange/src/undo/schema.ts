// undo/schema — the document an undo stack lives in.
//
// A stack is plain data: steps of records, one per document a gesture
// wrote, each encoded by its substrate. It is kept in a serialized document
// the app names, so the exchange stores, syncs and compacts it like any
// other, and the one-writer rule of serialized documents is what keeps two
// runtimes from popping the same step.

import type { ReplicaType, SyncMode } from "@kyneta/schema"
import { json, Schema } from "@kyneta/schema"

/** One document's record in a step. */
export interface Part {
  readonly docId: string
  /** What opens the document again after a reload, through the Exchange's
   *  schema registry. */
  readonly schemaHash: string
  readonly replicaType: ReplicaType
  readonly syncMode: SyncMode
  /** The record, in its substrate's codec, as base64. */
  readonly record: string
}

/** What one gesture did: its parts, in the order they committed. */
export interface Step {
  readonly id: string
  readonly parts: readonly Part[]
}

export type Direction = "undo" | "redo"

/** The write-ahead note: a revert about to happen, and where each document
 *  stood before it. */
export interface Note {
  readonly step: string
  readonly direction: Direction
  /** docId → the substrate's position, as base64. */
  readonly positions: Readonly<Record<string, string>>
}

const StepSchema = Schema.struct.json({
  id: Schema.string(),
  parts: Schema.list.json(
    Schema.struct.json({
      docId: Schema.string(),
      schemaHash: Schema.string(),
      replicaType: Schema.list.json(Schema.any()),
      syncMode: Schema.struct.json({
        writerModel: Schema.string(),
        durability: Schema.string(),
      }),
      record: Schema.string(),
    }),
  ),
})

/** The undo document: stacks by key. */
export const UndoSchema = Schema.struct({
  stacks: Schema.record(
    Schema.struct({
      undo: Schema.list(StepSchema),
      redo: Schema.list(StepSchema),
      pending: Schema.struct
        .json({
          step: Schema.string(),
          direction: Schema.string(),
          positions: Schema.record.json(Schema.string()),
        })
        .nullable(),
    }),
  ),
})

/** The undo document, bound. Serialized: one writer. */
export const UndoDoc = json.bind(UndoSchema)
