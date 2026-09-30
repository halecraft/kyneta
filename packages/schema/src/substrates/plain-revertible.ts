// plain-revertible — undo for a plain (serialized) document.
//
// A plain document has one writer, so its undo is a strict stack: a step is
// reverted exactly when the document is where the step left it, and then its
// recorded inverses apply as they are. A revert returns the document to the
// state before the step, at a new log position; the remap names that
// position, so the step below, which recorded the old one as where it left
// the document, reverts next. A write outside the stack moves the head
// somewhere no record names, and ends undo past it.
//
// Decisions are pure (`planPlainRevert`, `settlePlainRevert`,
// `rewritePlainRecord`); `createPlainRevertible` is the shell over a
// substrate's context and log head.

import type { ChangeBase } from "../change.js"
import type { Op } from "../changefeed.js"
import type { WritableContext } from "../interpreters/writable.js"
import type {
  BatchOutcome,
  CommitOptions,
  RecordCodec,
  Remap,
  Reverted,
  Revertible,
  RevertibleCommit,
} from "../substrate.js"
import { deserializeOps, type SerializedOp, serializeOps } from "./op-codec.js"

/** One authored batch on a plain document, as undo keeps it. */
export interface PlainRecord {
  /** The log head before the batch, as a serialized `PlainVersion`. */
  readonly before: string
  /** The log head after it. */
  readonly after: string
  /** The batch's ops, in order, at raw paths. */
  readonly ops: readonly Op[]
  /** Their inverses, in the same order. */
  readonly inverses: readonly Op[]
}

/**
 * The changes that revert `record`, last first, or null when the document is
 * not where the record left it.
 */
export function planPlainRevert(
  record: PlainRecord,
  head: string,
): readonly Op[] | null {
  if (head !== record.after) return null
  return [...record.inverses].reverse()
}

/**
 * What reverting `record` produced, given the heads around the revert. The
 * revert applied the record's inverses, so undoing the revert reapplies its
 * ops; and the new head is where `before` was.
 */
export function settlePlainRevert(
  record: PlainRecord,
  headBefore: string,
  headAfter: string,
): Reverted<PlainRecord> {
  return {
    redo: {
      before: headBefore,
      after: headAfter,
      ops: [...record.inverses].reverse(),
      inverses: [...record.ops].reverse(),
    },
    remap: new Map([[record.before, headAfter]]),
  }
}

/** `record` with its positions renamed through `remap`. */
export function rewritePlainRecord(
  record: PlainRecord,
  remap: Remap,
): PlainRecord {
  const before = remap.get(record.before) ?? record.before
  const after = remap.get(record.after) ?? record.after
  if (before === record.before && after === record.after) return record
  return { ...record, before, after }
}

interface EncodedRecord {
  readonly before: string
  readonly after: string
  readonly ops: SerializedOp[]
  readonly inverses: SerializedOp[]
}

const codec: RecordCodec<PlainRecord> = {
  encode(record) {
    const body: EncodedRecord = {
      before: record.before,
      after: record.after,
      ops: serializeOps(record.ops),
      inverses: serializeOps(record.inverses),
    }
    return new TextEncoder().encode(JSON.stringify(body))
  },
  decode(bytes) {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as EncodedRecord
    return {
      before: body.before,
      after: body.after,
      ops: deserializeOps(body.ops),
      inverses: deserializeOps(body.inverses),
    }
  },
}

/** What a plain substrate gives its undo. */
export interface PlainRevertibleHost {
  /** The log head, serialized. */
  head(): string
  /** Whether the head has passed `position` (a serialized head). */
  isPast(position: string): boolean
  context(): WritableContext
}

/** A plain substrate's undo, plus the hook its `afterBatch` calls. */
export interface PlainRevertible extends Revertible<PlainRecord> {
  /** Record a batch that moved the head from `before` to `after`. */
  captured(outcome: BatchOutcome, before: string, after: string): void
}

const raw = (op: { path: Op["path"]; change: ChangeBase }): Op => ({
  path: op.path.toRaw(),
  change: op.change,
})

export function createPlainRevertible(
  host: PlainRevertibleHost,
): PlainRevertible {
  const listeners = new Set<(commit: RevertibleCommit<PlainRecord>) => void>()
  let reverting = false

  return {
    captured(outcome, before, after) {
      if (reverting || outcome.aborted || outcome.inverses.length === 0) return
      if (listeners.size === 0) return
      const record: PlainRecord = {
        before,
        after,
        ops: outcome.ops.map(raw),
        inverses: outcome.inverses.map(e =>
          raw({ path: e.path, change: e.inverse }),
        ),
      }
      const commit = { record, ops: record.ops }
      for (const listener of [...listeners]) listener(commit)
    },

    subscribeCommits(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    revert(record: PlainRecord, options: CommitOptions) {
      const headBefore = host.head()
      const changes = planPlainRevert(record, headBefore)
      if (changes === null) return null
      const ctx = host.context()
      reverting = true
      try {
        ctx.runBatch(() => {
          for (const op of changes) ctx.dispatch(op.path, op.change)
        }, options)
      } finally {
        reverting = false
      }
      return settlePlainRevert(record, headBefore, host.head())
    },

    recovered(record, position) {
      return settlePlainRevert(
        record,
        new TextDecoder().decode(position),
        host.head(),
      )
    },

    rewrite: rewritePlainRecord,

    position() {
      return new TextEncoder().encode(host.head())
    },

    authoredSince(position) {
      return host.isPast(new TextDecoder().decode(position))
    },

    codec,
  }
}
