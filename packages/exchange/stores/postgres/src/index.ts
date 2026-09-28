// Postgres Store backend.
//
// Why JSONB on meta, not TEXT: operators occasionally need to filter
// metas by `syncMode` or `replicaType` during incident
// investigations, and JSONB makes `data->>'syncMode'` trivial.
// Cost: JSONB normalizes whitespace and key order at insert time, so
// `meta.data` bytes don't match SQLite's TEXT-stored meta — but
// round-trip through `loadAll` still yields a structurally equal
// `StoreRecord`, which is what cross-backend portability actually
// requires.
//
// Seats are pooled through session-level advisory locks, held on a
// connection dedicated to the store for its lifetime: Postgres releases them
// when that connection ends, so a dead process frees its seat. Writes go
// through other connections, so each one checks its seat's fence in the
// store-metadata table, inside its own transaction.

import {
  assertSeatHeld,
  type DocId,
  freshPeerIds,
  type PeerId,
  type PooledSeat,
  parseSeatPool,
  planStoreOpen,
  planWriter,
  prefixSuccessor,
  STORE_META_FORMAT_KEY,
  STORE_META_SEATS_KEY,
  type Store,
  type StoreMark,
  type StoreMeta,
  type StoreRecord,
  type WriteOptions,
} from "@kyneta/exchange"
import {
  fromRow,
  planAppend,
  planCompact,
  type RowShape,
  resolveTables,
  STORE_FORMAT_VERSION,
  type TableNames,
} from "@kyneta/sql-store-core"
import type { Client, Pool, PoolClient } from "pg"
import { DOC_ID_COLLATION } from "./schema.js"

export { postgresSchema } from "./schema.js"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PostgresStoreOptions {
  /**
   * Override the default table names (`kyneta_doc_meta`, `kyneta_records`,
   * `kyneta_store_meta`).
   *
   * Use when running multiple isolated Exchange instances against the
   * same database — each instance owns one `tables` set.
   */
  tables?: Partial<TableNames>
}

/**
 * Narrow structural type for the methods we actually call. Keeps the
 * package independent of `pg`'s top-level type changes across versions.
 */
export interface PgQuerier {
  query<R = unknown>(text: string, values?: unknown[]): Promise<{ rows: R[] }>
}

/**
 * A connection held by one store for its lifetime. The store's seat lock is
 * session-level, so it belongs to this connection and ends with it.
 */
export interface PgDedicated extends PgQuerier {
  /**
   * Give the connection back. With `destroy`, end it instead of returning it
   * to a pool: a connection that failed may still hold session state.
   */
  release(destroy: boolean): void
}

/**
 * The minimal Postgres capability `PostgresStore` needs, decoupled from any
 * specific pg surface — mirrors `SqliteAdapter`. `fromPool` / `fromClient`
 * supply it, so `PostgresStore` never discriminates connection types and `pg`
 * stays a type-only import (no `instanceof`, no runtime class coupling).
 */
export interface PgAdapter extends PgQuerier {
  /**
   * Run `fn` with a querier whose statements share one connection under
   * BEGIN/COMMIT; ROLLBACK and rethrow on failure.
   */
  transaction<R>(fn: (q: PgQuerier) => Promise<R>): Promise<R>
  /** A connection for the store's lifetime, which holds its seat lock. */
  dedicated(): Promise<PgDedicated>
}

/**
 * Run `fn` on `q` under BEGIN/COMMIT; ROLLBACK and rethrow on failure. `q`
 * must be one connection.
 */
async function inTransaction<R>(
  q: PgQuerier,
  fn: (q: PgQuerier) => Promise<R>,
): Promise<R> {
  await q.query("BEGIN")
  try {
    const result = await fn(q)
    await q.query("COMMIT")
    return result
  } catch (e) {
    await q.query("ROLLBACK")
    throw e
  }
}

