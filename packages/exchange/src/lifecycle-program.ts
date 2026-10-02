// lifecycle-program — a document's lifecycle in the Runtime, as one table.
//
// Every request a door makes (`get`, `replicate`, `defer`, `destroy`,
// `suspend`, `resume`, `unload`, `reload`, `hooked`, `close-all`) and every
// completion it started reports (`loaded`, `load-failed`, `released`, `left`)
// is answered here, in every phase, refusals included. The Runtime is the
// shell: it holds each instance's live objects, keyed by generation, and runs
// a step as a transaction (see `Runtime.#step` and TECHNICAL.md §"How a
// document becomes ready").
//
// Every instance of a document (each create, load or promotion) has a
// generation, which the model issues and never reuses. A completion carries
// the generation it was started for, and `update` ignores one that is not
// current: a load that returns after its document was destroyed, created
// again or promoted changes nothing.
//
// Every transition is pure: a new Map for each model, no mutation.

import type { Program } from "@kyneta/machine"
import type {
  BoundSchema,
  ClosedReason,
  DocMetadata,
  MetadataMismatch,
  ReplicaFactoryLike,
  SyncMode,
} from "@kyneta/schema"
import { metadataOf } from "@kyneta/schema"
import type { DocId, PeerId } from "@kyneta/transport"
import type { Hydration } from "./document-terms.js"
import {
  type DocPhase,
  type LoadStatus,
  planInterpretation,
} from "./interpret.js"
import type { StoreInput } from "./store/store-program.js"

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type Tier = "interpret" | "replicate"
export type Generation = number

/**
 * Why the document is being made: to be had whatever the store holds
 * (`create`), or only if held (`open`). An `open` that finds nothing puts back
 * the deferred entry it `replaced`, which holds nothing, so the name alone
 * restores it; one that `replaced` an unloaded entry finds the document gone
 * from the store, and removes it everywhere.
 */
export type Intent =
  | { readonly kind: "create" }
  | {
      readonly kind: "open"
      readonly replaced: "deferred" | "unloaded" | undefined
    }

export const CREATE: Intent = { kind: "create" }

/** How a build makes its instance's replica. */
export type BuildSpec =
  | {
      readonly tier: "interpret"
      readonly bound: BoundSchema
      /** `hydration`: to load into. `empty`: nothing to load. `promote`: the
       *  ready replica of that generation, upgraded. */
      readonly from: "hydration" | "empty" | { readonly promote: Generation }
    }
  | {
      readonly tier: "replicate"
      readonly replicaFactory: ReplicaFactoryLike
      readonly syncMode: SyncMode
      readonly schemaHash: string
    }

/** What every held phase knows of its instance, all of it data. */
export type Held = {
  readonly gen: Generation
  /**
   * What built the instance. Its tier is `spec.tier`, and its format, sync
   * mode and schema hash are `metadataOfSpec(spec)`.
   */
  readonly spec: BuildSpec
  /**
   * Out of the sync graph. A flag, not a phase: it says whether the document
   * is in the sync graph, not which tier holds it, so it survives promotion
   * and an unload.
   */
  readonly suspended: boolean
}

export type Lifecycle =
  /** A peer announced it; this Runtime holds nothing. */
  | { readonly phase: "deferred" }
  /** Built, and loading from the store. */
  | ({ readonly phase: "loading"; readonly intent: Intent } & Held)
  /** Loaded, or had nothing to load. `writer`: the seat the store recorded. */
  | ({
      readonly phase: "ready"
      /** `onDocReady` has fired for this instance. */
      readonly registered: boolean
      readonly writer: PeerId | null
    } & Held)
  /** Its load failed. Held, never registered, its writes refused. */
  | ({ readonly phase: "failed"; readonly error: unknown } & Held)
  /**
   * Leaving memory, its writes refused. `storing`: waiting for the store to
   * hold all of it, and a door cancels the unload. `leaving`: released and
   * closed, leaving the sync graph, and a door loads a new instance.
   */
  | ({
      readonly phase: "unloading"
      readonly stage: "storing" | "leaving"
      readonly registered: boolean
      readonly writer: PeerId | null
    } & Held)
  /**
   * Out of memory, kept in the store. No instance exists. `spec` builds it
   * again, in the tier it had, loading from the store.
   */
  | {
      readonly phase: "unloaded"
      readonly spec: BuildSpec
      readonly suspended: boolean
    }

