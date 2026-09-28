# @kyneta/sqlite-store

SQLite storage backend for `@kyneta/exchange` — universal persistent storage for every deployment target.

## Installation

```sh
pnpm add @kyneta/sqlite-store
```

Peer dependencies: `@kyneta/exchange`, `@kyneta/schema`, `@kyneta/sql-store-core`.

You also need a SQLite binding of your choice — this package has **zero opinion** about which one you use. It works with any object conforming to the `SqliteAdapter` interface.

**A SQLite database has one owner.** The adapter owns it until it closes: `fromBetterSqlite3` and `fromBunSqlite` lock the file exclusively when they wrap the connection, and a second adapter over the same file waits `busyTimeout` (5 s by default) and is then refused, naming the reason. SQLite is an embedded database, owned by one process in nearly every deployment; a fleet of server processes over one database is what [`@kyneta/postgres-store`](../postgres/) is for.

**The owner keeps one identity.** The store issues the exchange's `peerId`, a seat kept in the database and reused on every open, so a restarted process is the same peer. Nothing else can write under it while the file is owned, so writes need no further check.

## Usage

### With `better-sqlite3` (Node.js)

```ts
import Database from "better-sqlite3"
import { Exchange } from "@kyneta/exchange"
import { createSqliteStore, fromBetterSqlite3 } from "@kyneta/sqlite-store"

const db = new Database("./data/exchange.db")
const store = createSqliteStore(fromBetterSqlite3(db))

const exchange = new Exchange({
  store,
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
  store,
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
    // A Durable Object is the sole owner of its storage by platform guarantee,
    // so the adapter takes no lock (DO SQL refuses `PRAGMA locking_mode` and
    // `BEGIN EXCLUSIVE` anyway). Its request handlers run atomically against
    // the storage, so `transaction` just runs the function.
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

// Take ownership of the database before handing it to the store: no other
// connection may write to it until `close()`.
const adapter: SqliteAdapter = {
  exec(sql, ...params) { /* execute a write statement */ },
  iterate(sql, ...params) { /* return an Iterable of rows (lazy) */ },
  transaction(fn) { /* execute fn inside a transaction, return result */ },
  close() { /* release resources, and ownership */ },
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

Four methods: `exec` (write), `iterate` (read, returns a lazy `Iterable<T>`), `transaction` (a plain transaction: commit if `fn` returns, roll back if it throws), `close` (release).

**One adapter is the one owner of its database** until it closes. How ownership is held belongs to the host: over a file, take it when wrapping the connection (`PRAGMA locking_mode = EXCLUSIVE`, then `BEGIN EXCLUSIVE; COMMIT` to take the lock at once), as the built-in adapters do; a host that guarantees it, like a Durable Object, does nothing.

### `fromBetterSqlite3(db, options?)` / `fromBunSqlite(db, options?)`

Wrap a connection and take ownership of its file. `options.busyTimeout` (milliseconds, default 5000) is how long to wait for another owner to close before refusing.

## Recommended setup for `better-sqlite3` and `bun:sqlite`

Enable WAL mode before constructing the store. Without it, readers block on writes:

```ts
const db = new Database("./data/exchange.db")
db.exec("PRAGMA journal_mode = WAL")
db.exec("PRAGMA synchronous = NORMAL")
```

Not needed for Cloudflare DO — the platform manages durability.

## Options

### `tables`

```ts
const store = new SqliteStore(adapter, {
  tables: { docMeta: "app_doc_meta", records: "app_records", storeMeta: "app_store_meta" },
})
```

Default: `{ docMeta: "kyneta_doc_meta", records: "kyneta_records", storeMeta: "kyneta_store_meta" }`. Any subset of names may be overridden.

Use `tables` when co-locating Exchange tables alongside application tables in the same SQLite database (for example, in a Cloudflare Durable Object that also stores application state), or when running multiple isolated Exchange instances in one database with distinct table-name sets.

## Migration from v1.x

The current API uses `tables: { docMeta, records, storeMeta }` (replacing v1.x's `tablePrefix`), defaulting to `kyneta_doc_meta` / `kyneta_records` / `kyneta_store_meta`. There is no compatibility shim.

```ts
// v1.x
new SqliteStore(adapter)                                  // tables: meta, records
new SqliteStore(adapter, { tablePrefix: "app_" })         // tables: app_meta, app_records

// current
new SqliteStore(adapter)  // tables: kyneta_doc_meta, kyneta_records, kyneta_store_meta
new SqliteStore(adapter, {
  tables: { docMeta: "app_doc_meta", records: "app_records", storeMeta: "app_store_meta" },
})
```

To keep using existing table names, pass them explicitly via the `tables` option, or rename via `ALTER TABLE`.

## Schema

The store creates three tables on first use:

- **`tables.docMeta`** (default `kyneta_doc_meta`) — per-document materialized metadata index. `doc_id TEXT PRIMARY KEY`, `data TEXT NOT NULL` (JSON-encoded `StoreMeta`). `WITHOUT ROWID`.
- **`tables.records`** (default `kyneta_records`) — per-document append-only record stream. Composite primary key `(doc_id, seq)`. Binary `Uint8Array` payloads are stored in a `BLOB` column; string/JSON payloads in a `TEXT` column. `WITHOUT ROWID`.
- **`tables.storeMeta`** (default `kyneta_store_meta`) — store-global metadata. `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`. Holds the on-disk format version (under `key = "format"`), checked on open, and the seat pool (under `key = "seats"`). `WITHOUT ROWID`.

The on-disk format is 1.1 (shared with `postgres-store` and `prisma-store`): the store-metadata table holds the seat pool. A 1.0 database opens as one with no seat yet, and is given one.

## Store interface

See the [`Store` interface](../../src/store/store.ts) in `@kyneta/exchange` for the full contract: a `seat`, and eight methods, `append`, `loadAll`, `mark`, `compact`, `delete`, `currentMeta`, `listDocIds`, `close`.

With one owner, each write reads the document's last `seq` inside its transaction and writes after it, and nothing can come between.

## Testing

The package passes the full `describeStore` conformance suite exported from `@kyneta/exchange/testing`, including its seat section (`owned`: a reopen holds the same seat, a second open is refused), plus SQLite-specific tests for close/reopen persistence, sequence number continuity, adapter factories, and `tables` isolation.

## See also

- [`@kyneta/sql-store-core`](../sql-core/) — pure helpers shared with `postgres-store` and `prisma-store`.
- [`@kyneta/postgres-store`](../postgres/) — async-native Postgres backend.
- [`@kyneta/prisma-store`](../prisma/) — backend that takes a caller-supplied `PrismaClient`.