/**
 * Adapter over a `Pool`: each transaction checks out a `PoolClient` so
 * BEGIN..COMMIT share one physical connection (Postgres transactions are
 * connection-scoped — checking back out for COMMIT would target a different
 * connection), then releases it. Non-transactional queries go to the pool
 * directly (the pool checks out/in per query — fine for single reads). The
 * dedicated connection is a checked-out client, kept until the store closes.
 */
export function fromPool(pool: Pool): PgAdapter {
  const direct = pool as unknown as PgQuerier
  return {
    query<R = unknown>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      return direct.query<R>(text, values)
    },
    async transaction<R>(fn: (q: PgQuerier) => Promise<R>): Promise<R> {
      const poolClient: PoolClient = await pool.connect()
      try {
        return await inTransaction(poolClient as unknown as PgQuerier, fn)
      } finally {
        poolClient.release()
      }
    },
    async dedicated(): Promise<PgDedicated> {
      const poolClient: PoolClient = await pool.connect()
      // A checked-out client that loses its connection emits `error`, which
      // would crash the process unheard. Its seat lock is gone with it; the
      // fence stops its store's writes once another store takes the seat.
      const onError = (error: Error): void => {
        console.warn(
          "[postgres-store] a store's seat connection failed; its seat is no longer held",
          error,
        )
      }
      poolClient.on("error", onError)
      const q = poolClient as unknown as PgQuerier
      return {
        query: <R = unknown>(text: string, values?: unknown[]) =>
          q.query<R>(text, values),
        release: destroy => {
          poolClient.off("error", onError)
          poolClient.release(destroy)
        },
      }
    },
  }
}

/**
 * Adapter over a single `Client` (or an already-checked-out `PoolClient`):
 * transactions run inline on the one connection, which is also the dedicated
 * one. Re-throws on rollback so a caller can place post-commit work lexically
 * after the awaited call. The caller owns the client, so releasing it does
 * nothing.
 */
export function fromClient(client: Client | PoolClient): PgAdapter {
  const q = client as unknown as PgQuerier
  return {
    query<R = unknown>(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: R[] }> {
      return q.query<R>(text, values)
    },
    transaction<R>(fn: (q: PgQuerier) => Promise<R>): Promise<R> {
      return inTransaction(q, fn)
    },
    async dedicated(): Promise<PgDedicated> {
      return {
        query: <R = unknown>(text: string, values?: unknown[]) =>
          q.query<R>(text, values),
        release: () => {},
      }
    },
  }
}

// ---------------------------------------------------------------------------
// PostgresStore
// ---------------------------------------------------------------------------

/**
 * The caller owns the pool or client — `pool.end()` is the caller's
 * responsibility. `close()` releases the store's seat and its dedicated
 * connection. Open one with `PostgresStore.open` or `createPostgresStore`,
 * which validate the schema first, so misconfiguration fails loudly with a
 * curated error rather than per-method `column does not exist` later.
 */
export class PostgresStore implements Store {
  readonly seat: PooledSeat
  readonly #adapter: PgAdapter
  readonly #tables: TableNames
  readonly #dedicated: PgDedicated
  #closed = false

  private constructor(
    adapter: PgAdapter,
    tables: TableNames,
    dedicated: PgDedicated,
    seat: PooledSeat,
  ) {
    this.#adapter = adapter
    this.#tables = tables
    this.#dedicated = dedicated
    this.seat = seat
  }

  /**
   * Validate the schema, check the store format, and take a seat from the
   * pool on a connection held until `close()`.
   *
   * Validation runs once, here, not on every method call. A schema change
   * applied while the Exchange is running won't be detected — restart after
   * migrations.
   */
  static async open(
    adapter: PgAdapter,
    options: PostgresStoreOptions = {},
  ): Promise<PostgresStore> {
    const tables = resolveTables(options)
    await validateSchema(adapter, tables)
    const dedicated = await adapter.dedicated()
    try {
      const seat = await openSeat(dedicated, tables)
      return new PostgresStore(adapter, tables, dedicated, seat)
    } catch (error) {
      dedicated.release(true)
      throw error
    }
  }

