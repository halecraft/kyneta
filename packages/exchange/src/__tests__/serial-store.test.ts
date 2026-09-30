// serial-store — one document's store calls run one at a time, in order.

import { describe, expect, it } from "vitest"
import { createInMemoryStore } from "../store/in-memory-store.js"
import { serialStore } from "../store/serial-store.js"
import type { Store, StoreRecord } from "../store/store.js"
import { wrapStore } from "./wrap-store.js"

const META: StoreRecord = {
  kind: "meta",
  meta: {
    replicaType: ["plain", 2, 0],
    syncMode: { writerModel: "serialized", durability: "persistent" },
    schemaHash: "h",
  },
}

/** A store whose `currentMeta` calls wait until the test releases them, and
 *  that logs when each call starts and ends. */
function heldStore(inner: Store = createInMemoryStore()) {
  const log: string[] = []
  const gates: (() => void)[] = []
  const hold = <T>(name: string, call: () => Promise<T>): Promise<T> => {
    log.push(`start ${name}`)
    return new Promise<void>(release => gates.push(release))
      .then(call)
      .finally(() => log.push(`end ${name}`))
  }
  const store = wrapStore(inner, {
    currentMeta: docId => hold(`meta ${docId}`, () => inner.currentMeta(docId)),
    delete: docId => hold(`delete ${docId}`, () => inner.delete(docId)),
    close: () => {
      log.push("close")
      return inner.close()
    },
  })
  const release = () => gates.shift()?.()
  return { store, log, release }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe("serialStore", () => {
  it("runs one document's calls in the order made, each after the last", async () => {
    const { store, log, release } = heldStore()
    const serial = serialStore(store)
    const read = serial.currentMeta("a")
    const deleted = serial.delete("a")
    await tick()
    expect(log).toEqual(["start meta a"])
    release()
    await read
    await tick()
    expect(log).toEqual(["start meta a", "end meta a", "start delete a"])
    release()
    await deleted
  })

  it("runs different documents' calls at once", async () => {
    const { store, log, release } = heldStore()
    const serial = serialStore(store)
    const a = serial.currentMeta("a")
    const b = serial.currentMeta("b")
    await tick()
    expect(log).toEqual(["start meta a", "start meta b"])
    release()
    release()
    await Promise.all([a, b])
  })

  it("a call that fails rejects its caller and the next call still runs", async () => {
    const inner = createInMemoryStore()
    const failing = wrapStore(inner, {
      currentMeta: () => Promise.reject(new Error("read failed")),
    })
    const serial = serialStore(failing)
    const read = serial.currentMeta("a")
    const mark = serial.mark("a")
    await expect(read).rejects.toThrow("read failed")
    await expect(mark).resolves.toBeNull()
  })

  it("a loadAll holds the document's queue until its iteration ends", async () => {
    const inner = createInMemoryStore()
    await inner.append("a", META, { authored: false })
    const { store, log, release } = heldStore(inner)
    const serial = serialStore(store)
    const iterator = serial.loadAll("a")[Symbol.asyncIterator]()
    await iterator.next()
    const read = serial.currentMeta("a")
    await tick()
    expect(log).toEqual([])
    await iterator.return?.()
    await tick()
    expect(log).toEqual(["start meta a"])
    release()
    await read
  })

  it("idle and close wait for every queue, then close closes the store", async () => {
    const { store, log, release } = heldStore()
    const serial = serialStore(store)
    void serial.delete("a")
    let idle = false
    void serial.idle().then(() => {
      idle = true
    })
    const closed = serial.close()
    await tick()
    expect(idle).toBe(false)
    expect(log).toEqual(["start delete a"])
    release()
    await closed
    expect(idle).toBe(true)
    expect(log).toEqual(["start delete a", "end delete a", "close"])
  })
})
