// interpret — what `get()` should do about a document, given only local facts.
//
// Three separate places in this package decide whether to raise a document to
// the interpret tier: a caller's `exchange.get()`, the `onEnsureDoc` hook when
// a peer announces a document we have a schema for, and `registerSchema`'s
// sweep over deferred documents. They used to apply three different rule sets,
// which is how a network event ended up able to enter interpretation without
// passing any of the guards a direct caller had to pass.
//
// This is the one rule. It reports *facts* about the document; deciding to act
// against those facts is policy, and policy stays with the caller that holds
// it (see `#getImpl` in exchange.ts, which is the only door with any).
//
// FC/IS: pure classifier here, effects in the callers — the same split
// `deriveDocStatus` and `planInitialization` use.

import type {
  DocMetadata,
  MetadataMismatch,
  ReadCapability,
} from "@kyneta/schema"
import { mismatchForInterpretation } from "@kyneta/schema"

/**
 * Which tier a document sits in, or `"absent"` when we hold nothing for it.
 *
 * Note that suspension is not one of these. A suspended document is still in
 * `interpret` — `suspend()` only sets a flag and tells peers to drop it, and
 * leaves the ref and substrate exactly as they were.
 */
export type DocPhase = "absent" | "interpret" | "replicate" | "deferred"

/** What `get()` should do about a document, given only local facts. */
export type InterpretAction =
  | { action: "return-cached" }
  | { action: "create" }
  | { action: "promote"; from: "deferred" | "replicate" }
  | { action: "refuse"; kind: "mismatch"; mismatch: MetadataMismatch }
  | { action: "refuse"; kind: "not-hydrated" }

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
 *   caller, not the document, and true of only one of the three doors. The
 *   network path holds whichever object the capability registry returned, so
 *   applying it there would reject documents that are perfectly fine.
 *
 * `hydrated` passes that same test and so belongs here: whether a document's
 * stored state has finished loading is a fact about the document, not about
 * who is asking. It only bears on the `replicate` arm — see there.
 */
export function planInterpretation(input: {
  phase: DocPhase
  /** What the caller's `BoundSchema` can read. */
  reader: ReadCapability
  /** What is known about the document; `undefined` when nothing is. */
  doc: DocMetadata | undefined
  /**
   * Whether the document's stored state has finished loading.
   *
   * Ignored by every arm but `replicate`. A `deferred` document holds nothing
   * that a load could preserve, and an `absent` one has nothing to load, so
   * neither has anything to wait for.
   */
  hydrated: boolean
}): InterpretAction {
  switch (input.phase) {
    case "absent":
      return { action: "create" }

    case "interpret":
      return { action: "return-cached" }

    case "replicate": {
      // The caller supplies the one thing a replicate document lacks — a
      // schema — so this is a transition it has the information to make.
      // `SubstrateFactory.upgrade` performs it over the same backing document,
      // so accumulated state carries across rather than being rebuilt.
      //
      // Hydration is checked before compatibility, and the order matters. A
      // caller whose document is still loading should be told to wait, not
      // told their schema is wrong — the schema may be perfectly good, and the
      // comparison is against metadata that is still settling.
      //
      // The wait is required, not cautious. `upgrade()` claims this peer's
      // stable identity, which is only safe once the document's own history
      // has finished arriving — `SubstrateFactory.createForHydration` in
      // `@kyneta/schema` states that contract and what goes wrong without it.
      if (!input.hydrated) return { action: "refuse", kind: "not-hydrated" }

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
  }
}
