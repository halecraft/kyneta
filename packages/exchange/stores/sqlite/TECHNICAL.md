# @kyneta/sqlite-store — Technical Reference

> **Package**: `@kyneta/sqlite-store`
> **Role**: Universal SQL-family `Store` implementation for `@kyneta/exchange`. Wraps any SQLite binding behind a thin synchronous adapter (`SqliteAdapter`); ships factories for `better-sqlite3` and `bun:sqlite`. Designed to also fit Cloudflare DO `ctx.storage.sql` (cursor-yielding, sync) when a factory ships.
> **Depends on**: `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer). Optional driver dependency: `better-sqlite3` or `bun:sqlite`.
> **Depended on by**: Server, Bun, Cloudflare DO, and embedded-database applications.
> **Canonical symbols**: `SqliteStore`, `createSqliteStore`, `SqliteAdapter`, `SqliteStoreOptions`, `fromBetterSqlite3`, `fromBunSqlite`.
> **Key invariant(s)**: `append`'s meta-upsert + record-insert run inside a single `transaction(...)` — atomic — and so does `compact`. Both read the meta and `MAX(seq)` inside that transaction, which takes the write lock when it begins, so several stores over one database file never take the same `seq`. The `SqliteAdapter` interface is deliberately synchronous to preserve compatibility with all SQLite-family drivers (better-sqlite3, bun:sqlite, Cloudflare DO).

## Architecture

`SqliteStore` is a thin mapping from `Store` methods onto a four-method synchronous adapter (`exec` / `iterate` / `transaction` / `close`). The caller chooses a SQLite binding and constructs an adapter via `fromBetterSqlite3(db)` / `fromBunSqlite(db)`, or implements `SqliteAdapter` against any other binding.

Pure serialization helpers (`toRow`, `fromRow`, `RowShape`, `EntryPayloadJson`, `normalizeBlob`, `planAppend`, `planReplace`) live in `@kyneta/sql-store-core` and are shared with `@kyneta/postgres-store` and `@kyneta/prisma-store`.

## Why a synchronous adapter

The adapter is sync because every relevant SQLite-family binding is sync:

- `better-sqlite3` is sync by design.
- `bun:sqlite` is sync by design.
- Cloudflare DO `ctx.storage.sql.exec(sql, ...params)` returns a synchronous cursor.

A unified async adapter would force every implementation to wrap with a Promise per call — a real cost on hot paths and no benefit, since the underlying I/O is in-memory or fast-disk. Postgres-store and Prisma-store live in separate packages where async-native makes sense; the SQLite-family stays sync.

The Cloudflare DO factory does not yet exist — only the design accommodates it. Adding one requires a `fromCloudflareDO(ctx)` export that pass-through maps onto `ctx.storage.sql`.

## The `Store` contract mapping

| Method | SQL |
|--------|-----|
| `append` | `transaction(() => { iterate (meta); iterate (MAX(seq)); exec (meta upsert if applicable); exec (record insert at MAX + 1) })`. |
| `loadAll` | `iterate("SELECT kind, payload, blob FROM records WHERE doc_id = ? ORDER BY seq", docId)`. |
| `mark` | `iterate("SELECT MAX(seq) …")`. |
| `compact` | `transaction(() => { iterate (meta); iterate (MAX(seq)); exec DELETE seq <= through; for each: exec INSERT from MAX + 1; exec meta upsert })`. |
| `delete` | `transaction(() => { exec DELETE records; exec DELETE meta })`. |
| `currentMeta` | `iterate("SELECT data FROM meta WHERE doc_id = ?")` → `JSON.parse`. |
| `listDocIds(prefix)` | `iterate("SELECT doc_id FROM meta WHERE doc_id >= ? AND doc_id < ?")` over `[prefix, prefixSuccessor(prefix, "code-point"))`. |
| `close` | `adapter.close()`. |

## Schema and the `tables` option

Three tables, created on first use via `#ensureSchema` (sync DDL — fast, errors are immediate, no factory layer needed):

```sql
CREATE TABLE IF NOT EXISTS kyneta_doc_meta (
  doc_id  TEXT PRIMARY KEY,
  data    TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kyneta_records (
  doc_id  TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  payload TEXT,
  blob    BLOB,
  PRIMARY KEY (doc_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS kyneta_store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
```

