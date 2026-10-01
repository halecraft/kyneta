// document-key — the identity per-document state is stored under.
//
// Readiness, sync mode and the sync handle belong to a document, but callers
// hold refs, and often not the root one: `useText(doc.title)`,
// `useDocStatus(doc.items)`. Every ref in a document carries the same context
// under `[TRANSACT]`, so that context names the document from any of its refs.
// A value without one, which is no schema ref, stands for itself.

import { hasTransact, TRANSACT } from "@kyneta/schema"

/** The document a ref belongs to, as a key: its shared context, or the ref. */
export function documentKey(ref: object): object {
  return hasTransact(ref) ? ref[TRANSACT] : ref
}

/**
 * A `WeakMap` from documents to `V`, read and written through any ref within
 * the document. Weak, so the registry never keeps a document alive.
 */
export interface DocumentMap<V> {
  get(ref: object): V | undefined
  set(ref: object, value: V): void
}

export function createDocumentMap<V>(): DocumentMap<V> {
  const entries = new WeakMap<object, V>()
  return {
    get: ref => entries.get(documentKey(ref)),
    set: (ref, value) => {
      entries.set(documentKey(ref), value)
    },
  }
}
