// use-write-refusal — "may this peer write this document?"
//
// A stored `json` document refuses this peer's writes when another seat of
// the same store (another tab, another process) writes it. `useText` already
// keeps its element read-only then; this hook is for every other editor, and
// for saying why.

import { changefeed } from "@kyneta/changefeed"
import { type WriterRefusedError, writeRefusalFeed } from "@kyneta/exchange"
import { useMemo } from "react"
import { useChangefeed } from "./use-changefeed.js"

/**
 * Subscribe to why a document refuses this peer's writes: a
 * `WriterRefusedError` naming the seat that writes it, or `undefined` while
 * writes are allowed. Once set it stays set for the session.
 *
 * ```tsx
 * function TitleField({ doc }: { doc: Ref<typeof NoteSchema> }) {
 *   const refusal = useWriteRefusal(doc)
 *   return (
 *     <input
 *       value={useValue(doc.title)}
 *       disabled={refusal !== undefined}
 *       title={refusal ? "Another tab is editing this note" : undefined}
 *       onChange={e => doc.title.set(e.target.value)}
 *     />
 *   )
 * }
 * ```
 *
 * @param doc - A document ref (or any ref within one).
 */
export function useWriteRefusal(doc: object): WriterRefusedError | undefined {
  const feed = useMemo(() => changefeed(writeRefusalFeed(doc)), [doc])
  return useChangefeed(feed)
}
