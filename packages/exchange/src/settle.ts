// settle — "have all of this document's truth sources reported yet?"
//
// A document can sit at one of several layers, and each layer adds exactly one
// thing worth waiting for:
//
//   createDoc(bound)                — nothing to wait for
//   + Runtime with stores           — the saved data has to finish loading
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
// Positive evidence needs no such gate — see `isPopulated` in @kyneta/schema,
// which flips as soon as any source delivers data.
//
// A term is a `[CHANGEFEED]` carrier rather than a bespoke interface. That is
// the codebase's universal reactive contract (see packages/changefeed/
// TECHNICAL.md), so a term has the same shape as `populatedFeed(ref)` and
// composes with `useChangefeed`, `@kyneta/reactive`, and `@kyneta/index`
// without any new plumbing.

import type {
  ChangefeedProtocol,
  Changeset,
  HasChangefeed,
} from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"

// ---------------------------------------------------------------------------
// The term protocol
// ---------------------------------------------------------------------------

/**
 * One layer's answer to "has my truth source reported for this document?".
 *
 * Call it for the current boolean; subscribe via `[CHANGEFEED]` to be told
 * when it changes. Terms are monotonic in practice — a source that has
 * reported does not un-report — but nothing here depends on that.
 */
export type SettleTerm = (() => boolean) & HasChangefeed<boolean>

/**
 * Build a `SettleTerm` from a reader and a subscribe function.
 *
 * Follows `attachIsPopulated` in `@kyneta/schema`'s `with-changefeed.ts`: a
 * plain function with the protocol attached under `[CHANGEFEED]` as a
 * non-enumerable property. Using the same construction keeps settle terms
 * indistinguishable from every other carrier in the codebase.
 *
 * @internal
 */
export function makeSettleTerm(
  read: () => boolean,
  subscribe: (onChange: () => void) => () => void,
): SettleTerm {
  const protocol: ChangefeedProtocol<boolean, never> = {
    get current(): boolean {
      return read()
    },
    subscribe(callback: (changeset: Changeset<never>) => void): () => void {
      // The payload carries no changes — a settle term is a bare boolean, and
      // subscribers only care that it moved.
      return subscribe(() => callback({ changes: [] }))
    },
  }
  const term = (() => read()) as SettleTerm
  Object.defineProperty(term, CHANGEFEED, {
    value: protocol,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return term
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Terms attached to a document, keyed by its root ref.
 *
 * A `WeakMap` for the same reason `syncRefMap` in `sync.ts` is one: the
 * registry must not keep a document alive, and the ref is the natural identity
 * for "which document is this?". Mirroring that existing pattern also means
 * there is one way to attach out-of-band per-document state, not two.
 */
const settleTerms = new WeakMap<object, SettleTerm[]>()

/**
 * Attach a settle term to a document.
 *
 * @internal Called by `Runtime` (the storage term) and `Exchange` (the peer
 * term) as a document is created. Applications never call this.
 */
export function registerSettleTerm(ref: object, term: SettleTerm): void {
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
export function termsFor(ref: object): readonly SettleTerm[] {
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
const hydrationTerms = new WeakMap<object, SettleTerm>()

/**
 * Register the storage term for a document: it joins the conjunction *and*
 * becomes individually addressable via {@link hydrated}.
 *
 * @internal Called by `Runtime` as a document is created.
 */
export function registerHydrationTerm(ref: object, term: SettleTerm): void {
  hydrationTerms.set(ref, term)
  registerSettleTerm(ref, term)
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
  const term = hydrationTerms.get(ref)
  return term ? term() : true
}

/** Observable form of {@link hydrated}. A callable, so never put it in an `if`. */
export function hydratedFeed(ref: object): SettleTerm {
  return (
    hydrationTerms.get(ref) ??
    makeSettleTerm(
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
export function settledFeed(ref: object): SettleTerm {
  // Read `termsFor` on every access rather than capturing it: a term can be
  // registered after this feed is created (the Exchange's peer term is added
  // after the Runtime's storage term), and a captured array would miss it.
  return makeSettleTerm(
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
