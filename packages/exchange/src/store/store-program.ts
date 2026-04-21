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

export type DocPhase =
  | { status: "idle"; version: string }
  | {
      status: "writing"
      version: string
      pendingVersion: string
      queued?: QueuedInput
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
 */
function processQueued(
  docId: DocId,
  idleVersion: string,
  queued: QueuedInput,
): [DocPhase, ...StoreEffect[]] {
  switch (queued.type) {
    case "state-advanced": {
      const phase: DocPhase = {
        status: "writing",
        version: idleVersion,
        pendingVersion: queued.newVersion,
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
        version: idleVersion,
        pendingVersion: queued.newVersion,
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
        const phase: DocPhase = {
          status: "writing",
          version: "",
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

        if (existing.status === "idle") {
          const phase: DocPhase = {
            status: "writing",
            version: existing.version,
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

        // writing — queue (latest wins)
        const phase: DocPhase = {
          status: "writing",
          version: existing.version,
          pendingVersion: msg.newVersion,
          queued: {
            type: "state-advanced",
            delta: msg.delta,
            newVersion: msg.newVersion,
          },
        }
        return [withDoc(model, msg.docId, phase)]
      }

      // -------------------------------------------------------------------
      // compact — replace entire doc
      // -------------------------------------------------------------------
      case "compact": {
        const existing = model.docs.get(msg.docId)
        if (!existing) return [model]

        if (existing.status === "idle") {
          const phase: DocPhase = {
            status: "writing",
            version: existing.version,
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

        // writing — queue (latest wins)
        const phase: DocPhase = {
          status: "writing",
          version: existing.version,
          pendingVersion: msg.newVersion,
          queued: {
            type: "compact",
            meta: msg.meta,
            entirety: msg.entirety,
            newVersion: msg.newVersion,
          },
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

        const idleVersion = msg.version

        if (existing.queued) {
          const [phase, ...effects] = processQueued(
            msg.docId,
            idleVersion,
            existing.queued,
          )
          return [withDoc(model, msg.docId, phase), ...effects]
        }

        const phase: DocPhase = { status: "idle", version: idleVersion }
        return [withDoc(model, msg.docId, phase)]
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

        // Revert to idle at the old version — next exportSince will
        // recompute from the old version, so nothing is lost.
        const idleVersion = existing.version

        if (existing.queued) {
          const [phase, ...queuedEffects] = processQueued(
            msg.docId,
            idleVersion,
            existing.queued,
          )
          return [withDoc(model, msg.docId, phase), errorEffect, ...queuedEffects]
        }

        const phase: DocPhase = { status: "idle", version: idleVersion }
        return [withDoc(model, msg.docId, phase), errorEffect]
      }
    }
  },
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

export function allDocsIdle(model: StoreModel): boolean {
  for (const phase of model.docs.values()) {
    if (phase.status !== "idle") return false
  }
  return true
}