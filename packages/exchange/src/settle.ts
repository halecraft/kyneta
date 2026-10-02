// settle — "have all of this document's truth sources reported yet?"
//
// A document can sit at one of several layers, and each layer adds exactly one
// thing worth waiting for:
//
//   createDoc(bound)                — nothing to wait for
//   + Runtime with a store          — the saved data has to finish loading
//   + Exchange with transports      — the authoritative peer has to answer
//
// Each layer contributes one **settle term** to the document's terms
// (`document-terms.ts`): the Runtime its hydration, the Exchange its peer
// term. A document is settled when both have reported, and a term a layer
// does not contribute has nothing to report.
//
// No terms at all is the empty conjunction, and an empty conjunction is
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
// A term is a `Feed`, the codebase's universal reactive contract (see
// packages/changefeed/TECHNICAL.md), so a term has the same shape as
// `populatedFeed(ref)` and composes with `useChangefeed`, `@kyneta/reactive`,
// and `@kyneta/index` without any new plumbing.

import { CHANGEFEED, type Feed, signalFeed } from "@kyneta/changefeed"
import {
  constantFeed,
  type Hydration,
  networkTermFeed,
  type Peer,
  termsOf,
} from "./document-terms.js"
import type { Authority } from "./governance.js"

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
  const terms = termsOf(ref)
  if (terms === undefined) return true
  return (
    terms.local.hydration().status === "loaded" &&
    (terms.network()?.peer().settled ?? true)
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
  const terms = termsOf(ref)
  if (terms === undefined) return constantFeed(true)
  // The Exchange attaches the peer term after the local terms, so a
  // subscriber that came first follows it from when it arrives.
  const peer = networkTermFeed<Peer | undefined>(
    terms,
    network => network.peer,
    undefined,
  )
  return signalFeed(
    () => settled(ref),
    onChange => {
      const stopHydration = terms.local.hydration[CHANGEFEED].subscribe(() =>
        onChange(),
      )
      const stopPeer = peer[CHANGEFEED].subscribe(() => onChange())
      return () => {
        stopHydration()
        stopPeer()
      }
    },
  )
}

// ---------------------------------------------------------------------------
// The storage term, addressable on its own
// ---------------------------------------------------------------------------
//
// "Has my store finished loading?" is a question a server genuinely wants to
// ask — it is the gate for deciding whether a document is safe to initialise
// — and answering it through the whole conjunction would also wait on peers,
// which an authoritative peer has no reason to do.

/** The hydration of the document `ref` belongs to, `loaded` when nothing
 *  loads it. */
function hydrationOf(ref: object): Hydration {
  return termsOf(ref)?.local.hydration() ?? LOADED
}

const LOADED: Hydration = { status: "loaded" }

/**
 * The error from this document's failed load, or `undefined` if the load
 * succeeded, is still running, or there was nothing to load. A document
 * closed while it loaded failed with its `DocumentClosedError`.
 */
export function hydrationError(ref: object): unknown | undefined {
  const hydration = hydrationOf(ref)
  return hydration.status === "failed" ? hydration.error : undefined
}

/**
 * Resolve once this document's stored data has finished loading; reject if the
 * load failed, or if the document closed before it finished (with its
 * `DocumentClosedError`).
 *
 * Deliberately takes no timeout. A missing peer may genuinely never arrive, so
 * giving up on one is the only option available — but a slow disk is a local
 * fault we can observe, and abandoning the wait would mean proceeding as
 * though the document were empty. That is how defaults end up written over
 * data we merely failed to read.
 */
export function whenHydrated(ref: object): Promise<void> {
  const term = termsOf(ref)?.local.hydration
  if (term === undefined) return Promise.resolve() // nothing to load
  return new Promise<void>((resolve, reject) => {
    const settle = (hydration: Hydration): boolean => {
      if (hydration.status === "pending") return false
      if (hydration.status === "failed") reject(hydration.error)
      else resolve()
      return true
    }
    if (settle(term())) return
    const stop = term[CHANGEFEED].subscribe(() => {
      if (settle(term())) stop()
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
  return hydrationOf(ref).status === "loaded"
}

/** Observable form of {@link hydrated}. A callable, so never put it in an `if`. */
export function hydratedFeed(ref: object): Feed<boolean> {
  const term = termsOf(ref)?.local.hydration
  if (term === undefined) return constantFeed(true)
  return signalFeed(
    () => term().status === "loaded",
    onChange => term[CHANGEFEED].subscribe(() => onChange()),
  )
}

// ---------------------------------------------------------------------------
// Authority override
// ---------------------------------------------------------------------------

/**
 * {@link settled}, but with the authority decided by the caller rather than by
 * the Exchange's policy.
 *
 * The resolution order this completes is: call-site → `Policy.authority` →
 * `"any"`. The call-site override is what makes runtime leader election
 * expressible — a peer can compute who the leader is from the current peer set
 * and pass it in, which a policy fixed at construction could never express.
 *
 * Only the peer term depends on the authority, so it is asked through its
 * `resolve` rather than read.
 */
export function settledWith(ref: object, authority?: Authority): boolean {
  if (authority === undefined) return settled(ref)
  if (!hydrated(ref)) return false
  return termsOf(ref)?.network()?.peer().resolve(authority) ?? true
}
