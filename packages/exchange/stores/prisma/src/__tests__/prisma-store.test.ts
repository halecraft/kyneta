// prisma-store — unit tests over a structural Prisma mock.
//
// These tests exercise the PrismaStore's translation of Store calls
// into Prisma model-accessor calls without depending on @prisma/client
// at runtime (which would force a real schema generation step). No
// conformance run reaches Prisma: these tests are its coverage. They
// verify:
//
// 1. PrismaStore accepts a structurally-typed accessor object.
// 2. The model names default to `kynetaDocMeta` / `kynetaRecord` /
//    `kynetaStoreMeta`, overridable via options.
// 3. Append, currentMeta, loadAll, listDocIds, delete, mark and compact
//    each call the expected mock methods with the expected args.
// 4. An append that loses a race for a sequence number to another
//    instance retries, reading the last sequence number afresh.
//
// The structural-typing test is the load-bearing claim of the
// `unknown`-with-internal-cast approach: any caller-supplied
// PrismaClient with the right method signatures must work.

import type { StoreMeta } from "@kyneta/exchange"
import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { createPrismaStore, PrismaStore } from "../index.js"

const baseMeta: StoreMeta = {
  replicaType: ["plain", 1, 0] as const,
  syncMode: SYNC_AUTHORITATIVE,
  schemaHash: "00test",
}

interface MockState {
  metas: Map<string, unknown>
  storeMetas: Map<string, unknown>
  records: Array<{
    docId: string
    seq: number
    kind: string
    payload: string | null
    blob: Uint8Array | null
  }>
  txCalls: number
  /**
   * Run once before the next `create`: another instance inserting between
   * this transaction's read of the last sequence number and its insert.
   */
  beforeCreate?: () => void
  /** Records created by the transaction in progress, undone if it fails. */
  createdInTx?: MockState["records"]
}

function makeMockClient(state: MockState): unknown {
  const metaModel = {
    async findUnique(args: { where: { docId: string } }) {
      const data = state.metas.get(args.where.docId)
      if (data === undefined) return null
      return { docId: args.where.docId, data }
    },
    async findMany(args: {
      where?: { docId?: { startsWith: string } }
      select: { docId: true }
    }) {
      const ids = Array.from(state.metas.keys())
      const docIdFilter = args.where?.docId
      // Matches the way SQLite's LIKE does, and MySQL's default collation:
      // wildcards literal (Prisma escapes them), case ignored.
      const filtered =
        docIdFilter === undefined
          ? ids
          : ids.filter(id =>
              id.toLowerCase().startsWith(docIdFilter.startsWith.toLowerCase()),
            )
      return filtered.map(docId => ({ docId }))
    },
    async upsert(args: {
      where: { docId: string }
      create: { docId: string; data: unknown }
      update: { data: unknown }
    }) {
      state.metas.set(args.where.docId, args.update.data)
      return { docId: args.where.docId, data: args.update.data }
    },
    async delete(args: { where: { docId: string } }) {
      state.metas.delete(args.where.docId)
      return null
    },
    async deleteMany(args: { where: { docId: string } }) {
      state.metas.delete(args.where.docId)
      return null
    },
    async count() {
      return state.metas.size
    },
  }

  const storeMetaModel = {
    async findUnique(args: { where: { key: string } }) {
      const value = state.storeMetas.get(args.where.key)
      if (value === undefined) return null
      return { key: args.where.key, value }
    },
    async upsert(args: {
      where: { key: string }
      create: { key: string; value: unknown }
      update: { value: unknown }
    }) {
      state.storeMetas.set(args.where.key, args.update.value)
      return { key: args.where.key, value: args.update.value }
    },
  }

  const recordModel = {
    async findMany(args: {
      where: { docId: string }
      orderBy: { seq: "asc" }
    }) {
      return state.records
        .filter(r => r.docId === args.where.docId)
        .sort((a, b) => a.seq - b.seq)
    },
    async create(args: {
      data: {
        docId: string
        seq: number
        kind: string
        payload: string | null
        blob: Uint8Array | null
      }
    }) {
      const interleave = state.beforeCreate
      state.beforeCreate = undefined
      interleave?.()
      if (
        state.records.some(
          r => r.docId === args.data.docId && r.seq === args.data.seq,
        )
      ) {
        throw Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
        })
      }
      state.records.push(args.data)
      state.createdInTx?.push(args.data)
      return null
    },
    async deleteMany(args: {
      where: { docId: string; seq?: { lte: number } }
    }) {
      const { docId, seq } = args.where
      state.records = state.records.filter(
        r => r.docId !== docId || (seq !== undefined && r.seq > seq.lte),
      )
      return null
    },
    async aggregate(args: { where: { docId: string }; _max: { seq: true } }) {
      const seqs = state.records
        .filter(r => r.docId === args.where.docId)
        .map(r => r.seq)
      return { _max: { seq: seqs.length === 0 ? null : Math.max(...seqs) } }
    },
  }

  // The client's `$transaction` passes the same client object back as
  // its `tx` argument. This means callers who wrap or rename outer
  // model accessors (renamed model names; fault-injected methods) see
  // those wrappings inside the transaction too, mirroring real Prisma's
  // behavior where `tx` exposes the same model accessors as the client.
  const client: Record<string, unknown> = {
    kynetaDocMeta: metaModel,
    kynetaRecord: recordModel,
    kynetaStoreMeta: storeMetaModel,
  }
  client.$transaction = async <R>(
    fn: (tx: unknown) => Promise<R>,
  ): Promise<R> => {
    state.txCalls += 1
    // Roll back only what this transaction did: another instance's writes
    // made meanwhile stand.
    const metas = new Map(state.metas)
    const created: MockState["records"] = []
    state.createdInTx = created
    try {
      return await fn(client)
    } catch (e) {
      state.metas = metas
      state.records = state.records.filter(r => !created.includes(r))
      throw e
    } finally {
      state.createdInTx = undefined
    }
  }
  return client
}