/** The phases that hold an instance. */
export type HeldLifecycle = Extract<
  Lifecycle,
  { phase: "loading" | "ready" | "failed" | "unloading" }
>

export interface LifecycleModel {
  /** Absent is the absence of an entry. */
  readonly docs: ReadonlyMap<DocId, Lifecycle>
  /**
   * Instances a door replaced while they left the sync graph, closed and
   * waiting for their `left` to be disposed, with the document each was of.
   * No entry names them.
   */
  readonly departing: ReadonlyMap<Generation, DocId>
  readonly nextGen: Generation
  /** Whether an Exchange has set hooks: registration waits for them. */
  readonly hooked: boolean
  /** Whether the Runtime has a store. */
  readonly hasStore: boolean
}

/** The model of a Runtime that holds nothing yet. */
export function initialLifecycle(hasStore: boolean): LifecycleModel {
  return {
    docs: new Map(),
    departing: new Map(),
    nextGen: 0,
    hooked: false,
    hasStore,
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What loading found. */
export type LoadOutcome =
  /**
   * The store holds the document at `version`: the join of the stored
   * entries the replica reaches.
   */
  | { readonly kind: "stored"; readonly version: string }
  /** The store holds nothing of the document the replica could take in. */
  | { readonly kind: "empty" }
  /** Nothing was loaded: no store, a transient document, or a promotion
   *  whose replica already loaded. */
  | { readonly kind: "none" }

/** A request, one per door. */
export type LifecycleRequest =
  | {
      readonly type: "get"
      readonly docId: DocId
      readonly bound: BoundSchema
      readonly intent: Intent["kind"]
    }
  | {
      readonly type: "replicate"
      readonly docId: DocId
      readonly replicaFactory: ReplicaFactoryLike
      readonly syncMode: SyncMode
      readonly schemaHash: string
    }
  | { readonly type: "defer"; readonly docId: DocId }
  | { readonly type: "destroy"; readonly docId: DocId }
  | { readonly type: "suspend"; readonly docId: DocId }
  | { readonly type: "resume"; readonly docId: DocId }
  | { readonly type: "unload"; readonly docId: DocId }
  /** A peer asked for an unloaded document, where this peer serves. */
  | { readonly type: "reload"; readonly docId: DocId }

export type LifecycleInput =
  | LifecycleRequest
  /** An Exchange set hooks: register every ready, unregistered instance. */
  | { readonly type: "hooked" }
  /** `reset` or `shutdown`: close every instance. */
  | { readonly type: "close-all"; readonly reason: ClosedReason }
  // ── Completions, each carrying the generation it was started for ──
  | {
      readonly type: "loaded"
      readonly docId: DocId
      readonly gen: Generation
      readonly outcome: LoadOutcome
      /** The seat the store records as the document's writer, if any. */
      readonly writer: PeerId | null
    }
  | {
      readonly type: "load-failed"
      readonly docId: DocId
      readonly gen: Generation
      readonly error: unknown
    }
  /**
   * The store holds all of the document, at `version`, and stopped tracking
   * it. An offer: taken by the unload of `gen`, or handed back.
   */
  | {
      readonly type: "released"
      readonly docId: DocId
      readonly gen: Generation
      readonly version: string
    }
  /** The instance of `gen` has left the sync graph. */
  | { readonly type: "left"; readonly docId: DocId; readonly gen: Generation }

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/** Why a request is refused. Each door decides what a refusal means. */
export type Refusal =
  | { readonly kind: "not-hydrated"; readonly docId: DocId }
  | {
      readonly kind: "load-failed"
      readonly docId: DocId
      readonly error: unknown
    }
  | {
      readonly kind: "mismatch"
      readonly docId: DocId
      readonly mismatch: MetadataMismatch
    }
  | {
      readonly kind: "not-held"
      readonly docId: DocId
      readonly door: "suspend" | "resume"
      readonly phase: "absent" | "deferred" | "unloaded"
    }
  | {
      readonly kind: "not-held"
      readonly docId: DocId
      readonly door: "unload"
      readonly phase: "absent" | "deferred"
    }
  | { readonly kind: "not-suspended"; readonly docId: DocId }
  | {
      readonly kind: "already-held"
      readonly docId: DocId
      readonly tier: Tier
    }
  /** Unloading it would lose its data: no store, or a transient document. */
  | { readonly kind: "not-stored"; readonly docId: DocId }
  /** Suspension cannot change while an unload is in flight. */
  | {
      readonly kind: "unloading"
      readonly docId: DocId
      readonly door: "suspend" | "resume"
    }

export type LifecycleEffect =
  // ── Run before the commit; a refusal or a throw discards the step ──
  | { readonly type: "refuse"; readonly refusal: Refusal }
  | {
      readonly type: "build"
      readonly docId: DocId
      readonly gen: Generation
      readonly spec: BuildSpec
    }
  // ── Run after the commit, in order ──
  /** Fire `onDocInterpreted`, before the document can register. */
  | {
      readonly type: "interpreted"
      readonly docId: DocId
      readonly gen: Generation
    }
  | { readonly type: "load"; readonly docId: DocId; readonly gen: Generation }
  /** Claim identity, and refuse a serialized document another seat writes. */
  | {
      readonly type: "adopt"
      readonly docId: DocId
      readonly gen: Generation
      readonly writer: PeerId | null
    }
  | { readonly type: "store"; readonly input: StoreInput }
  /** `onDocReady`. A suspended instance registers without being announced. */
  | {
      readonly type: "register"
      readonly docId: DocId
      readonly gen: Generation
      readonly suspended: boolean
    }
  | { readonly type: "wire"; readonly docId: DocId; readonly gen: Generation }
  /** Commit what the native document holds uncommitted, and request
   *  persistence and a push for its own writes (`#drainLocal`). */
  | { readonly type: "drain"; readonly docId: DocId; readonly gen: Generation }
  /** Start or stop leaving the sync graph (`onDocLeaving`). */
  | { readonly type: "leaving"; readonly docId: DocId; readonly on: boolean }
  /** Leave the sync graph as `unload`, then step `left` with this
   *  generation (`onDocUnload`). */
  | { readonly type: "leave"; readonly docId: DocId; readonly gen: Generation }
  /**
   * End the instance's ref: unwire it, close its terms, settle its observers.
   * `hydration`: its hydration before the close, which the executor closes
   * (`closedHydration`).
   */
  | {
      readonly type: "close"
      readonly docId: DocId
      readonly gen: Generation
      readonly reason: ClosedReason
      readonly hydration: Hydration
    }
  /** Release the instance's replica, and delete the instance. */
  | {
      readonly type: "dispose"
      readonly docId: DocId
      readonly gen: Generation
      readonly reason: ClosedReason
    }
  | {
      readonly type: "notify"
      readonly docId: DocId
      readonly hook: "destroyed" | "suspended" | "resumed"
    }

/** What an `open` that found nothing fails its load with. */
export class NotHeldError extends Error {
  constructor(docId: DocId) {
    super(`Document '${docId}' is not held here`)
    this.name = "NotHeldError"
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Whether `entry` holds an instance. */
export function isHeld(entry: Lifecycle | undefined): entry is HeldLifecycle {
  switch (entry?.phase) {
    case "loading":
    case "ready":
    case "failed":
    case "unloading":
      return true
    default:
      return false
  }
}

/** A document's format, sync mode and schema hash, by what builds it. */
export function metadataOfSpec(spec: BuildSpec): DocMetadata {
  return spec.tier === "interpret"
    ? {
        replicaType: spec.bound.replicaType,
        syncMode: spec.bound.syncMode,
        schemaHash: spec.bound.schemaHash,
      }
    : {
        replicaType: spec.replicaFactory.replicaType,
        syncMode: spec.syncMode,
        schemaHash: spec.schemaHash,
      }
}

/** What builds a document again from the store, in the tier `spec` had. */
function storedSpec(spec: BuildSpec): BuildSpec {
  return spec.tier === "interpret" ? { ...spec, from: "hydration" } : spec
}

/**
 * Which tier holds the document, whether a peer announced it, or whether it
 * is out of memory and stored.
 */
export function phaseOf(model: LifecycleModel, docId: DocId): DocPhase {
  const entry = model.docs.get(docId)
  if (entry === undefined) return "absent"
  if (!isHeld(entry)) return entry.phase
  return entry.spec.tier
}

/** The generation of the instance held under `docId`, if one is. */
export function currentGen(
  model: LifecycleModel,
  docId: DocId,
): Generation | undefined {
  const entry = model.docs.get(docId)
  return isHeld(entry) ? entry.gen : undefined
}

/**
 * Whether the instance of `gen` is the current one and unloading: its owner
 * then refuses its authored writes. An instance that stops being current is
 * closed, which fixes its refusal, so nothing reads this for it afterwards.
 */
export function unloadingOf(
  model: LifecycleModel,
  docId: DocId,
  gen: Generation,
): boolean {
  const entry = model.docs.get(docId)
  return entry?.phase === "unloading" && entry.gen === gen
}

/**
 * Will a document of this sync mode ever reach a store, in either direction?
 * The one rule: which substrate to build, whether to load, whether a destroy
 * deletes, whether a write waits for the store, and whether an unload may
 * let go of it all ask it.
 */
export function storedOf(model: LifecycleModel, syncMode: SyncMode): boolean {
  return model.hasStore && syncMode.durability === "persistent"
}

const LOADED: Hydration = { status: "loaded" }
const PENDING: Hydration = { status: "pending" }

/** What a lifecycle says of its load. */
function hydrationOfEntry(entry: Lifecycle | undefined): Hydration {
  if (!isHeld(entry)) return LOADED
  switch (entry.phase) {
    case "loading":
      return PENDING
    case "ready":
    case "unloading":
      return LOADED
    case "failed":
      return { status: "failed", error: entry.error }
  }
}

/**
 * Where the document's load stands. A document with nothing loading (absent,
 * deferred, unloading or unloaded) reads `loaded`.
 */
export function hydrationOf(model: LifecycleModel, docId: DocId): Hydration {
  return hydrationOfEntry(model.docs.get(docId))
}

/** Every document a peer announced and this Runtime holds nothing of. */
export function deferredIds(model: LifecycleModel): ReadonlySet<DocId> {
  const ids = new Set<DocId>()
  for (const [docId, entry] of model.docs) {
    if (entry.phase === "deferred") ids.add(docId)
  }
  return ids
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

type Step = [LifecycleModel, ...LifecycleEffect[]]

function withDoc(
  model: LifecycleModel,
  docId: DocId,
  entry: Lifecycle | undefined,
): Map<DocId, Lifecycle> {
  const docs = new Map(model.docs)
  if (entry === undefined) docs.delete(docId)
  else docs.set(docId, entry)
  return docs
}

function put(
  model: LifecycleModel,
  docId: DocId,
  entry: Lifecycle | undefined,
): LifecycleModel {
  return { ...model, docs: withDoc(model, docId, entry) }
}

function refuse(model: LifecycleModel, refusal: Refusal): Step {
  return [model, { type: "refuse", refusal }]
}

function close(
  docId: DocId,
  entry: HeldLifecycle,
  reason: ClosedReason,
): LifecycleEffect {
  return {
    type: "close",
    docId,
    gen: entry.gen,
    reason,
    hydration: hydrationOfEntry(entry),
  }
}

function dispose(
  docId: DocId,
  gen: Generation,
  reason: ClosedReason,
): LifecycleEffect {
  return { type: "dispose", docId, gen, reason }
}

/**
 * End an instance for good: close its ref, unless an unload's `released`
 * already did (`leaving`), then release its memory.
 */
function end(
  docId: DocId,
  entry: HeldLifecycle,
  reason: ClosedReason,
): LifecycleEffect[] {
  const disposal = dispose(docId, entry.gen, reason)
  if (entry.phase === "unloading" && entry.stage === "leaving") {
    return [disposal]
  }
  return [close(docId, entry, reason), disposal]
}

/**
 * Register an instance that is ready, if it is not yet and an Exchange has
 * set hooks: the one rule by which a load's end and a cancelled unload
 * register.
 */
function registration(
  model: LifecycleModel,
  docId: DocId,
  gen: Generation,
  suspended: boolean,
  registered: boolean,
): { readonly registered: boolean; readonly effects: LifecycleEffect[] } {
  if (registered || !model.hooked) return { registered, effects: [] }
  return {
    registered: true,
    effects: [{ type: "register", docId, gen, suspended }],
  }
}

/**
 * End a load, however it ended, including having nothing to load. `prefix`
 * leads the effects: the build and its `interpreted` effect, for an instance
 * that begins and ends its load in one step.
 *
 * An `open` that found nothing closes and disposes its instance with a
 * `NotHeldError`, in this one step: nothing was registered, written or
 * announced. It puts back the deferred entry it replaced, or removes the
 * entry; one that replaced an unloaded entry also tells the Exchange the
 * document is gone (`notify destroyed`), since the store no longer holds it.
 * Otherwise the document is ready, and in this order:
 * 1. `adopt` claims identity, and refuses a serialized document another seat
 *    writes, before anything can write: the store program's input starts a
 *    write, which must not claim a document this seat may not author.
 * 2. The store program learns what the store holds, for an outcome that says.
 * 3. `register` publishes the document to the sync graph, while an Exchange
 *    has set hooks; a suspended one registers without being announced.
 * 4. `wire` lets its local updates leave the process.
 *
 * `adopt` and `wire` are an interpreted document's: a replica claims no
 * identity and makes no writes of its own.
 */
function finishLoad(
  model: LifecycleModel,
  docId: DocId,
  loading: Extract<Lifecycle, { phase: "loading" }>,
  outcome: LoadOutcome,
  writer: PeerId | null,
  prefix: readonly LifecycleEffect[],
): Step {
  const { gen, spec, suspended, intent } = loading
  if (intent.kind === "open" && outcome.kind !== "stored") {
    const restored: Lifecycle | undefined =
      intent.replaced === "deferred" ? { phase: "deferred" } : undefined
    const effects: LifecycleEffect[] = [
      ...prefix,
      {
        type: "close",
        docId,
        gen,
        reason: "disposed",
        hydration: { status: "failed", error: new NotHeldError(docId) },
      },
      dispose(docId, gen, "disposed"),
    ]
    if (intent.replaced === "unloaded") {
      effects.push({ type: "notify", docId, hook: "destroyed" })
    }
    return [put(model, docId, restored), ...effects]
  }

  const { registered, effects: registering } = registration(
    model,
    docId,
    gen,
    suspended,
    false,
  )
  const ready: Lifecycle = {
    phase: "ready",
    gen,
    spec,
    suspended,
    writer,
    registered,
  }
  const effects: LifecycleEffect[] = [...prefix]
  if (spec.tier === "interpret") {
    effects.push({ type: "adopt", docId, gen, writer })
  }
  const store: StoreInput | undefined =
    outcome.kind === "stored"
      ? { type: "hydrated", docId, version: outcome.version }
      : outcome.kind === "empty"
        ? { type: "register", docId }
        : undefined
  if (store) effects.push({ type: "store", input: store })
  effects.push(...registering)
  if (spec.tier === "interpret") effects.push({ type: "wire", docId, gen })
  return [put(model, docId, ready), ...effects]
}

/**
 * Issue a generation for a new instance, record it, and start its load; or,
 * with nothing to load, finish it at once.
 */
function begin(
  model: LifecycleModel,
  docId: DocId,
  spec: BuildSpec,
  suspended: boolean,
  intent: Intent,
  writer: PeerId | null,
): Step {
  const gen = model.nextGen
  const issued = { ...model, nextGen: gen + 1 }
  const loads =
    storedOf(model, metadataOfSpec(spec).syncMode) &&
    !(spec.tier === "interpret" && typeof spec.from === "object")
  const loading: Extract<Lifecycle, { phase: "loading" }> = {
    phase: "loading",
    gen,
    spec,
    suspended,
    intent,
  }
  const prefix: LifecycleEffect[] = [{ type: "build", docId, gen, spec }]
  if (spec.tier === "interpret") {
    prefix.push({ type: "interpreted", docId, gen })
  }
  if (loads) {
    return [
      put(issued, docId, loading),
      ...prefix,
      { type: "load", docId, gen },
    ]
  }
  return finishLoad(issued, docId, loading, { kind: "none" }, writer, prefix)
}

/**
 * Load a new instance of a document the store holds all of: one unloaded, or
 * one a door asks for once its unload was released. A `departing` instance is
 * the one leaving meanwhile, disposed at its `left`.
 */
function loadAgain(
  model: LifecycleModel,
  docId: DocId,
  spec: BuildSpec,
  suspended: boolean,
  kind: Intent["kind"],
  departing: Generation | undefined,
): Step {
  const intent: Intent =
    kind === "create" ? CREATE : { kind: "open", replaced: "unloaded" }
  const recorded =
    departing === undefined
      ? model
      : {
          ...model,
          departing: new Map(model.departing).set(departing, docId),
        }
  return begin(recorded, docId, storedSpec(spec), suspended, intent, null)
}

/**
 * Cancel an unload the store has not released: the document is ready again,
 * as it was, and registered the way a load registers it. The store keeps
 * tracking it, and it takes in from peers again, if the unload had stopped
 * that.
 */
function cancel(
  model: LifecycleModel,
  docId: DocId,
  entry: Extract<Lifecycle, { phase: "unloading" }>,
): Step {
  const { gen, spec, suspended, writer } = entry
  const { registered, effects: registering } = registration(
    model,
    docId,
    gen,
    suspended,
    entry.registered,
  )
  const effects: LifecycleEffect[] = [
    { type: "store", input: { type: "keep", docId } },
  ]
  if (entry.registered && !suspended) {
    effects.push({ type: "leaving", docId, on: false })
  }
  effects.push(...registering)
  const ready: Lifecycle = {
    phase: "ready",
    gen,
    spec,
    suspended,
    writer,
    registered,
  }
  return [put(model, docId, ready), ...effects]
}

const BEFORE_COMMIT: ReadonlySet<LifecycleEffect["type"]> = new Set([
  "refuse",
  "build",
])

/**
 * `then`'s step, run after `first`'s, as one step: what can fail leads, and
 * a refusal discards both.
 */
function sequence(before: LifecycleModel, first: Step, then: Step): Step {
  const [, ...firstEffects] = first
  const [next, ...thenEffects] = then
  const refusal = thenEffects.find(e => e.type === "refuse")
  if (refusal !== undefined) return [before, refusal]
  const leading = thenEffects.filter(e => BEFORE_COMMIT.has(e.type))
  const trailing = thenEffects.filter(e => !BEFORE_COMMIT.has(e.type))
  return [next, ...leading, ...firstEffects, ...trailing]
}

function get(
  model: LifecycleModel,
  input: Extract<LifecycleInput, { type: "get" }>,
): Step {
  const { docId, bound } = input
  const entry = model.docs.get(docId)

  // Before the store released it, a door cancels the unload and is answered
  // as for a ready document; after, the store holds all of it, and the door
  // is answered as for an unloaded one, while the departing instance leaves.
  if (entry?.phase === "unloading" && entry.stage === "storing") {
    const cancelled = cancel(model, docId, entry)
    return sequence(model, cancelled, get(cancelled[0], input))
  }
  const stored =
    entry?.phase === "unloaded" || entry?.phase === "unloading"
      ? entry
      : undefined
  const held = stored === undefined && isHeld(entry) ? entry : undefined
  const known = stored ?? held

  const action = planInterpretation({
    phase: stored === undefined ? phaseOf(model, docId) : "unloaded",
    reader: metadataOf(bound),
    doc: known && metadataOfSpec(known.spec),
    hydration: held
      ? hydrationOfEntry(held)
      : ({ status: "none" } satisfies LoadStatus),
  })
  switch (action.action) {
    case "refuse":
      return refuse(
        model,
        action.kind === "mismatch"
          ? { kind: "mismatch", docId, mismatch: action.mismatch }
          : action.kind === "load-failed"
            ? { kind: "load-failed", docId, error: action.error }
            : { kind: "not-hydrated", docId },
      )

    case "return-cached":
      // A `get` of a document an `open` is loading keeps it, whatever the
      // load finds: the `get` caller holds the ref.
      if (
        entry?.phase === "loading" &&
        entry.intent.kind === "open" &&
        input.intent === "create"
      ) {
        return [put(model, docId, { ...entry, intent: CREATE })]
      }
      return [model]

    case "load":
      // A new instance from the store, under the caller's schema.
      if (stored === undefined) return [model]
      return loadAgain(
        model,
        docId,
        { tier: "interpret", bound, from: "hydration" },
        stored.suspended,
        input.intent,
        stored.phase === "unloading" ? stored.gen : undefined,
      )

    case "create":
    case "promote": {
      if (isHeld(entry)) {
        // A ready replica, promoted: the same replica, given a schema. It
        // loads nothing more, and keeps the writer it loaded with. A promoted
        // replica is held, so it is had whatever an `open` asked; and it stays
        // out of the sync graph if it was. `planInterpretation` promotes only
        // a replica that has loaded.
        if (entry.phase !== "ready") return [model]
        return begin(
          model,
          docId,
          { tier: "interpret", bound, from: { promote: entry.gen } },
          entry.suspended,
          CREATE,
          entry.writer,
        )
      }
      const stored = storedOf(model, bound.syncMode)
      // An `open` that can load nothing builds nothing.
      if (input.intent === "open" && !stored) return [model]
      const intent: Intent =
        input.intent === "create"
          ? CREATE
          : {
              kind: "open",
              replaced: entry?.phase === "deferred" ? "deferred" : undefined,
            }
      return begin(
        model,
        docId,
        { tier: "interpret", bound, from: stored ? "hydration" : "empty" },
        false,
        intent,
        null,
      )
    }
  }
}

function unload(model: LifecycleModel, docId: DocId): Step {
  const entry = model.docs.get(docId)
  switch (entry?.phase) {
    case undefined:
    case "deferred":
      return refuse(model, {
        kind: "not-held",
        docId,
        door: "unload",
        phase: entry === undefined ? "absent" : "deferred",
      })
    case "loading":
      return refuse(model, { kind: "not-hydrated", docId })
    case "failed":
      return refuse(model, { kind: "load-failed", docId, error: entry.error })
    case "unloading":
    case "unloaded":
      return [model]
    case "ready":
      break
  }
  if (!storedOf(model, metadataOfSpec(entry.spec).syncMode)) {
    return refuse(model, { kind: "not-stored", docId })
  }
  const { gen, spec, suspended, registered } = entry
  const unloading: Lifecycle = {
    ...entry,
    phase: "unloading",
    stage: "storing",
  }
  // The commit makes it `unloading` first, so its refusal (`unloadingOf`)
  // stands before the drain commits what the native document held. Then
  // nothing new joins the store queue: own writes are refused, and once it is
  // leaving, merges are not taken. A write is requested before the release,
  // since merges reach the store program only at the Synchronizer's next quiet
  // point; it reads the replica when it starts, so it holds every merge
  // queued before `leaving`, and the release waits for it.
  const effects: LifecycleEffect[] = []
  if (spec.tier === "interpret") effects.push({ type: "drain", docId, gen })
  if (registered && !suspended) {
    effects.push({ type: "leaving", docId, on: true })
  }
  effects.push(
    { type: "store", input: { type: "state-advanced", docId } },
    { type: "store", input: { type: "release", docId, gen } },
  )
  return [put(model, docId, unloading), ...effects]
}

/**
 * The store released the document. The unload of that generation takes it:
 * the instance closes, before the leave clears the readiness latch, so a
 * held ref keeps the readiness and peer states it had; then it leaves the
 * sync graph, or, never registered, is unloaded at once. A ready document
 * kept it meanwhile (a door cancelled the unload in the transition that
 * released it), so the release is handed back: the store program tracks it
 * again from the version it holds.
 */
function released(
  model: LifecycleModel,
  input: Extract<LifecycleInput, { type: "released" }>,
): Step {
  const { docId, gen, version } = input
  const entry = model.docs.get(docId)
  if (entry?.phase === "ready") {
    return [
      model,
      { type: "store", input: { type: "hydrated", docId, version } },
    ]
  }
  if (
    entry?.phase !== "unloading" ||
    entry.stage !== "storing" ||
    entry.gen !== gen
  ) {
    return [model]
  }
  const closing = close(docId, entry, "unloaded")
  if (entry.registered) {
    return [
      put(model, docId, { ...entry, stage: "leaving" }),
      closing,
      { type: "leave", docId, gen },
    ]
  }
  return [
    put(model, docId, {
      phase: "unloaded",
      spec: storedSpec(entry.spec),
      suspended: entry.suspended,
    }),
    closing,
    dispose(docId, gen, "unloaded"),
  ]
}

/**
 * An instance left the sync graph: its replica is disposed. The current one
 * is then unloaded; a departing one a door replaced has no entry.
 */
function left(
  model: LifecycleModel,
  input: Extract<LifecycleInput, { type: "left" }>,
): Step {
  const { docId, gen } = input
  const entry = model.docs.get(docId)
  if (
    entry?.phase === "unloading" &&
    entry.stage === "leaving" &&
    entry.gen === gen
  ) {
    return [
      put(model, docId, {
        phase: "unloaded",
        spec: storedSpec(entry.spec),
        suspended: entry.suspended,
      }),
      dispose(docId, gen, "unloaded"),
    ]
  }
  if (!model.departing.has(gen)) return [model]
  const departing = new Map(model.departing)
  departing.delete(gen)
  return [{ ...model, departing }, dispose(docId, gen, "unloaded")]
}

function update(input: LifecycleInput, model: LifecycleModel): Step {
  switch (input.type) {
    case "get":
      return get(model, input)

    case "replicate": {
      const { docId, replicaFactory, syncMode, schemaHash } = input
      const entry = model.docs.get(docId)
      if (isHeld(entry)) {
        return refuse(model, {
          kind: "already-held",
          docId,
          tier: entry.spec.tier,
        })
      }
      if (entry?.phase === "unloaded" && entry.spec.tier === "interpret") {
        return refuse(model, { kind: "already-held", docId, tier: "interpret" })
      }
      return begin(
        model,
        docId,
        { tier: "replicate", replicaFactory, syncMode, schemaHash },
        entry?.phase === "unloaded" && entry.suspended,
        CREATE,
        null,
      )
    }

    case "reload": {
      const entry = model.docs.get(input.docId)
      if (entry?.phase !== "unloaded") return [model]
      return loadAgain(
        model,
        input.docId,
        entry.spec,
        entry.suspended,
        "open",
        undefined,
      )
    }

    case "defer":
      // A peer's announcement never replaces what this Runtime holds or has
      // stored.
      if (model.docs.has(input.docId)) return [model]
      return [put(model, input.docId, { phase: "deferred" })]

    case "destroy": {
      // Deleting is skipped only when the document is known never to have
      // been stored. An absent or deferred one may be on disk from an earlier
      // session, and there is no sync mode to consult; an unloaded one is
      // stored.
      const { docId } = input
      const entry = model.docs.get(docId)
      const effects: LifecycleEffect[] = []
      if (isHeld(entry)) effects.push(...end(docId, entry, "destroyed"))
      if (
        !isHeld(entry) ||
        storedOf(model, metadataOfSpec(entry.spec).syncMode)
      ) {
        effects.push({ type: "store", input: { type: "destroy", docId } })
      }
      effects.push({ type: "notify", docId, hook: "destroyed" })
      return [put(model, docId, undefined), ...effects]
    }

    case "suspend":
    case "resume": {
      const { docId } = input
      const entry = model.docs.get(docId)
      if (entry?.phase === "unloading") {
        return refuse(model, { kind: "unloading", docId, door: input.type })
      }
      if (!isHeld(entry)) {
        return refuse(model, {
          kind: "not-held",
          docId,
          door: input.type,
          phase: entry === undefined ? "absent" : entry.phase,
        })
      }
      const suspended = input.type === "suspend"
      if (entry.suspended === suspended) {
        return suspended
          ? [model]
          : refuse(model, { kind: "not-suspended", docId })
      }
      return [
        put(model, docId, { ...entry, suspended }),
        {
          type: "notify",
          docId,
          hook: suspended ? "suspended" : "resumed",
        },
      ]
    }

    case "unload":
      return unload(model, input.docId)

    case "hooked": {
      // Only a ready instance registers here. A loading one registers when
      // its load finishes, a failed one never does, and an unloading one
      // finishes its unload without a leave.
      const docs = new Map(model.docs)
      const effects: LifecycleEffect[] = []
      for (const [docId, entry] of model.docs) {
        if (entry.phase !== "ready" || entry.registered) continue
        docs.set(docId, { ...entry, registered: true })
        effects.push({
          type: "register",
          docId,
          gen: entry.gen,
          suspended: entry.suspended,
        })
      }
      return [{ ...model, docs, hooked: true }, ...effects]
    }

    case "close-all": {
      const effects: LifecycleEffect[] = []
      for (const [docId, entry] of model.docs) {
        if (isHeld(entry)) effects.push(...end(docId, entry, input.reason))
      }
      for (const [gen, docId] of model.departing) {
        effects.push(dispose(docId, gen, input.reason))
      }
      return [{ ...model, docs: new Map(), departing: new Map() }, ...effects]
    }

    case "loaded": {
      const entry = model.docs.get(input.docId)
      if (entry?.phase !== "loading" || entry.gen !== input.gen) return [model]
      return finishLoad(
        model,
        input.docId,
        entry,
        input.outcome,
        input.writer,
        [],
      )
    }

    case "load-failed": {
      const entry = model.docs.get(input.docId)
      if (entry?.phase !== "loading" || entry.gen !== input.gen) return [model]
      const { gen, spec, suspended } = entry
      return [
        put(model, input.docId, {
          phase: "failed",
          gen,
          spec,
          suspended,
          error: input.error,
        }),
      ]
    }

    case "released":
      return released(model, input)

    case "left":
      return left(model, input)
  }
}

export const lifecycleProgram: Program<
  LifecycleInput,
  LifecycleModel,
  LifecycleEffect
> = {
  init: [initialLifecycle(false)],
  update,
}
