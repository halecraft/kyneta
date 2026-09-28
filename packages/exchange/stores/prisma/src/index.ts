// Prisma-based Store backend.
//
// Why `unknown`-typed client: capturing Prisma's generic typed
// accessors without a hard dep on `@prisma/client` types is brittle,
// and depending on them pins this package to one Prisma major. The
// trade is less compile-time safety inside this package (one cast to
// the structural interfaces below) for version portability across
// Prisma releases. Caller's call site stays fully typed.

import {
  type DocId,
  decideStoreFormat,
  parseStoreFormat,
  STORE_META_FORMAT_KEY,
  type Store,
  StoreFormatVersionError,
  type StoreMark,
  type StoreMeta,
  type StoreRecord,
} from "@kyneta/exchange"
import {
  fromRow,
  planAppend,
  planCompact,
  type RowShape,
  STORE_FORMAT_VERSION,
} from "@kyneta/sql-store-core"

// ---------------------------------------------------------------------------
// Internal structural types — narrow shapes for the Prisma methods we use
// ---------------------------------------------------------------------------

interface MetaRow {
  docId: string
  data: unknown
}

interface RecordRow {
  docId: string
  seq: number
  kind: string
  payload: string | null
  blob: Uint8Array | null
}

interface MetaModel {
  findUnique(args: { where: { docId: string } }): Promise<MetaRow | null>
  findMany(args: {
    where?: { docId?: { startsWith: string } }
    select: { docId: true }
  }): Promise<Array<{ docId: string }>>
  upsert(args: {
    where: { docId: string }
    create: { docId: string; data: unknown }
    update: { data: unknown }
  }): Promise<MetaRow>
  delete(args: { where: { docId: string } }): Promise<unknown>
  deleteMany(args: { where: { docId: string } }): Promise<unknown>
  // Empty-store probe for the store-format gate (does any document exist).
  count(): Promise<number>
}

interface StoreMetaRow {
  key: string
  value: unknown
}

/** Store-global metadata model — keyed by an opaque `key`, not a `docId`. */
interface StoreMetaModel {
  findUnique(args: { where: { key: string } }): Promise<StoreMetaRow | null>
  upsert(args: {
    where: { key: string }
    create: { key: string; value: unknown }
    update: { value: unknown }
  }): Promise<StoreMetaRow>
}

interface RecordModel {
  findMany(args: {
    where: { docId: string }
    orderBy: { seq: "asc" }
  }): Promise<RecordRow[]>
  create(args: { data: RecordRow }): Promise<unknown>
  deleteMany(args: {
    where: { docId: string; seq?: { lte: number } }
  }): Promise<unknown>
  aggregate(args: {
    where: { docId: string }
    _max: { seq: true }
  }): Promise<{ _max: { seq: number | null } }>
}

interface PrismaClientLike {
  $transaction<R>(fn: (tx: PrismaTransactionLike) => Promise<R>): Promise<R>
}

/**
 * Real Prisma's `tx` exposes the same model accessors as the client.
 * Indexed by string so caller-chosen model names (via `metaModel` /
 * `recordModel` options) resolve through the same lookup path.
 */
interface PrismaTransactionLike {
  readonly [k: string]: unknown
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PrismaStoreOptions {
  /** The PrismaClient. Pass `prisma` directly. */
  client: unknown

  /** Property name on the client. Default matches `model KynetaDocMeta`. */
  metaModel?: string

  /** Property name on the client. Default matches `model KynetaRecord`. */
  recordModel?: string

  /** Property name on the client. Default matches `model KynetaStoreMeta`. */
  storeMetaModel?: string
}

// ---------------------------------------------------------------------------
// PrismaStore
// ---------------------------------------------------------------------------

export class PrismaStore implements Store {
  readonly #client: PrismaClientLike
  readonly #metaModelName: string
  readonly #recordModelName: string
  readonly #storeMetaModelName: string

  constructor(options: PrismaStoreOptions) {
    this.#client = options.client as PrismaClientLike
    this.#metaModelName = options.metaModel ?? "kynetaDocMeta"
    this.#recordModelName = options.recordModel ?? "kynetaRecord"
    this.#storeMetaModelName = options.storeMetaModel ?? "kynetaStoreMeta"
  }

  get #meta(): MetaModel {
    return (this.#client as unknown as Record<string, unknown>)[
      this.#metaModelName
    ] as MetaModel
  }

