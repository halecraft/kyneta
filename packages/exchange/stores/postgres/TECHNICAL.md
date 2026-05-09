# @kyneta/postgres-store — Technical Reference

> **Package**: `@kyneta/postgres-store`
> **Role**: Postgres `Store` implementation for `@kyneta/exchange`. Async-native, takes a caller-supplied `pg` `Client` or `Pool`, validates schema via an async factory, uses JSONB for meta and BYTEA for blobs.
> **Depends on**: `pg` (peer), `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer).
> **Depended on by**: Server applications that want Postgres durability behind an `Exchange`.
> **Canonical symbols**: `PostgresStore`, `createPostgresStore`, `PostgresStoreOptions`.
> **Key invariant(s)**: `append` and `replace` are atomic across meta + record writes (single transaction). Schema validation runs once at factory time (no auto-DDL, no runtime drift detection). The seq-tracker mutation in `replace` runs lexically after the awaited transaction — a rejection propagates past it.

## Architecture

Async-native. The caller supplies a `pg` `Client | Pool`; the store calls `pool.connect()` / `release()` per transaction or runs against the single `Client`. `close()` is a no-op — the caller owns the lifecycle.

Recommended entry point is the async `createPostgresStore(client, options)` factory, which queries `information_schema.columns` to validate that the canonical schema exists with compatible column types. The sync `PostgresStore` constructor is exported for advanced callers.

## The `Store` contract mapping

| Method | SQL |
|--------|-----|
| `append` | `SELECT MAX(seq)` (only on cold start per docId) → `planAppend` → `BEGIN; INSERT ON CONFLICT … (meta upsert if applicable); INSERT INTO records …; COMMIT`. |
| `loadAll` | `SELECT kind, payload, blob FROM records WHERE doc_id = $1 ORDER BY seq`. |
| `replace` | `BEGIN; DELETE FROM records …; INSERT INTO records … (per row); INSERT ON CONFLICT … (meta upsert); COMMIT`. |
| `delete` | `BEGIN; DELETE FROM records …; DELETE FROM meta …; COMMIT`. |
| `currentMeta` | `SELECT data FROM meta WHERE doc_id = $1`. JSONB → JS object via `pg`'s built-in parser. |
| `listDocIds(prefix)` | Range scan: `WHERE doc_id >= $1 AND doc_id < $2` where `$2 = successor(prefix)`. |
| `close` | No-op. |

## Schema validation flow

`createPostgresStore` queries `information_schema.columns` for both tables (`meta` and `records`) and asserts:

- Both tables exist.
- Each expected column is present with a compatible `data_type` (Postgres types: `text`, `jsonb`, `integer`, `bytea`).
- A curated error names the missing table or column on failure.

Validation does **not** auto-DDL. Postgres convention is migrations-as-deployment-step; the `schema.sql` file ships canonical DDL for callers to include in their migration pipeline.

### Runtime drift

Schema validation runs once at factory time. If a DBA alters the schema while the Exchange is running, the change is not detected — re-run `createPostgresStore` after migrations (which means restarting the Exchange). This is a known and accepted limitation; building a `revalidate()` API would be over-engineering for the failure-mode frequency.

## JSONB rationale

`meta.data` is JSONB, not TEXT. The choice gives operators a small amount of queryability (`data->>'syncProtocol'`, `data->>'replicaType'`) for admin tooling — useful when filtering metas during incident investigations. The cost: byte-level non-identity with SQLite's TEXT-stored meta. Round-trip portability through `loadAll` is preserved by construction (both backends consume `toRow`/`fromRow` from `@kyneta/sql-store-core`); admins doing a `pg_dump`-and-restore through sqlite or vice versa get structural equality, not byte equality.

## Range scan instead of LIKE

`listDocIds(prefix)` uses `WHERE doc_id >= prefix AND doc_id < successor(prefix)` — not `LIKE`. The successor is computed by incrementing the last code unit of the prefix (`/` (0x2F) → `0` (0x30), and so on). Doc IDs containing `%` and `_` are matched literally, eliminating the LIKE-pattern hazard that motivated SQLite's `escapeLike` helper.

## Pool semantics

When the caller supplies a `Pool`, transaction methods check out one `PoolClient` for the duration of the transaction (BEGIN…COMMIT/ROLLBACK) and release on commit/rollback. Non-transactional reads (`currentMeta`, `loadAll`, `listDocIds`, the cold-start `MAX(seq)` lookup) use the pool directly via `pool.query` — these don't need a held connection.

The `#withTransaction(fn)` helper centralizes the BEGIN/COMMIT/ROLLBACK protocol and the checkout/release plumbing. It re-throws on rollback so callers place post-commit work (e.g. `seqNos.reset` in `replace`) lexically after the awaited call.

## Multi-process namespacing

Each Exchange owns one `tables` pair. Multiple Exchanges (or test isolates) sharing the same database use distinct `tables` pairs; no two Exchanges should write to the same tables.

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
