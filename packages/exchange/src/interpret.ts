// interpret — what `get()` should do about a document, given only local facts.
//
// The lifecycle program (`lifecycle-program.ts`) asks this for every `get`,
// whichever door it came through: a caller's `get` or `open`, the `onEnsureDoc`
// hook when a peer announces a document we have a schema for, and
// `registerSchema`'s sweep over deferred documents. The Exchange asks it too,
// for a deferred document, against the metadata the synchronizer holds and the
// Runtime does not.
//
// It reports *facts* about the document; deciding to act against those facts
// is policy, and policy stays with the caller that holds it (see `#getImpl` in
// exchange.ts, which is the only door with any).

import type {
  DocMetadata,
  MetadataMismatch,
  ReadCapability,
} from "@kyneta/schema"
import { mismatchForInterpretation } from "@kyneta/schema"
import type { Hydration } from "./document-terms.js"

/**
 * Which tier a document sits in, `"absent"` when we hold nothing for it,
 * `"deferred"` when a peer announced it, or `"unloaded"` when it is out of
 * memory and kept in the store.
 *
 * Neither suspension nor the load's progress is one of these. A suspended
 * document is still in `interpret`: `suspend()` only sets a flag and tells
 * peers to drop it, and leaves the ref and substrate exactly as they were. A
 * document still loading is in its tier already; `planInterpretation` is told
 * of the load separately. An unloaded document is `"unloaded"` whichever tier
 * it had.
 */
export type DocPhase =
  | "absent"
  | "interpret"
  | "replicate"
  | "deferred"
  | "unloaded"

/**
 * Where a document's load stands, or `none` when nothing is loading: a
 * document that is absent, deferred or unloaded.
 */
export type LoadStatus = Hydration | { readonly status: "none" }

/** What `get()` should do about a document, given only local facts. */
export type InterpretAction =
  | { action: "return-cached" }
  | { action: "create" }
  | { action: "promote"; from: "deferred" | "replicate" }
  /** Load it again from the store, under the caller's schema. */
  | { action: "load" }
  | { action: "refuse"; kind: "mismatch"; mismatch: MetadataMismatch }
  | { action: "refuse"; kind: "not-hydrated" }
  | { action: "refuse"; kind: "load-failed"; error: unknown }

/**
 * Decide what to do about a document, from its phase and what is known of it.
 *
 * Every parameter is a fact about the *document*. Three things a reader might
 * expect to find here are missing on purpose, and it is easier to add them
 * back than to notice later why they were left out:
 *
 * - **whether it is suspended** — not a fact about readability, so there is no
 *   branch here that could make an ordinary read change what peers see.
 * - **which door is asking** — that would make this answer "what is true of
 *   this document *for you*", two questions in one signature. Where callers
 *   genuinely differ, the difference is written at the caller.
 * - **whether the `BoundSchema` is the same object** — a fact about the
 *   caller, not the document. What a caller needs to be told is whether its
 *   schema can read what is there, and `reader` already says that. Object
 *   identity is a different question with a coincidentally similar answer:
 *   too strict (two `bind()` calls over one schema are interchangeable) and
 *   too weak (holding on to an object proves nothing about compatibility).
 *
 * `hydration` passes that same test and so belongs here: how far a document's
 * stored state has loaded is a fact about the document, not about who is
 * asking. It only bears on the `replicate` arm — see there.
 */
export function planInterpretation(input: {
  phase: DocPhase
  /** What the caller's `BoundSchema` can read. */
  reader: ReadCapability
  /** What is known about the document; `undefined` when nothing is. */
  doc: DocMetadata | undefined
  /**
   * How far the document's stored state has loaded.
   *
   * Ignored by every arm but `replicate`. A `deferred` document holds nothing
   * that a load could preserve, an `absent` one has nothing to load, and an
   * `unloaded` one is held entirely by the store, so none has anything to
   * wait for.
   */
  hydration: LoadStatus
}): InterpretAction {
  switch (input.phase) {
    case "absent":
      return { action: "create" }

    case "interpret": {
      // Being open is no exemption: the caller's schema still has to be able
      // to read what is there. Reaching a cached ref is this phase's answer,
      // not a reason to skip the question — and returning unconditionally is
      // what pushed the doors into comparing `BoundSchema` object identity.
      const mismatch =
        input.doc && mismatchForInterpretation(input.reader, input.doc)
      return mismatch
        ? { action: "refuse", kind: "mismatch", mismatch }
        : { action: "return-cached" }
    }

    case "replicate": {
      // The caller supplies the one thing a replicate document lacks — a
      // schema — so this is a transition it has the information to make.
      // `SubstrateFactory.upgrade` performs it over the same backing document,
      // so accumulated state carries across rather than being rebuilt.
      //
      // The load is checked before compatibility, and the order matters. A
      // caller whose document is still loading should be told to wait, not
      // told their schema is wrong — the schema may be perfectly good, and the
      // comparison is against metadata that is still settling.
      //
      // The wait is required, not cautious. `upgrade()` claims this peer's
      // stable identity, which is only safe once the document's own history
      // has finished arriving — `SubstrateFactory.createForHydration` in
      // `@kyneta/schema` states that contract and what goes wrong without it.
      // A load that failed never finishes arriving, so it refuses for good,
      // with the load's error.
      const { hydration } = input
      if (hydration.status === "pending") {
        return { action: "refuse", kind: "not-hydrated" }
      }
      if (hydration.status === "failed") {
        return { action: "refuse", kind: "load-failed", error: hydration.error }
      }

      const mismatch =
        input.doc && mismatchForInterpretation(input.reader, input.doc)
      return mismatch
        ? { action: "refuse", kind: "mismatch", mismatch }
        : { action: "promote", from: "replicate" }
    }

    case "deferred": {
      // `undefined` promotes rather than refuses: nothing contradicts the
      // request. A blanket sweep that genuinely knows nothing about a document
      // should skip it, but that is the sweep's own guard to keep — it is
      // defensive coding about a synchronizer lookup, not a rule about
      // documents.
      const mismatch =
        input.doc && mismatchForInterpretation(input.reader, input.doc)
      return mismatch
        ? { action: "refuse", kind: "mismatch", mismatch }
        : { action: "promote", from: "deferred" }
    }

    case "unloaded": {
      // The metadata is our own, recorded when it was held, so a mismatch
      // refuses on every axis: none of the deferred exception's reasons
      // applies, since no peer's announcement is involved.
      const mismatch =
        input.doc && mismatchForInterpretation(input.reader, input.doc)
      return mismatch
        ? { action: "refuse", kind: "mismatch", mismatch }
        : { action: "load" }
    }
  }
}
