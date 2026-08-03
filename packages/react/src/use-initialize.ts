// use-initialize — write a document's defaults once, from a component.
//
// The effect fires on mount and the work is idempotent per document, so React
// strict-mode's deliberate double-invocation, a remount, or two components
// both wanting defaults all collapse to a single seed write. That guarantee
// lives in `initialize` itself (a per-document promise cache), not here — this
// hook is only the trigger.

import type { Authority } from "@kyneta/exchange"
import { type DocStatus, initialize } from "@kyneta/exchange"
import { useEffect, useRef } from "react"
import { useDocStatus } from "./use-doc-status.js"

/**
 * Ensure a document has its defaults, and report what is known about it.
 *
 * Waits for every truth source before deciding, so it will not overwrite a
 * store that is still loading or a document the authority has yet to describe.
 * The returned status is live: `"pending"` while waiting, then `"populated"`
 * once the document has data — whether that data was seeded here or arrived
 * from storage or a peer.
 *
 * ```tsx
 * function Blog({ doc }: { doc: Ref<typeof BlogSchema> }) {
 *   const status = useInitialize(doc, d => d.set({ title: "Untitled", posts: [] }))
 *   if (status === "pending") return <Spinner />
 *   return <Editor doc={doc} />
 * }
 * ```
 *
 * Seeding failures are surfaced through `onError` rather than thrown, because
 * a rejected promise inside an effect has nowhere useful to go. The two causes
 * worth handling are an unreadable store and a refusal to seed a
 * serialized-writer document from a non-authoritative peer.
 *
 * @param doc - A document ref.
 * @param seed - Applies the defaults. Runs at most once per document.
 * @param opts.authority - Whose answer settles "is this empty?".
 * @param opts.offlineAfter - Seed anyway if no authority answers within this
 *   many milliseconds. Applies to the network wait only, never to storage.
 * @param opts.onError - Called if initialization fails.
 */
export function useInitialize<T = unknown>(
  doc: object,
  seed: (d: T) => void,
  opts?: {
    authority?: Authority
    offlineAfter?: number
    onError?: (error: unknown) => void
  },
): DocStatus {
  const { authority, offlineAfter, onError } = opts ?? {}

  // Hold the latest callbacks in refs rather than in the dependency list.
  // Both are almost always inline arrows, so a fresh identity every render
  // would re-run the effect every render. The document is the identity that
  // actually matters here. Same technique as `useTracked`'s `thunkRef`.
  const seedRef = useRef(seed)
  seedRef.current = seed
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  useEffect(() => {
    initialize(doc, (d: T) => seedRef.current(d), {
      ...(authority ? { authority } : {}),
      ...(offlineAfter !== undefined ? { offlineAfter } : {}),
    }).catch(error => onErrorRef.current?.(error))
  }, [doc, authority, offlineAfter])

  return useDocStatus(doc, authority ? { authority } : undefined)
}
