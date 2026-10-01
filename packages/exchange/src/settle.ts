// settle — "have all of this document's truth sources reported yet?"
//
// A document can sit at one of several layers, and each layer adds exactly one
// thing worth waiting for:
//
//   createDoc(bound)                — nothing to wait for
//   + Runtime with a store          — the saved data has to finish loading
//   + Exchange with transports      — the authoritative peer has to answer
//
// Each layer registers one **settle term**: a boolean that starts `false` and
// flips to `true` once that layer's source has reported in. A document is
// settled when *every* attached term is true.
//
// Zero terms means the conjunction is empty, and an empty conjunction is
// `true` — so a plain in-memory document, or a daemon with no storage and no
// network, is settled the moment it is created. That is not a special case
// bolted on; it falls out of the algebra, which is why the transportless case
// needs no carve-out anywhere else.
//
// Why a conjunction and not a disjunction: `settled` exists to make the
// *negative* verdict trustworthy ("this document is genuinely empty"). Absence
// of evidence is not evidence of absence until every source has been consulted.
// Positive evidence needs no such gate — see `populated` in @kyneta/schema,
// which flips as soon as any source delivers data.
//
// A term is a `[CHANGEFEED]` carrier rather than a bespoke interface. That is
// the codebase's universal reactive contract (see packages/changefeed/
// TECHNICAL.md), so a term has the same shape as `populatedFeed(ref)` and
// composes with `useChangefeed`, `@kyneta/reactive`, and `@kyneta/index`
// without any new plumbing.

import type { Changeset, Feed } from "@kyneta/changefeed"
import { CHANGEFEED, createFeed } from "@kyneta/changefeed"
import { createDocumentMap } from "./document-key.js"
import type { Authority } from "./governance.js"

// ---------------------------------------------------------------------------
// The term protocol
// ---------------------------------------------------------------------------

/**
 * A feed whose subscribers hear only that it moved: `subscribe` calls back
 * with no change, and each subscriber receives an empty changeset. A settle
 * term is one over a boolean: one layer's answer to "has my truth source
 * reported for this document?". Terms are monotonic in practice (a source
 * that has reported does not un-report), but nothing here depends on that.
 *
 * @internal
 */
