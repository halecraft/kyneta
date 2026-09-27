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

// On shutdown:
// await exchange.shutdown()
// await pool.end()
```

`createPostgresStore` takes a `PgAdapter` — wrap your connection with `fromPool(pool)` (pooled; each transaction checks out and releases a connection) or `fromClient(client)` (a single dedicated connection). This injection mirrors `@kyneta/sqlite-store`'s `fromBetterSqlite3` and keeps the store free of any runtime `pg`-class coupling. The factory queries `information_schema.columns` to validate that the canonical schema exists with compatible column types, then returns a ready Store; a curated error tells you which column is missing or has the wrong type.

### Sync constructor (advanced)

For callers that validate the schema separately at process start:

```ts
import { PostgresStore, fromPool } from "@kyneta/postgres-store"

const store = new PostgresStore(fromPool(pool))
```

## Schema

Run [`schema.sql`](./schema.sql) once before constructing the store, or include the canonical DDL as a step in your migration pipeline. The store does not auto-DDL — Postgres convention is migrations-as-deployment-step.

```sql
CREATE TABLE IF NOT EXISTS kyneta_doc_meta (
  doc_id TEXT  PRIMARY KEY,
  data   JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS kyneta_records (
  doc_id  TEXT    NOT NULL,
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

`createPostgresStore` validates all three tables exist and runs the **store-format gate** on open: it stamps a `{ major, minor }` version into `kyneta_store_meta` (a one-row idempotent write — not DDL) and, on a later open, throws `StoreFormatVersionError` for an incompatible major or an unversioned store that already holds documents. No automatic migration is performed. Adding `kyneta_store_meta` (and the `kyneta_meta` → `kyneta_doc_meta` rename) to an existing deployment is an explicit migration step.

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

- `fromPool(pool)`: each transaction checks out a connection via `pool.connect()` and `release()`s it; the caller calls `pool.end()` on shutdown.
- `fromClient(client)`: transactions run against the one connection; the caller calls `client.end()` on shutdown.

`PostgresStore.close()` is a no-op.

### Runtime schema drift

Schema validation runs once at `createPostgresStore` time. If a DBA alters the schema while the Exchange is running, the change is **not** detected — re-run `createPostgresStore` after migrations (which means restarting the Exchange). Build a `revalidate()` API only if your operational pattern actually requires it.

## See also

- [`@kyneta/sql-store-core`](../sql-core/) — pure helpers shared with `sqlite-store` and `prisma-store`.
- [`@kyneta/sqlite-store`](../sqlite/) — universal SQLite backend.
- [`@kyneta/prisma-store`](../prisma/) — backend that takes a caller-supplied `PrismaClient`.
