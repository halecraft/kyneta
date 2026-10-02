// store-program — pure Mealy machine for store coordination.
//
// The program decides *which* write a document owes and *from what base*. It
// never holds a payload. The executor (in `Runtime`) reads the replica at the
// moment a write starts, so every write is computed against the version the
// store has confirmed by then — including everything the previous write
// carried.
//
// It also reports what the store confirmed (`persisted`) and when a failed
// write should be tried again (`retry`), as effects, so the executor acts on
// them with the model already updated.
//
// It lets a document go once the store holds all of it (`release`), so its
// instance can leave memory: `released` is emitted from one check after every
// transition, for each document asked to be released whose phase is
// `storedEntirely`, and the document stops being tracked. Only an `idle` phase
// without failures qualifies: `unwritten` holds nothing confirmed, a phase with
// failures has a retry scheduled, and a lost seat can never store what is
// unconfirmed.
//
// Losing the store's seat (`seat-lost`) is final and store-wide: every later
// write would fail the same way, so the model becomes terminal and asks for
// nothing more. A write refused because another seat writes the document
// (`writer-refused`) ends only that document's tracking, and asks the
// executor to `rebuild` it from storage.
//
// Every transition is pure: new Map for each model, no mutation.

import type { Program } from "@kyneta/machine"
import type { DocId } from "@kyneta/transport"
import type { Generation } from "../lifecycle-program.js"
import type { WriterRefusedError } from "./seats.js"

// ---------------------------------------------------------------------------
// DocPhase — per-document lifecycle state
// ---------------------------------------------------------------------------

/**
 * A phase with no write in flight — what a `writing` phase falls back to.
 *
 * `unwritten` means the store has never acknowledged anything for this
 * document, so there is no version to compute a delta against; `idle` means
 * it has, and names the version.
 *
 * `failures` counts the writes that have failed in a row since the last one
 * that succeeded, and sets the delay before the next retry. Absent when the
 * last write succeeded.
 */
export type SettledPhase =
  | { status: "unwritten"; failures?: number }
  | { status: "idle"; version: string; failures?: number }

/**
 * A write requested while another is in flight.
 *
 * Not a payload: a request, resolved against the replica when the write in
 * flight ends. `compact` absorbs `advance`, because a compaction writes the
 * whole document as it stands when it starts, which includes any advance.
 */
export type Owed = "advance" | "compact"

/**
 * Where a document's persistence has got to.
 *
 * A write in flight carries `revertTo` — the settled phase to return to if it
 * fails — and `owed`, the one further write requested since it started. Two
 * requests during one write collapse into one follow-up, so the number of
 * store records is bounded by the number of writes, not by the number of
 * mutations that arrived during them.
 */
export type DocPhase =
  | SettledPhase
  | { status: "writing"; revertTo: SettledPhase; owed?: Owed }

// ---------------------------------------------------------------------------
// StoreModel
// ---------------------------------------------------------------------------

export type StoreModel = {
  docs: Map<DocId, DocPhase>
  /**
   * The documents asked to be released, by the generation the lifecycle asked
   * for, which `released` echoes. Each is released, and leaves `docs`, at the
   * first transition after which its phase is `storedEntirely`.
   */
  releasing: ReadonlyMap<DocId, Generation>
  /**
   * Set once a write found the store's seat claimed by another writer: the
   * `SeatLostError`. The model is then terminal. It tracks no document, so
   * every document counts as settled, and it answers every input with
   * nothing.
   */
  seatLost?: unknown
}

// ---------------------------------------------------------------------------
// StoreInput — messages into the program
// ---------------------------------------------------------------------------

