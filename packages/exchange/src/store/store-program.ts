// store-program — pure Mealy machine for store coordination.
//
// The store-program replaces imperative store coordination code in the
// Exchange. It is a pure Program<StoreInput, StoreModel, StoreEffect>
// run via createObservableProgram at the Exchange level. The Exchange's
// executor interprets effects as actual I/O (persist-append → store.append,
// persist-replace → store.replace, persist-delete → store.delete).
//
// Every transition is pure: new Map for each model, no mutation.

import type { SubstratePayload } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import type { StoreMeta, StoreRecord } from "./store.js"

// ---------------------------------------------------------------------------
// Program — local definition matching @kyneta/machine's Program type.
// The exchange package does not depend on @kyneta/machine; defining the
// type here keeps the dependency graph clean.
// ---------------------------------------------------------------------------

type Program<Msg, Model, Fx> = {
  init: [Model, ...Fx[]]
  update(msg: Msg, model: Model): [Model, ...Fx[]]
  done?(model: Model): void
}

// ---------------------------------------------------------------------------
// DocPhase — per-document lifecycle state
// ---------------------------------------------------------------------------

/**
 * A phase with no write in flight — what a `writing` phase falls back to.
 *
 * The two cases are genuinely different, and keeping them apart is the whole
 * point of this type. `unwritten` means the store has never acknowledged
 * anything for this document, so there is no version to compute a delta
 * against; `idle` means it has, and names the version.
 */
export type SettledPhase =
  | { status: "unwritten" }
  | { status: "idle"; version: string }

/**
 * Where a document's persistence has got to.
 *
 * A write in flight carries `revertTo` — the settled phase to return to if it
 * fails. That is what keeps this to three variants rather than four. The
 * alternative, a separate status for "writing with nothing to fall back to",
 * would silently fall out of every `status === "writing"` check in this file,
 * including the two that decide whether a completed write is acknowledged at
 * all. Carrying the fallback inside the phase means the decision is made once,
 * where the write starts and the caller knows which case it is in, rather than
 * being re-derived at each place a write can end.
 */
export type DocPhase =
  | SettledPhase
  | {
      status: "writing"
      revertTo: SettledPhase
      pendingVersion: string
      queued?: QueuedInput[]
    }

type QueuedInput =
  | {
      type: "state-advanced"
      delta: SubstratePayload
      newVersion: string
    }
  | {
      type: "compact"
      meta: StoreMeta
      entirety: SubstratePayload
      newVersion: string
    }

// ---------------------------------------------------------------------------
// StoreModel
// ---------------------------------------------------------------------------

export type StoreModel = {
  docs: Map<DocId, DocPhase>
}

// ---------------------------------------------------------------------------
// StoreInput — messages into the program
// ---------------------------------------------------------------------------

export type StoreInput =
  | {
      type: "register"
      docId: DocId
      meta: StoreMeta
      entirety: SubstratePayload
      version: string
    }
  | { type: "hydrated"; docId: DocId; version: string }
  | {
      type: "state-advanced"
      docId: DocId
      delta: SubstratePayload
      newVersion: string
    }
  | {
      type: "compact"
      docId: DocId
      meta: StoreMeta
      entirety: SubstratePayload
      newVersion: string
    }
  | { type: "destroy"; docId: DocId }
  | { type: "write-succeeded"; docId: DocId; version: string }
  | { type: "write-failed"; docId: DocId; error: unknown }

// ---------------------------------------------------------------------------
// StoreEffect — data effects interpreted by the Exchange executor
// ---------------------------------------------------------------------------

