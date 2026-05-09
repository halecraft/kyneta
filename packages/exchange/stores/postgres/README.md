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
import { createPostgresStore } from "@kyneta/postgres-store"

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const store = await createPostgresStore(pool)

const exchange = new Exchange({
  stores: [store],
  // ...
})

// On shutdown:
// await exchange.shutdown()
// await pool.end()
```

The factory queries `information_schema.columns` to validate that the canonical schema exists with compatible column types, then returns a ready Store. If validation fails, a curated error tells you which column is missing or has the wrong type.

### Sync constructor (advanced)

For callers that validate the schema separately at process start:

```ts
import { PostgresStore } from "@kyneta/postgres-store"

const store = new PostgresStore(pool)
```

## Schema

Run [`schema.sql`](./schema.sql) once before constructing the store, or include the canonical DDL as a step in your migration pipeline. The store does not auto-DDL — Postgres convention is migrations-as-deployment-step.

```sql
CREATE TABLE IF NOT EXISTS kyneta_meta (
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
```

JSONB on `meta.data` enables operator queryability for admin tooling (`data->>'syncProtocol'`, `data->>'replicaType'`). Round-trip through `loadAll` is structurally portable with `@kyneta/sqlite-store` (both consume `toRow`/`fromRow` from `@kyneta/sql-store-core`); JSONB normalizes whitespace and key order, so a byte-level dump comparison would diverge.

## Options

### `tables`

```ts
const store = await createPostgresStore(pool, {
  tables: { meta: "app_meta", records: "app_records" },
})
```

Default: `{ meta: "kyneta_meta", records: "kyneta_records" }`. Use to run multiple isolated Exchange instances against the same database — each owns one `tables` pair.

`listDocIds(prefix)` uses a range scan (`doc_id >= prefix AND doc_id < successor(prefix)`), not `LIKE`. Doc IDs containing `%` and `_` are matched literally.

## Lifecycle

The caller owns the connection lifecycle:

- `Pool`: passed in by the caller. The Store calls `pool.connect()`/`release()` per transaction. The caller calls `pool.end()` on shutdown.
- `Client`: passed in by the caller; transactions run against the same connection. The caller calls `client.end()` on shutdown.

`PostgresStore.close()` is a no-op.

### Runtime schema drift

Schema validation runs once at `createPostgresStore` time. If a DBA alters the schema while the Exchange is running, the change is **not** detected — re-run `createPostgresStore` after migrations (which means restarting the Exchange). Build a `revalidate()` API only if your operational pattern actually requires it.

## See also

- [`@kyneta/sql-store-core`](../sql-core/) — pure helpers shared with `sqlite-store` and `prisma-store`.
- [`@kyneta/sqlite-store`](../sqlite/) — universal SQLite backend.
- [`@kyneta/prisma-store`](../prisma/) — backend that takes a caller-supplied `PrismaClient`.