export type StoreInput =
  /** Hydration found the document in no store. */
  | { type: "register"; docId: DocId }
  /** Hydration loaded the document; the store holds it at `version`. */
  | { type: "hydrated"; docId: DocId; version: string }
  /** The document's state may have moved past what the store holds. */
  | { type: "state-advanced"; docId: DocId }
  /** Replace what the store holds with the document as it now stands. */
  | { type: "compact"; docId: DocId }
  | { type: "destroy"; docId: DocId }
  | { type: "write-succeeded"; docId: DocId; version: string }
  | { type: "write-failed"; docId: DocId; error: unknown }
  /** A write of `docId` found the store's seat claimed by another writer. */
  | { type: "seat-lost"; docId: DocId; error: unknown }
  /**
   * An authored write of `docId` was refused: another seat of the storage is
   * the serialized document's writer.
   */
  | { type: "writer-refused"; docId: DocId; error: WriterRefusedError }
  /** Emit `released` once the store holds all of `docId`, then stop tracking it. */
  | { type: "release"; docId: DocId; gen: Generation }
  /** Withdraw a release not yet made. */
  | { type: "keep"; docId: DocId }

// ---------------------------------------------------------------------------
// StoreEffect — data effects interpreted by the Runtime executor
// ---------------------------------------------------------------------------

/**
 * The write to perform. The executor reads the replica when it starts it.
 *
 * - `register` — meta and the whole document, appended. For a document the
 *   store has never acknowledged.
 * - `since` — the delta since `version`, the store's confirmed version,
 *   appended. If the document has not moved past it there is nothing to write,
 *   and the executor reports success at `version` without touching the store.
 * - `compact` — meta and the whole document, replacing what is stored.
 */
export type Write =
  | { kind: "register" }
  | { kind: "since"; version: string }
  | { kind: "compact" }

export type StoreEffect =
  | { type: "persist"; docId: DocId; write: Write }
  /** The store now holds the document at `version`. */
  | { type: "persisted"; docId: DocId; version: string }
  /**
   * The store holds all of the document, at `version`, and no longer tracks
   * it. `gen` is the release's, echoed. An offer: a lifecycle that kept the
   * document meanwhile hands it back with `hydrated` at `version`.
   */
  | { type: "released"; docId: DocId; gen: Generation; version: string }
  /** A write failed and none is owed: ask for one again after `afterMs`. */
  | { type: "retry"; docId: DocId; afterMs: number }
  | { type: "persist-delete"; docId: DocId }
  /** The seat is lost: nothing more will be written, or retried. */
  | { type: "seat-lost" }
  /**
   * Replace the document with what the store holds, discarding the refused
   * write, and report back with `hydrated` (or `register`).
   */
  | { type: "rebuild"; docId: DocId; error: WriterRefusedError }
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
  return { ...model, docs }
}

/** `model` with `docId`'s release recorded under `gen`, or withdrawn. */
function withRelease(
  model: StoreModel,
  docId: DocId,
  gen: Generation | null,
): StoreModel {
  const releasing = new Map(model.releasing)
  if (gen === null) releasing.delete(docId)
  else releasing.set(docId, gen)
  return { ...model, releasing }
}

/**
 * Release every document asked to be released whose phase is
 * `storedEntirely`, after the effects of the transition that made it so: a
 * `persisted` the same write emitted comes first.
 */
function releaseStored(
  model: StoreModel,
  effects: StoreEffect[],
): [StoreModel, ...StoreEffect[]] {
  let next = model
  const released: StoreEffect[] = []
  for (const [docId, gen] of model.releasing) {
    const phase = model.docs.get(docId)
    if (phase === undefined || !storedEntirely(phase)) continue
    next = withRelease(withDoc(next, docId, null), docId, null)
    released.push({ type: "released", docId, gen, version: phase.version })
  }
  return [next, ...effects, ...released]
}

/**
 * Begin the write `owed` from `settled`.
 *
 * The only place a write starts, so the one place that decides its kind. An
 * `advance` from `unwritten` has no confirmed version to diff against, so it
 * writes the whole document; that is also how a failed first write is retried.
 */
