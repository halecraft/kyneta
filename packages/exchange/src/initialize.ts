// initialize — write a document's defaults, exactly once, only when it is
// genuinely empty.
//
// This completes the design commit jj:rpuqvkyy set out when it removed the
// `seed` parameter from `SubstrateFactory.create` and `Exchange.get`. That
// commit split seeding into two halves: a predicate for "has data arrived?"
// (`isPopulated`, which shipped) and authoritative initial content applied as
// real operations after construction (which shipped as unwritten convention).
// This is the missing half, written down.
//
// Why writing through `batch()` is what makes this safe where the old `seed`
// parameter was not: seed values were baked into the store before the
// substrate existed, so they produced no operations, no version bump, and no
// log entries. Two peers seeding different values had divergent state with no
// way to merge. Here every write is an ordinary operation with version
// history, so concurrent seeds merge under the document's normal rules.

import type { WriterModel } from "@kyneta/schema"
import { batch } from "@kyneta/schema"
import { authorityFor, writerModelOf } from "./doc-meta.js"
import { type DocStatus, docStatus } from "./doc-status.js"
import type { Authority } from "./governance.js"
import { whenSettled } from "./sync.js"

// ---------------------------------------------------------------------------
// Functional core
// ---------------------------------------------------------------------------

/** What `initialize` should do, once everything that can report has. */
export type InitAction =
  | { action: "seed" }
  | { action: "skip" }
  | { action: "reject"; reason: string }

/**
 * Every guard, in one pure function.
 *
 * Kept separate from the effects so the rules are a truth table rather than
 * something only a live multi-peer scenario can exercise. That matters here
 * more than usual: these branches decide whether defaults get written, and the
 * failure mode is silent data loss rather than a crash.
 */
export function planInitialization(input: {
  /** May still be `"pending"` — see `waitOutcome`. */
  status: DocStatus
  /** Why the wait ended. */
  waitOutcome: "peer" | "local" | "offline"
  /** Already resolved by the shell: call-site → policy → `"any"`. */
  authority: Authority
  writerModel: WriterModel
}): InitAction {
  // Data is already there. Nothing to do, whatever else is true.
  if (input.status === "populated") return { action: "skip" }

  // A serialized-writer document (json.bind / SYNC_AUTHORITATIVE) has exactly
  // one writer by construction, so concurrent seeds cannot merge — they
  // overwrite. Rather than lose that race at runtime, refuse: a non-authority
  // peer trying to seed one is a topology mistake the schema binding lets us
  // detect up front.
  if (input.writerModel === "serialized" && input.authority !== "self") {
    return {
      action: "reject",
      reason:
        "Refusing to seed a serialized-writer document from a peer that is not the authority. " +
        "Concurrent seeds cannot merge on this document type, so only the authoritative peer " +
        'may write defaults. Declare `policy: { authority: "self" }` on that peer, and let ' +
        "clients wait and read.",
    }
  }

  if (input.status === "empty") return { action: "seed" }

  // Still `"pending"` — we never heard from the authority. Seeding is allowed
  // only when the caller explicitly asked to stop waiting, and even then it is
  // a decision to act under uncertainty rather than a claim that the document
  // is empty. `docStatus` still reads `"pending"`, truthfully; the choice to
  // proceed lives here, where it is visible.
  if (input.waitOutcome === "offline") return { action: "seed" }

  return { action: "skip" }
}

// ---------------------------------------------------------------------------
// Imperative shell
// ---------------------------------------------------------------------------

/**
 * In-flight initializations, so concurrent callers collapse to one write.
 *
 * Keyed on the document ref, like every other per-document registry here.
 * Without this, React strict-mode's deliberate double-invocation would seed
 * twice, and so would any two components that both want defaults present.
 */
const inFlight = new WeakMap<object, Promise<"created" | "loaded">>()

/**
 * Write `seed` into the document if — and only if — it is genuinely empty.
 *
 * Waits for every truth source first (stored data finishing its load, the
 * authority answering), then decides. Returns `"created"` if it wrote the
 * defaults and `"loaded"` if the document already had data.
 *
 * With no options this is correct for a CRDT document in the usual
 * hub-and-spoke topology, and for an authoritative document once that peer has
 * declared `policy: { authority: "self" }` once at construction.
 *
 * ```ts
 * // Server — authoritative, loads from disk, never waits for a client
 * const exchange = new Exchange({ id: "server", stores: [...],
 *                                 authority: "self" })
 * await initialize(doc, d => d.set({ title: "Untitled", posts: [] }))
 *
 * // Client — waits for the server's answer before deciding
 * await initialize(doc, seedDefaults, { offlineAfter: 3000 })
 * ```
 *
 * The seed is an ordinary local write: it broadcasts, persists, and passes the
 * same governance gates as any other mutation.
 *
 * @throws If the document's store could not be read (via `whenSettled`), or if
 *   a non-authoritative peer tries to seed a serialized-writer document.
 */
export function initialize<T = unknown>(
  doc: object,
  seed: (d: T) => void,
  opts?: { authority?: Authority; offlineAfter?: number },
): Promise<"created" | "loaded"> {
  const existing = inFlight.get(doc)
  if (existing) return existing

  const run = (async (): Promise<"created" | "loaded"> => {
    // GATHER — wait for every source, then look. Reading the status *after*
    // the wait is what makes the answer meaningful; reading it before would
    // just observe "pending".
    const { via } = await whenSettled(doc, {
      ...(opts?.offlineAfter !== undefined
        ? { offlineAfter: opts.offlineAfter }
        : {}),
    })

    // Resolution order: call-site → Policy.authority → "any".
    const authority = opts?.authority ?? authorityFor(doc)

    // PLAN — all the rules, none of the effects.
    const decision = planInitialization({
      status: docStatus(doc, opts?.authority ? { authority } : undefined),
      waitOutcome: via,
      authority,
      writerModel: writerModelOf(doc),
    })

    // EXECUTE
    if (decision.action === "reject") throw new Error(decision.reason)
    if (decision.action === "skip") return "loaded"

    batch(doc as never, seed as never, { origin: "init" })
    return "created"
  })()

  inFlight.set(doc, run)
  // Clear on failure so a transient store error can be retried; a successful
  // run stays cached, which is what makes repeat calls cheap and idempotent.
  run.catch(() => inFlight.delete(doc))
  return run
}
