# @kyneta/sqlite-store — Technical Reference

> **Package**: `@kyneta/sqlite-store`
> **Role**: Universal SQL-family `Store` implementation for `@kyneta/exchange`. Wraps any SQLite binding behind a thin synchronous adapter (`SqliteAdapter`); ships factories for `better-sqlite3` and `bun:sqlite`. Designed to also fit Cloudflare DO `ctx.storage.sql` (cursor-yielding, sync) when a factory ships.
> **Depends on**: `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer). Optional driver dependency: `better-sqlite3` or `bun:sqlite`.
> **Depended on by**: Server, Bun, Cloudflare DO, and embedded-database applications.
> **Canonical symbols**: `SqliteStore`, `createSqliteStore`, `SqliteAdapter`, `SqliteStoreOptions`, `fromBetterSqlite3`, `fromBunSqlite`.
> **Key invariant(s)**: `append`'s meta-upsert + record-insert run inside a single `transaction(...)` — atomic. The `SqliteAdapter` interface is deliberately synchronous to preserve compatibility with all SQLite-family drivers (better-sqlite3, bun:sqlite, Cloudflare DO).

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
| `append` | `iterate` (currentMeta) → `iterate` (cold-start `MAX(seq)`) → `transaction(() => { exec (meta upsert if applicable); exec (record insert) })`. |
| `loadAll` | `iterate("SELECT kind, payload, blob FROM records WHERE doc_id = ? ORDER BY seq", docId)`. |
| `replace` | `transaction(() => { exec DELETE; for each: exec INSERT; exec meta upsert })`. |
| `delete` | `transaction(() => { exec DELETE records; exec DELETE meta })`. |
| `currentMeta` | `iterate("SELECT data FROM meta WHERE doc_id = ?")` → `JSON.parse`. |
| `listDocIds(prefix)` | `iterate("SELECT doc_id FROM meta WHERE doc_id LIKE ? ESCAPE '\\'")` with `escapeLike`. |
| `close` | `adapter.close()`. |

## Schema and the `tables` option

Two tables, created on first use via `#ensureSchema` (sync DDL — fast, errors are immediate, no factory layer needed):

```sql
CREATE TABLE IF NOT EXISTS kyneta_meta (
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
```

`SqliteStoreOptions.tables` overrides either or both names:

```ts
new SqliteStore(adapter, {
  tables: { meta: "app_meta", records: "app_records" },
})
```

`WITHOUT ROWID` makes the primary key the row identifier directly — saves space and a level of indirection on lookups when the PK is well-shaped (which it is here: short TEXT for meta, composite (TEXT, INTEGER) for records).

## Breaking change in v2.0.0

v1.x had `SqliteStoreOptions.tablePrefix?: string` defaulting to `""` — tables were named `meta` / `records` by default and `{prefix}meta` / `{prefix}records` with a prefix. v2.0.0 replaces this with `tables: { meta: string, records: string }` defaulting to `kyneta_meta` / `kyneta_records`. There is no compatibility shim. Migration is documented in [README.md](./README.md#migration-from-v1x).

The two-table contract makes "prefix" a misframing — there are exactly two tables, not arbitrary "kyneta things." Asking for table names directly is more honest.

## Atomic append

Pre-v2.0.0, `append` performed the meta upsert and the record insert as separate `exec` calls. A crash between them left the meta updated with no corresponding record — an atomicity bug. v2.0.0 wraps both writes in `transaction(() => …)`, exploiting the sync-by-default `transaction` method already implemented by both extant adapter factories. The conformance suite's fault-injected atomicity test catches the regression — the seam is `adapter.exec`, and arming "fail on the 2nd exec" forces the record-insert step to throw inside the transaction, which rolls back the meta upsert.

## seq-tracker post-commit ordering

In `replace`, `this.#seqNos.reset(docId, records.length - 1)` runs **lexically after** the sync `transaction(() => …)` call. If the transaction throws (rollback), the throw propagates past the `reset`, leaving the cache untouched. Critical: not inside the transaction callback — the cache is in-process state, not part of the database transaction; rollback would leave a stale cache pointing below the actual seq, causing primary-key collisions on subsequent appends.

## LIKE-pattern hazard handling

`listDocIds(prefix)` uses `LIKE prefix% ESCAPE '\'` with `escapeLike(prefix)` to escape `%`, `_`, and `\`. Doc IDs containing those characters are matched literally. (Postgres-store and Prisma-store use range scans instead — same end result, different mechanism.)

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
| `src/index.ts` | `SqliteStore`, `SqliteAdapter`, factory functions, `escapeLike` helper, schema DDL. |
| `src/__tests__/sqlite-store.test.ts` | Conformance suite (with fault factory + isolation factory) plus SQLite-specific tests (close+reopen, adapter factory, LIKE-pattern handling, two-store isolation). |

## Testing

Conformance suite from `@kyneta/exchange/testing` runs against an in-memory `:memory:` database; the fault-injection test uses a tmpfile so a fresh non-faulting Store can verify rollback state. Run with: `cd packages/exchange/stores/sqlite && pnpm verify`.
