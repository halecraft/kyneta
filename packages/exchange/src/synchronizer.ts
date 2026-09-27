// synchronizer — runtime that wires the TEA state machines to adapters and substrates.
//
// The Synchronizer is the imperative shell around two pure TEA update functions:
// - Session program: manages channel topology, establish handshake, peer
//   identity, and the connection/disconnection/departure lifecycle.
// - Sync program: manages document convergence — present, interest, offer,
//   dismiss — and per-peer document sync states.
//
// Both pure programs are hosted by `createObservableProgram` (from
// @kyneta/machine) sharing a single `Lease`. An outer coordinator —
// itself a `createDispatcher` — owns cross-program input ordering and
// drives `tick/quiescent` self-messages until the cascade reaches a
// output-phase level.

import type {
  Changeset,
  ReactiveMap,
  ReactiveMapHandle,
} from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import {
  createDispatcher,
  createLease,
  createObservableProgram,
  type DispatcherHandle,
  type Lease,
  type ObservableHandle,
} from "@kyneta/machine"
import type {
  DevtoolsHistory,
  DocMetadata,
  ReplicaFactoryLike,
  ReplicaLike,
  ReplicaType,
  SubstratePayload,
  SyncMode,
  Version,
} from "@kyneta/schema"
import {
  DEFAULT_LINEAGE,
  DEVTOOLS_HISTORY,
  hasDevtoolsHistory,
  reaches,
  supersedes,
} from "@kyneta/schema"
import type {
  AddressedEnvelope,
  AnyTransport,
  Channel,
  ChannelId,
  ChannelMsg,
  ConnectedChannel,
  DocId,
  FrameTrace,
  PeerId,
  PeerIdentityDetails,
  SyncMsg,
  WireFeatures,
} from "@kyneta/transport"
import { isLifecycleMsg } from "@kyneta/transport"
import type { Authority } from "./governance.js"
import {
  createObservationBus,
  frameTraceToBody,
  type ObsEventBody,
  type ObservationBus,
  type ObsSink,
  observeInput,
  observePeerSyncState,
  observeSessionEffect,
  observeSyncEffect,
  summarizeChangeset,
} from "./observe.js"
import type { DocReadyInfo } from "./runtime.js"
import {
  createSessionUpdate,
  initSession,
  type SessionEffect,
  type SessionInput,
  type SessionModel,
} from "./session-program.js"
import {
  createSyncUpdate,
  type DocEntry,
  hasReconciled,
  initSync,
  type LineageCrossing,
  reconciledMatching,
  type SyncEffect,
  type SyncInput,
  type SyncModel,
} from "./sync-program.js"
import { TransportManager } from "./transport/transport-manager.js"
import type {
  Connectivity,
  DocChange,
  DocInfo,
  PeerChange,
  PeerSyncState,
} from "./types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A registered document, as the Synchronizer sees it: the Runtime's record, read-only. */
type RegisteredDoc = Readonly<DocReadyInfo>

/**
 * Fired by the `ensure-doc` effect when a peer announces an unknown doc.
 *
 * **Must be idempotent.** A doc may be announced by multiple peers in the
 * same dispatch cycle, producing one `ensure-doc` effect each. The first
 * caller to register state wins; subsequent ones must return early.
 */
export type DocCreationCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
  replicaType: ReplicaType,
  syncMode: SyncMode,
  schemaHash: string,
  supportedHashes?: readonly string[],
) => void

/**
 * Fired by the `ensure-doc-dismissed` effect when a peer dismisses a doc.
 *
 * **Must be idempotent** — same rationale as `DocCreationCallback`.
 */
export type DocDismissedCallback = (
  docId: DocId,
  peer: PeerIdentityDetails,
  origin: "local" | "remote",
) => void

/**
 * Consulted when an incoming entirety payload would overwrite a doc that
 * has already synced with at least one peer (a likely compaction-induced
 * reset). Returns `true` to accept the reset, `false` to keep local state
 * and diverge from compacted peers.
 */
export type LineageBoundaryPredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
  syncMode: SyncMode,
) => boolean

export type SynchronizerParams = {
  identity: PeerIdentityDetails
  transports?: AnyTransport[]
  canShare: (docId: DocId, peer: PeerIdentityDetails) => boolean
  canAccept: (docId: DocId, peer: PeerIdentityDetails) => boolean
  canConnect?: (peer: PeerIdentityDetails) => boolean
  canReset: LineageBoundaryPredicate
  /**
   * Replace a replicate-mode document's replica with one built from
   * `payload`. The Runtime owns the document's record, so it does the
   * replacing; the Synchronizer holds the same record and sees it.
   */
  rebuildReplica: (docId: DocId, payload: SubstratePayload) => void
  /**
   * May this document's live state leave the process now? Asked immediately
   * before every export to a peer. The Runtime answers `false` while the
   * store has not confirmed the document's own writes, and reports the
   * opening through `notifyPublishable`.
   */
  publishable: (docId: DocId) => boolean
  onEnsureDoc?: DocCreationCallback
  onEnsureDocDismissed?: DocDismissedCallback
  departureTimeout?: number
  /**
   * Wire features advertised by this peer in outbound `establish`.
   * Defaults to `{ alias: true }` for v1.
   */
  selfFeatures?: WireFeatures
  /**
   * Optional shared dispatch budget. If omitted, the Synchronizer
   * creates its own private lease.
   */
  lease?: Lease
}

// ---------------------------------------------------------------------------
// Version-gap planning helpers
// ---------------------------------------------------------------------------

/** The `import-doc-data` effect the shell executes. */
type ImportDocData = Extract<SyncEffect, { type: "import-doc-data" }>

/** What comparing a peer's version against ours can yield. */
export type VersionGapResult =
  | { kind: "parse-error"; error: unknown }
  | { kind: "no-gap"; comparison: "behind" | "equal" }
  | {
      kind: "gap"
      comparison: "ahead" | "concurrent"
      parsed: Version
    }
  /**
   * The peer sent no version at all. Only an inbound `interest` can produce
   * this — `InterestMsg.version` is optional and the wire decoder omits it
   * when the frame carries none — and it means the peer holds nothing we
   * need. Offers always carry a version.
   */
  | { kind: "absent" }

/**
 * Compare an offered or stated version against ours. `ahead`/`concurrent`
 * means the peer has data we may need to take in; `behind`/`equal` means it
 * has nothing we lack.
 */
function resolveInboundVersionGap(
  replica: ReplicaLike,
  replicaFactory: ReplicaFactoryLike,
  serializedVersion: string | undefined,
  peerDigest?: string,
): VersionGapResult {
  if (serializedVersion === undefined) return { kind: "absent" }
  let parsed: Version
  try {
    parsed = replicaFactory.parseVersion(serializedVersion)
  } catch (error) {
    return { kind: "parse-error", error }
  }
  // The digest enters as part of the comparison, not as part of the
  // `Version`: a version is a lattice element with a `meet`, and a
  // fingerprint has neither. A match reports `"equal"`, which is all a
  // digest can say.
  const comparison =
    peerDigest !== undefined && replica.digest?.() === peerDigest
      ? "equal"
      : parsed.compare(replica.version())
  if (comparison === "behind" || comparison === "equal") {
    return { kind: "no-gap", comparison }
  }
  return { kind: "gap", comparison, parsed }
}

/**
 * What a peer's version tells us about them, as the next transition — or
 * nothing.
 *
 * This is the whole of the decision that turns a version comparison into a
 * sync-state change, kept pure so it can be table-tested without a runtime.
 * Two paths ask it: the offer path, when a peer sends us its state, and the
 * interest path, when a peer asks for ours. Both are answering the same
 * question — does this peer have anything we still need? — and `synced` must
 * mean the same thing whichever way it was reached.
 *
 * - `absent` — the peer sent no version at all; a peer that cannot state a
 *   version holds nothing we need. `synced`.
 * - `no-gap` — behind or equal. Nothing to receive. `synced`.
 * - `gap` — ahead or concurrent. Their offer is coming; stay `pending`.
 * - `parse-error` — a version we cannot read must not be assumed either way.
 *   Stay `pending`; the caller warns.
 *
 * The `version: ""` in the `"absent"` case is a value the model already
 * holds — the interest handler used to write `message.version || ""` — and
 * the lowest-common-version computation excludes entries that do not parse,
 * so an empty string is safe downstream.
 */
