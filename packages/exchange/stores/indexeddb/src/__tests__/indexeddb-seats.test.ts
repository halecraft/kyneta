// indexeddb-seats — seat allocation over Web Locks, against a model of an
// origin's pages (`fake-locks.ts`) over fake-indexeddb.

import { afterAll, describe, expect, it, vi } from "vitest"
import { deleteIndexedDBStore, IndexedDBStore } from "../index.js"
import { FakeLockManager, type FakePage } from "./fake-locks.js"

let dbCounter = 0
const dbNames: string[] = []

function uniqueDbName(): string {
  const name = `kyneta-seats-${Date.now()}-${dbCounter++}`
  dbNames.push(name)
  return name
}

afterAll(async () => {
  for (const name of dbNames) await deleteIndexedDBStore(name)
})

/** The seat pool `dbName` stores, read through a connection of its own. */
function storedPool(dbName: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(dbName, 2)
    open.onsuccess = () => {
      const db = open.result
      const get = db
        .transaction("store_meta", "readonly")
        .objectStore("store_meta")
        .get("seats")
      get.onsuccess = () => {
        db.close()
        resolve((get.result as { value: unknown } | undefined)?.value)
      }
      get.onerror = () => reject(get.error)
    }
    open.onerror = () => reject(open.error)
  })
}

async function poolSize(dbName: string): Promise<number> {
  const pool = (await storedPool(dbName)) as { seats: unknown[] } | undefined
  return pool?.seats.length ?? 0
}

/** A page of `origin` with the store `dbName` open on it. */
async function load(
  origin: FakeLockManager,
  dbName: string,
): Promise<{ page: FakePage; store: IndexedDBStore }> {
  const page = origin.page()
  return { page, store: await IndexedDBStore.open(dbName, { locks: page }) }
}

/** The page unloads: its connection closes, and the browser frees its locks. */
async function unload(tab: {
  page: FakePage
  store: IndexedDBStore
}): Promise<void> {
  await tab.store.close()
  tab.page.terminate()
}

describe("IndexedDB seats", () => {
  it("a duplicated tab takes another seat", async () => {
    const origin = new FakeLockManager()
    const name = uniqueDbName()
    const first = await load(origin, name)
    const duplicate = await load(origin, name)
    expect(duplicate.store.seat.peerId).not.toBe(first.store.seat.peerId)
    expect(await poolSize(name)).toBe(2)
    await unload(first)
    await unload(duplicate)
  })

  it("a reload keeps its seat", async () => {
    const origin = new FakeLockManager()
    const name = uniqueDbName()
    const before = await load(origin, name)
    await unload(before)
    const after = await load(origin, name)
    expect(after.store.seat.peerId).toBe(before.store.seat.peerId)
    expect(after.store.seat).toMatchObject({ kind: "pooled", fence: 2 })
    expect(await poolSize(name)).toBe(1)
    await unload(after)
  })

  it("a page that dies without closing frees its seat", async () => {
    const origin = new FakeLockManager()
    const name = uniqueDbName()
    const crashed = await load(origin, name)
    crashed.page.terminate()
    const next = await load(origin, name)
    expect(next.store.seat.peerId).toBe(crashed.store.seat.peerId)
    await crashed.store.close()
    await unload(next)
  })

  it("reloads that overlap their predecessor grow the pool to 2, and no further", async () => {
    const origin = new FakeLockManager()
    const name = uniqueDbName()
    let current = await load(origin, name)
    const seen = new Set([current.store.seat.peerId])
    for (let reload = 0; reload < 4; reload++) {
      const next = await load(origin, name)
      await unload(current)
      current = next
      seen.add(current.store.seat.peerId)
    }
    expect(seen.size).toBe(2)
    expect(await poolSize(name)).toBe(2)
    await unload(current)
  })

  it("concurrent first opens take distinct seats", async () => {
    const origin = new FakeLockManager()
    const name = uniqueDbName()
    const tabs = await Promise.all([
      load(origin, name),
      load(origin, name),
      load(origin, name),
    ])
    const ids = new Set(tabs.map(tab => tab.store.seat.peerId))
    expect(ids.size).toBe(3)
    expect(await poolSize(name)).toBe(3)
    for (const tab of tabs) await unload(tab)
  })

  it("an open refuses a seat whose lock was taken outside the allocation lock", async () => {
    const origin = new FakeLockManager()
    const name = uniqueDbName()
    const first = await load(origin, name)
    const seat = first.store.seat.peerId
    await unload(first)

    // A lock on the free seat that the snapshot does not show: the governing
    // invariant is broken, and the open must not return the seat.
    const intruder = origin.page()
    const lockName = `kyneta:${name}:seat:${seat}`
    let release = () => {}
    void intruder.request(lockName, () => new Promise<void>(r => (release = r)))
    origin.hideFromQuery(lockName)

    await expect(
      IndexedDBStore.open(name, { locks: origin.page() }),
    ).rejects.toThrow(/outside its allocation lock/)
    // The refused open holds nothing.
    expect(origin.heldNames()).toEqual([lockName])
    release()
  })

  it("without Web Locks, issues a session seat and writes no pool", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const name = uniqueDbName()
    const first = await IndexedDBStore.open(name, { locks: null })
    const second = await IndexedDBStore.open(name, { locks: null })
    expect(first.seat.kind).toBe("session")
    expect(second.seat.peerId).not.toBe(first.seat.peerId)
    expect(await storedPool(name)).toBeUndefined()
    await first.close()
    await second.close()
    warn.mockRestore()
  })
})
