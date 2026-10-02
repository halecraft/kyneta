// use-write-refusal — "may this peer write this document?"
//
// A document refuses this peer's writes when it is closed (destroyed, or its
// Exchange shut down), while a stored `json` document is still loading, when
// another seat of the same store (another tab, another process) writes a
// stored `json` document, and when a `canWrite` policy excludes this peer.
// `useText` already keeps its element read-only then; this hook is for every
// other editor, and for saying why.

import { changefeed } from "@kyneta/changefeed"
import { writeRefusalFeed } from "@kyneta/exchange"
import type { WriteRefusal } from "@kyneta/schema"
import { useMemo } from "react"
import { useChangefeed } from "./use-changefeed.js"

/**
 * Subscribe to why a document refuses this peer's writes, or `undefined`
 * while writes are allowed. The refusal is a `WriteRefusal`; narrow it with
 * `instanceof` to say why:
 * - `NotAWriterError` names the document and this peer's identity, which a
 *   `canWrite` policy rejects, and lifts if the policy changes;
 * - `WriterRefusedError` names the seat that writes the document, and stays
 *   for the session;
 * - `DocumentLoadingError` lasts until the document has loaded from its store;
 * - `DocumentClosedError` is final.
 *
 * ```tsx
 * function TitleField({ doc }: { doc: Ref<typeof NoteSchema> }) {
 *   const refusal = useWriteRefusal(doc)
 *   return (
 *     <input
 *       value={useValue(doc.title)}
 *       disabled={refusal !== undefined}
 *       title={
 *         refusal instanceof WriterRefusedError
 *           ? "Another tab is editing this note"
 *           : undefined
 *       }
 *       onChange={e => doc.title.set(e.target.value)}
 *     />
 *   )
 * }
 * ```
 *
 * @param doc - A document ref (or any ref within one).
 */
export function useWriteRefusal(doc: object): WriteRefusal | undefined {
  const feed = useMemo(() => changefeed(writeRefusalFeed(doc)), [doc])
  return useChangefeed(feed)
}