function start(
  docId: DocId,
  settled: SettledPhase,
  owed: Owed,
): [DocPhase, StoreEffect] {
  const write: Write =
    owed === "compact"
      ? { kind: "compact" }
      : settled.status === "idle"
        ? { kind: "since", version: settled.version }
        : { kind: "register" }
  return [
    { status: "writing", revertTo: settled },
    { type: "persist", docId, write },
  ]
}

/** Least upper bound of two requests: `compact` absorbs `advance`. */
function join(a: Owed | undefined, b: Owed): Owed {
  return a === "compact" || b === "compact" ? "compact" : "advance"
}

/**
 * Request a write: start it if nothing is in flight, otherwise owe it.
 */
function request(
  model: StoreModel,
  docId: DocId,
  existing: DocPhase,
  owed: Owed,
): [StoreModel, ...StoreEffect[]] {
  if (existing.status !== "writing") {
    const [phase, effect] = start(docId, existing, owed)
    return [withDoc(model, docId, phase), effect]
  }
  const phase: DocPhase = { ...existing, owed: join(existing.owed, owed) }
  return [withDoc(model, docId, phase)]
}

/**
 * The write in flight has ended and the document settles at `settled`. Start
 * what is owed, if anything, in the same transition — so a document with a
 * write owed never passes through a settled phase, and `flush()` cannot
 * observe it as quiescent in between.
 */