export function transitionForPeerVersion(
  gap: VersionGapResult,
  docId: DocId,
  peerId: PeerId,
  version: string | undefined,
): Extract<SyncInput, { type: "sync/peer-synced" }> | null {
  switch (gap.kind) {
    case "absent":
    case "no-gap":
      return { type: "sync/peer-synced", docId, version: version ?? "", peerId }
    case "gap":
    case "parse-error":
      return null
  }
}

/**
 * Which kind of reset — if any — an inbound offer represents.
 *
 * A "reset" means: stop trying to reconcile with local state, and take the
 * sender's word for the document instead. Two quite different situations lead
 * there, and they are worth telling apart because only one of them is about
 * identity.
 *
 * - `"lineage"` — an *identity* discontinuity. The sender is authoring a
 *   different lineage than we are (see {@link Version.lineage}), and its
 *   lineage supersedes ours (`supersedes`: it was minted later), typically by
 *   a serialized writer that restarted with no persisted store. Its history
 *   is not a continuation of ours.
 * - `"stale-lineage"` — the same discontinuity the other way: ours supersedes
 *   the sender's. Nothing is reset here; the sender must reset to ours.
 *   Deciding by one order on every peer is what makes two lineages converge
 *   rather than swap.
 * - `"compaction"` — a *history* gap within the same lineage. The sender
 *   trimmed history past our version, so its `exportSince()` could not compute
 *   a delta and fell back to a whole-state image. Identity is unchanged; only
 *   the connecting history is missing.
 * - `"none"` — an ordinary offer. Merge it.
 */
export type ResetTrigger = "none" | "lineage" | "stale-lineage" | "compaction"

/**
 * Classify an inbound offer into a {@link ResetTrigger}. Pure, so that every
 * outcome can be tested without standing up a Synchronizer.
 *
 * **Lineage** requires a REAL lineage on *both* sides. `DEFAULT_LINEAGE` is
 * excluded because it is the ordinary lazy-mint / first-sync value, which
 * `merge()` already handles — a mismatch against it means nothing. Only
 * `PlainVersion` ever mints a real one, so in practice this fires for `json`
 * documents alone. `supersedes` picks the direction: `"lineage"` when the
 * sender's was minted later, `"stale-lineage"` when ours was, so the two
 * peers of a crossing never both reset.
 *
 * **Compaction** requires a whole-state image from a peer already marked
 * synced; a first entirety is just initial sync. It is the only signal
 * available for a same-lineage history gap, since there is no lineage
 * mismatch to find.
 *
 * A history-free format (`ReplicaFactoryLike.historyFree`) is excluded from
 * compaction outright. The heuristic presumes a sender that can trim history,
 * and such a format keeps none: its state carries its whole meaning, so every
 * cursor stays serviceable and there is no compaction to detect.
 *
 * One consequence is worth stating, because it depends on two facts that live
 * in different files: **a history-free document reaches neither trigger.**
 * `historyFree` excludes it from compaction here, and `StateVersion` reporting
 * `DEFAULT_LINEAGE` excludes it from lineage. That is what lets the reset path
 * rebuild a replica rather than merge into it — see `#executeImportDocData`.
 * `reset-trigger.test.ts` pins both halves.
 */
export function classifyResetTrigger(
  localLineage: string,
  remoteLineage: string,
  isEntirety: boolean,
  senderAlreadySynced: boolean,
  historyFree: boolean,
): ResetTrigger {
  const lineagesComparable =
    remoteLineage !== DEFAULT_LINEAGE && localLineage !== DEFAULT_LINEAGE
  if (lineagesComparable && remoteLineage !== localLineage) {
    return supersedes(remoteLineage, localLineage) ? "lineage" : "stale-lineage"
  }

  if (isEntirety && senderAlreadySynced && !historyFree) {
    return "compaction"
  }

  return "none"
}

// ---------------------------------------------------------------------------
// Taking in an offer — a pure plan, and a pure report
// ---------------------------------------------------------------------------

/** What is known about an inbound offer before anything is applied. */
export type ImportFacts = {
  /** The offered version against ours. */
  readonly gap: VersionGapResult
  /** `classifyResetTrigger`, or `"none"` when there is no gap. */
  readonly resetTrigger: ResetTrigger
  /** The `canReset` policy's answer, asked only for a reset. */
  readonly resetPermitted: boolean
  readonly payloadKind: SubstratePayload["kind"]
}

/**
 * What to do with an inbound offer.
 *
 * - `unreadable`: its version does not parse. Nothing, and no `accept`.
 * - `already-held`: we hold its version. `accept` if owed.
 * - `refused`: a reset the policy vetoed. Keep local state.
 * - `outrank`: the sender's lineage is superseded by ours. Take nothing, and
 *   owe the sender our whole document, to which it will reset.
 * - `ask-whole`: a delta across a lineage boundary, which no reset can
 *   take. Report it not held, which asks the sender for its whole document.
 * - `reset`: take the sender's whole document in place of ours. A headless
 *   replica is rebuilt from it; an interpreted document calls
 *   `resetFromEntirety`.
 * - `merge`: an ordinary offer.
 */
export type ImportPlan =
  | "unreadable"
  | "already-held"
  | "refused"
  | "outrank"
  | "ask-whole"
  | "reset"
  | "merge"

export function planImport(facts: ImportFacts): ImportPlan {
  switch (facts.gap.kind) {
    case "parse-error":
      return "unreadable"
    case "absent":
    case "no-gap":
      return "already-held"
    case "gap":
      break
  }
  if (facts.resetTrigger === "none") return "merge"
  // Nothing of ours is discarded, so the reset policy is not asked.
  if (facts.resetTrigger === "stale-lineage") return "outrank"
  if (!facts.resetPermitted) return "refused"
  // `resetFromEntirety`/`fromEntirety` take only a self-sufficient state
  // image. The lineage trigger fires regardless of payload shape, so a delta
  // can reach here; the sender's answer to an interest is its whole document.
  if (facts.payloadKind !== "entirety") return "ask-whole"
  return "reset"
}

/**
 * The lineage boundary an offer crossed, and our response, or `undefined` if
 * it crossed none. Every peer that meets two lineages reports it.
 */
export function crossingOf(
  trigger: ResetTrigger,
  plan: ImportPlan,
  local: string,
  remote: string,
): LineageCrossing | undefined {
  if (trigger !== "lineage" && trigger !== "stale-lineage") return undefined
  const response = CROSSING_RESPONSE[plan]
  return response === undefined ? undefined : { local, remote, response }
}

/** What each plan that follows a lineage trigger does about the crossing. */
const CROSSING_RESPONSE: Partial<
  Record<ImportPlan, LineageCrossing["response"]>
> = {
  reset: "adopted",
  "ask-whole": "asking",
  outrank: "outranking",
  refused: "refused",
}

/**
 * What an offer did, from the versions around it.
 *
 * `refused`, `outrank` and `ask-whole` take nothing in: unchanged, not held.
 * `changed`: a reset replaced the state; a merge moved it iff our version's
 * serialization changed. That is not a lattice comparison: a history-free
 * version (an install counter) compares `"concurrent"` even with itself, and
 * reporting such a merge as a change relays it, which loops in a mesh of
 * three. `held`: our version now reaches the offered one (`reaches`). A
 * history-free document's offer is held once merged, since its versions do
 * not compare across replicas and its merge is a join that waits on nothing.
 */
export function reportImport(r: {
  readonly plan: "refused" | "outrank" | "ask-whole" | "reset" | "merge"
  readonly prior: Version
  readonly after: Version
  readonly offered: Version
  readonly historyFree: boolean
}): { readonly changed: boolean; readonly held: boolean } {
  // These take nothing in.
  if (r.plan === "refused" || r.plan === "outrank" || r.plan === "ask-whole") {
    return { changed: false, held: false }
  }
  const changed =
    r.plan === "reset" || r.after.serialize() !== r.prior.serialize()
  const held = r.historyFree || reaches(r.after, r.offered)
  return { changed, held }
}

// ---------------------------------------------------------------------------
// Outer coordinator message
// ---------------------------------------------------------------------------