function freshState(): MockState {
  return { metas: new Map(), storeMetas: new Map(), records: [], txCalls: 0 }
}

describe("PrismaStore — structural mock", () => {
  it("append + loadAll round-trips a meta and an entry", async () => {
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })

    await store.append("doc-1", { kind: "meta", meta: baseMeta })
    await store.append("doc-1", {
      kind: "entry",
      payload: { kind: "entirety", encoding: "json", data: '{"x":1}' },
      version: "v1",
    })

    expect(state.txCalls).toBe(2)
    expect(state.metas.size).toBe(1)
    expect(state.records).toHaveLength(2)

    const out: unknown[] = []
    for await (const r of store.loadAll("doc-1")) out.push(r)
    expect(out).toHaveLength(2)
  })

  it("currentMeta returns null for nonexistent doc", async () => {
    const store = new PrismaStore({ client: makeMockClient(freshState()) })
    expect(await store.currentMeta("none")).toBeNull()
  })

  it("currentMeta returns a parsed StoreMeta after append", async () => {
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })
    await store.append("doc-1", { kind: "meta", meta: baseMeta })

    const meta = await store.currentMeta("doc-1")
    expect(meta).toEqual(baseMeta)
  })

  it("delete clears both meta and records", async () => {
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })
    await store.append("doc-1", { kind: "meta", meta: baseMeta })
    await store.append("doc-1", {
      kind: "entry",
      payload: { kind: "entirety", encoding: "json", data: "{}" },
      version: "v1",
    })

    await store.delete("doc-1")

    expect(state.metas.size).toBe(0)
    expect(state.records).toHaveLength(0)
  })

  it("compact swaps what is at or before the mark, after what remains", async () => {
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })
    await store.append("doc-1", { kind: "meta", meta: baseMeta })
    await store.append("doc-1", {
      kind: "entry",
      payload: { kind: "since", encoding: "json", data: "{}" },
      version: "v1",
    })
    await store.append("doc-1", {
      kind: "entry",
      payload: { kind: "since", encoding: "json", data: "{}" },
      version: "v2",
    })

    const through = await store.mark("doc-1")
    expect(through).toBe(2)

    await store.compact(
      "doc-1",
      [
        { kind: "meta", meta: baseMeta },
        {
          kind: "entry",
          payload: { kind: "entirety", encoding: "json", data: "{}" },
          version: "v3",
        },
      ],
      through,
    )

    const records = state.records
      .filter(r => r.docId === "doc-1")
      .sort((a, b) => a.seq - b.seq)
    expect(records.map(r => r.seq)).toEqual([3, 4])
  })

  it("an append that loses its sequence number to another instance retries", async () => {
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })
    await store.append("doc-1", { kind: "meta", meta: baseMeta })

    // Another instance takes seq 1 after this append read the last seq (0).
    state.beforeCreate = () => {
      state.records.push({
        docId: "doc-1",
        seq: 1,
        kind: "entry",
        payload: "{}",
        blob: null,
      })
    }
    await store.append("doc-1", {
      kind: "entry",
      payload: { kind: "since", encoding: "json", data: "{}" },
      version: "v1",
    })

    const seqs = state.records
      .filter(r => r.docId === "doc-1")
      .map(r => r.seq)
      .sort((a, b) => a - b)
    expect(seqs).toEqual([0, 1, 2])
  })

  it("listDocIds(prefix) keeps only exact matches, though LIKE ignores case", async () => {
    // The mock's `startsWith` ignores case, as SQLite's LIKE and MySQL's
    // default collation do. The store must still return exact matches only.
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })

    await store.append("users/alice", { kind: "meta", meta: baseMeta })
    await store.append("Users/Bob", { kind: "meta", meta: baseMeta })
    await store.append("other", { kind: "meta", meta: baseMeta })

    const matched: string[] = []
    for await (const id of store.listDocIds("users/")) matched.push(id)
    expect(matched).toEqual(["users/alice"])
  })

  it("custom model names override defaults", async () => {
    const state = freshState()
    // Build a mock with non-default model names by aliasing the same
    // model objects under the requested keys. The mock's $transaction
    // passes the client back as `tx`, so the renamed accessors are
    // visible both at the top level and inside transactions.
    const base = makeMockClient(state) as Record<string, unknown>
    const renamed: Record<string, unknown> = {
      app_meta: base.kynetaDocMeta,
      app_record: base.kynetaRecord,
    }
    renamed.$transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
      fn(renamed)

    const store = new PrismaStore({
      client: renamed,
      metaModel: "app_meta",
      recordModel: "app_record",
    })

    await store.append("doc-1", { kind: "meta", meta: baseMeta })
    expect(state.metas.size).toBe(1)
  })

  it("transaction rejection leaves observable state unchanged", async () => {
    const state = freshState()
    const base = makeMockClient(state) as Record<string, unknown>

    // Wrap $transaction so the SECOND call throws before its callback runs.
    // Models a real Prisma `$transaction` that rejects (e.g. failed COMMIT).
    let txCount = 0
    const baseTx = base.$transaction as <R>(
      fn: (tx: unknown) => Promise<R>,
    ) => Promise<R>
    base.$transaction = async <R>(fn: (tx: unknown) => Promise<R>) => {
      txCount += 1
      if (txCount === 2) throw new Error("fault")
      return baseTx(fn)
    }

    const store = new PrismaStore({ client: base })

    // First append: tx #1 — succeeds, schemaHash="primer" persists.
    await store.append("doc-1", {
      kind: "meta",
      meta: { ...baseMeta, schemaHash: "primer" },
    })

    // Second append: tx #2 — rejects.
    await expect(
      store.append("doc-1", {
        kind: "meta",
        meta: { ...baseMeta, schemaHash: "injected" },
      }),
    ).rejects.toThrow("fault")

    // No write happened in tx #2 → state still has the primer's meta.
    const meta = await store.currentMeta("doc-1")
    expect(meta?.schemaHash).toBe("primer")
    expect(state.records).toHaveLength(1)
  })
})

describe("PrismaStore — store-format gate", () => {
  it("createPrismaStore stamps a fresh store, then accepts it on reopen", async () => {
    const state = freshState()
    await createPrismaStore({ client: makeMockClient(state) })
    expect(state.storeMetas.get("format")).toEqual({ major: 1, minor: 0 })

    // Reopen against the same state: the marker round-trips, no throw.
    await expect(
      createPrismaStore({ client: makeMockClient(state) }),
    ).resolves.toBeDefined()
  })

  it("refuses a store whose stamped major is incompatible", async () => {
    const state = freshState()
    state.storeMetas.set("format", { major: 99, minor: 0 })
    state.metas.set("doc-1", {}) // store already holds a document

    await expect(
      createPrismaStore({ client: makeMockClient(state) }),
    ).rejects.toMatchObject({
      name: "StoreFormatVersionError",
      reason: "incompatible-major",
    })
  })
})