  /** The adapter, while the store is open. */
  get #db(): PgAdapter {
    if (this.#closed) throw new Error("PostgresStore: the store is closed")
    return this.#adapter
  }

  /**
   * Throws `SeatLostError` when this store's seat has been claimed again.
   * `FOR SHARE` makes an allocation that updates the pool wait for this
   * transaction, and this transaction wait for an allocation in flight and
   * then read its fence: no write lands after a new holder has taken the seat.
   */
  async #fence(q: PgQuerier): Promise<void> {
    const result = await q.query<{ value: unknown }>(
      `SELECT value FROM ${this.#tables.storeMeta} WHERE key = $1 FOR SHARE`,
      [STORE_META_SEATS_KEY],
    )
    assertSeatHeld(parseSeatPool(result.rows[0]?.value), this.seat)
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async append(
    docId: DocId,
    record: StoreRecord,
    options: WriteOptions,
  ): Promise<void> {
    await this.#db.transaction(async q => {
      await this.#fence(q)
      await this.#lockDoc(q, docId)
      const stored = await this.#readDoc(q, docId)
      const writer = this.#writer(docId, stored, options)
      const plan = planAppend(
        docId,
        record,
        stored?.data ?? null,
        await this.#nextSeq(q, docId),
      )
      if (plan.upsertMeta !== null) {
        await this.#upsertMeta(q, docId, plan.upsertMeta.data, writer)
      } else if (writer !== (stored?.writer ?? null)) {
        await q.query(
          `UPDATE ${this.#tables.docMeta} SET writer = $2 WHERE doc_id = $1`,
          [docId, writer],
        )
      }
      const { row } = plan.insertRecord
      await q.query(
        `INSERT INTO ${this.#tables.records}
         (doc_id, seq, kind, payload, blob)
         VALUES ($1, $2, $3, $4, $5)`,
        [docId, plan.insertRecord.seq, row.kind, row.payload, row.blob],
      )
    })
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const result = await this.#db.query<RowShape>(
      `SELECT kind, payload, blob FROM ${this.#tables.records}
       WHERE doc_id = $1 ORDER BY seq`,
      [docId],
    )
    for (const row of result.rows) {
      yield fromRow(row)
    }
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    return this.#lastSeq(this.#db, docId)
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
    options: WriteOptions,
  ): Promise<void> {
    await this.#db.transaction(async q => {
      await this.#fence(q)
      await this.#lockDoc(q, docId)
      const stored = await this.#readDoc(q, docId)
      const writer = this.#writer(docId, stored, options)
      const plan = planCompact(
        records,
        stored?.data ?? null,
        await this.#nextSeq(q, docId),
      )
      if (through !== null) {
        await q.query(
          `DELETE FROM ${this.#tables.records} WHERE doc_id = $1 AND seq <= $2`,
          [docId, through],
        )
      }

      for (const { seq, row } of plan.records) {
        await q.query(
          `INSERT INTO ${this.#tables.records}
           (doc_id, seq, kind, payload, blob)
           VALUES ($1, $2, $3, $4, $5)`,
          [docId, seq, row.kind, row.payload, row.blob],
        )
      }

      await this.#upsertMeta(q, docId, plan.upsertMeta.data, writer)
    })
  }

  /** The document's meta and writer, read inside the write transaction. */
  async #readDoc(
    q: PgQuerier,
    docId: DocId,
  ): Promise<{ data: StoreMeta; writer: PeerId | null } | null> {
    const result = await q.query<{ data: StoreMeta; writer: PeerId | null }>(
      `SELECT data, writer FROM ${this.#tables.docMeta} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0] ?? null
  }

  /**
   * The writer to record after this write; throws `WriterRefusedError` when
   * another seat writes the document. Checked after the fence and under the
   * document lock, which serializes two seats' first claims.
   */
  #writer(
    docId: DocId,
    stored: { writer: PeerId | null } | null,
    options: WriteOptions,
  ): PeerId | null {
    return planWriter({
      docId,
      seat: this.seat,
      recorded: stored?.writer ?? null,
      authored: options.authored,
    })
  }

  /** Write the materialized meta, and the writer, which keeps a recorded one. */
  async #upsertMeta(
    q: PgQuerier,
    docId: DocId,
    data: string,
    writer: PeerId | null,
  ): Promise<void> {
    await q.query(
      `INSERT INTO ${this.#tables.docMeta} (doc_id, data, writer)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (doc_id)
       DO UPDATE SET data = EXCLUDED.data, writer = EXCLUDED.writer`,
      [docId, data, writer],
    )
  }

  /**
   * Hold the document's write lock until the transaction ends. Several
   * stores may open one schema: each reads the document's last sequence
   * number and writes after it, so two writers of one document take turns.
   * Released at commit or rollback. `hashtext` collisions only make two
   * documents take turns too.
   *
   * The lock is in the one-key advisory space; seat locks are in the two-key
   * space, which the manual says does not overlap it. They must not share
   * one: a seat lock is held for its connection's lifetime, so a document
   * whose key equalled a held seat's would wait for that process to end.
   */
  async #lockDoc(q: PgQuerier, docId: DocId): Promise<void> {
    await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `${this.#tables.records}:${docId}`,
    ])
  }

  async #lastSeq(q: PgQuerier, docId: DocId): Promise<number | null> {
    const result = await q.query<{ max_seq: number | null }>(
      `SELECT MAX(seq)::int AS max_seq FROM ${this.#tables.records} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0]?.max_seq ?? null
  }

  /** The next sequence number. Read inside the write transaction. */
  async #nextSeq(q: PgQuerier, docId: DocId): Promise<number> {
    return ((await this.#lastSeq(q, docId)) ?? -1) + 1
  }

  async #readMeta(q: PgQuerier, docId: DocId): Promise<StoreMeta | null> {
    const result = await q.query<{ data: StoreMeta }>(
      `SELECT data FROM ${this.#tables.docMeta} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0]?.data ?? null
  }

  async delete(docId: DocId): Promise<void> {
    await this.#db.transaction(async q => {
      await this.#fence(q)
      await this.#lockDoc(q, docId)
      const stored = await this.#readDoc(q, docId)
      this.#writer(docId, stored, { authored: true })
      await q.query(`DELETE FROM ${this.#tables.records} WHERE doc_id = $1`, [
        docId,
      ])
      await q.query(`DELETE FROM ${this.#tables.docMeta} WHERE doc_id = $1`, [
        docId,
      ])
    })
  }

  async writerOf(docId: DocId): Promise<PeerId | null> {
    const result = await this.#db.query<{ writer: PeerId | null }>(
      `SELECT writer FROM ${this.#tables.docMeta} WHERE doc_id = $1`,
      [docId],
    )
    return result.rows[0]?.writer ?? null
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    return this.#readMeta(this.#db, docId)
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    if (prefix === undefined) {
      const result = await this.#db.query<{ doc_id: string }>(
        `SELECT doc_id FROM ${this.#tables.docMeta}`,
      )
      for (const row of result.rows) yield row.doc_id
      return
    }

    // Range scan instead of LIKE — `%` and `_` in doc IDs are literal,
    // not wildcards. `doc_id` is `COLLATE "C"`, so the column compares in
    // code-point order, which the range assumes (see `schema.ts`).
    const upper = prefixSuccessor(prefix, "code-point")
    const result =
      upper === null
        ? await this.#db.query<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.docMeta} WHERE doc_id >= $1`,
            [prefix],
          )
        : await this.#db.query<{ doc_id: string }>(
            `SELECT doc_id FROM ${this.#tables.docMeta}
             WHERE doc_id >= $1 AND doc_id < $2`,
            [prefix, upper],
          )
    for (const row of result.rows) yield row.doc_id
  }

  /**
   * Release the seat lock and the dedicated connection. A connection that
   * has already failed held nothing more, and is ended rather than reused.
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#dedicated.query(
        `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
        [this.#tables.storeMeta, this.seat.peerId],
      )
      this.#dedicated.release(false)
    } catch {
      this.#dedicated.release(true)
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: createPostgresStore (recommended entry point)
// ---------------------------------------------------------------------------

/**
 * Open a Postgres store: see `PostgresStore.open`. The store holds a
 * connection of its own until it closes, so close it before ending the pool.
 */