function settle(
  docId: DocId,
  existing: Extract<DocPhase, { status: "writing" }>,
  settled: SettledPhase,
): [DocPhase, ...StoreEffect[]] {
  if (!existing.owed) return [settled]
  return start(docId, settled, existing.owed)
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export const storeProgram: Program<StoreInput, StoreModel, StoreEffect> = {
  init: [{ docs: new Map(), releasing: new Map() }],

  update(msg: StoreInput, model: StoreModel): [StoreModel, ...StoreEffect[]] {
    if (model.seatLost !== undefined) return [model]
    const [next, ...effects] = transition(msg, model)
    return releaseStored(next, effects)
  },
}

function transition(
  msg: StoreInput,
  model: StoreModel,
): [StoreModel, ...StoreEffect[]] {
  switch (msg.type) {
    case "register": {
      // A document hydration found nowhere. It has nothing confirmed, so its
      // first write is the whole document.
      const existing = model.docs.get(msg.docId) ?? { status: "unwritten" }
      return request(model, msg.docId, existing, "advance")
    }

    case "hydrated": {
      // The store holds the document at `version`. The document may be
      // ahead of that, by writes made while it loaded, so a `since` write
      // is owed from there; when nothing arrived it touches no store.
      const phase: DocPhase = { status: "idle", version: msg.version }
      return request(model, msg.docId, phase, "advance")
    }

    case "state-advanced": {
      // Unknown documents are not ours to write: transient, deferred, or
      // still hydrating.
      const existing = model.docs.get(msg.docId)
      if (!existing) return [model]
      return request(model, msg.docId, existing, "advance")
    }

    case "compact": {
      const existing = model.docs.get(msg.docId)
      if (!existing) return [model]
      return request(model, msg.docId, existing, "compact")
    }

    case "destroy": {
      const effect: StoreEffect = {
        type: "persist-delete",
        docId: msg.docId,
      }
      return [
        withRelease(withDoc(model, msg.docId, null), msg.docId, null),
        effect,
      ]
    }

    case "release":
      return [withRelease(model, msg.docId, msg.gen)]

    case "keep":
      return [withRelease(model, msg.docId, null)]

    case "write-succeeded": {
      // `persisted` comes before the owed write's `persist`, so the
      // executor acts on this confirmation before the next write starts.
      const existing = model.docs.get(msg.docId)
      if (!existing || existing.status !== "writing") return [model]
      const confirmed: StoreEffect = {
        type: "persisted",
        docId: msg.docId,
        version: msg.version,
      }
      const [phase, ...effects] = settle(msg.docId, existing, {
        status: "idle",
        version: msg.version,
      })
      return [withDoc(model, msg.docId, phase), confirmed, ...effects]
    }

    case "write-failed": {
      // Fall back to where this write started. For a document with a
      // confirmed version the next `since` recomputes from it, covering the
      // failed write's changes; for one without, the next write is whole
      // again.
      //
      // An owed write, if there is one, starts now and is the retry.
      // Otherwise `retry` asks for one after a delay that doubles with each
      // failure in a row, up to `MAX_RETRY_MS`, which bounds a persistently
      // failing store to one attempt per `MAX_RETRY_MS` rather than a loop.
      const existing = model.docs.get(msg.docId)
      if (!existing || existing.status !== "writing") return [model]
      const errorEffect: StoreEffect = {
        type: "store-error",
        docId: msg.docId,
        operation: "write",
        error: msg.error,
      }
      const fallback: SettledPhase = {
        ...existing.revertTo,
        failures: (existing.revertTo.failures ?? 0) + 1,
      }
      const [phase, ...effects] = settle(msg.docId, existing, fallback)
      if (effects.length === 0) {
        const retry: StoreEffect = {
          type: "retry",
          docId: msg.docId,
          afterMs: retryDelay(fallback.failures ?? 1),
        }
        return [withDoc(model, msg.docId, phase), errorEffect, retry]
      }
      return [withDoc(model, msg.docId, phase), errorEffect, ...effects]
    }

    case "writer-refused": {
      // Not a failed write: retrying it would retry a write that is not
      // this seat's to make. The document stops being tracked, owed write
      // included, until the rebuild reports what the store holds; a write
      // still in flight then finds no phase and is ignored.
      const errorEffect: StoreEffect = {
        type: "store-error",
        docId: msg.docId,
        operation: "write",
        error: msg.error,
      }
      return [
        withDoc(model, msg.docId, null),
        { type: "rebuild", docId: msg.docId, error: msg.error },
        errorEffect,
      ]
    }

    case "seat-lost": {
      // Every document stops being tracked: nothing is in flight that could
      // be confirmed, and nothing is owed that could be written.
      const errorEffect: StoreEffect = {
        type: "store-error",
        docId: msg.docId,
        operation: "write",
        error: msg.error,
      }
      return [
        { docs: new Map(), releasing: new Map(), seatLost: msg.error },
        { type: "seat-lost" },
        errorEffect,
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** First retry delay, in milliseconds. */
export const FIRST_RETRY_MS = 250
/** Longest retry delay, in milliseconds. */
export const MAX_RETRY_MS = 30_000

/**
 * How long to wait before retrying after `failures` writes have failed in a
 * row: `FIRST_RETRY_MS`, doubling, up to `MAX_RETRY_MS`.
 */
export function retryDelay(failures: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** (failures - 1), MAX_RETRY_MS)
}

/**
 * The version the store holds the document at: the version of the last write
 * it confirmed, which a write in flight falls back to. `undefined` when it
 * has confirmed none.
 */
export function confirmedVersion(phase: DocPhase): string | undefined {
  const settled = phase.status === "writing" ? phase.revertTo : phase
  return settled.status === "idle" ? settled.version : undefined
}

/** The store holds everything: nothing in flight, nothing owed, nothing failed. */
export function storedEntirely(
  phase: DocPhase,
): phase is Extract<SettledPhase, { status: "idle" }> {
  return phase.status === "idle" && phase.failures === undefined
}

/** No write in flight for this document, and none owed. */
export function isSettled(phase: DocPhase): phase is SettledPhase {
  return phase.status !== "writing"
}

/**
 * Is every tracked document settled? `flush()` and `shutdown()` block on this.
 * An `unwritten` document counts: it has nothing in flight.
 */
export function allDocsSettled(model: StoreModel): boolean {
  for (const phase of model.docs.values()) {
    if (!isSettled(phase)) return false
  }
  return true
}