type OuterMsg =
  | { type: "route"; input: SessionInput | SyncInput }
  | { type: "tick" }

// ---------------------------------------------------------------------------
// Connectivity classifier (pure — unit-testable without a Synchronizer)
// ---------------------------------------------------------------------------

/**
 * Classify connection lifecycle from two counts:
 * - `online` if any peer is established (has a live channel),
 * - `offline` if no transports are configured,
 * - `connecting` otherwise (transports present, no established peer yet).
 */
export function deriveConnectivity(input: {
  establishedPeers: number
  transportCount: number
}): Connectivity {
  if (input.establishedPeers > 0) return "online"
  if (input.transportCount === 0) return "offline"
  return "connecting"
}

/**
 * Has the authority reported on this document yet — the network half of
 * document readiness?
 *
 * Pure, so the authority rules are a truth table rather than something only a
 * live two-peer scenario can exercise. That matters more here than usual: a
 * wrong branch means an application concludes a document is empty when it is
 * not, and writes defaults over live data.
 *
 * The rules, in order:
 * - `"self"` — we are the authority, so there is nobody to wait for.
 * - a predicate — a peer satisfying it must have reconciled.
 * - `"any"` — any peer reconciling is enough.
 *
 * And in every case, having no transports at all also counts as reported: with
 * nothing configured to reach a peer, there is nothing that could ever answer,
 * so waiting would be waiting forever. That is the same empty-conjunction idea
 * the settle layer is built on, applied to one term.
 *
 * "Reconciled" means the peer either sent data or replied `vacant` ("I do not
 * have this document"). Both are answers; only silence is not.
 */
export function derivePeerSettled(input: {
  authority: Authority
  /** Any peer reached `synced` or `vacant` for this document. */
  hasReconciled: boolean
  /** A peer satisfying the authority predicate did. */
  matchesAuthority: boolean
  /** No transports are configured. */
  isOffline: boolean
}): boolean {
  if (input.authority === "self") return true
  if (input.isOffline) return true
  if (input.authority === "any") return input.hasReconciled
  return input.matchesAuthority
}

// ---------------------------------------------------------------------------
// Synchronizer
// ---------------------------------------------------------------------------

export class Synchronizer {
  readonly identity: PeerIdentityDetails
  readonly transports: TransportManager

  readonly #lease: Lease
  readonly #departureTimeout: number
  readonly #selfFeatures: WireFeatures | undefined

  /**
   * Per-synchronizer channelId counter. Injected into every transport via
   * `TransportContext.mintChannelId` so a single namespace covers all of
   * this synchronizer's transports. Reset on `reset()` so HMR cycles
   * restart from 1.
   */
  #nextChannelId = 1

  #sessionHandle: ObservableHandle<SessionInput, SessionModel>
  #syncHandle: ObservableHandle<SyncInput, SyncModel>
  #outerHandle: DispatcherHandle<OuterMsg>

  readonly #docs = new Map<DocId, RegisteredDoc>()
  readonly #docCreationCallback?: DocCreationCallback
  readonly #docDismissedCallback?: DocDismissedCallback

  /**
   * Outbound message queue — accumulated during dispatch, flushed at
   * quiescence by the outer coordinator's tick. Carries channelId
   * routing + transport-selection knowledge that the pure programs do
   * not have.
   */
  readonly #outboundQueue: AddressedEnvelope[] = []

  // Departure timers — shell-managed side effects from session program
  #departureTimers = new Map<PeerId, ReturnType<typeof setTimeout>>()

  // Peer lifecycle — changefeed
  #peerHandle: ReactiveMapHandle<
    PeerId,
    PeerIdentityDetails,
    PeerChange
  > | null = null

  // Document lifecycle — changefeed
  #docHandle: ReactiveMapHandle<DocId, DocInfo, DocChange> | null = null

  // Peer-sync-state listeners
  readonly #peerSyncListeners = new Set<
    (docId: DocId, peerStates: PeerSyncState[]) => void
  >()

  // State-advanced listeners
  readonly #stateAdvancedListeners = new Set<(docId: DocId) => void>()

  /**
   * DevTools observation bus. A passive, fire-and-forget side-output —
   * never a Mealy effect, never re-enters dispatch, never enters the shared
   * `Lease` budget. Tee call sites gate on `enabled` for zero cost when no
   * sink is attached. Context: jj:qpmkoryn.
   */
  readonly #observationBus: ObservationBus

  readonly #canReset: LineageBoundaryPredicate
  readonly #rebuildReplica: SynchronizerParams["rebuildReplica"]
  readonly #publishable: SynchronizerParams["publishable"]
  readonly #canConnect?: (peer: PeerIdentityDetails) => boolean
  readonly #canShare: (docId: DocId, peer: PeerIdentityDetails) => boolean
  readonly #canAccept: (docId: DocId, peer: PeerIdentityDetails) => boolean

  /**
   * Backward-compat getter — exposes `documents` and `peers` from the
   * sync model for test access via `synchronizer.model.documents`.
   */
  get model(): {
    documents: Map<DocId, DocEntry>
    peers: Map<PeerId, unknown>
  } {
    const sync = this.#syncHandle.getState()
    return {
      documents: sync.documents,
      peers: sync.peers,
    }
  }

  /**
   * Subscribe a DevTools sink to the observation bus. Returns an
   * unsubscribe function. The first sink flips `bus.enabled` true, which
   * is what the tee call sites gate on.
   */
  observe(sink: ObsSink): () => void {
    return this.#observationBus.subscribe(sink)
  }

  /**
   * Publish a document changeset to the observation bus. Called by the
   * Exchange for every changeset of every interpreted doc, local and replay,
   * including remote-auto-resolved ones.
   */
  observeDocChangeset(docId: DocId, changeset: Changeset<unknown>): void {
    if (!this.#observationBus.enabled) return
    this.#observationBus.publish(summarizeChangeset(docId, changeset))
  }

  /** Fan an array of observation bodies into the bus. */
  #tee(bodies: readonly ObsEventBody[]): void {
    for (const body of bodies) this.#observationBus.publish(body)
  }

  /**
   * Lazy **pull** DevTools history for a doc, if its substrate implements the
   * capability (Loro does; plain/Yjs return `undefined`). Read on demand by a
   * renderer — not pushed through the bus.
   */
  docHistory(docId: DocId): DevtoolsHistory | undefined {
    const doc = this.#docs.get(docId)
    if (!doc) return undefined
    return hasDevtoolsHistory(doc.replica)
      ? doc.replica[DEVTOOLS_HISTORY]
      : undefined
  }

