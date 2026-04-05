import { describe, expect, it } from "vitest"
import { AsyncQueue } from "../async-queue.js"

describe("AsyncQueue", () => {
  it("push then pull — buffered values yield in order", async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.push(2)
    q.close()

    const values: number[] = []
    for await (const v of q) {
      values.push(v)
    }
    expect(values).toEqual([1, 2])
  })

  it("pull then push — parked waiter resolves on push", async () => {
    const q = new AsyncQueue<number>()
    const iter = q[Symbol.asyncIterator]()

    // iter.next() parks — no value buffered yet
    const pending = iter.next()
    q.push(1)

    const result = await pending
    expect(result).toEqual({ value: 1, done: false })
  })

  it("close() completes the iterator", async () => {
    const q = new AsyncQueue<number>()
    const iter = q[Symbol.asyncIterator]()

    q.close()

    const result = await iter.next()
    expect(result.done).toBe(true)
  })

  it("close() resolves parked waiters with done", async () => {
    const q = new AsyncQueue<number>()
    const iter = q[Symbol.asyncIterator]()

    const pending = iter.next()
    q.close()

    const result = await pending
    expect(result.done).toBe(true)
  })

  it("push() after close() is a no-op", async () => {
    const q = new AsyncQueue<number>()
    q.push(1)
    q.close()
    q.push(2) // should be silently ignored

    expect(q.closed).toBe(true)

    const values: number[] = []
    for await (const v of q) {
      values.push(v)
    }
    // only the pre-close value is present
    expect(values).toEqual([1])
  })

  it("interleaved push/pull — values arrive in order", async () => {
    const q = new AsyncQueue<number>()
    const iter = q[Symbol.asyncIterator]()

    q.push(1)
    expect(await iter.next()).toEqual({ value: 1, done: false })

    const pending2 = iter.next()
    q.push(2)
    expect(await pending2).toEqual({ value: 2, done: false })

    q.push(3)
    q.push(4)
    expect(await iter.next()).toEqual({ value: 3, done: false })
    expect(await iter.next()).toEqual({ value: 4, done: false })

    q.close()
    expect(await iter.next()).toEqual({ value: undefined, done: true })
  })
})
