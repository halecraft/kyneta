// use-doc-status — subscribe a component to what is known about a document.
//
// This hook is deliberately thin. `docStatusFeed` carries `[CHANGEFEED]`, and
// that protocol is already the `useSyncExternalStore` contract (`.current` for
// the snapshot, `.subscribe()` returning an unsubscribe), so `useChangefeed`
// bridges the two with no store factory in between.
//
// That matters more than it looks: the status moves for two different reasons
// — data arriving, and the last truth source reporting in — and a hand-rolled
// hook would have to subscribe to both and merge them. The composed feed has
// already done that, so there is nothing left to wire here.

import { changefeed } from "@kyneta/changefeed"
import type { Authority } from "@kyneta/exchange"
import { type DocStatus, docStatusFeed } from "@kyneta/exchange"
import { useMemo } from "react"
import { useChangefeed } from "./use-changefeed.js"

/**
 * Subscribe to what is known about a document's contents.
 *
 * Returns `"pending"` while some source has yet to report, `"empty"` once
 * everything has reported and there is no data, and `"populated"` as soon as
 * there is data. Re-renders when that changes.
 *
 * The three states exist so that "we do not know yet" cannot be mistaken for
 * "there is nothing here" — the distinction that decides whether writing
 * defaults is safe.
 *
 * ```tsx
 * function Blog({ doc }: { doc: Ref<typeof BlogSchema> }) {
 *   const status = useDocStatus(doc)
 *   if (status === "pending") return <Spinner />
 *   return <Editor doc={doc} />
 * }
 * ```
 *
 * The snapshot is a plain string, so `useSyncExternalStore` bails out via
 * `Object.is` when it has not moved — no flicker as the underlying per-peer
 * state churns.
 *
 * @param doc - A document ref (or any ref within one).
 * @param opts.authority - Whose answer settles the question. Defaults to the
 *   Exchange's declared `Policy.authority`, and to `"any"` if none was set.
 */
export function useDocStatus(
  doc: object,
  opts?: { authority?: Authority },
): DocStatus {
  const authority = opts?.authority
  const feed = useMemo(
    () => changefeed(docStatusFeed(doc, authority ? { authority } : undefined)),
    [doc, authority],
  )
  return useChangefeed(feed)
}
