// document-terms — everything this package keeps per document, in one record.
//
// A ref knows its contents, but not the terms it was created under: whether
// its store has loaded it, whether its own writes are confirmed, whether its
// peers have answered, its sync mode and authority, and its sync handle. Those
// live here, one `DocumentTerms` record per document, which the Runtime
// attaches (`local`) and the Exchange completes (`network`).
//
// Readiness, sync mode and the sync handle belong to a document, but callers
// hold refs, and often not the root one: `useText(doc.title)`,
// `useDocStatus(doc.items)`. Every ref in a document carries the same context
// under `[TRANSACT]`, so that context names the document from any of its refs
// (`documentKey`).
//
// Every term is a `settableFeed`. While the document is open it follows a live
// feed over the Runtime or the Exchange. When the document closes, each term
// is set to a constant (`closedTerms`), which drops the live feed and what it
// closed over, and tells every subscriber: a feed or a wait obtained before the
// close follows it like any other change. A held ref of a closed document then
// reaches its terms' constants, and through them nothing else.

import {
  CHANGEFEED,
  type Feed,
  type Settable,
  settableFeed,
  signalFeed,
} from "@kyneta/changefeed"
import {
  type DocumentClosedError,
  hasTransact,
  type SyncMode,
  TRANSACT,
  type WriteRefusal,
} from "@kyneta/schema"
import type { DocId, PeerId, PeerIdentityDetails } from "@kyneta/transport"
import type { Authority } from "./governance.js"
import { derivePeerSettled } from "./synchronizer.js"
import type { Connectivity, PeerSyncState } from "./types.js"

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** Where the document's load from its store stands. A failed load carries
 *  its error, so one `set` changes both. */
export type Hydration =
  | { readonly status: "pending" | "loaded" }
  | { readonly status: "failed"; readonly error: unknown }

/** Whether the store has confirmed every own write. `error` is the latest
 *  failed store write; it can be set while `persisted` is true. */
export type Persistence = {
  readonly persisted: boolean
  readonly error?: unknown
}

/** Whether the peers this document waits on have answered, by the declared
 *  authority (`settled`) or by another (`resolve`). */
export type Peer = {
  readonly settled: boolean
  readonly resolve: (authority: Authority) => boolean
}

/**
 * What `whenSettled` waits on: the Synchronizer, bound to one document and
 * narrowed so a closed form can stand in for it.
 */
export interface SyncSource {
  connectivity(): Connectivity
  /** The identities of the peers this document has reconciled with. */
  reconciled(): readonly PeerIdentityDetails[]
  /** Resolve once `isSettled`, `"offline"` after `offlineAfter` ms (0 waits
   *  forever), and stop waiting on `signal`'s abort. */
  awaitReconciliation(
    isSettled: () => boolean,
    offlineAfter: number,
    signal: AbortSignal,
  ): Promise<"ready" | "offline">
}

/**
 * What `sync(ref)` returns: a document's sync and network state.
 *
 * - `peerId` / `docId` — the local peer and the document
 * - `peerStates` — current per-peer sync state
 * - `ready` / `readyFor(pred)` — monotonic readiness latches
 * - `connectivity` — the coarse connection lifecycle
 * - `onPeerSyncChange()` — subscribe to per-peer sync state changes
 */
export interface SyncRef {
  /** The local peer ID. */
  readonly peerId: PeerId

  /** The document ID. */
  readonly docId: DocId

  /** Current per-peer sync state with all peers (volatile — can regress). */
  readonly peerStates: PeerSyncState[]

  /**
   * Monotonic readiness latch: `true` once this doc has reconciled with ≥1
   * peer (received data, or a terminal `vacant` reply). Stays `true` across
   * the `synced→pending→synced` reconnect re-handshake flip and across a
   * reconciled peer departing. The 90% case that users typically want: "is it
   * safe to read?" gate.
   */
  readonly ready: boolean

  /**
   * Monotonic latch restricted to peers matching `pred` (the authority /
   * quorum case) — resolved against stored identities, so it holds even
   * after the matching peer has left.
   */
  readyFor(pred: (peer: PeerIdentityDetails) => boolean): boolean

  /**
   * Coarse connection lifecycle: `online` (≥1 established peer),
   * `connecting` (transports configured, none established), or `offline`
   * (no transports configured).
   */
  readonly connectivity: Connectivity

  /**
   * Subscribe to per-peer sync state changes.
   * @param cb Callback that receives the new peer states
   * @returns Unsubscribe function
   */
  onPeerSyncChange(cb: (peerStates: PeerSyncState[]) => void): () => void
}

/** A document's sync handle and what its waits wait on. */
export type Sync = { readonly ref: SyncRef; readonly source: SyncSource }