export function signalFeed<T>(
  read: () => T,
  subscribe: (onChange: () => void) => () => void,
): Feed<T> {
  return createFeed(read, {
    get current(): T {
      return read()
    },
    subscribe(callback: (changeset: Changeset<never>) => void): () => void {
      return subscribe(() => callback({ changes: [] }))
    },
  })
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Terms attached to a document. A `DocumentMap`, like every per-document
 * registry in this package, so any ref within the document finds them.
 */
const settleTerms = createDocumentMap<Feed<boolean>[]>()

/**
 * Attach a settle term to a document.
 *
 * @internal Called by `Runtime` (the storage term) and `Exchange` (the peer
 * term) as a document is created. Applications never call this.
 */
export function registerSettleTerm(ref: object, term: Feed<boolean>): void {
  const existing = settleTerms.get(ref)
  if (existing) existing.push(term)
  else settleTerms.set(ref, [term])
}

/**
 * The terms attached to a document. Empty for a document with nothing to
 * await.
 *
 * @internal
 */
export function termsFor(ref: object): readonly Feed<boolean>[] {
  return settleTerms.get(ref) ?? []
}

// ---------------------------------------------------------------------------
// The conjunction
// ---------------------------------------------------------------------------

/**
 * Has every truth source attached to this document reported yet?
 *
 * Returns `true` when there are no terms at all — the empty conjunction. That
 * is the honest answer for a document with nothing to wait for, and it is what
 * makes a standalone `createDoc` and a transportless, storeless `Exchange`
 * behave identically here.
 *
 * This is a plain boolean and is safe to put in an `if`. For the observable
 * form, use {@link settledFeed}.
 */
export function settled(ref: object): boolean {
  for (const term of termsFor(ref)) {
    if (!term()) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// The storage term, addressable on its own
// ---------------------------------------------------------------------------

/**
 * The Runtime's storage term, kept separately so it can be asked about by
 * itself.
 *
 * "Has my store finished loading?" is a question a server genuinely wants to
 * ask — it is the gate for deciding whether a document is safe to initialise —
 * and answering it through the whole conjunction would also wait on peers,
 * which an authoritative peer has no reason to do.
 */
const storage = createDocumentMap<{
  readonly term: Feed<boolean>
  /** The load error, if the load failed. */
  readonly readError: () => unknown | undefined
}>()

/**
 * Register the storage term for a document: it joins the conjunction *and*
 * becomes individually addressable via {@link hydrated}.
 *
 * `readError` lets a failed load be *reported* rather than merely waited on
 * forever. Without it a store error would present as a document that is
 * permanently un-settled with nothing said about why — safe, but impossible
 * to debug.
 *
 * @internal Called by `Runtime` as a document is created.
 */
export function registerHydrationTerm(
  ref: object,
  term: Feed<boolean>,
  readError: () => unknown | undefined,
): void {
  storage.set(ref, { term, readError })
  registerSettleTerm(ref, term)
}

/**
 * The error from this document's failed load, or `undefined` if the load
 * succeeded, is still running, or there was nothing to load.
 */
export function hydrationError(ref: object): unknown | undefined {
  return storage.get(ref)?.readError()
}

/**
 * Resolve once this document's stored data has finished loading; reject if the
 * load failed.
 *
 * Deliberately takes no timeout. A missing peer may genuinely never arrive, so
 * giving up on one is the only option available — but a slow disk is a local
 * fault we can observe, and abandoning the wait would mean proceeding as
 * though the document were empty. That is how defaults end up written over
 * data we merely failed to read.
 */
export function whenHydrated(ref: object): Promise<void> {
  const term = storage.get(ref)?.term
  if (!term) return Promise.resolve() // nothing to load
  if (term()) return Promise.resolve()

  const failure = hydrationError(ref)
  if (failure !== undefined) return Promise.reject(failure)

  return new Promise<void>((resolve, reject) => {
    const dispose = term[CHANGEFEED].subscribe(() => {
      const error = hydrationError(ref)
      dispose()
      if (error !== undefined) reject(error)
      else resolve()
    })
  })
}

/**
 * Has this document finished loading from storage?
 *
 * `true` when the document has no store behind it — there is nothing to load,
 * so the load is trivially done. Also `true` once a load completes. Stays
 * `false` if a load is in flight *or if it failed*: a failed read is not an
 * empty document, and reporting it as loaded would invite writing defaults
 * over data we simply could not read.
 *
 * This — not `exchange.flush()` — is the storage gate. `flush()` is named for
 * draining pending *writes* and only happens to await hydration as an
 * implementation detail.
 */
export function hydrated(ref: object): boolean {
  const term = storage.get(ref)?.term
  return term ? term() : true
}

/** Observable form of {@link hydrated}. A callable, so never put it in an `if`. */
export function hydratedFeed(ref: object): Feed<boolean> {
  return (
    storage.get(ref)?.term ??
    signalFeed(
      () => true,
      () => () => {},
    )
  )
}

/**
 * The same conjunction as an observable carrier, so callers can react to a
 * document becoming settled rather than polling it.
 *
 * Being a carrier, this is a *callable* — and therefore always truthy. Never
 * write `if (settledFeed(ref))`; call it, or use {@link settled}.
 */
export function settledFeed(ref: object): Feed<boolean> {
  // Read `termsFor` on every access rather than capturing it: a term can be
  // registered after this feed is created (the Exchange's peer term is added
  // after the Runtime's storage term), and a captured array would miss it.
  return signalFeed(
    () => settled(ref),
    onChange => {
      const disposers = termsFor(ref).map(term =>
        term[CHANGEFEED].subscribe(() => onChange()),
      )
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Authority override
// ---------------------------------------------------------------------------

/** Re-evaluates the peer term against a caller-supplied authority. */
const peerResolvers = createDocumentMap<(authority: Authority) => boolean>()

/**
 * Register the peer term's resolver, so a caller can ask "would this be
 * settled if I treated *this* peer as the authority?" without the answer being
 * fixed at document-creation time.
 *
 * @internal Called by `Exchange` alongside the peer term itself.
 */
export function registerPeerResolver(
  ref: object,
  resolve: (authority: Authority) => boolean,
): void {
  peerResolvers.set(ref, resolve)
}

/**
 * {@link settled}, but with the authority decided by the caller rather than by
 * the Exchange's policy.
 *
 * The resolution order this completes is: call-site → `Policy.authority` →
 * `"any"`. The call-site override is what makes runtime leader election
 * expressible — a peer can compute who the leader is from the current peer set
 * and pass it in, which a policy fixed at construction could never express.
 *
 * Enumerates the two term kinds rather than iterating the generic term list,
 * because only the peer term is authority-dependent and it has to be evaluated
 * differently from the rest.
 */
export function settledWith(ref: object, authority?: Authority): boolean {
  if (authority === undefined) return settled(ref)
  if (!hydrated(ref)) return false
  const resolve = peerResolvers.get(ref)
  return resolve ? resolve(authority) : true
}