  constructor({
    identity,
    transports = [],
    canShare,
    canAccept,
    canConnect,
    canReset,
    rebuildReplica,
    publishable,
    onEnsureDoc,
    onEnsureDocDismissed,
    departureTimeout,
    selfFeatures,
    lease,
  }: SynchronizerParams) {
    this.identity = identity
    // Create the observation bus before #buildHandles — the decorated
    // executors and transition taps reference it.
    this.#observationBus = createObservationBus(identity.peerId)
    this.#departureTimeout = departureTimeout ?? 30_000
    this.#selfFeatures = selfFeatures
    this.#canReset = canReset
    this.#rebuildReplica = rebuildReplica
    this.#publishable = publishable
    this.#canConnect = canConnect
    this.#canShare = canShare
    this.#canAccept = canAccept
    this.#docCreationCallback = onEnsureDoc
    this.#docDismissedCallback = onEnsureDocDismissed
    this.#lease = lease ?? createLease()
    ;[this.#sessionHandle, this.#syncHandle, this.#outerHandle] =
      this.#buildHandles()

    // Create adapter context
    const transportContext = {
      identity: this.identity,
      onChannelAdded: this.channelAdded.bind(this),
      onChannelRemoved: this.channelRemoved.bind(this),
      onChannelReceive: this.channelReceive.bind(this),
      onChannelEstablish: this.channelEstablish.bind(this),
      mintChannelId: (): ChannelId => this.#nextChannelId++,
      // Wire-frame observation. Always supplied (cheap when no sink): the
      // hook checks `bus.enabled` per frame. Transports thread it into their
      // Pipeline's `opts.onFrame`.
      onFrame: (ev: FrameTrace): void => {
        if (this.#observationBus.enabled)
          this.#observationBus.publish(frameTraceToBody(ev))
      },
    }

    // Create TransportManager
    this.transports = new TransportManager({
      transports,
      context: transportContext,
      onReset: (transport: AnyTransport) => {
        for (const channel of transport.channels) {
          this.channelRemoved(channel)
        }
      },
    })

    // Start all adapters
    this.transports.startAll()
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // HANDLE CONSTRUCTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #buildHandles(): [
    ObservableHandle<SessionInput, SessionModel>,
    ObservableHandle<SyncInput, SyncModel>,
    DispatcherHandle<OuterMsg>,
  ] {
    const sessionProgram = {
      init: [
        initSession(this.identity, this.#departureTimeout, this.#selfFeatures),
      ] as [SessionModel],
      update: createSessionUpdate({ canConnect: this.#canConnect }),
    }
    const sessionHandle = createObservableProgram(
      sessionProgram,
      (effect, _dispatch) => {
        // Observation tee — the effect IS the data; map it purely, publish,
        // then execute. Guard before the mapper so nothing allocates when
        // unobserved.
        if (this.#observationBus.enabled)
          this.#tee(observeSessionEffect(effect))
        this.#executeSessionEffect(effect)
      },
      { lease: this.#lease, label: "synchronizer:session" },
    )

    const syncProgram = {
      init: [initSync(this.identity)] as [SyncModel],
      update: createSyncUpdate({
        canShare: this.#canShare,
        canAccept: this.#canAccept,
      }),
    }
    const syncHandle = createObservableProgram(
      syncProgram,
      (effect, _dispatch) => {
        if (this.#observationBus.enabled) this.#tee(observeSyncEffect(effect))
        this.#executeSyncEffect(effect)
      },
      { lease: this.#lease, label: "synchronizer:sync" },
    )

    // Engine layer — coalesced TEA state transitions (fire only when
    // `from !== to`). Always attached but guarded, so re-`#buildHandles()`
    // on reset re-binds for free; the cost when unobserved is one boolean
    // check per transition.
    sessionHandle.subscribeToTransitions(t => {
      if (!this.#observationBus.enabled) return
      this.#observationBus.publish({
        layer: "engine",
        kind: "transition",
        program: "session",
        summary: `peers=${t.to.peers.size} channels=${t.to.channels.size}`,
      })
    })
    syncHandle.subscribeToTransitions(t => {
      if (!this.#observationBus.enabled) return
      this.#observationBus.publish({
        layer: "engine",
        kind: "transition",
        program: "sync",
        summary: `docs=${t.to.documents.size} peers=${t.to.peers.size}`,
      })
    })

    // The outer coordinator owns cross-program input ordering: a
    // session `sync-event` effect re-enters as a `route` here rather
    // than dispatching directly into syncHandle, so user-dispatched
    // inputs and cross-program inputs interleave in arrival order.
    // It also drives ticks — and because it is itself a dispatcher,
    // ticks that produce more `route` msgs (via subscriber re-entry)
    // converge in the same drain.
    //
    // `tickPending` is closure-scoped imperative state. It coalesces a
    // burst of routes into at most one queued tick — the tick-quiescent
    // handlers are idempotent (`session-program.ts:handleTickQuiescent`,
    // `sync-program.ts:handleTickQuiescent` both early-return when their
    // accumulators are empty), so coalescing is semantics-preserving and
    // bounds the iteration count of long cascades by ~⅓.
    //
    // This is structurally inconsistent with `jj:qlvnvxox`'s thesis that
    // accumulator state lives inside the algebra; promoting the outer
    // coordinator from `createDispatcher` to a `Program<OuterMsg,
    // {tickPending: boolean}, OuterEffect>` would put this in the model.
    // Out of scope for `jj:tozwpvuu`; follow up if the flag accretes
    // siblings.
    let tickPending = false
    const outerHandle = createDispatcher<OuterMsg>(
      (msg, dispatch) => {
        if (msg.type === "route") {
          // Inbound-message tee — `route` is the sole inbound-input point,
          // so it captures protocol-IN (and the triggering Msg).
          if (this.#observationBus.enabled) this.#tee(observeInput(msg.input))
          if (msg.input.type.startsWith("sess/")) {
            sessionHandle.dispatch(msg.input as SessionInput)
          } else {
            syncHandle.dispatch(msg.input as SyncInput)
          }
          if (!tickPending) {
            tickPending = true
            dispatch({ type: "tick" })
          }
        } else {
          // Clear *before* the tick-quiescent dispatches so a subscriber
          // inside an emit-* effect that issues a new route can queue a
          // fresh tick — preserving the `peer-event-reentry.test.ts`
          // "tick-induced" guarantee.
          tickPending = false
          // Outbound flushes last so subscribers fired by the emit-*
          // effects observe the model→world ordering implied by their
          // events (e.g., a ready-state listener that reads peer state
          // sees it after the program update committed).
          sessionHandle.dispatch({ type: "sess/tick-quiescent" })
          syncHandle.dispatch({ type: "sync/tick-quiescent" })
          this.#drainOutboundOnce()
        }
      },
      { lease: this.#lease, label: "synchronizer:outer" },
    )

    return [sessionHandle, syncHandle, outerHandle]
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Document management
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Multi-channel peers advertise one feature set per identity. Any
   * established channel for the peer is authoritative; returns the first
   * one found, or `undefined` if the peer is unestablished.
   */
  getPeerFeatures(peerId: PeerId): WireFeatures | undefined {
    const session = this.#sessionHandle.getState()
    const peer = session.peers.get(peerId)
    if (!peer) return undefined
    for (const channelId of peer.channels) {
      const entry = session.channels.get(channelId)
      if (entry?.peerFeatures) return entry.peerFeatures
    }
    return undefined
  }

  /**
   * Track a document and announce it to peers via `doc-ensure`.
   * Called by Exchange.get() / Exchange.replicate() after the
   * substrate/replica is created.
   */
  registerDoc(doc: RegisteredDoc): void {
    const sync = this.#syncHandle.getState()
    const existing = sync.documents.get(doc.docId)
    // The promoted-vs-created distinction depends on the *pre-dispatch*
    // model state; capture it before #docs mutates and the
    // dispatch updates sync.documents.
    // Any change of mode is a promotion, not just `deferred → X`: a document
    // relayed headlessly and now interpreted has moved tier exactly as a
    // deferred one does.
    //
    // Emitting matters more than it looks. `#emitDocEvents` rebuilds every
    // `DocInfo` from `#docs` but returns early on an empty event list,
    // so a transition with no event is not a missing notification — it is
    // `exchange.documents` reporting the old mode indefinitely.
    let event: DocChange | undefined
    if (existing && existing.mode !== doc.mode) {
      event = { type: "doc-promoted", docId: doc.docId }
    } else if (!this.#docs.has(doc.docId)) {
      event = { type: "doc-created", docId: doc.docId }
    }

    this.#docs.set(doc.docId, doc)

    this.#dispatchSync({
      type: "sync/doc-ensure",
      docId: doc.docId,
      mode: doc.mode,
      version: doc.replica.version().serialize(),
      replicaType: doc.replicaFactory.replicaType,
      historyFree: doc.replicaFactory.historyFree,
      syncMode: doc.syncMode,
      schemaHash: doc.schemaHash,
      ...(doc.supportedHashes ? { supportedHashes: doc.supportedHashes } : {}),
      event,
    })
  }

  /**
   * Register a doc as deferred — participates in routing (peers learn it
   * exists via `present`) but does not exchange data. Promoted to
   * interpret/replicate later by a subsequent `registerDoc`.
   */
  deferDoc(
    docId: DocId,
    replicaType: ReplicaType,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined = !sync.documents.has(docId)
      ? { type: "doc-deferred", docId }
      : undefined

    this.#dispatchSync({
      type: "sync/doc-defer",
      docId,
      replicaType,
      syncMode,
      schemaHash,
      event,
    })
  }

  getDocMetadata(docId: DocId): DocMetadata | undefined {
    const entry = this.#syncHandle.getState().documents.get(docId)
    if (!entry) return undefined
    return {
      replicaType: entry.replicaType,
      syncMode: entry.syncMode,
      schemaHash: entry.schemaHash,
    }
  }

  /**
   * Ask for a document that advanced by a route other than the network to be
   * pushed to peers: a local write, or records a compaction took in from the
   * store. The push is sent when the document may leave the process
   * (`publishable`), and owed until then. The Exchange calls this from the
   * Runtime's `onDocAdvanced` hook, which fires for every local write,
   * including writes made directly on the native document, so no application
   * code needs to call it.
   */
  notifyAdvanced(docId: DocId): void {
    const doc = this.#docs.get(docId)
    if (!doc) return

    this.#dispatchSync({
      type: "sync/doc-advanced",
      docId,
      version: doc.replica.version().serialize(),
    })
  }

  /**
   * A document may leave the process again: send the offers withheld while
   * it could not. The Exchange calls this from the Runtime's
   * `onDocPublishable` hook.
   */
  notifyPublishable(docId: DocId): void {
    this.#dispatchSync({ type: "sync/doc-publishable", docId })
  }

  getDoc(docId: DocId): RegisteredDoc | undefined {
    return this.#docs.get(docId)
  }

  /**
   * Greatest version that is ≤ what every peer we keep up to date holds of
   * ours (`ourVersionTheyHold`, from its `accept`s and interests): the safe
   * trim point for `advance()`. The local version is excluded deliberately:
   * the LCV represents "what every remote has," so including local state
   * would raise it past what peers actually have and strand them on
   * subsequent syncs.
   *
   * Returns `null` when no peer's holding is known (nothing to bound
   * against) or the doc is unknown.
   */
  leastCommonVersion(
    docId: DocId,
    peerFilter?: (peer: PeerIdentityDetails, docId: DocId) => boolean,
  ): Version | null {
    const doc = this.#docs.get(docId)
    if (!doc) return null

    let lcv: Version | null = null

    for (const [, peerState] of this.#syncHandle.getState().peers) {
      const docSync = peerState.docSyncStates.get(docId)
      // Every peer we keep up to date counts, `pending` ones included:
      // leaving one out could trim past what it holds.
      if (!docSync || docSync.status === "vacant") continue
      if (docSync.ourVersionTheyHold === undefined) continue
      if (peerFilter && !peerFilter(peerState.identity, docId)) continue

      let peerVersion: Version
      try {
        peerVersion = doc.replicaFactory.parseVersion(
          docSync.ourVersionTheyHold,
        )
      } catch {
        // Unparseable peer versions are excluded so a single corrupted
        // entry can't poison the LCV for the rest of the cohort.
        continue
      }

      lcv = lcv === null ? peerVersion : lcv.meet(peerVersion)
    }

    return lcv
  }

  hasDoc(docId: DocId): boolean {
    return this.#docs.has(docId)
  }

  async removeDocument(docId: DocId): Promise<void> {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined =
      this.#docs.has(docId) || sync.documents.has(docId)
        ? { type: "doc-removed", docId }
        : undefined
    // Runtime must be deleted before the dispatch: emit-doc-events
    // rebuilds the doc map from #docs, so a live entry here
    // would re-introduce the doc the event is meant to remove.
    this.#docs.delete(docId)
    this.#dispatchSync({
      type: "sync/doc-delete",
      docId,
      event,
    })
  }

  dismissDocument(docId: DocId): void {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined =
      this.#docs.has(docId) || sync.documents.has(docId)
        ? { type: "doc-removed", docId }
        : undefined
    // See removeDocument: the local delete must precede the dispatch.
    this.#docs.delete(docId)
    this.#dispatchSync({
      type: "sync/doc-dismiss",
      docId,
      event,
    })
  }