  get #storeMeta(): StoreMetaModel {
    return (this.#client as unknown as Record<string, unknown>)[
      this.#storeMetaModelName
    ] as StoreMetaModel
  }

  get #records(): RecordModel {
    return (this.#client as unknown as Record<string, unknown>)[
      this.#recordModelName
    ] as RecordModel
  }

  #txModels(tx: PrismaTransactionLike): {
    meta: MetaModel
    records: RecordModel
  } {
    return {
      meta: tx[this.#metaModelName] as MetaModel,
      records: tx[this.#recordModelName] as RecordModel,
    }
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    await this.#writeAfterLast(docId, async (tx, existingMeta, nextSeq) => {
      const { meta, records } = this.#txModels(tx)
      const plan = planAppend(docId, record, existingMeta, nextSeq)

      if (plan.upsertMeta !== null) {
        const dataValue = JSON.parse(plan.upsertMeta.data) as unknown
        await meta.upsert({
          where: { docId },
          create: { docId, data: dataValue },
          update: { data: dataValue },
        })
      }

      const { row } = plan.insertRecord
      await records.create({
        data: {
          docId,
          seq: plan.insertRecord.seq,
          kind: row.kind,
          payload: row.payload,
          blob: row.blob,
        },
      })
    })
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const rows = await this.#records.findMany({
      where: { docId },
      orderBy: { seq: "asc" },
    })
    for (const r of rows) {
      const row: RowShape = {
        kind: r.kind === "meta" ? "meta" : "entry",
        payload: r.payload as string,
        blob: r.blob ?? null,
      }
      yield fromRow(row)
    }
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    const result = await this.#records.aggregate({
      where: { docId },
      _max: { seq: true },
    })
    return result._max.seq ?? null
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
  ): Promise<void> {
    await this.#writeAfterLast(docId, async (tx, existingMeta, nextSeq) => {
      const { meta, records: recordsModel } = this.#txModels(tx)
      const plan = planCompact(records, existingMeta, nextSeq)

      if (through !== null) {
        await recordsModel.deleteMany({
          where: { docId, seq: { lte: through } },
        })
      }

      for (const { seq, row } of plan.records) {
        await recordsModel.create({
          data: {
            docId,
            seq,
            kind: row.kind,
            payload: row.payload,
            blob: row.blob,
          },
        })
      }

      const dataValue = JSON.parse(plan.upsertMeta.data) as unknown
      await meta.upsert({
        where: { docId },
        create: { docId, data: dataValue },
        update: { data: dataValue },
      })
    })
  }

  /**
   * Run `write` in a transaction, given the document's meta and next
   * sequence number as read inside it.
   *
   * Several stores may open one database, and Prisma offers no portable
   * lock, so two may read the same last sequence number and both insert
   * after it. The second insert then violates the `(docId, seq)` key, and
   * the whole transaction is retried once, reading afresh.
   */
  async #writeAfterLast(
    docId: DocId,
    write: (
      tx: PrismaTransactionLike,
      existingMeta: StoreMeta | null,
      nextSeq: number,
    ) => Promise<void>,
  ): Promise<void> {
    const attempt = () =>
      this.#client.$transaction(async tx => {
        const { meta, records } = this.#txModels(tx)
        const row = await meta.findUnique({ where: { docId } })
        const existingMeta =
          row === null ? null : (parseMetaData(row.data) as StoreMeta)
        const last = await records.aggregate({
          where: { docId },
          _max: { seq: true },
        })
        await write(tx, existingMeta, (last._max.seq ?? -1) + 1)
      })
    try {
      await attempt()
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      await attempt()
    }
  }

  async delete(docId: DocId): Promise<void> {
    await this.#client.$transaction(async tx => {
      const { meta, records } = this.#txModels(tx)
      await records.deleteMany({ where: { docId } })
      await meta.deleteMany({ where: { docId } })
    })
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    const row = await this.#meta.findUnique({ where: { docId } })
    if (row === null) return null
    return parseMetaData(row.data) as StoreMeta
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    if (prefix === undefined) {
      const rows = await this.#meta.findMany({ select: { docId: true } })
      for (const r of rows) yield r.docId
      return
    }

    // Prisma serves several databases, which order and match text
    // differently, so no one query is exact on all of them. A range scan
    // assumes code-point order, which a locale collation breaks, and misses
    // ids. `startsWith` becomes LIKE, which Prisma escapes, and which SQLite
    // and MySQL's default collation match without regard to case: it can
    // return extra ids, never fewer. So the database narrows with
    // `startsWith`, and the exact test is ours.
    const rows = await this.#meta.findMany({
      where: { docId: { startsWith: prefix } },
      select: { docId: true },
    })
    for (const r of rows) if (r.docId.startsWith(prefix)) yield r.docId
  }

  async close(): Promise<void> {
    // Caller owns the lifecycle (`prisma.$disconnect()`).
  }

  // Bootstrap reader: stamp/accept/refuse the store-format marker on open.
  // A `static open` reaches this private method so the gate stays internal.
  async #assertFormat(): Promise<void> {
    const row = await this.#storeMeta.findUnique({
      where: { key: STORE_META_FORMAT_KEY },
    })
    const parsed =
      row === null ? null : parseStoreFormat(parseMetaData(row.value))
    if (parsed === "malformed") {
      throw new StoreFormatVersionError({
        reason: "malformed-version",
        backend: "prisma",
        stored: null,
        current: STORE_FORMAT_VERSION,
      })
    }

    const docCount = await this.#meta.count()

    const decision = decideStoreFormat({
      current: STORE_FORMAT_VERSION,
      stored: parsed,
      storeHasData: docCount > 0,
    })

    if (decision.action === "refuse") {
      throw new StoreFormatVersionError({
        reason: decision.reason,
        backend: "prisma",
        stored: parsed,
        current: STORE_FORMAT_VERSION,
      })
    }
    if (decision.action === "stamp") {
      await this.#storeMeta.upsert({
        where: { key: STORE_META_FORMAT_KEY },
        create: { key: STORE_META_FORMAT_KEY, value: decision.value },
        update: { value: decision.value },
      })
    }
  }

  /** Construct + run the store-format gate. Used by `createPrismaStore`. */
  static async open(options: PrismaStoreOptions): Promise<Store> {
    const store = new PrismaStore(options)
    await store.#assertFormat()
    return store
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Prisma's unique-constraint violation (`P2002`). */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  )
}

/**
 * Prisma's `Json` field arrives parsed on Postgres/MySQL but as a raw
 * string on SQLite — the only place where the underlying database
 * type leaks through Prisma's abstraction.
 */
function parseMetaData(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value)
  return value
}

/**
 * Does no schema validation (Prisma's typed accessors enforce model
 * presence at compile time; runtime failures surface on first call), but
 * does run the store-format gate on open: it stamps a brand-new store,
 * accepts a compatible one, or throws `StoreFormatVersionError`.
 */
export async function createPrismaStore(
  options: PrismaStoreOptions,
): Promise<Store> {
  return PrismaStore.open(options)
}
