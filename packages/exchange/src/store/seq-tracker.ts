// seq-tracker — shared per-document monotonic sequence number tracker.
//
// Manages an in-memory cache of the highest-used seqNo per document.
// On first access for a given docId, the caller-provided `discover`
// callback resolves the current maximum from the backend (e.g. a
// reverse-iterator seek in LevelDB, or `SELECT MAX(seq)` in SQLite).
// Subsequent calls return the next value from the cache without I/O.
//
// This pattern was originally inline in LevelDBStore. Extracting it
// as a shared utility prevents duplication across store backends.

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

  reset(docId: string, value: number): void {
    this.#cache.set(docId, value)
  }

  remove(docId: string): void {
    this.#cache.delete(docId)
  }
}