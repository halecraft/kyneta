// pg-adapter — non-gated unit tests for the fromPool / fromClient adapters.
//
// These run without KYNETA_PG_URL: they assert the transaction control flow
// (checkout / BEGIN / COMMIT / ROLLBACK / release) against lightweight fakes,
// locking the behaviour that used to live in PostgresStore's connection-type
// discriminant — now resolved at the call site by which factory is used.

import type { Client, Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { fromClient, fromPool } from "../index.js"

describe("fromClient", () => {
  it("runs a transaction inline: BEGIN → fn → COMMIT", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return { rows: [] }
      }),
    } as unknown as Client

    const result = await fromClient(client).transaction(async q => {
      await q.query("INSERT 1")
      return "done"
    })

    expect(result).toBe("done")
    expect(calls).toEqual(["BEGIN", "INSERT 1", "COMMIT"])
  })

  it("ROLLBACK + rethrow when fn throws", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return { rows: [] }
      }),
    } as unknown as Client

    await expect(
      fromClient(client).transaction(async q => {
        await q.query("INSERT 1")
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(calls).toEqual(["BEGIN", "INSERT 1", "ROLLBACK"])
  })
})

describe("fromPool", () => {
  it("checks out a client, BEGIN/COMMIT on it, releases in finally", async () => {
    const calls: string[] = []
    const release = vi.fn()
    const poolClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return { rows: [] }
      }),
      release,
    }
    const connect = vi.fn(async () => poolClient)
    const pool = { connect, query: vi.fn() } as unknown as Pool

    const result = await fromPool(pool).transaction(async q => {
      await q.query("INSERT 1")
      return 42
    })

    expect(result).toBe(42)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(["BEGIN", "INSERT 1", "COMMIT"])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("ROLLBACK + release + rethrow when fn throws", async () => {
    const calls: string[] = []
    const release = vi.fn()
    const poolClient = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return { rows: [] }
      }),
      release,
    }
    const pool = {
      connect: vi.fn(async () => poolClient),
      query: vi.fn(),
    } as unknown as Pool

    await expect(
      fromPool(pool).transaction(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(calls).toEqual(["BEGIN", "ROLLBACK"])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it("non-transactional query goes to the pool directly (no checkout)", async () => {
    const connect = vi.fn()
    const poolQuery = vi.fn(async () => ({ rows: [{ n: 1 }] }))
    const pool = { connect, query: poolQuery } as unknown as Pool

    const res = await fromPool(pool).query<{ n: number }>("SELECT 1")

    expect(res.rows).toEqual([{ n: 1 }])
    expect(poolQuery).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
  })
})

describe("dedicated connections", () => {
  it("fromPool checks out a client, listens for its errors while held, and releases or ends it", async () => {
    const release = vi.fn()
    const on = vi.fn()
    const off = vi.fn()
    const poolClient = {
      query: vi.fn(async () => ({ rows: [{ n: 1 }] })),
      release,
      on,
      off,
    }
    const pool = {
      connect: vi.fn(async () => poolClient),
      query: vi.fn(),
    } as unknown as Pool

    const dedicated = await fromPool(pool).dedicated()
    expect(on).toHaveBeenCalledWith("error", expect.any(Function))
    expect((await dedicated.query("SELECT 1")).rows).toEqual([{ n: 1 }])
    dedicated.release(false)
    expect(off).toHaveBeenCalledWith("error", on.mock.calls[0]?.[1])
    expect(release).toHaveBeenLastCalledWith(false)
    dedicated.release(true)
    expect(release).toHaveBeenLastCalledWith(true)
  })

  it("fromClient is its client, which the caller owns", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
      end: vi.fn(),
    }
    const dedicated = await fromClient(client as unknown as Client).dedicated()
    await dedicated.query("SELECT 1")
    expect(client.query).toHaveBeenCalledWith("SELECT 1", undefined)
    dedicated.release(true)
    expect(client.release).not.toHaveBeenCalled()
    expect(client.end).not.toHaveBeenCalled()
  })
})