  suspendDocument(docId: DocId): void {
    const sync = this.#syncHandle.getState()
    const event: DocChange | undefined =
      this.#docs.has(docId) || sync.documents.has(docId)
        ? { type: "doc-suspended", docId }
        : undefined
    // Runtime survives — `resume()` re-registers from it. Emit-doc-events
    // computes `suspended: !sync.documents.has(docId)`; folding the event
    // into doc-dismiss is what makes sync.documents lose the doc before
    // the emit rebuild reads it, so `suspended: true` is visible.
    this.#dispatchSync({
      type: "sync/doc-dismiss",
      docId,
      event,
    })
  }

  /**
   * Rejoin the sync graph using the surviving document's current version.
   * Peers receive `present` + `interest` and delta-sync from the
   * suspended version, so any drift accumulated during suspension is
   * reconciled rather than overwritten.
   */
  resumeDocument(docId: DocId): void {
    const doc = this.#docs.get(docId)
    if (!doc) {
      throw new Error(
        `Cannot resume document '${docId}': it is not registered. ` +
          `The document may have been destroyed.`,
      )
    }
    this.#dispatchSync({
      type: "sync/doc-ensure",
      docId: doc.docId,
      mode: doc.mode,
      version: doc.replica.version().serialize(),
      replicaType: doc.replicaFactory.replicaType,
      historyFree: doc.replicaFactory.historyFree,
      syncMode: doc.syncMode,
      schemaHash: doc.schemaHash,
      event: { type: "doc-resumed", docId },
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Ready state
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Tell a peer we will not serve a doc it asked for. Routes a `vacant`
   * message through the sync program; the shell drops it if the peer has
   * no live channel. Does not affect our own replica.
   */
  declareVacant(docId: DocId, peerId: PeerId): void {
    this.#dispatchSync({ type: "sync/declare-vacant", docId, to: peerId })
  }

  /**
   * Monotonic doc-level latch: has this doc reconciled with ≥1 peer
   * (`synced` or `vacant`) at any point? Connection-independent — survives
   * the reconnect re-handshake flip and a reconciled peer departing.
   */
  hasReconciled(docId: DocId): boolean {
    return hasReconciled(this.#syncHandle.getState(), docId)
  }

  /**
   * Monotonic doc-level latch restricted to peers matching `pred` —
   * resolved against stored identities, so it holds even after the matching
   * peer has left.
   */
  reconciledMatching(
    docId: DocId,
    pred: (peer: PeerIdentityDetails) => boolean,
  ): boolean {
    return reconciledMatching(this.#syncHandle.getState(), docId, pred)
  }

  /**
   * Coarse connection lifecycle for sync: `online` if any peer is
   * established, `offline` if no transports are configured, else
   * `connecting`. Gathers the two counts and delegates to the pure
   * `deriveConnectivity` classifier.
   */
  connectivity(): Connectivity {
    let establishedPeers = 0
    for (const [, sessionPeer] of this.#sessionHandle.getState().peers) {
      if (sessionPeer.channels.size > 0) establishedPeers++
    }
    return deriveConnectivity({
      establishedPeers,
      transportCount: this.transports.size,
    })
  }

  getPeerStates(docId: DocId): PeerSyncState[] {
    const states: PeerSyncState[] = []

    for (const [_peerId, peerState] of this.#syncHandle.getState().peers) {
      const docSync = peerState.docSyncStates.get(docId)
      if (docSync) {
        states.push({
          docId,
          peer: peerState.identity,
          state:
            docSync.status === "synced"
              ? "synced"
              : docSync.status === "vacant"
                ? "vacant"
                : "pending",
        })
      }
    }

    return states
  }

  /**
   * Shared wait core: resolve `"ready"` once `isReady()` becomes true (on a
   * peer-sync change for `docId`), or `"timeout"` after `timeoutMs` (0 ⇒ no
   * timeout). Never rejects — callers decide what a timeout means.
   *
   * The resolve predicate is a parameter so this stays a pure
   * listener-plus-timeout mechanism with no opinion about readiness.
   * `whenSettled` — its only caller — passes the document's settle
   * conjunction, `settledWith(ref, authority)`, so the authority rules are
   * applied in one place (`derivePeerSettled`) rather than duplicated here.
   */
  awaitReconciliation(
    docId: DocId,
    isReady: () => boolean,
    timeoutMs: number,
  ): Promise<"ready" | "timeout"> {
    if (isReady()) return Promise.resolve("ready")

    return new Promise<"ready" | "timeout">(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const listener = (changedDocId: DocId) => {
        if (changedDocId === docId && isReady()) {
          cleanup()
          resolve("ready")
        }
      }

      const cleanup = () => {
        this.#peerSyncListeners.delete(listener)
        if (timer) clearTimeout(timer)
      }

      this.#peerSyncListeners.add(listener)

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup()
          resolve("timeout")
        }, timeoutMs)
      }
    })
  }

  /**
   * Fires once per docId at quiescence when a network import advanced the
   * document's state (handleOffer → import-doc-data → handleDocImported).
   * Local changes don't fire it: the Runtime persists them from its own
   * drain before it reports them. Coalescing is intentional: multiple
   * advances within one dispatch cycle produce a single notification so
   * persistence reads the full delta once instead of re-exporting per change.
   */
  onStateAdvanced(cb: (docId: DocId) => void): () => void {
    this.#stateAdvancedListeners.add(cb)
    return () => {
      this.#stateAdvancedListeners.delete(cb)
    }
  }

  onPeerSyncChange(
    cb: (docId: DocId, peerStates: PeerSyncState[]) => void,
  ): () => void {
    this.#peerSyncListeners.add(cb)
    return () => this.#peerSyncListeners.delete(cb)
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Adapter management
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  async addTransport(adapter: AnyTransport): Promise<void> {
    await this.transports.addTransport(adapter)
  }

  async removeTransport(transportId: string): Promise<void> {
    await this.transports.removeTransport(transportId)
  }

  hasTransport(transportId: string): boolean {
    return this.transports.hasTransport(transportId)
  }

  getTransport(transportId: string): AnyTransport | undefined {
    return this.transports.getTransport(transportId)
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PUBLIC API — Lifecycle
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  async flush(): Promise<void> {
    await this.transports.flush()
  }

  reset(): void {
    this.#emitSyntheticOnTeardown()
    this.#clearDepartureTimers()
    this.#sessionHandle.dispose()
    this.#syncHandle.dispose()
    ;[this.#sessionHandle, this.#syncHandle, this.#outerHandle] =
      this.#buildHandles()
    this.#nextChannelId = 1
    this.transports.reset()
  }

  async shutdown(): Promise<void> {
    this.#sendDepartToAllPeers()
    // transports.flush() drains the transport layer, not #outboundQueue
    // — without this explicit drain the depart envelopes never reach
    // the transport and peers don't see the departure before close.
    this.#drainOutboundOnce()
    await this.transports.flush()
    this.#emitSyntheticOnTeardown()
    this.#clearDepartureTimers()
    this.#sessionHandle.dispose()
    this.#syncHandle.dispose()
    ;[this.#sessionHandle, this.#syncHandle, this.#outerHandle] =
      this.#buildHandles()
    await this.transports.shutdown()
  }

  createPeerFeed(): ReactiveMap<PeerId, PeerIdentityDetails, PeerChange> {
    const [feed, handle] = createReactiveMap<
      PeerId,
      PeerIdentityDetails,
      PeerChange
    >()
    this.#peerHandle = handle
    return feed
  }

  createDocFeed(): ReactiveMap<DocId, DocInfo, DocChange> {
    const [feed, handle] = createReactiveMap<DocId, DocInfo, DocChange>()
    this.#docHandle = handle
    return feed
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // CHANNEL CALLBACKS — called by TransportManager
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  channelAdded(channel: ConnectedChannel): void {
    this.#dispatchSession({
      type: "sess/channel-added",
      channelId: channel.channelId,
      transportType: channel.transportType,
    })
  }

  channelEstablish(channel: ConnectedChannel): void {
    this.#dispatchSession({
      type: "sess/channel-establish",
      channelId: channel.channelId,
    })
  }

  channelReceive(channelId: ChannelId, message: ChannelMsg): void {
    if (isLifecycleMsg(message)) {
      this.#dispatchSession({
        type: "sess/message-received",
        fromChannelId: channelId,
        message,
      })
    } else {
      // Sync message — resolve channel → peer
      const entry = this.#sessionHandle.getState().channels.get(channelId)
      if (!entry?.remoteIdentity) return // not established, drop
      this.#dispatchSync({
        type: "sync/message-received",
        from: entry.remoteIdentity.peerId,
        message,
      })
    }
  }

  channelRemoved(channel: Channel): void {
    this.#dispatchSession({
      type: "sess/channel-removed",
      channelId: channel.channelId,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // DISPATCH — all entry points route through the outer coordinator
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #dispatchSession(input: SessionInput): void {
    this.#outerHandle.dispatch({ type: "route", input })
  }

  #dispatchSync(input: SyncInput): void {
    this.#outerHandle.dispatch({ type: "route", input })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SESSION EFFECT EXECUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #executeSessionEffect(effect: SessionEffect): void {
    switch (effect.type) {
      case "send": {
        this.#outboundQueue.push({
          toChannelIds: [effect.to],
          message: effect.message,
        })
        break
      }
      case "reject-channel":
        // Re-route through the outer (rather than touching the session
        // queue directly) so the synthetic channel-removed interleaves
        // with any other pending input in arrival order.
        this.#dispatchSession({
          type: "sess/channel-removed",
          channelId: effect.channelId,
        })
        break
      case "start-departure-timer": {
        const existing = this.#departureTimers.get(effect.peerId)
        if (existing) clearTimeout(existing)
        const timer = setTimeout(() => {
          this.#departureTimers.delete(effect.peerId)
          this.#dispatchSession({
            type: "sess/departure-timer-expired",
            peerId: effect.peerId,
          })
        }, effect.delayMs)
        this.#departureTimers.set(effect.peerId, timer)
        break
      }
      case "cancel-departure-timer": {
        const timer = this.#departureTimers.get(effect.peerId)
        if (timer) {
          clearTimeout(timer)
          this.#departureTimers.delete(effect.peerId)
        }
        break
      }
      case "sync-event":
        // Direct sync-handle dispatch would skip the outer's queue and
        // reorder relative to concurrently-dispatched user inputs;
        // routing through the outer is what keeps cross-program inputs
        // in arrival order.
        this.#dispatchSync(effect.event)
        break
      case "emit-peer-events":
        this.#emitPeerEvents(effect.events)
        break
      case "diagnostic":
        // console for now; the `severity` discriminant is the seam for the
        // planned structured onProtocolWarning callback (jj:wkwskqsy), where
        // these protocol mismatches become a programmatic `kind` rather than
        // a log line. Context: jj:yukrpnwm
        if (effect.severity === "error") console.error(effect.message)
        else console.warn(effect.message)
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SYNC EFFECT EXECUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #executeSyncEffect(effect: SyncEffect): void {
    switch (effect.type) {
      case "send-to-peer": {
        this.#sendToPeer(effect.to, effect.message)
        break
      }
      case "send-to-peers": {
        for (const peerId of effect.to) {
          this.#sendToPeer(peerId, effect.message)
        }
        break
      }
      case "send-offers":
        this.#executeSendOffers(effect)
        break
      case "import-doc-data":
        this.#executeImportDocData(effect)
        break
      case "classify-peer-version":
        this.#executeClassifyPeerVersion(effect)
        break
      case "ensure-doc":
        this.#docCreationCallback?.(
          effect.docId,
          effect.peer,
          effect.replicaType,
          effect.syncMode,
          effect.schemaHash,
          effect.supportedHashes,
        )
        break
      case "ensure-doc-dismissed":
        this.#docDismissedCallback?.(effect.docId, effect.peer, "remote")
        break
      case "emit-doc-events":
        this.#emitDocEvents(effect.events)
        break
      case "emit-ready-state-changes":
        this.#emitPeerSyncChanges(effect.docIds)
        break
      case "emit-state-advanced":
        this.#emitStateAdvanced(effect.docIds)
        break
      case "diagnostic":
        // Severity-aware console (mirrors #executeSessionEffect). The
        // convergence-preventing mismatches are `severity: "error"`. The
        // observation bus surfaces the structured `Diagnostic` (jj:qpmkoryn).
        // Context: jj:nztkqwpm
        if (effect.severity === "error") console.error(effect.message)
        else console.warn(effect.message)
        break
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // PEER→CHANNEL RESOLUTION
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #sendToPeer(peerId: PeerId, message: SyncMsg): void {
    const peer = this.#sessionHandle.getState().peers.get(peerId)
    if (!peer || peer.channels.size === 0) return // disconnected, drop

    const toChannelIds: ChannelId[] = Array.from(peer.channels)

    this.#outboundQueue.push({
      toChannelIds,
      message: this.#withDigest(message),
    })
  }

  /**
   * Attach our state fingerprint to a message that carries a version.
   *
   * Done here, at the one place messages leave, rather than where they are
   * built: the sync program is pure and holds no replica, and the digest is
   * a fact about the replica at the moment of sending.
   *
   * A substrate whose version already answers equality returns nothing, and
   * the field stays absent — which is itself the instruction to compare
   * versions instead.
   */
  #withDigest(message: SyncMsg): SyncMsg {
    if (message.type !== "interest" && message.type !== "offer") return message
    const digest = this.#docs.get(message.docId)?.replica.digest?.()
    return digest === undefined ? message : { ...message, digest }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SEND OFFER — build and queue outbound offer for a document
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Send each recipient an offer from its own baseline, if the document may
   * leave the process, and report what was sent.
   *
   * - `publishable` is asked first, immediately before the export, and
   *   nothing can write between the two. Refused, nothing is sent and every
   *   recipient stays owed; the Runtime reports the opening later.
   * - One export per distinct baseline. Baselines differ only between an
   *   import and the next push, so a fan-out usually costs one export however
   *   many peers it reaches.
   * - `sync/offers-sent` names each recipient whose offer was queued, with
   *   the version the offer carried, which is where its baseline moves. A
   *   peer without a channel is not named, and stays owed.
   */
  #executeSendOffers(
    effect: Extract<SyncEffect, { type: "send-offers" }>,
  ): void {
    const { docId } = effect
    if (!this.#publishable(docId)) return
    const payloads = new Map<string | undefined, SubstratePayload | null>()
    const sent: { peerId: PeerId; version: string }[] = []
    for (const { peerId, sinceVersion } of effect.to) {
      let payload = payloads.get(sinceVersion)
      if (payload === undefined) {
        payload = this.#buildOffer(docId, sinceVersion)
        payloads.set(sinceVersion, payload)
      }
      if (payload === null) continue
      const version = this.#sendOfferToPeer(peerId, docId, payload)
      if (version !== undefined) sent.push({ peerId, version })
    }
    if (sent.length > 0) {
      this.#dispatchSync({ type: "sync/offers-sent", docId, sent })
    }
  }

  /**
   * The payload that brings a peer at `sinceVersion` to our version: the
   * delta from it, or the whole document when we cannot serve it (history
   * trimmed past it, an incarnation not ours, a version that does not parse)
   * or no baseline is given. `null` only when the document is gone.
   *
   * A version that does not parse is answered with the whole document rather
   * than nothing. It can come from a peer's interest, and a peer left with
   * no answer would stay owed one, and be skipped by every push, until it
   * reconnected.
   */
  #buildOffer(docId: DocId, sinceVersion?: string): SubstratePayload | null {
    const doc = this.#docs.get(docId)
    if (!doc) {
      console.warn(
        `[exchange] document not registered, offer not sent: ${docId}`,
      )
      return null
    }
    if (sinceVersion === undefined) return doc.replica.exportEntirety()

    let since: Version
    try {
      since = doc.replicaFactory.parseVersion(sinceVersion)
    } catch (error) {
      console.warn(
        `[exchange] version parse failed for doc '${docId}', sending the whole document:`,
        error,
      )
      return doc.replica.exportEntirety()
    }
    return doc.replica.exportSince(since) ?? doc.replica.exportEntirety()
  }

  /**
   * Queue an offer to every channel of `peerId`. Returns the version the
   * offer carries, or `undefined` when nothing was queued: the peer has no
   * channel, or the document is gone.
   */
  #sendOfferToPeer(
    peerId: PeerId,
    docId: DocId,
    payload: SubstratePayload,
  ): string | undefined {
    const peer = this.#sessionHandle.getState().peers.get(peerId)
    if (!peer || peer.channels.size === 0) return undefined

    const doc = this.#docs.get(docId)
    if (!doc) return undefined

    const version = doc.replica.version().serialize()
    this.#outboundQueue.push({
      toChannelIds: Array.from(peer.channels),
      message: this.#withDigest({
        type: "offer",
        docId,
        payload,
        version,
      }),
    })
    return version
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // IMPORT DOC DATA — merge inbound data and notify model on success
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  /**
   * Compare a peer's version against ours, mark it `synced` if there is
   * nothing left to receive, and hand back what the comparison found.
   *
   * This is the single place a version comparison becomes a `synced`
   * transition: the offer path continues into a merge when a gap comes back,
   * and the interest path stops here. `sync/peer-synced` has no other
   * producer in the shell, which is what makes "every `synced` follows a
   * version comparison" true by construction rather than by discipline.
   */
  #classifyPeer(
    doc: RegisteredDoc,
    docId: DocId,
    peerId: PeerId,
    version: string | undefined,
    digest?: string,
  ): VersionGapResult {
    const gap = resolveInboundVersionGap(
      doc.replica,
      doc.replicaFactory,
      version,
      digest,
    )

    switch (gap.kind) {
      case "parse-error":
        console.warn(
          `[exchange] version parse failed for doc '${docId}':`,
          gap.error,
        )
        return gap
      case "absent":
      case "no-gap": {
        const transition = transitionForPeerVersion(gap, docId, peerId, version)
        if (transition) this.#dispatchSync(transition)
        return gap
      }
      case "gap":
        return gap
    }
  }

  /**
   * An inbound `interest` told the program a peer wants our state. Whether we
   * also want theirs is the same question the offer path asks — see
   * `#classifyPeer` — so this is that call and nothing more. A peer whose
   * version is ahead stays `pending` until its offer arrives and takes the
   * `doc-imported` path.
   */
  #executeClassifyPeerVersion(effect: {
    type: "classify-peer-version"
    docId: DocId
    peerId: PeerId
    version: string | undefined
    digest?: string
  }): void {
    const doc = this.#docs.get(effect.docId)
    if (!doc) return
    this.#classifyPeer(
      doc,
      effect.docId,
      effect.peerId,
      effect.version,
      effect.digest,
    )
  }

  /**
   * Take in an offer: gather what is known, plan, do the one thing the plan
   * names, and report what it did.
   */
  #executeImportDocData(effect: ImportDocData): void {
    const doc = this.#docs.get(effect.docId)
    if (!doc) return

    const gap = this.#classifyPeer(
      doc,
      effect.docId,
      effect.fromPeerId,
      effect.version,
      effect.digest,
    )
    const sync = this.#syncHandle.getState()
    const peerState = sync.peers.get(effect.fromPeerId)
    const resetTrigger =
      gap.kind === "gap"
        ? classifyResetTrigger(
            doc.replica.version().lineage,
            gap.parsed.lineage,
            effect.payload.kind === "entirety",
            peerState?.docSyncStates.get(effect.docId)?.status === "synced",
            doc.replicaFactory.historyFree,
          )
        : "none"
    const plan = planImport({
      gap,
      resetTrigger,
      resetPermitted:
        resetTrigger !== "none" &&
        this.#canReset(
          effect.docId,
          (peerState?.identity ?? {
            peerId: effect.fromPeerId,
          }) as PeerIdentityDetails,
          doc.syncMode,
        ),
      payloadKind: effect.payload.kind,
    })

    switch (plan) {
      case "unreadable":
        return
      case "already-held":
        this.#acceptIfOwed(effect)
        return
    }
    // Every remaining plan follows a gap, which carries the parsed version.
    if (gap.kind !== "gap") return

    // A refused compaction reset stays silent: the document diverges from the
    // compacted peers until governance reconciles. Reported not held, it
    // would draw an interest whose answer is the same image, refused again.
    if (plan === "refused" && resetTrigger === "compaction") return

    const prior = doc.replica.version()
    const crossing = crossingOf(
      resetTrigger,
      plan,
      prior.lineage,
      gap.parsed.lineage,
    )
    try {
      switch (plan) {
        case "reset":
          if (doc.mode === "replicate") {
            // Headless replicas rebuild from the payload rather than merging
            // it, for both triggers: the incoming image is not a continuation
            // of what we hold. Under `"compaction"` the sender rewrote its
            // history (`LoroReplica.advance()` exports a shallow snapshot and
            // rebuilds from it; `YjsReplica.advance()` re-projects into a
            // fresh `Y.Doc`, because Yjs has no trim primitive), and merging
            // such an image keeps local ops whose causal anchors it no longer
            // carries. Under `"lineage"` the sender's history is a different
            // identity, so there is nothing to reconcile against. Rebuilding
            // would be wrong for a field-level LWW substrate, which drops
            // concurrent field writes the sender has not seen; such a
            // document never reaches here (see `classifyResetTrigger`).
            //
            // The Runtime does the rebuild: it owns the document's record,
            // and persistence and promotion read the replica from there.
            this.#rebuildReplica(effect.docId, effect.payload)
          } else {
            // `resetFromEntirety` discards local history and adopts the
            // incoming state and lineage, which the routine merge never does
            // across lineages.
            doc.replica.resetFromEntirety(effect.payload, { origin: "sync" })
          }
          break
        case "merge":
          doc.replica.merge(effect.payload, { origin: "sync" })
          break
        case "ask-whole":
        case "refused":
        case "outrank":
          // These take nothing in; the report says what follows.
          break
      }
    } catch (err) {
      console.warn(
        plan === "merge"
          ? `[exchange] import failed for doc '${effect.docId}'. ` +
              `If you recently switched CRDT backends, stale clients may be sending incompatible data.`
          : `[exchange] ${resetTrigger} reset failed for doc '${effect.docId}'.`,
        err,
      )
      return
    }

    const after = doc.replica.version()
    this.#took(
      effect,
      after.serialize(),
      reportImport({
        plan,
        prior,
        after,
        offered: gap.parsed,
        historyFree: doc.replicaFactory.historyFree,
      }),
      this.#senderWillHold(doc, effect, gap.parsed, plan),
      crossing,
    )
  }

  /**
   * What the sender will hold of ours now that it has told us its version:
   * its baseline joined with the version it offered. After a reset it is the
   * offered version alone, since the reset discarded what the sender held of
   * our old state. Absent for a history-free document,
   * whose versions are private counters that do not join across replicas.
   */
  #senderWillHold(
    doc: RegisteredDoc,
    effect: ImportDocData,
    offered: Version,
    plan: ImportPlan,
  ): string | undefined {
    if (doc.replicaFactory.historyFree) return undefined
    const baseline = effect.ourVersionTheyWillHold
    if (baseline === undefined || plan === "reset") {
      return offered.serialize()
    }
    try {
      return doc.replicaFactory.parseVersion(baseline).join(offered).serialize()
    } catch {
      // A baseline that does not parse or join (from another lineage) is
      // no longer what the sender holds; its offer is.
      return offered.serialize()
    }
  }

  /**
   * The one exit of every offer that showed a gap, except a refused
   * compaction: `accept` it if it is held and an accept is owed, then tell
   * the program what the offer did, including any lineage it crossed.
   */
  #took(
    effect: ImportDocData,
    version: string,
    report: { readonly changed: boolean; readonly held: boolean },
    senderWillHold: string | undefined,
    crossing: LineageCrossing | undefined,
  ): void {
    if (report.held) this.#acceptIfOwed(effect)
    this.#dispatchSync({
      type: "sync/doc-imported",
      docId: effect.docId,
      version,
      offered: effect.version,
      fromPeerId: effect.fromPeerId,
      changed: report.changed,
      held: report.held,
      ...(senderWillHold === undefined ? {} : { senderWillHold }),
      ...(crossing === undefined ? {} : { crossing }),
    })
  }

  /**
   * Tell the offerer we now hold its version, if the program said it is owed.
   *
   * Sent here, as soon as the offer is held, rather than from the program's
   * handling of the import that follows: anything the import makes this peer
   * send (a subscriber that answers what arrived, say) is queued behind the
   * import, and an offerer that hears that answer first could compact before
   * it knows what we hold.
   */
  #acceptIfOwed(effect: ImportDocData): void {
    if (!effect.accept) return
    this.#sendToPeer(effect.fromPeerId, {
      type: "accept",
      docId: effect.docId,
      version: effect.version,
    })
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // OUTBOUND — flush accumulated envelopes
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #drainOutboundOnce(): void {
    while (this.#outboundQueue.length > 0) {
      const envelope = this.#outboundQueue.shift()
      if (!envelope) break
      this.transports.send(envelope)
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // EMIT HANDLERS — interpret emit-* effects against ReactiveMaps / listeners
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #emitPeerEvents(events: readonly PeerChange[]): void {
    if (events.length === 0) return
    if (!this.#peerHandle) return

    // Rebuild peer map from session model (source of truth for presence)
    this.#peerHandle.clear()
    for (const [peerId, sessionPeer] of this.#sessionHandle.getState().peers) {
      this.#peerHandle.set(peerId, sessionPeer.identity)
    }

    this.#peerHandle.emit({ changes: [...events] })
  }

  #emitDocEvents(events: readonly DocChange[]): void {
    if (events.length === 0) return
    if (!this.#docHandle) return

    this.#docHandle.clear()

    // Rebuild from #docs (interpret + replicate docs)
    const sync = this.#syncHandle.getState()
    for (const [docId, doc] of this.#docs) {
      const suspended = !sync.documents.has(docId)
      this.#docHandle.set(docId, { mode: doc.mode, suspended })
    }

    // Merge deferred docs from syncModel (not registered, only a model entry)
    for (const [docId, entry] of sync.documents) {
      if (entry.mode === "deferred") {
        this.#docHandle.set(docId, { mode: "deferred", suspended: false })
      }
    }

    this.#docHandle.emit({ changes: [...events] })
  }

  #emitPeerSyncChanges(docIds: readonly DocId[]): void {
    if (docIds.length === 0) return
    const observing = this.#observationBus.enabled
    if (this.#peerSyncListeners.size === 0 && !observing) return

    for (const docId of docIds) {
      if (!this.#docs.has(docId)) continue
      const peerStates = this.getPeerStates(docId)
      // Observation tee — the authoritative per-peer-doc status, so a devtools
      // fold reconstructs the directory/status view without re-deriving the
      // sync program's reconciliation. Context: jj:pusmrzuy.
      if (observing) this.#tee(observePeerSyncState(docId, peerStates))
      for (const listener of this.#peerSyncListeners) {
        listener(docId, peerStates)
      }
    }
  }

  #emitStateAdvanced(docIds: readonly DocId[]): void {
    if (this.#stateAdvancedListeners.size === 0 || docIds.length === 0) return

    for (const docId of docIds) {
      if (!this.#docs.has(docId)) continue
      for (const listener of this.#stateAdvancedListeners) {
        listener(docId)
      }
    }
  }

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // SHUTDOWN / RESET HELPERS
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  #sendDepartToAllPeers(): void {
    for (const [_peerId, peer] of this.#sessionHandle.getState().peers) {
      for (const channelId of peer.channels) {
        this.#outboundQueue.push({
          toChannelIds: [channelId],
          message: { type: "depart" },
        })
      }
    }
  }

  #clearDepartureTimers(): void {
    for (const timer of this.#departureTimers.values()) {
      clearTimeout(timer)
    }
    this.#departureTimers.clear()
  }

  /**
   * Run the teardown emit cascade through the algebra so subscribers
   * see doc-removed / peer-departed events before the handles are
   * disposed.
   *
   * The docIds snapshot must be taken before `#docs` is cleared;
   * the clear itself must happen before the dispatch, because
   * `#emitDocEvents` rebuilds the doc map from `#docs` and a
   * live entry there would re-introduce the doc the event is meant to
   * remove.
   */
  #emitSyntheticOnTeardown(): void {
    const sync = this.#syncHandle.getState()

    const docIds: DocId[] = []
    for (const docId of this.#docs.keys()) docIds.push(docId)
    for (const [docId, entry] of sync.documents) {
      if (entry.mode === "deferred" && !this.#docs.has(docId)) {
        docIds.push(docId)
      }
    }

    this.#docs.clear()

    if (docIds.length > 0) {
      this.#dispatchSync({
        type: "sync/synthetic-doc-removed-all",
        docIds,
      })
    }

    if (this.#sessionHandle.getState().peers.size > 0) {
      this.#dispatchSession({ type: "sess/synthetic-depart-all" })
    }
  }
}
