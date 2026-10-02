// doc-meta — per-document facts that a bare ref cannot answer for itself.
//
// A ref knows its own contents but not the terms it was created under. The
// `SyncMode` in particular lives on the `BoundSchema`, which only the Runtime
// sees at creation time — yet `initialize` needs it, because whether
// concurrent seeds merge or overwrite is decided by `writerModel`. Both facts
// here are fields of the document's terms (`document-terms.ts`).

import type { SyncMode, WriterModel } from "@kyneta/schema"
import { termsOf } from "./document-terms.js"
import type { Authority } from "./governance.js"

/** The sync mode this document was created under, if it is known. */
export function docSyncMode(ref: object): SyncMode | undefined {
  return termsOf(ref)?.local.syncMode
}

/**
 * How many writers this document admits.
 *
 * Falls back to `"concurrent"` when unknown — deliberately the *permissive*
 * answer, because the only rule keyed on this refuses an action. An unknown
 * document is therefore treated the way a CRDT is, where concurrent seeds
 * merge rather than overwrite, instead of being blocked on a guess.
 */
export function writerModelOf(ref: object): WriterModel {
  return docSyncMode(ref)?.writerModel ?? "concurrent"
}

/**
 * The authority in force for this document.
 *
 * Completes the resolution order — call-site → `Policy.authority` → `"any"` —
 * by supplying the middle and last terms. Read through the authority term,
 * which reads the Exchange's `Policy` lazily: a policy registered after the
 * document was created still counts. `"any"` is safe as the fallback because
 * the case where a wrong guess would corrupt data is refused elsewhere: a
 * serialized-writer document may only be seeded by `"self"`.
 */
export function authorityFor(ref: object): Authority {
  return termsOf(ref)?.network()?.authority() ?? "any"
}
