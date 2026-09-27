# @kyneta/postgres-store — Technical Reference

> **Package**: `@kyneta/postgres-store`
> **Role**: Postgres `Store` implementation for `@kyneta/exchange`. Async-native, takes an injected `PgAdapter` (`fromPool` / `fromClient` over the caller's `pg` `Pool` / `Client`), validates schema via an async factory, uses JSONB for meta and BYTEA for blobs.
> **Depends on**: `pg` (peer, **type-only** — no runtime class coupling), `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer).
> **Depended on by**: Server applications that want Postgres durability behind an `Exchange`.
> **Canonical symbols**: `PostgresStore`, `createPostgresStore`, `PostgresStoreOptions`, `PgAdapter`, `PgQuerier`, `fromPool`, `fromClient`.
> **Key invariant(s)**: `append` and `compact` are atomic across meta + record writes (single transaction, owned by the injected adapter), and each reads the document's `MAX(seq)` inside that transaction under a per-document advisory lock, so several stores over one schema never take the same `seq`. Schema validation runs once at factory time (no auto-DDL, no runtime drift detection).

## Architecture

Async-native. The caller wraps their `pg` connection in a `PgAdapter` — `fromPool(pool)` (each transaction checks out a `PoolClient` and releases it) or `fromClient(client)` (transactions run inline). `PostgresStore` consumes the adapter and **never discriminates connection types at runtime** — the `Pool`-vs-`Client` choice is made at the call site, where the type is statically known, mirroring `SqliteStore`'s `SqliteAdapter` / `fromBetterSqlite3`. Consequently `pg` is a **type-only** import: no `instanceof`, no concrete-class coupling. `close()` is a no-op — the caller owns the lifecycle.

Recommended entry point is the async `createPostgresStore(fromPool(pool), options)` factory, which queries `information_schema.columns` to validate that the canonical schema exists with compatible column types. The `PostgresStore` constructor takes the same `PgAdapter` for advanced callers.

## The `Store` contract mapping

| Method | SQL |
|--------|-----|
| `append` | `BEGIN; SELECT pg_advisory_xact_lock(…); SELECT data FROM meta …; SELECT MAX(seq) …;` → `planAppend` → `INSERT ON CONFLICT … (meta upsert if applicable); INSERT INTO records … at MAX + 1; COMMIT`. |
| `loadAll` | `SELECT kind, payload, blob FROM records WHERE doc_id = $1 ORDER BY seq`. |
| `mark` | `SELECT MAX(seq) FROM records WHERE doc_id = $1`. |
| `compact` | `BEGIN; SELECT pg_advisory_xact_lock(…); SELECT data FROM meta …; SELECT MAX(seq) …;` → `planCompact` → `DELETE FROM records … AND seq <= $through; INSERT INTO records … (per row, from MAX + 1); INSERT ON CONFLICT … (meta upsert); COMMIT`. |
| `delete` | `BEGIN; DELETE FROM records …; DELETE FROM meta …; COMMIT`. |
| `currentMeta` | `SELECT data FROM meta WHERE doc_id = $1`. JSONB → JS object via `pg`'s built-in parser. |
| `listDocIds(prefix)` | Range scan: `WHERE doc_id >= $1 AND doc_id < $2` where `$2 = successor(prefix)`. |
| `close` | No-op. |

## Schema validation flow

`createPostgresStore` queries `information_schema.columns` for all three tables (`doc_meta`, `records`, `store_meta`) and asserts:

- All three tables exist.
- Each expected column is present with a compatible `data_type` (Postgres types: `text`, `jsonb`, `integer`, `bytea`).
- A curated error names the missing table or column on failure.

Validation does **not** auto-DDL. Postgres convention is migrations-as-deployment-step; the `schema.sql` file ships canonical DDL for callers to include in their migration pipeline. (The per-document table was renamed `kyneta_meta` → `kyneta_doc_meta`, and `kyneta_store_meta` was added — adopting both in an existing deployment is an explicit migration.)

After validation, the factory runs the **store-format gate**: it reads `store_meta.format`, probes whether `doc_meta` holds any rows, and via `decideStoreFormat` either stamps a brand-new store (`INSERT … ON CONFLICT DO NOTHING` — one idempotent row, *not* DDL, so the no-auto-DDL invariant holds), accepts a compatible major, or throws `StoreFormatVersionError` (incompatible major, or unversioned data already present). No migration is performed.

### Runtime drift

Schema validation runs once at factory time. If a DBA alters the schema while the Exchange is running, the change is not detected — re-run `createPostgresStore` after migrations (which means restarting the Exchange). This is a known and accepted limitation; building a `revalidate()` API would be over-engineering for the failure-mode frequency.

## JSONB rationale

`meta.data` is JSONB, not TEXT. The choice gives operators a small amount of queryability (`data->>'syncMode'`, `data->>'replicaType'`) for admin tooling — useful when filtering metas during incident investigations. The cost: byte-level non-identity with SQLite's TEXT-stored meta. Round-trip portability through `loadAll` is preserved by construction (both backends consume `toRow`/`fromRow` from `@kyneta/sql-store-core`); admins doing a `pg_dump`-and-restore through sqlite or vice versa get structural equality, not byte equality.

## Range scan instead of LIKE

`listDocIds(prefix)` uses `WHERE doc_id >= prefix AND doc_id < successor(prefix)` — not `LIKE`. The successor is computed by incrementing the last code unit of the prefix (`/` (0x2F) → `0` (0x30), and so on). Doc IDs containing `%` and `_` are matched literally, eliminating the LIKE-pattern hazard that motivated SQLite's `escapeLike` helper.

## Adapter semantics: `fromPool` vs `fromClient`

The `PgAdapter` interface is `{ query, transaction }` — the two capabilities `PostgresStore` needs. Each factory owns the transaction protocol so the store never branches on connection type:

- **`fromPool(pool)`** — `transaction(fn)` checks out one `PoolClient` for the duration (BEGIN…COMMIT/ROLLBACK on that single physical connection, since Postgres transactions are connection-scoped) and `release()`s it in `finally`. `query` (non-transactional reads: `currentMeta`, `loadAll`, `listDocIds`, `mark`) goes to the pool directly — no held connection needed.
- **`fromClient(client)`** — `transaction(fn)` runs BEGIN…COMMIT/ROLLBACK inline on the one connection (a standalone `Client` or an already-checked-out `PoolClient`). This is also the seam the conformance fault test wraps: `fromClient(makeArmedFault(client, { query: 1 }))`.

Both re-throw on rollback. Replacing the former runtime `Pool`/`Client` sniff with adapter injection also fixed a bug: a bare `Client` previously mis-routed to the pool branch and threw on `release()`; now `fromClient` handles it correctly.

## Several stores over one schema

Several stores may open one set of tables: the processes of one server fleet. Each write reads the document's `MAX(seq)` and inserts after it, inside one transaction that first takes `pg_advisory_xact_lock(hashtext('<records table>:<doc_id>'))`. Writers of one document therefore take turns, and the lock is released at commit or rollback. A `hashtext` collision only makes two documents take turns too. An earlier version cached the next `seq` per document in memory, seeded once from `MAX(seq)`; two processes then handed out the same `seq`, and the second insert failed on the primary key.

Distinct `tables` sets are for separate storages in one database (test isolates, unrelated Exchanges), not for keeping instances of one deployment apart.

## Byte-portability with sqlite-store

Records table is byte-identical (TEXT + BYTEA in Postgres ↔ TEXT + BLOB in SQLite, both populated from the same `toRow` output). Meta table is round-trip portable but not byte-identical (JSONB normalizes; TEXT doesn't). The integration test in `tests/integration/src/exchange-postgres/` round-trips a Yjs doc through both backends and verifies structural equality on `loadAll`.

## Key Types

| Type | Role |
|------|------|
| `PostgresStore` | Sync-constructed Store; advanced callers only. |
| `createPostgresStore` | Async factory. Validates schema, returns a ready Store. |
| `PostgresStoreOptions` | `{ tables?: Partial<TableNames> }`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | `PostgresStore` class, `createPostgresStore` factory, `validateSchema`, `prefixUpperBound`. |
| `schema.sql` | Canonical DDL — run once or include in migrations. |
| `src/__tests__/postgres-store.test.ts` | Conformance suite + Postgres-specific tests, gated by `KYNETA_PG_URL`. |

## Testing

Conformance suite + Postgres-specific tests run when `KYNETA_PG_URL` is set:

```sh
KYNETA_PG_URL=postgres://localhost:5432/kyneta_test pnpm verify
```

Postgres-specific tests cover: `createPostgresStore` validation errors (missing tables, missing columns, wrong column types), range-scan correctness on doc IDs containing `%` and `_`, fault-injected atomicity, storage-domain isolation across two `tables` pairs.