export async function createPostgresStore(
  adapter: PgAdapter,
  options: PostgresStoreOptions = {},
): Promise<Store> {
  return PostgresStore.open(adapter, options)
}

/**
 * Take a seat from the pool, on `dedicated`, and check the store format.
 *
 * The pool's row is the allocation lock: `FOR UPDATE` holds it until commit,
 * and a seat lock is only ever taken while holding it. So the snapshot of
 * held seat locks read under it is authoritative — held seats can be released
 * meanwhile, never taken — and the one seat lock requested cannot be refused.
 * A row lock cannot collide with any advisory lock, as a lock in the
 * advisory space could with a seat whose key happened to equal it.
 *
 * Writes at most the format marker and the pool rows — not DDL, so the "no
 * auto-DDL" invariant holds; the operator still owns the table.
 */
async function openSeat(
  dedicated: PgQuerier,
  tables: TableNames,
): Promise<PooledSeat> {
  let locked: PeerId | undefined
  return inTransaction(dedicated, async q => {
    await q.query(
      `INSERT INTO ${tables.storeMeta} (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO NOTHING`,
      [STORE_META_SEATS_KEY, JSON.stringify({ seats: [], fences: {} })],
    )
    const pool = await q.query<{ value: unknown }>(
      `SELECT value FROM ${tables.storeMeta} WHERE key = $1 FOR UPDATE`,
      [STORE_META_SEATS_KEY],
    )
    const format = await q.query<{ value: unknown }>(
      `SELECT value FROM ${tables.storeMeta} WHERE key = $1`,
      [STORE_META_FORMAT_KEY],
    )
    const hasData = await q.query(`SELECT 1 FROM ${tables.docMeta} LIMIT 1`)
    const storedPool = pool.rows[0]?.value

    // Two-key advisory locks show in `pg_locks` with the keys as `classid`
    // and `objid` and `objsubid = 2`. A seat whose key collides with another's
    // reads as held too, which only passes it over.
    const held = await q.query<{ peer_id: PeerId }>(
      `SELECT peer_id FROM unnest($2::text[]) AS peer_id
       WHERE EXISTS (
         SELECT 1 FROM pg_locks
         WHERE locktype = 'advisory' AND objsubid = 2
           AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
           AND classid = hashtext($1)::oid AND objid = hashtext(peer_id)::oid
       )`,
      [tables.storeMeta, parseSeatPool(storedPool).seats],
    )

    const plan = planStoreOpen({
      backend: "postgres",
      current: STORE_FORMAT_VERSION,
      storedFormat: format.rows[0]?.value,
      storeHasData: hasData.rows.length > 0,
      storedPool,
      seating: {
        kind: "pooled",
        held: new Set(held.rows.map(row => row.peer_id)),
      },
      fresh: freshPeerIds(),
    })
    if (plan.action === "refuse") throw plan.error

    const granted = await q.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked`,
      [tables.storeMeta, plan.seat.peerId],
    )
    if (granted.rows[0]?.locked !== true) {
      throw new Error(
        `@kyneta/postgres-store: seat ${plan.seat.peerId} was locked outside ` +
          `its allocation lock; refusing a seat another holder may have`,
      )
    }

    locked = plan.seat.peerId

    if (plan.writeFormat !== undefined) {
      await q.query(
        `INSERT INTO ${tables.storeMeta} (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [STORE_META_FORMAT_KEY, JSON.stringify(plan.writeFormat)],
      )
    }
    await q.query(
      `UPDATE ${tables.storeMeta} SET value = $2::jsonb WHERE key = $1`,
      [STORE_META_SEATS_KEY, JSON.stringify(plan.writePool)],
    )
    return plan.seat
  }).catch(async (error: unknown) => {
    // The seat lock is session-level, so the rollback left it held. Released
    // after the rollback: an aborted transaction runs no statement.
    if (locked !== undefined) {
      await dedicated
        .query(`SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`, [
          tables.storeMeta,
          locked,
        ])
        .catch(() => {})
    }
    throw error
  })
}

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
  collation_name: string | null
}

