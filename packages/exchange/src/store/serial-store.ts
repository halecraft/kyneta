// serial-store — a Store whose calls on one document run one at a time.
//
// The Runtime calls its Store sequentially per document, but a Store need not
// finish one call before a later one starts: a pooled backend (Postgres,
// Prisma) may run them at once. Without an order, a destroy's `delete` can
// finish before a write already sent, which then stores the document again,
// and a load issued after the `delete` can read what it deletes.
//
// The order is kept here, beneath every Runtime operation, one Store call at
// a time. A queued call waits only for earlier Store calls, and a Store call
// never calls back into the Runtime, so no call can wait for one queued after
// it: the queue cannot deadlock.

import type { DocId, PeerId } from "@kyneta/transport"
import type {
  Store,
  StoreMark,
  StoreMeta,
  StoreRecord,
  WriteOptions,
} from "./store.js"

/** A Store whose calls on one document run one at a time, in the order they
 *  were made. */
export interface SerialStore extends Store {
  /** Resolves when every document's queue is empty. */
  idle(): Promise<void>
}

/**
 * `store`, with each document's calls queued. Calls on different documents
 * run concurrently. A call that fails rejects its caller and does not stop
 * the queue.
 */
export function serialStore(store: Store): SerialStore {
  const tails = new Map<DocId, Promise<void>>()

  const queued = <T>(docId: DocId, call: () => Promise<T>): Promise<T> => {
    const result = (tails.get(docId) ?? Promise.resolve()).then(call)
    const tail = result.then(
      () => {},
      () => {},
    )
    tails.set(docId, tail)
    void tail.then(() => {
      if (tails.get(docId) === tail) tails.delete(docId)
    })
    return result
  }

  const idle = async (): Promise<void> => {
    while (tails.size > 0) await Promise.all(tails.values())
  }

  return {
    seat: store.seat,
    append: (docId: DocId, record: StoreRecord, options: WriteOptions) =>
      queued(docId, () => store.append(docId, record, options)),
    compact: (
      docId: DocId,
      records: StoreRecord[],
      through: StoreMark | null,
      options: WriteOptions,
    ) => queued(docId, () => store.compact(docId, records, through, options)),
    delete: (docId: DocId) => queued(docId, () => store.delete(docId)),
    mark: (docId: DocId): Promise<StoreMark | null> =>
      queued(docId, () => store.mark(docId)),
    writerOf: (docId: DocId): Promise<PeerId | null> =>
      queued(docId, () => store.writerOf(docId)),
    currentMeta: (docId: DocId): Promise<StoreMeta | null> =>
      queued(docId, () => store.currentMeta(docId)),
    // The whole iteration is one queued call, from the first `next()` until
    // the iteration ends or is returned.
    async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
      let finish: () => void = () => {}
      const ended = new Promise<void>(resolve => {
        finish = resolve
      })
      await new Promise<void>(start => {
        void queued(docId, () => {
          start()
          return ended
        })
      })
      try {
        yield* store.loadAll(docId)
      } finally {
        finish()
      }
    },
    listDocIds: (prefix?: string) => store.listDocIds(prefix),
    idle,
    async close() {
      await idle()
      await store.close()
    },
  }
}
