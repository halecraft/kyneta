// seq-tracker — per-document monotonic sequence numbers, kept in memory.
//
// On first access for a given docId, the caller-provided `discover`
// callback resolves the current maximum from disk (a reverse-iterator seek).
// Subsequent calls return the next value from the cache without I/O.
//
// A cache is sound only for a store with one writer. LevelDB is one:
// `classic-level` refuses a second open of a directory. Stores whose storage
// several instances open assign positions from the storage instead.

// ---------------------------------------------------------------------------
// SeqNoTracker
// ---------------------------------------------------------------------------

/** Per-document monotonic sequence number tracker. */
export class SeqNoTracker {
  readonly #cache = new Map<string, number>()

  /** `discover` is called at most once per docId (to seed the cache). */
  async next(
    docId: string,
    discover: () => Promise<number | null>,
  ): Promise<number> {
    const cached = this.#cache.get(docId)
    if (cached !== undefined) {
      const next = cached + 1
      this.#cache.set(docId, next)
      return next
    }

    const maxSeq = await discover()
    const next = (maxSeq ?? -1) + 1
    this.#cache.set(docId, next)
    return next
  }

  remove(docId: string): void {
    this.#cache.delete(docId)
  }
}