// `collation` is checked only where it is named: the `doc_id` columns, whose
// byte order `listDocIds(prefix)`'s range scan depends on (see `schema.ts`).
const EXPECTED_COLUMNS = {
  docMeta: [
    { name: "doc_id", types: ["text"], collation: DOC_ID_COLLATION },
    { name: "data", types: ["jsonb"] },
    { name: "writer", types: ["text"], migration: "ADD COLUMN writer TEXT" },
  ],
  records: [
    { name: "doc_id", types: ["text"], collation: DOC_ID_COLLATION },
    { name: "seq", types: ["integer"] },
    { name: "kind", types: ["text"] },
    { name: "payload", types: ["text"] },
    { name: "blob", types: ["bytea"] },
  ],
  storeMeta: [
    { name: "key", types: ["text"] },
    { name: "value", types: ["jsonb"] },
  ],
} as const

async function validateSchema(q: PgQuerier, tables: TableNames): Promise<void> {
  for (const [role, expected] of [
    ["docMeta", EXPECTED_COLUMNS.docMeta] as const,
    ["records", EXPECTED_COLUMNS.records] as const,
    ["storeMeta", EXPECTED_COLUMNS.storeMeta] as const,
  ]) {
    const tableName = tables[role]
    const result = await q.query<ColumnInfo>(
      `SELECT column_name, data_type, is_nullable, collation_name
       FROM information_schema.columns
       WHERE table_name = $1`,
      [tableName],
    )
    if (result.rows.length === 0) {
      throw new Error(
        `@kyneta/postgres-store: table "${tableName}" not found. ` +
          `Run schema.sql or include the canonical DDL in your migrations.`,
      )
    }
    const columnsByName = new Map(result.rows.map(r => [r.column_name, r]))
    for (const col of expected) {
      const found = columnsByName.get(col.name)
      if (found === undefined) {
        throw new Error(
          `@kyneta/postgres-store: table "${tableName}" missing column ` +
            `"${col.name}". See schema.sql for the canonical definition.` +
            ("migration" in col
              ? ` Migrate with: ALTER TABLE ${tableName} ${col.migration};`
              : ""),
        )
      }
      if (!(col.types as readonly string[]).includes(found.data_type)) {
        throw new Error(
          `@kyneta/postgres-store: table "${tableName}" column ` +
            `"${col.name}" has type "${found.data_type}", ` +
            `expected one of [${col.types.join(", ")}].`,
        )
      }
      if ("collation" in col && found.collation_name !== col.collation) {
        throw new Error(
          `@kyneta/postgres-store: table "${tableName}" column ` +
            `"${col.name}" has collation ` +
            `${found.collation_name === null ? "(the database default)" : `"${found.collation_name}"`}, ` +
            `expected "${col.collation}", which listDocIds(prefix) needs to ` +
            `compare document ids byte by byte. Migrate with: ` +
            `ALTER TABLE ${tableName} ALTER COLUMN ${col.name} TYPE TEXT COLLATE "${col.collation}";`,
        )
      }
    }
  }
}
