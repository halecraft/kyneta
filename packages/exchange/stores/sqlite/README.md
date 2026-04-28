# @kyneta/sqlite-store

SQLite storage backend for `@kyneta/exchange` — universal persistent storage for every deployment target.

## Installation

```sh
pnpm add @kyneta/sqlite-store
```

Peer dependencies: `@kyneta/exchange`, `@kyneta/schema`.

You also need a SQLite binding of your choice — this package has **zero opinion** about which one you use. It works with any object conforming to the `SqliteAdapter` interface.

## Usage

### With `better-sqlite3` (Node.js)

```ts
import Database from "better-sqlite3"
import { Exchange } from "@kyneta/exchange"
import { createSqliteStore, fromBetterSqlite3 } from "@kyneta/sqlite-store"

const db = new Database("./data/exchange.db")
const store = createSqliteStore(fromBetterSqlite3(db))

const exchange = new Exchange({
  stores: [store],
  // ...
})
```

### With `bun:sqlite` (Bun)

```ts
import { Database } from "bun:sqlite"
import { Exchange } from "@kyneta/exchange"
import { createSqliteStore, fromBunSqlite } from "@kyneta/sqlite-store"

const db = new Database("./data/exchange.db")
const store = createSqliteStore(fromBunSqlite(db))

const exchange = new Exchange({
  stores: [store],
  // ...
})
```

### With Cloudflare Durable Objects

DO's `ctx.storage.sql.exec(sql, ...params)` already returns an iterable cursor, so the adapter is essentially pass-through:

```ts
import { SqliteStore, type SqliteAdapter } from "@kyneta/sqlite-store"

function fromCloudflareDoSql(ctx: DurableObjectState): SqliteAdapter {
  return {
    exec: (sql, ...params) => { ctx.storage.sql.exec(sql, ...params) },
    iterate: (sql, ...params) => ctx.storage.sql.exec(sql, ...params),
    // DO request handlers are implicitly transactional — each request runs
    // atomically against storage. `transaction` just runs the function.
    transaction: (fn) => fn(),
    // DO storage doesn't have an explicit close — the actor lifecycle owns it.
    close: () => {},
  }
}

// In your DO class:
const store = new SqliteStore(fromCloudflareDoSql(this.ctx))
```

### With any other binding

Any object conforming to `SqliteAdapter` works:

```ts
import { SqliteStore, type SqliteAdapter } from "@kyneta/sqlite-store"

const adapter: SqliteAdapter = {
  exec(sql, ...params) { /* execute a write statement */ },
  iterate(sql, ...params) { /* return an Iterable of rows (lazy) */ },
  transaction(fn) { /* execute fn inside a transaction, return result */ },
  close() { /* release resources */ },
}

const store = new SqliteStore(adapter)
```

## `SqliteAdapter` interface

```ts
interface SqliteAdapter {
  exec(sql: string, ...params: unknown[]): void
  iterate<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Iterable<T>
  transaction<R>(fn: () => R): R
  close(): void
}
```

Four methods: `exec` (write), `iterate` (read, returns a lazy `Iterable<T>`), `transaction` (atomic batch), `close` (release).

## Recommended setup for `better-sqlite3` and `bun:sqlite`

Enable WAL mode before constructing the store. Without it, readers block on writes:

```ts
const db = new Database("./data/exchange.db")
db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = NORMAL")
```

Not needed for Cloudflare DO — the platform manages durability.

## Options

### `tablePrefix`

```ts
const store = new SqliteStore(adapter, { tablePrefix: "kyneta_" })
// Creates tables: kyneta_meta, kyneta_records
```

Default: `""` (tables are named `meta` and `records`).

Use `tablePrefix` when co-locating Exchange tables alongside application tables in the same SQLite database — for example, in a Cloudflare Durable Object that also stores application state.

## Schema

The store creates two tables on first use:

- **`{prefix}meta`** — materialized metadata index. `doc_id TEXT PRIMARY KEY`, `data TEXT NOT NULL` (JSON-encoded `StoreMeta`). `WITHOUT ROWID`.
- **`{prefix}records`** — per-document append-only record stream. Composite primary key `(doc_id, seq)`. Binary `Uint8Array` payloads are stored in a `BLOB` column; string/JSON payloads in a `TEXT` column. `WITHOUT ROWID`.

## Store interface

See the [`Store` interface](../../src/store/store.ts) in `@kyneta/exchange` for the full contract. Seven methods: `append`, `loadAll`, `replace`, `delete`, `currentMeta`, `listDocIds`, `close`.

## Testing

The package passes the full `describeStore` conformance suite (17 contract tests) exported from `@kyneta/exchange/testing`, plus SQLite-specific tests for close/reopen persistence, sequence number continuity, replace atomicity, adapter factories, and table prefix isolation.