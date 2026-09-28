# @kyneta/postgres-store

Postgres storage backend for `@kyneta/exchange` — async-native, JSONB meta, BYTEA blobs.

## Installation

```sh
pnpm add @kyneta/postgres-store pg
```

Peer dependencies: `@kyneta/exchange`, `@kyneta/schema`, `@kyneta/sql-store-core`, `pg`.

## Usage

### Recommended: `createPostgresStore` factory

```ts
import { Pool } from "pg"
import { Exchange } from "@kyneta/exchange"
import { createPostgresStore, fromPool } from "@kyneta/postgres-store"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const store = await createPostgresStore(fromPool(pool))

const exchange = new Exchange({
  store,
  // ...
})

// On shutdown (the store holds a connection until it closes):
// await exchange.shutdown()
// await pool.end()
```

`createPostgresStore` takes a `PgAdapter` — wrap your connection with `fromPool(pool)` (pooled; each transaction checks out and releases a connection) or `fromClient(client)` (a single dedicated connection). This injection mirrors `@kyneta/sqlite-store`'s `fromBetterSqlite3` and keeps the store free of any runtime `pg`-class coupling. The factory queries `information_schema.columns` to validate that the canonical schema exists with compatible column types, takes the store's seat (below), then returns a ready Store; a curated error tells you which column is missing or has the wrong type. `PostgresStore.open(adapter, options)` is the same; the constructor is private, since a store is born holding its seat.

### The peer's identity

The store issues the exchange's `peerId`, a **seat** from a pool kept in `kyneta_store_meta`. A restarted process gets its seat back, so it stays the same peer, and a `Line` to it survives the restart; several processes over one database hold different seats; the pool never grows past the most processes open at once.

Each store holds its seat with a session-level advisory lock on a **connection of its own**, checked out of the pool (or, with `fromClient`, the client itself) and kept until `close()`. Postgres releases the lock when that connection ends, so a crashed process frees its seat. Size your pool for one extra connection per open store. Writes go through other connections, so each write checks, in its own transaction, that no other store has claimed the seat since; if one has (the seat's connection died while the process ran), every write fails with `SeatLostError` and nothing more is written or sent.

**Only one process writes each `json` document.** The store records, in `kyneta_doc_meta.writer`, the seat whose write first carried its own changes, and refuses every other process's: a process that loads a document another writes throws on its first write, and `writeRefusal(doc)` from `@kyneta/exchange` says why. A restarted writer gets its seat back, so it stays the writer. Loro and Yjs documents are unaffected.

Seat locks use Postgres's two-key advisory lock space, `(hashtext(<store-meta table>), hashtext(peerId))`, and the per-document write locks the one-key space. The two spaces do not overlap, and must not: a seat lock is held for its process's lifetime, so a document whose write lock collided with it would wait until that process ended. If your application takes advisory locks of its own, keep them out of the two-key space with the store-metadata table's `hashtext` as the first key.

## Schema

Run [`schema.sql`](./schema.sql) once before constructing the store, or include the canonical DDL as a step in your migration pipeline. The store does not auto-DDL — Postgres convention is migrations-as-deployment-step.

```sql
CREATE TABLE IF NOT EXISTS kyneta_doc_meta (
  doc_id TEXT COLLATE "C" PRIMARY KEY,
  data   JSONB NOT NULL,
  writer TEXT
);
CREATE TABLE IF NOT EXISTS kyneta_records (
  doc_id  TEXT COLLATE "C" NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT,
  blob    BYTEA,
  PRIMARY KEY (doc_id, seq)
);
-- Store-global metadata (e.g. the on-disk format version). Distinct from
-- the per-document kyneta_doc_meta.
CREATE TABLE IF NOT EXISTS kyneta_store_meta (
  key   TEXT  PRIMARY KEY,
  value JSONB NOT NULL
);
```

`createPostgresStore` validates all three tables exist and checks the **store format** on open: it stamps a `{ major, minor }` version into `kyneta_store_meta` (row writes — not DDL) and, on a later open, throws `StoreFormatVersionError` for an incompatible major or an unversioned store that already holds documents. No automatic migration is performed. The format is 1.1: `kyneta_store_meta` holds the seat pool under `key = 'seats'`. A 1.0 database opens as one with an empty pool. Adding `kyneta_store_meta` (and the `kyneta_meta` → `kyneta_doc_meta` rename) to an existing deployment is an explicit migration step.

For other table names, `postgresSchema(tables)` returns this DDL with those names.

**`writer` is the seat that writes a serialized document.** The store refuses a doc-meta table without it, and its error gives the migration:

```sql
ALTER TABLE kyneta_doc_meta ADD COLUMN writer TEXT;
```

**`doc_id` is `COLLATE "C"`.** Document ids are compared byte by byte: `listDocIds(prefix)` scans a range that is exactly the ids with that prefix only in code-point order, and a locale collation such as `en_US.utf8` (the default almost everywhere) nearly ignores punctuation and returns nothing for a prefix like `users/`. The store refuses a `doc_id` column without `COLLATE "C"`. To migrate an existing deployment:

```sql
ALTER TABLE kyneta_doc_meta ALTER COLUMN doc_id TYPE TEXT COLLATE "C";
ALTER TABLE kyneta_records  ALTER COLUMN doc_id TYPE TEXT COLLATE "C";
```

JSONB on `doc_meta.data` enables operator queryability for admin tooling (`data->>'syncMode'`, `data->>'replicaType'`). Round-trip through `loadAll` is structurally portable with `@kyneta/sqlite-store` (both consume `toRow`/`fromRow` from `@kyneta/sql-store-core`); JSONB normalizes whitespace and key order, so a byte-level dump comparison would diverge.

## Options

### `tables`

```ts
const store = await createPostgresStore(pool, {
  tables: { docMeta: "app_doc_meta", records: "app_records", storeMeta: "app_store_meta" },
})
```

Default: `{ docMeta: "kyneta_doc_meta", records: "kyneta_records", storeMeta: "kyneta_store_meta" }`. Use to run multiple isolated Exchange instances against the same database — each owns one `tables` set.

`listDocIds(prefix)` uses a range scan (`doc_id >= prefix AND doc_id < successor(prefix)`), not `LIKE`. Doc IDs containing `%` and `_` are matched literally.

## Lifecycle

The caller owns the connection lifecycle:

- `fromPool(pool)`: each transaction checks out a connection via `pool.connect()` and `release()`s it, and the store keeps one more checked out for its seat until `close()`; the caller calls `pool.end()` on shutdown, after the store has closed.
- `fromClient(client)`: transactions, and the seat lock, run on the one connection; the caller calls `client.end()` on shutdown.

`PostgresStore.close()` releases the seat lock and returns its connection to the pool. A closed store refuses every operation.

### Runtime schema drift

Schema validation runs once at `createPostgresStore` time. If a DBA alters the schema while the Exchange is running, the change is **not** detected — re-run `createPostgresStore` after migrations (which means restarting the Exchange). Build a `revalidate()` API only if your operational pattern actually requires it.

## See also

- [`@kyneta/sql-store-core`](../sql-core/) — pure helpers shared with `sqlite-store` and `prisma-store`.
- [`@kyneta/sqlite-store`](../sqlite/) — universal SQLite backend.
- [`@kyneta/prisma-store`](../prisma/) — backend that takes a caller-supplied `PrismaClient`.