/** What the Runtime attaches to every interpreted document. */
export interface LocalTerms {
  readonly syncMode: SyncMode
  readonly hydration: Settable<Hydration>
  readonly persistence: Settable<Persistence>
}

/**
 * What the Exchange attaches to a document it syncs: whether its peers have
 * answered, its authority, its sync handle, and the policy's refusal of this
 * peer's authored writes (`Policy.canWrite`), which the Runtime's owner
 * refusal follows through {@link networkTermFeed}.
 */
export interface NetworkTerms {
  readonly peer: Settable<Peer>
  readonly authority: Settable<Authority>
  readonly sync: Settable<Sync>
  readonly refusal: Settable<WriteRefusal | undefined>
}

/**
 * Everything kept per document. `network` is empty for a document no Exchange
 * syncs, which `settled` reads as nothing to wait for, as an empty conjunction
 * does; it is a feed because the Exchange attaches it after the Runtime
 * attaches `local`.
 */
export interface DocumentTerms {
  readonly local: LocalTerms
  readonly network: Settable<NetworkTerms | undefined>
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/** The document a ref belongs to, as a key: its shared context, or the ref. */
export function documentKey(ref: object): object {
  return hasTransact(ref) ? ref[TRANSACT] : ref
}

/** Weak, so the registry never keeps a document alive. */
const registry = new WeakMap<object, DocumentTerms>()

/**
 * The terms of the document `ref` belongs to, or `undefined` for a document no
 * Runtime holds (a standalone `createDoc`).
 */
export function termsOf(ref: object): DocumentTerms | undefined {
  return registry.get(documentKey(ref))
}

/**
 * A document's terms record, as a value: its local terms, and an empty
 * `network` the Exchange fills later. Built before the document's ref, so
 * the ref's owner refusal can follow the record's network refusal from the
 * start; {@link registerTerms} files it once the ref exists.
 *
 * @internal Called by `Runtime` as it creates an interpreted document.
 */
export function buildLocalTerms(local: LocalTerms): DocumentTerms {
  return {
    local,
    network: settableFeed<NetworkTerms | undefined>(undefined),
  }
}

/**
 * File `terms` under the document `ref` belongs to.
 *
 * @internal Called by `Runtime` once it has created the document's ref.
 */
export function registerTerms(ref: object, terms: DocumentTerms): void {
  registry.set(documentKey(ref), terms)
}

/**
 * Attach a document's network terms, after its local ones.
 *
 * @internal Called by `Exchange` for every interpreted document.
 */
export function registerNetworkTerms(ref: object, network: NetworkTerms): void {
  const terms = termsOf(ref)
  if (terms === undefined) {
    throw new Error(
      "[document-terms] network terms need the document's local terms first",
    )
  }
  terms.network.set(network)
}

// ---------------------------------------------------------------------------
// Closing: a snapshot, its closed values, and one set per term
// ---------------------------------------------------------------------------

/** Each term's value at the close, read before anything is computed. */
export interface TermsSnapshot {
  readonly hydration: Hydration
  readonly persistence: Persistence
  readonly network?: {
    readonly peerId: PeerId
    readonly docId: DocId
    readonly authority: Authority
    readonly connectivity: Connectivity
    readonly peerStates: readonly PeerSyncState[]
    /** The identities of the peers the document had reconciled with. */
    readonly reconciled: readonly PeerIdentityDetails[]
  }
}

/** The values a record's terms hold: one per `Settable` field. */
type TermValues<R> = {
  readonly [K in keyof R as R[K] extends Settable<any>
    ? K
    : never]: R[K] extends Settable<infer T> ? T : never
}

/**
 * A closed document's term values. Complete by type: a term added to
 * `LocalTerms` or `NetworkTerms` that `closedTerms` does not close fails to
 * type-check.
 */
export interface ClosedValues {
  readonly local: TermValues<LocalTerms>
  readonly network?: TermValues<NetworkTerms>
}

/**
 * What a hydration says once its document has closed: `pending` fails with
 * `error`, and an answer already given stands. Pure. The Runtime closes the
 * hydration term and the waiters on a document's load through this, so both
 * report the same error object.
 */
export function closedHydration(
  hydration: Hydration,
  error: DocumentClosedError,
): Hydration {
  return hydration.status === "pending"
    ? { status: "failed", error }
    : hydration
}

/**
 * What a document's terms say once it has closed. Pure.
 *
 * **Closing never invents an answer.** Each term keeps the answer it had, and
 * a term still pending closes as failed with `error`:
 * - hydration: `loaded` stays loaded, a `failed` load keeps its error, and a
 *   `pending` one fails with `error`;
 * - persistence: `persisted` stays as it was; unconfirmed own writes fail with
 *   `error`, so a pending `whenPersisted` rejects;
 * - peer: settled exactly as it was, by any authority, judged from the peers
 *   the document had reconciled with, since no peer can be asked any more;
 * - authority: its value at the close;
 * - sync: a `SyncRef` reporting the state at the close, over a source whose
 *   waits reject with `error`;
 * - refusal: none, which lets go of the policy it followed. The Runtime
 *   refuses a closed document's writes with the close error, and its
 *   disposed slot with its own `DocumentClosedError`.
 *
 * Every value closes over nothing but the snapshot and `error`.
 */
export function closedTerms(
  snapshot: TermsSnapshot,
  error: DocumentClosedError,
): ClosedValues {
  const hydration = closedHydration(snapshot.hydration, error)
  const persistence: Persistence = snapshot.persistence.persisted
    ? snapshot.persistence
    : { persisted: false, error }
  const local = { hydration, persistence }
  const { network } = snapshot
  if (network === undefined) return { local }

  const { authority, connectivity, reconciled } = network
  const settledBy = (by: Authority): boolean =>
    derivePeerSettled({
      authority: by,
      hasReconciled: reconciled.length > 0,
      matchesAuthority: typeof by === "function" && reconciled.some(by),
      isOffline: connectivity === "offline",
    })
  const peerStates = [...network.peerStates]
  const ref: SyncRef = {
    peerId: network.peerId,
    docId: network.docId,
    get peerStates() {
      return [...peerStates]
    },
    ready: connectivity === "offline" || reconciled.length > 0,
    readyFor: pred => reconciled.some(pred),
    connectivity,
    onPeerSyncChange: () => () => {},
  }
  const source: SyncSource = {
    connectivity: () => connectivity,
    reconciled: () => reconciled,
    awaitReconciliation: isSettled =>
      isSettled() ? Promise.resolve("ready") : Promise.reject(error),
  }
  return {
    local,
    network: {
      peer: { settled: settledBy(authority), resolve: settledBy },
      authority,
      sync: { ref, source },
      refusal: undefined,
    },
  }
}

/**
 * Read every term of `terms` as it stands, but for hydration, which the
 * caller gives: the Runtime knows what a document's load came to, and by the
 * time it closes the document, its record of the load is already gone.
 */
export function snapshotOf(
  terms: DocumentTerms,
  hydration: Hydration,
): TermsSnapshot {
  const local = {
    hydration,
    persistence: terms.local.persistence(),
  }
  const network = terms.network()
  if (network === undefined) return local
  const { ref, source } = network.sync()
  return {
    ...local,
    network: {
      peerId: ref.peerId,
      docId: ref.docId,
      authority: network.authority(),
      connectivity: source.connectivity(),
      peerStates: ref.peerStates,
      reconciled: source.reconciled(),
    },
  }
}

/**
 * Close a document's terms: snapshot them, with `hydration` as the load's
 * answer, compute their closed values, and set each term. Every subscriber
 * hears its term move once.
 */
export function closeTerms(
  terms: DocumentTerms,
  error: DocumentClosedError,
  hydration: Hydration,
): void {
  const values = closedTerms(snapshotOf(terms, hydration), error)
  setEach(terms.local, values.local)
  const network = terms.network()
  if (network !== undefined && values.network !== undefined) {
    setEach(network, values.network)
  }
}

function setEach<R extends object>(terms: R, values: TermValues<R>): void {
  for (const key of Object.keys(values) as (keyof TermValues<R>)[]) {
    ;(terms[key as keyof R] as Settable<unknown>).set(values[key])
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One network term of `terms`, followed from before the Exchange attaches
 * the network terms: `absent` until then, and `pick(network)`'s answer
 * after. A subscriber hears the attachment and every change of the picked
 * term.
 */
export function networkTermFeed<T>(
  terms: DocumentTerms,
  pick: (network: NetworkTerms) => Feed<T>,
  absent: T,
): Feed<T> {
  const picked = (): Feed<T> | undefined => {
    const network = terms.network()
    return network === undefined ? undefined : pick(network)
  }
  return signalFeed(
    () => {
      const term = picked()
      return term === undefined ? absent : term()
    },
    onChange => {
      let stopTerm: (() => void) | undefined
      const follow = (): void => {
        stopTerm?.()
        stopTerm = picked()?.[CHANGEFEED].subscribe(() => onChange())
      }
      follow()
      const stopNetwork = terms.network[CHANGEFEED].subscribe(() => {
        follow()
        onChange()
      })
      return () => {
        stopNetwork()
        stopTerm?.()
      }
    },
  )
}

/** A feed that never moves, for a document with no term to follow. */
export function constantFeed<T>(value: T): Feed<T> {
  return signalFeed(
    () => value,
    () => () => {},
  )
}
