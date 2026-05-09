// async-queue — push/pull bridge for async iteration.
//
// A general-purpose adapter that buffers push-based events and yields
// them through the async iterator protocol. Used by Line to bridge
// the changefeed subscription to the pull-based async generator.

/**
 * A push/pull bridge for async iteration.
 *
 * Push values with `push(value)`. Pull values with `for await (const v of queue)`.
 * When no values are buffered, the iterator parks a promise that resolves
 * on the next `push()`. `close()` completes the iterator.
 */
export class AsyncQueue<T> {
  #buffer: T[] = []
  #waiters: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

  /** Push a value. If a consumer is waiting, resolve it immediately. */
  push(value: T): void {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
    } else {
      this.#buffer.push(value)
    }
  }

  /** Close the queue. Resolves all parked consumers with `{ done: true }`. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters) {
      waiter({ value: undefined as any, done: true })
    }
    this.#waiters.length = 0
  }

  /** Whether the queue has been closed. */
  get closed(): boolean {
    return this.#closed
  }

  #next(): Promise<IteratorResult<T>> {
    if (this.#buffer.length > 0) {
      const value = this.#buffer.shift()
      if (value === undefined) {
        throw new Error(
          "async-queue invariant: buffer reported non-empty but shift returned undefined",
        )
      }
      return Promise.resolve({ value, done: false })
    }
    if (this.#closed) {
      return Promise.resolve({ value: undefined as any, done: true })
    }
    return new Promise<IteratorResult<T>>(resolve => {
      this.#waiters.push(resolve)
    })
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return {
      next: () => this.#next(),
      return: async () => {
        this.close()
        return { value: undefined as any, done: true }
      },
      [Symbol.asyncIterator]() {
        return this
      },
    }
  }
}