export type StoreEffect =
  | { type: "persist-append"; docId: DocId; records: StoreRecord[] }
  | { type: "persist-replace"; docId: DocId; records: StoreRecord[] }
  | { type: "persist-delete"; docId: DocId }
  | {
      type: "store-error"
      docId: DocId
      operation: string
      error: unknown
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withDoc(
  model: StoreModel,
  docId: DocId,
  phase: DocPhase | null,
): StoreModel {
  const docs = new Map(model.docs)
  if (phase === null) {
    docs.delete(docId)
  } else {
    docs.set(docId, phase)
  }
  return { docs }
}

/**
 * The caller is responsible for splicing the returned phase into the model.
 *
 * `settled` is where the replayed write reverts to if it also fails — carried
 * through rather than rebuilt, so a queued write inherits the same fallback the
 * write it was queued behind had.
 *
 * A queued `state-advanced` cannot arrive here with `settled.status ===
 * "unwritten"`. Queueing only happens while a write is in flight, and
 * `state-advanced` is dropped rather than queued for a document with nothing
 * written (see the `state-advanced` case). So the pairing is unreachable, and
 * there is no branch for it below.
 */
function processQueued(
  docId: DocId,
  settled: SettledPhase,
  queuedList: QueuedInput[],
): [DocPhase, ...StoreEffect[]] {
  // We process all queued inputs into a single batch of effects
  // But wait, StoreProgram expects a single phase transition.
  // If we have multiple queued inputs, we can only process the FIRST one,
  // and keep the rest in the queue!

  const queued = queuedList[0]
  const remaining = queuedList.slice(1)

  switch (queued.type) {
    case "state-advanced": {
      const phase: DocPhase = {
        status: "writing",
        revertTo: settled,
        pendingVersion: queued.newVersion,
        queued: remaining.length > 0 ? remaining : undefined,
      }
      const effect: StoreEffect = {
        type: "persist-append",
        docId,
        records: [
          { kind: "entry", payload: queued.delta, version: queued.newVersion },
        ],
      }
      return [phase, effect]
    }
    case "compact": {
      const phase: DocPhase = {
        status: "writing",
        revertTo: settled,
        pendingVersion: queued.newVersion,
        queued: remaining.length > 0 ? remaining : undefined,
      }
      const effect: StoreEffect = {
        type: "persist-replace",
        docId,
        records: [
          { kind: "meta", meta: queued.meta },
          {
            kind: "entry",
            payload: queued.entirety,
            version: queued.newVersion,
          },
        ],
      }
      return [phase, effect]
    }
  }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export const storeProgram: Program<StoreInput, StoreModel, StoreEffect> = {
  init: [{ docs: new Map() }],

  update(msg: StoreInput, model: StoreModel): [StoreModel, ...StoreEffect[]] {
    switch (msg.type) {
      // -------------------------------------------------------------------
      // register — new doc, first boot
      // -------------------------------------------------------------------
      case "register": {
        // Arrives twice for one document, on two different occasions. First
        // from hydration, when the document is opened and found in no store.
        // Again from the runtime's persist path if that first write failed —
        // there is no confirmed version to send a delta against, so a retry
        // has to be another whole write.
        //
        // So this must be correct when a phase already exists, not only when
        // the document is unknown. Overwriting is right: whatever the previous
        // phase was, the document is now writing its whole self again.
        //
        // Nothing to fall back to either way. If this write fails there is
        // still no earlier version to recompute a delta from.
        const phase: DocPhase = {
          status: "writing",
          revertTo: { status: "unwritten" },
          pendingVersion: msg.version,
        }
        const effect: StoreEffect = {
          type: "persist-append",
          docId: msg.docId,
          records: [
            { kind: "meta", meta: msg.meta },
            {
              kind: "entry",
              payload: msg.entirety,
              version: msg.version,
            },
          ],
        }
        return [withDoc(model, msg.docId, phase), effect]
      }

      // -------------------------------------------------------------------
      // hydrated — existing doc loaded from store
      // -------------------------------------------------------------------
      case "hydrated": {
        const phase: DocPhase = { status: "idle", version: msg.version }
        return [withDoc(model, msg.docId, phase)]
      }

      // -------------------------------------------------------------------
      // state-advanced — delta to persist
      // -------------------------------------------------------------------
      case "state-advanced": {
        const existing = model.docs.get(msg.docId)
        if (!existing) return [model]

        // A delta is defined relative to a version the store acknowledged. An
        // `unwritten` document has none, so there is nothing to append this to
        // and nothing worth queueing — dropping it is the only coherent
        // answer. Note `compact` below deliberately does the opposite, because
        // it carries a whole document rather than a difference.
        if (existing.status === "unwritten") return [model]

        if (existing.status === "idle") {
          const phase: DocPhase = {
            status: "writing",
            revertTo: existing,
            pendingVersion: msg.newVersion,
          }
          const effect: StoreEffect = {
            type: "persist-append",
            docId: msg.docId,
            records: [
              {
                kind: "entry",
                payload: msg.delta,
                version: msg.newVersion,
              },
            ],
          }
          return [withDoc(model, msg.docId, phase), effect]
        }

        // writing — queue. The fallback is inherited, not recomputed: a write
        // queued behind another reverts to wherever that one would have.
        const phase: DocPhase = {
          status: "writing",
          revertTo: existing.revertTo,
          pendingVersion: existing.pendingVersion,
          queued: [
            ...(existing.queued || []),
            {
              type: "state-advanced",
              delta: msg.delta,
              newVersion: msg.newVersion,
            },
          ],
        }
        return [withDoc(model, msg.docId, phase)]
      }

      // -------------------------------------------------------------------
      // compact — replace entire doc
      // -------------------------------------------------------------------
      case "compact": {
        const existing = model.docs.get(msg.docId)
        if (!existing) {
          return [model]
        }

        // Unlike `state-advanced`, this writes from an `unwritten` document as
        // readily as from an `idle` one. A compaction carries the whole
        // document and its own `meta`, so it needs no base version — it is a
        // complete write in its own right. `revertTo: existing` says the same
        // thing for both cases: fall back to wherever we already were.
        if (existing.status !== "writing") {
          const phase: DocPhase = {
            status: "writing",
            revertTo: existing,
            pendingVersion: msg.newVersion,
          }
          const effect: StoreEffect = {
            type: "persist-replace",
            docId: msg.docId,
            records: [
              { kind: "meta", meta: msg.meta },
              {
                kind: "entry",
                payload: msg.entirety,
                version: msg.newVersion,
              },
            ],
          }
          return [withDoc(model, msg.docId, phase), effect]
        }

        // writing — queue
        const phase: DocPhase = {
          status: "writing",
          revertTo: existing.revertTo,
          pendingVersion: existing.pendingVersion,
          queued: [
            ...(existing.queued || []),
            {
              type: "compact",
              meta: msg.meta,
              entirety: msg.entirety,
              newVersion: msg.newVersion,
            },
          ],
        }
        return [withDoc(model, msg.docId, phase)]
      }

      // -------------------------------------------------------------------
      // destroy — remove doc entirely
      // -------------------------------------------------------------------
      case "destroy": {
        const effect: StoreEffect = {
          type: "persist-delete",
          docId: msg.docId,
        }
        return [withDoc(model, msg.docId, null), effect]
      }

      // -------------------------------------------------------------------
      // write-succeeded — I/O completed, advance version
      // -------------------------------------------------------------------
      case "write-succeeded": {
        const existing = model.docs.get(msg.docId)
        if (!existing || existing.status !== "writing") return [model]

        // The store acknowledged this version, so it is now the confirmed
        // one — whatever the document fell back to before is irrelevant.
        const settled: SettledPhase = { status: "idle", version: msg.version }

        if (existing.queued) {
          const [phase, ...effects] = processQueued(
            msg.docId,
            settled,
            existing.queued,
          )
          return [withDoc(model, msg.docId, phase), ...effects]
        }

        return [withDoc(model, msg.docId, settled)]
      }

      // -------------------------------------------------------------------
      // write-failed — do NOT advance version (self-healing)
      // -------------------------------------------------------------------
      case "write-failed": {
        const existing = model.docs.get(msg.docId)
        if (!existing || existing.status !== "writing") return [model]

        const errorEffect: StoreEffect = {
          type: "store-error",
          docId: msg.docId,
          operation: "write",
          error: msg.error,
        }

        // Fall back to whatever this write was started from. No branch on
        // which kind of write failed: that decision was made when the phase
        // was constructed, by the code that knew whether a confirmed version
        // existed. For a document that had one, this preserves it so the next
        // `exportSince` recomputes from the last known-good point. For one
        // that did not, it returns to `unwritten` — still nothing on disk,
        // and now say-so rather than an empty string.
        const settled = existing.revertTo

        if (existing.queued) {
          const [phase, ...queuedEffects] = processQueued(
            msg.docId,
            settled,
            existing.queued,
          )
          return [
            withDoc(model, msg.docId, phase),
            errorEffect,
            ...queuedEffects,
          ]
        }

        return [withDoc(model, msg.docId, settled), errorEffect]
      }
    }
  },
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Is every tracked document quiescent — no store I/O in flight?
 *
 * `flush()` and `shutdown()` both block until this is true, so it has to mean
 * "nothing is still being written", not "every document has status `idle`".
 * Those came to the same thing when `idle` was the only settled status. They
 * do not now: an `unwritten` document has no write outstanding and must
 * satisfy this, or every teardown hangs waiting for a write that will never
 * complete. Only `writing` is busy.
 *
 * The name predates the distinction. It is kept because it is what the callers
 * read, but test the status against `writing` rather than against `idle`.
 */
export function allDocsIdle(model: StoreModel): boolean {
  for (const phase of model.docs.values()) {
    if (phase.status === "writing") return false
  }
  return true
}
