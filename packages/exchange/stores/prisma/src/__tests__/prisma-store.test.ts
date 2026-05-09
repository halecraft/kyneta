// prisma-store — unit tests over a structural Prisma mock.
//
// These tests exercise the PrismaStore's translation of Store calls
// into Prisma model-accessor calls without depending on @prisma/client
// at runtime (which would force a real schema generation step). The
// full conformance suite runs against Prisma+SQLite as part of the
// integration tests in tests/integration. Here we only verify:
//
// 1. PrismaStore accepts a structurally-typed accessor object.
// 2. The model names default to `kynetaMeta` / `kynetaRecord`,
//    overridable via options.
// 3. Append, currentMeta, loadAll, listDocIds, delete, replace each
//    call the expected mock methods with the expected args.
//
// The structural-typing test is the load-bearing claim of the
// `unknown`-with-internal-cast approach: any caller-supplied
// PrismaClient with the right method signatures must work.

import type { StoreMeta } from "@kyneta/exchange"
import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { PrismaStore } from "../index.js"

const baseMeta: StoreMeta = {
  replicaType: ["plain", 1, 0] as const,
  syncProtocol: SYNC_AUTHORITATIVE,
  schemaHash: "00test",
}

interface MockState {
  metas: Map<string, unknown>
  records: Array<{
    docId: string
    seq: number
    kind: string
    payload: string | null
    blob: Uint8Array | null
  }>
  txCalls: number
}

function makeMockClient(state: MockState): unknown {
  const metaModel = {
    async findUnique(args: { where: { docId: string } }) {
      const data = state.metas.get(args.where.docId)
      if (data === undefined) return null
      return { docId: args.where.docId, data }
    },
    async findMany(args: {
      where?: { docId?: { gte?: string; lt?: string } }
      select: { docId: true }
    }) {
      const ids = Array.from(state.metas.keys())
      const docIdFilter = args.where?.docId
      const filtered =
        docIdFilter === undefined
          ? ids
          : ids.filter(id => {
              const { gte, lt } = docIdFilter
              if (gte !== undefined && id < gte) return false
              if (lt !== undefined && id >= lt) return false
              return true
            })
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
      state.records.push(args.data)
      return null
    },
    async deleteMany(args: { where: { docId: string } }) {
      state.records = state.records.filter(r => r.docId !== args.where.docId)
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
    kynetaMeta: metaModel,
    kynetaRecord: recordModel,
  }
  client.$transaction = async <R>(
    fn: (tx: unknown) => Promise<R>,
  ): Promise<R> => {
    state.txCalls += 1
    // Snapshot for rollback.
    const snapshot = {
      metas: new Map(state.metas),
      records: state.records.slice(),
    }
    try {
      return await fn(client)
    } catch (e) {
      state.metas = snapshot.metas
      state.records = snapshot.records
      throw e
    }
  }
  return client
}

function freshState(): MockState {
  return { metas: new Map(), records: [], txCalls: 0 }
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

  it("replace swaps the record stream and updates meta", async () => {
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

    await store.replace("doc-1", [
      { kind: "meta", meta: baseMeta },
      {
        kind: "entry",
        payload: { kind: "entirety", encoding: "json", data: "{}" },
        version: "v3",
      },
    ])

    const records = state.records
      .filter(r => r.docId === "doc-1")
      .sort((a, b) => a.seq - b.seq)
    expect(records).toHaveLength(2)
  })

  it("listDocIds(prefix) range-scans, no LIKE-pattern surface", async () => {
    const state = freshState()
    const store = new PrismaStore({ client: makeMockClient(state) })

    await store.append("100%_done", { kind: "meta", meta: baseMeta })
    await store.append("100_other", { kind: "meta", meta: baseMeta })
    await store.append("100xyz", { kind: "meta", meta: baseMeta })
    await store.append("other", { kind: "meta", meta: baseMeta })

    const matched: string[] = []
    for await (const id of store.listDocIds("100%")) matched.push(id)
    expect(matched).toEqual(["100%_done"])
  })

  it("custom model names override defaults", async () => {
    const state = freshState()
    // Build a mock with non-default model names by aliasing the same
    // model objects under the requested keys. The mock's $transaction
    // passes the client back as `tx`, so the renamed accessors are
    // visible both at the top level and inside transactions.
    const base = makeMockClient(state) as Record<string, unknown>
    const renamed: Record<string, unknown> = {
      app_meta: base.kynetaMeta,
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
