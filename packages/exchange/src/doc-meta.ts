// doc-meta — per-document facts that a bare ref cannot answer for itself.
//
// A ref knows its own contents but not the terms it was created under. The
// `SyncMode` in particular lives on the `BoundSchema`, which only the Runtime
// sees at creation time — yet `initialize` needs it, because whether
// concurrent seeds merge or overwrite is decided by `writerModel`.
//
// Keyed by ref in a WeakMap, the same pattern as `syncRefMap` in `sync.ts` and
// the settle registry: out-of-band per-document state that must not keep the
// document alive.

import type { SyncMode, WriterModel } from "@kyneta/schema"
import type { Authority } from "./governance.js"

const docSyncModes = new WeakMap<object, SyncMode>()

/**
 * Record the sync mode a document was created under.
 *
 * @internal Called by `Runtime` as an interpreted document is created.
 */
export function registerDocSyncMode(ref: object, syncMode: SyncMode): void {
  docSyncModes.set(ref, syncMode)
}

/** The sync mode this document was created under, if it is known. */
export function docSyncMode(ref: object): SyncMode | undefined {
  return docSyncModes.get(ref)
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
  return docSyncModes.get(ref)?.writerModel ?? "concurrent"
}

// ---------------------------------------------------------------------------
// Declared authority
// ---------------------------------------------------------------------------

/** Resolves the Exchange's declared authority, read lazily. */
const docAuthorities = new WeakMap<object, () => Authority>()

/**
 * Record how to resolve the declared authority for a document.
 *
 * Read lazily rather than captured, because `Policy` is a mutable registry —
 * a policy registered after the document was created still counts.
 *
 * @internal Called by `Exchange` as a document is created.
 */
export function registerDocAuthority(
  ref: object,
  resolve: () => Authority,
): void {
  docAuthorities.set(ref, resolve)
}

/**
 * The authority in force for this document.
 *
 * Completes the resolution order — call-site → `Policy.authority` → `"any"` —
 * by supplying the middle and last terms. `"any"` is safe as the fallback
 * because the case where a wrong guess would corrupt data is refused
 * elsewhere: a serialized-writer document may only be seeded by `"self"`.
 */
export function authorityFor(ref: object): Authority {
  return docAuthorities.get(ref)?.() ?? "any"
}