The constructor then runs the **store-format gate**: it reads `store_meta.format`, probes whether `doc_meta` holds rows, and via `@kyneta/exchange`'s `decideStoreFormat` stamps a brand-new store, accepts a compatible one, or throws `StoreFormatVersionError`. `store_meta` is store-global metadata keyed by an opaque `key` (the format version under `key = "format"`), distinct from the per-document `doc_meta`. No migration is performed.

`SqliteStoreOptions.tables` overrides any subset of the names:

```ts
new SqliteStore(adapter, {
  tables: { docMeta: "app_doc_meta", records: "app_records", storeMeta: "app_store_meta" },
})
```

`WITHOUT ROWID` makes the primary key the row identifier directly — saves space and a level of indirection on lookups when the PK is well-shaped (which it is here: short TEXT for doc-meta, composite (TEXT, INTEGER) for records).

## Breaking change in v2.0.0

v1.x had `SqliteStoreOptions.tablePrefix?: string` defaulting to `""` — tables were named `meta` / `records` by default and `{prefix}meta` / `{prefix}records` with a prefix. The current option is `tables: { docMeta, records, storeMeta }` defaulting to `kyneta_doc_meta` / `kyneta_records` / `kyneta_store_meta`. There is no compatibility shim. Migration is documented in [README.md](./README.md#migration-from-v1x).

The named-table contract makes "prefix" a misframing — there is a fixed set of tables, not arbitrary "kyneta things." Asking for table names directly is more honest.

## Atomic append

Pre-v2.0.0, `append` performed the meta upsert and the record insert as separate `exec` calls. A crash between them left the meta updated with no corresponding record — an atomicity bug. v2.0.0 wraps both writes in `transaction(() => …)`, exploiting the sync-by-default `transaction` method already implemented by both extant adapter factories. The conformance suite's fault-injected atomicity test catches the regression — the seam is `adapter.exec`, and arming "fail on the 2nd exec" forces the record-insert step to throw inside the transaction, which rolls back the meta upsert.

## Sequence numbers come from the table

Several stores may open one database file: two processes, or two connections in one. Each write reads `MAX(seq)` for the document and inserts after it, inside one transaction. That is sound only if no other writer comes between the read and the insert, so `SqliteAdapter.transaction` must take the write lock when it begins (`BEGIN IMMEDIATE`), not at its first write, as a deferred transaction would. The built-in adapters use `.immediate()`. The store sets `PRAGMA busy_timeout = 5000` on open, so a second writer waits for the lock rather than failing at once, whatever the driver's default.

An earlier version cached the next `seq` per document in memory, seeded once from `MAX(seq)`. Two instances over one table then handed out the same `seq`, and the second insert failed on the primary key.

## Prefix scans

`listDocIds(prefix)` scans the range `[prefix, prefixSuccessor(prefix, "code-point"))` (`@kyneta/exchange`). SQLite's default `BINARY` collation compares UTF-8 bytes, which is code-point order, so the range is exactly the ids starting with `prefix`, and it uses the primary-key index. `%` and `_` have no special meaning in a range.

It used `LIKE prefix% ESCAPE '\'` with an `escapeLike` helper. SQLite's `LIKE` ignores ASCII case, so prefix `users/` also returned `Users/Bob`, and it cannot use the index.

## What this package is NOT

- **Not opinionated about the SQLite binding.** Any object satisfying `SqliteAdapter` works. The two shipped factories cover the common cases.
- **Not async-uniform.** The synchronous adapter is load-bearing; trying to unify it with the async Postgres/Prisma stores would dilute SQLite-family ergonomics.
- **Not multi-process safe.** Use a separate `tables` pair per Exchange when sharing a database.

## Key Types

| Type | Role |
|------|------|
| `SqliteStore` | The `Store` implementation. |
| `SqliteAdapter` | Four-method synchronous database interface. |
| `SqliteStoreOptions` | `{ tables?: Partial<TableNames> }`. |
| `fromBetterSqlite3` / `fromBunSqlite` | Adapter factories for the two production-supported drivers. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | `SqliteStore`, `SqliteAdapter`, factory functions, schema DDL. |
| `src/__tests__/sqlite-store.test.ts` | Conformance suite (with fault factory + isolation factory) plus SQLite-specific tests (close+reopen, adapter factory, two-store isolation). Prefix scans are covered by the conformance suite. |

## Testing

Conformance suite from `@kyneta/exchange/testing` runs against an in-memory `:memory:` database; the fault-injection test uses a tmpfile so a fresh non-faulting Store can verify rollback state. Run with: `cd packages/exchange/stores/sqlite && pnpm verify`.
