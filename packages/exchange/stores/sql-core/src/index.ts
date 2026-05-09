// Pure helpers shared by every SQL-family Store backend. No SQL templates,
// no I/O, no driver knowledge.
//
// Why a shared package: the (kind, payload, blob) triple every SQL backend
// writes must serialize identically, or a dump from one backend won't load
// into another. Funneling all backends through the same `toRow`/`fromRow`
// is what makes round-trip portability a property of construction rather
// than a coordination problem across packages.

import {
  resolveMetaFromBatch,
  type StoreMeta,
  type StoreRecord,
  validateAppend,
} from "@kyneta/exchange"
import type { SubstratePayload } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Row shape — the (kind, payload, blob) triple every SQL backend persists
// ---------------------------------------------------------------------------

export interface RowShape {
  readonly kind: "meta" | "entry"
  readonly payload: string
  readonly blob: Uint8Array | null
}

/**
 * Why this shape: binary CRDT payloads (e.g. Yjs updates) would have
 * to be base64-wrapped to fit in JSON, doubling stored size on every
 * read and write. Splitting them off into the row's `blob` column
 * avoids that cost — so `data` is absent on binary entries.
 */
export interface EntryPayloadJson {
  readonly kind: "entirety" | "since"
  readonly encoding: "json" | "binary"
  readonly version: string
  readonly data?: string
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

export function toRow(record: StoreRecord): RowShape {
  if (record.kind === "meta") {
    return {
      kind: "meta",
      payload: JSON.stringify(record.meta),
      blob: null,
    }
  }

  const { payload, version } = record

  if (payload.data instanceof Uint8Array) {
    const json: EntryPayloadJson = {
      kind: payload.kind,
      encoding: payload.encoding,
      version,
    }
    return {
      kind: "entry",
      payload: JSON.stringify(json),
      blob: payload.data,
    }
  }

  const json: EntryPayloadJson = {
    kind: payload.kind,
    encoding: payload.encoding,
    version,
    data: payload.data as string,
  }
  return {
    kind: "entry",
    payload: JSON.stringify(json),
    blob: null,
  }
}

/**
 * `better-sqlite3` and `pg` both return `Buffer` for blob columns;
 * `Buffer extends Uint8Array` so `instanceof` passes, but vitest's
 * `toEqual` treats them as distinct types. Normalizing to a plain
 * `Uint8Array` keeps the Store contract driver-agnostic at the
 * loadAll boundary.
 */
export function normalizeBlob(blob: Uint8Array): Uint8Array {
  if (blob.constructor === Uint8Array) return blob
  return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)
}

export function fromRow(row: RowShape): StoreRecord {
  if (row.kind === "meta") {
    return { kind: "meta", meta: JSON.parse(row.payload) as StoreMeta }
  }

  const json = JSON.parse(row.payload) as EntryPayloadJson

  let data: string | Uint8Array
  if (row.blob !== null) {
    data = normalizeBlob(row.blob)
  } else {
    data = json.data as string
  }

  const payload: SubstratePayload = {
    kind: json.kind,
    encoding: json.encoding,
    data,
  }

  return { kind: "entry", payload, version: json.version }
}

// ---------------------------------------------------------------------------
// Table-name resolution
// ---------------------------------------------------------------------------

/**
 * The `kyneta_` prefix is chosen so these tables don't collide with
 * application tables in shared databases, and so the storage role is
 * obvious in `pg_dump` / `.dump` output.
 */
export const DEFAULT_TABLES = {
  meta: "kyneta_meta",
  records: "kyneta_records",
} as const satisfies TableNames

export interface TableNames {
  readonly meta: string
  readonly records: string
}

export function resolveTables(opts?: {
  tables?: Partial<TableNames>
}): TableNames {
  return {
    meta: opts?.tables?.meta ?? DEFAULT_TABLES.meta,
    records: opts?.tables?.records ?? DEFAULT_TABLES.records,
  }
}

// ---------------------------------------------------------------------------
// Pure planning helpers — gather/plan/execute split
// ---------------------------------------------------------------------------
//
// Why these exist: validation, serialization, and seq math are identical
// across every SQL backend. Factoring them into pure helpers keeps each
// backend's append/replace down to "gather state, plan, execute under
// transaction" — no duplicated invariant logic that can drift between
// backends.

export interface AppendPlan {
  readonly upsertMeta: { readonly data: string } | null
  readonly insertRecord: { readonly seq: number; readonly row: RowShape }
}

export interface ReplacePlan {
  readonly records: ReadonlyArray<{
    readonly seq: number
    readonly row: RowShape
  }>
  readonly upsertMeta: { readonly data: string }
}

export function planAppend(
  docId: string,
  record: StoreRecord,
  existingMeta: StoreMeta | null,
  nextSeq: number,
): AppendPlan {
  const resolved = validateAppend(docId, record, existingMeta)
  const row = toRow(record)

  return {
    upsertMeta: resolved !== null ? { data: JSON.stringify(resolved) } : null,
    insertRecord: { seq: nextSeq, row },
  }
}

export function planReplace(
  records: ReadonlyArray<StoreRecord>,
  existingMeta: StoreMeta | null,
): ReplacePlan {
  const resolved = resolveMetaFromBatch([...records], existingMeta)

  const rows: Array<{ readonly seq: number; readonly row: RowShape }> = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (record === undefined) continue
    rows.push({ seq: i, row: toRow(record) })
  }

  return {
    records: rows,
    upsertMeta: { data: JSON.stringify(resolved) },
  }
}

// ---------------------------------------------------------------------------
// failOnNthCall — fault-injection helper for the conformance suite
// ---------------------------------------------------------------------------

/**
 * Why this exists separately from each backend's own fault harness:
 * conformance tests need a uniform way to provoke "the Nth write
 * fails" without coupling to driver-specific seams. Each backend
 * decides which method to wrap; this helper handles the counting
 * and the sync-vs-async dispatch (async methods reject rather than
 * throw, so awaiters see a rejection instead of a synchronous throw).
 */
export function failOnNthCall<T extends object>(
  target: T,
  methodName: keyof T,
  n: number,
  error: Error = new Error(`fault-injected: ${String(methodName)} call #${n}`),
): T {
  if (n < 1) throw new Error(`failOnNthCall: n must be >= 1, got ${n}`)

  let count = 0
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver) as unknown
      if (prop !== methodName || typeof value !== "function") {
        return value
      }
      const fn = value as (...args: unknown[]) => unknown
      const isAsync = fn.constructor.name === "AsyncFunction"
      return function (this: unknown, ...args: unknown[]) {
        count += 1
        if (count === n) {
          if (isAsync) return Promise.reject(error)
          throw error
        }
        return fn.apply(this === receiver ? obj : this, args)
      }
    },
  })
}
