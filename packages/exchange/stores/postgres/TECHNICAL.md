# @kyneta/postgres-store — Technical Reference

> **Package**: `@kyneta/postgres-store`
> **Role**: Postgres `Store` implementation for `@kyneta/exchange`. Async-native, takes an injected `PgAdapter` (`fromPool` / `fromClient` over the caller's `pg` `Pool` / `Client`), validates schema via an async factory, uses JSONB for meta and BYTEA for blobs.
> **Depends on**: `pg` (peer, **type-only** — no runtime class coupling), `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer).
> **Depended on by**: Server applications that want Postgres durability behind an `Exchange`.
> **Canonical symbols**: `PostgresStore`, `createPostgresStore`, `PostgresStoreOptions`, `PgAdapter`, `PgDedicated`, `PgQuerier`, `fromPool`, `fromClient`.
> **Key invariant(s)**: `append` and `compact` are atomic across meta + record writes (single transaction, owned by the injected adapter), and each reads the document's `MAX(seq)` inside that transaction under a per-document advisory lock, so several stores over one schema never take the same `seq`. Each store holds a pooled seat through a session-level advisory lock in the two-key space, on a connection of its own; a seat lock is only ever taken while holding the pool row's lock; every write checks the seat's fence `FOR SHARE`. Schema validation runs once at factory time (no auto-DDL, no runtime drift detection).

## Architecture

Async-native. The caller wraps their `pg` connection in a `PgAdapter` — `fromPool(pool)` (each transaction checks out a `PoolClient` and releases it) or `fromClient(client)` (transactions run inline). `PostgresStore` consumes the adapter and **never discriminates connection types at runtime** — the `Pool`-vs-`Client` choice is made at the call site, where the type is statically known, mirroring `SqliteStore`'s `SqliteAdapter` / `fromBetterSqlite3`. Consequently `pg` is a **type-only** import: no `instanceof`, no concrete-class coupling. The caller owns the pool or client; `close()` releases the store's seat and its dedicated connection.

The entry point is the async `PostgresStore.open(adapter, options)`, which `createPostgresStore` delegates to: it queries `information_schema.columns` to validate that the canonical schema exists with compatible column types, then takes a seat (see [Seats](#seats)). The constructor is private: a store is born holding its seat.

## The `Store` contract mapping

| Method | SQL |
|--------|-----|
| `append` | `BEGIN; SELECT value FROM store_meta WHERE key = 'seats' FOR SHARE` → `assertSeatHeld`; `SELECT pg_advisory_xact_lock(…); SELECT data FROM meta …; SELECT MAX(seq) …;` → `planAppend` → `INSERT ON CONFLICT … (meta upsert if applicable); INSERT INTO records … at MAX + 1; COMMIT`. |
| `loadAll` | `SELECT kind, payload, blob FROM records WHERE doc_id = $1 ORDER BY seq`. |
| `mark` | `SELECT MAX(seq) FROM records WHERE doc_id = $1`. |
| `compact` | `BEGIN;` the fence, as `append`; `SELECT pg_advisory_xact_lock(…); SELECT data FROM meta …; SELECT MAX(seq) …;` → `planCompact` → `DELETE FROM records … AND seq <= $through; INSERT INTO records … (per row, from MAX + 1); INSERT ON CONFLICT … (meta upsert); COMMIT`. |
| `delete` | `BEGIN;` the fence, as `append`; `DELETE FROM records …; DELETE FROM meta …; COMMIT`. |
| `currentMeta` | `SELECT data FROM meta WHERE doc_id = $1`. JSONB → JS object via `pg`'s built-in parser. |
| `listDocIds(prefix)` | Range scan: `WHERE doc_id >= $1 AND doc_id < $2` where `$2 = successor(prefix)`. |
| `close` | `pg_advisory_unlock` on the dedicated connection, which then goes back to the pool (or is ended, if it failed). A closed store refuses every operation. |

## Schema validation flow

`createPostgresStore` queries `information_schema.columns` for all three tables (`doc_meta`, `records`, `store_meta`) and asserts:

- All three tables exist.
- Each expected column is present with a compatible `data_type` (Postgres types: `text`, `jsonb`, `integer`, `bytea`).
- Both `doc_id` columns have `COLLATE "C"` (see "Range scan instead of LIKE").
- A curated error names the missing table or column on failure, and for a wrong collation gives the `ALTER TABLE` that fixes it.

Validation does **not** auto-DDL. Postgres convention is migrations-as-deployment-step; the `schema.sql` file ships canonical DDL for callers to include in their migration pipeline. The DDL has one source, `postgresSchema(tables?)` (`src/schema.ts`): `schema.sql` is its output for the default names, a test keeps the two equal, and every test creates its tables from it. (The per-document table was renamed `kyneta_meta` → `kyneta_doc_meta`, and `kyneta_store_meta` was added — adopting both in an existing deployment is an explicit migration.)

After validation, `open` checks the store format and takes a seat in one transaction ([Seats](#seats)): it reads `store_meta`'s `format` and `seats` rows, probes whether `doc_meta` holds any rows, and runs `planStoreOpen`, which stamps a brand-new store (row writes, *not* DDL, so the no-auto-DDL invariant holds), accepts a compatible major, or throws `StoreFormatVersionError` (incompatible major, or unversioned data already present). No migration is performed. The format is 1.1 (`sql-store-core`'s, shared with sqlite and prisma): `store_meta` holds the seat pool; a 1.0 store reads as one with an empty pool.

### Runtime drift

Schema validation runs once at factory time. If a DBA alters the schema while the Exchange is running, the change is not detected — re-run `createPostgresStore` after migrations (which means restarting the Exchange). This is a known and accepted limitation; building a `revalidate()` API would be over-engineering for the failure-mode frequency.

## JSONB rationale

`meta.data` is JSONB, not TEXT. The choice gives operators a small amount of queryability (`data->>'syncMode'`, `data->>'replicaType'`) for admin tooling — useful when filtering metas during incident investigations. The cost: byte-level non-identity with SQLite's TEXT-stored meta. Round-trip portability through `loadAll` is preserved by construction (both backends consume `toRow`/`fromRow` from `@kyneta/sql-store-core`); admins doing a `pg_dump`-and-restore through sqlite or vice versa get structural equality, not byte equality.

## Range scan instead of LIKE

`listDocIds(prefix)` uses `WHERE doc_id >= prefix AND doc_id < successor(prefix)` — not `LIKE`. The successor is computed by incrementing the last code point of the prefix (`/` (0x2F) → `0` (0x30), and so on). Doc IDs containing `%` and `_` are matched literally. The successor is `prefixSuccessor(prefix, "code-point")` from `@kyneta/exchange`, shared with SQLite, LevelDB and IndexedDB.

**The range is the set of ids with that prefix only in code-point order**, which is why `doc_id` is `COLLATE "C"`: UTF-8 byte order is code-point order, and the primary-key index stays usable. Under a locale collation such as `en_US.utf8`, the default almost everywhere, punctuation is nearly ignored: `'users/alice' < 'users0'` is false, and a prefix like `users/` returned nothing. The conformance suite had asserted this all along, but never ran against a real Postgres until `scripts/postgres.sh` gave the repository one. Document ids are opaque identifiers, so byte order is also the right meaning. Rejected: `COLLATE "C"` inside the query, which cannot use the index built under the column's collation, and `starts_with(doc_id, prefix)`, which is correct under any collation but always scans.

## Adapter semantics: `fromPool` vs `fromClient`

The `PgAdapter` interface is `{ query, transaction, dedicated }` — the three capabilities `PostgresStore` needs. Each factory owns the transaction protocol so the store never branches on connection type:

- **`fromPool(pool)`** — `transaction(fn)` checks out one `PoolClient` for the duration (BEGIN…COMMIT/ROLLBACK on that single physical connection, since Postgres transactions are connection-scoped) and `release()`s it in `finally`. `query` (non-transactional reads: `currentMeta`, `loadAll`, `listDocIds`, `mark`) goes to the pool directly — no held connection needed. `dedicated()` checks out one more `PoolClient` for the store's lifetime, listening for its `error` event while held (an unheard one would crash the process), and `release(destroy)` returns it or ends it.
- **`fromClient(client)`** — `transaction(fn)` runs BEGIN…COMMIT/ROLLBACK inline on the one connection (a standalone `Client` or an already-checked-out `PoolClient`), and `dedicated()` is that connection too, which the caller owns, so releasing it does nothing. This is also the seam the conformance fault test wraps: `fromClient(makeArmedFault(client, { query: 1 }))`.

Both re-throw on rollback. Replacing the former runtime `Pool`/`Client` sniff with adapter injection also fixed a bug: a bare `Client` previously mis-routed to the pool branch and threw on `release()`; now `fromClient` handles it correctly.

## Several stores over one schema

Several stores may open one set of tables: the processes of one server fleet. Each write reads the document's `MAX(seq)` and inserts after it, inside one transaction that first takes `pg_advisory_xact_lock(hashtext('<records table>:<doc_id>'))`. Writers of one document therefore take turns, and the lock is released at commit or rollback. A `hashtext` collision only makes two documents take turns too.

## Seats

Source: `src/index.ts` → `PostgresStore.open`, `openSeat`, `#fence`, `close`.

Each store holds a **pooled** seat (see §"Durable seats" in `packages/exchange/TECHNICAL.md`). The pool, and each seat's fence, live in `store_meta` under `key = 'seats'`.

**The seat lock** is a session-level advisory lock, `pg_try_advisory_lock(hashtext(<store-meta table>), hashtext(peerId))`, taken on the store's dedicated connection and held until `close()`. Session-level locks belong to the connection that takes them and are released when it ends, so a dead process frees its seat; that is why the whole allocation runs on the dedicated connection, not through the pool.

**Seat locks live in the two-key lock space; per-document write locks in the one-key space.** The manual says the two spaces do not overlap, and they must not share one: a seat lock is held for its connection's lifetime, so a document whose write key equalled a held seat's key would have every write wait until that process ended. With `hashtext`'s 32 bits, a million documents and ten seats would collide somewhere with about 0.25% probability. Within the two-key space, two seats whose keys collide only make a free seat look held, which is harmless.

**Allocation**, in one transaction on the dedicated connection:

1. **The allocation lock is the pool's row**: insert the `seats` row if absent, then `SELECT … FOR UPDATE` it, held until commit. A row lock cannot collide with any advisory lock, as an allocation lock in the advisory space could with a seat whose key happened to equal it (and that seat's holder would then block every allocation for its lifetime).
2. **Gather**: the `format` row, whether any document exists, and the held seat locks, from `pg_locks` (`locktype = 'advisory'`, `objsubid = 2`, this database, `classid = hashtext(<store-meta table>)::oid`): a pool seat is held when its `hashtext(peerId)::oid` is among the held `objid`s. A seat lock is only ever taken while holding the row lock, so this snapshot is authoritative: held seats can be released meanwhile, never taken.
3. **Plan**: `planStoreOpen` with `pooled` seating.
4. **Execute**: `pg_try_advisory_lock` on the chosen seat, which the snapshot shows free, so a refusal means the invariant was broken and the open fails. Then write the format marker (for a new store) and the pool, and commit. If anything after the seat lock fails, the lock is released after the rollback: it is session-level, so the rollback leaves it held, and an aborted transaction runs no statement.

**The fence.** Every write transaction reads the pool row `FOR SHARE` and calls `assertSeatHeld`. Shared row locks do not conflict with each other, but they do with an allocation's `FOR UPDATE`: an allocation waits for writes in flight, and a write that starts during an allocation waits for it and then reads its fence (under `READ COMMITTED`, the row's latest version). So no write lands after a new holder has taken the seat and hydrated.

**The writer of a serialized document** is `doc_meta.writer`, `NULL` while unclaimed. Checks run in the order fence, then the per-document lock (`#lockDoc`), then the writer, so the document lock serializes two processes' first claims. An authored write records the store's seat when none is recorded and throws `WriterRefusedError` when another seat is; an unauthored one keeps the record (the meta upsert writes back the writer it read); `delete`, which now takes the document lock too, is refused when another seat is the writer. `validateSchema` refuses a doc-meta table without `writer`, and the error gives the migration, `ALTER TABLE <doc-meta table> ADD COLUMN writer TEXT;`. No format bump: column validation already guards the schema, and the format version is shared with SQLite and Prisma, which do not change.

**Abandonment** is `pg_terminate_backend` on the dedicated connection's backend, from another connection, which is what a crash looks like: the seat lock goes, the store's writes still reach the database through the pool, and the fence rejects them once another store takes the seat. An earlier version cached the next `seq` per document in memory, seeded once from `MAX(seq)`; two processes then handed out the same `seq`, and the second insert failed on the primary key.

Distinct `tables` sets are for separate storages in one database (test isolates, unrelated Exchanges), not for keeping instances of one deployment apart.

## Byte-portability with sqlite-store

Records table is byte-identical (TEXT + BYTEA in Postgres ↔ TEXT + BLOB in SQLite, both populated from the same `toRow` output). Meta table is round-trip portable but not byte-identical (JSONB normalizes; TEXT doesn't). The integration test in `tests/integration/src/exchange-postgres/` round-trips a Yjs doc through both backends and verifies structural equality on `loadAll`.

## Key Types

| Type | Role |
|------|------|
| `PostgresStore` | The Store; opened by `PostgresStore.open`, which validates the schema and takes a seat. |
| `createPostgresStore` | Async factory, delegating to `PostgresStore.open`. |
| `PgAdapter`, `PgDedicated` | The connection capability the store needs, including a connection for its lifetime. |
| `postgresSchema` | The canonical DDL for given table names; the one source of the schema. |
| `pgTestServer`, `pgTestDatabase` (`@kyneta/postgres-store/testing`) | The `KYNETA_PG_URL` server or `null`; the URL of a named database on it, created if missing. |
| `PostgresStoreOptions` | `{ tables?: Partial<TableNames> }`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | `PostgresStore` class, `createPostgresStore` factory, `PgAdapter` and its factories, `openSeat`, `validateSchema`. |
| `src/schema.ts` | `postgresSchema`, `DOC_ID_COLLATION`. |
| `src/testing.ts` | `pgTestServer`, `pgTestDatabase`, exported as `@kyneta/postgres-store/testing`. |
| `schema.sql` | Canonical DDL — `postgresSchema()` for the default names. Run once or include in migrations. |
| `src/__tests__/schema.test.ts` | `schema.sql` equals `postgresSchema()`; runs without Postgres. |
| `src/__tests__/postgres-store.test.ts` | Conformance suite + Postgres-specific tests, gated by `KYNETA_PG_URL`. |

## Testing

Conformance suite + Postgres-specific tests run when `KYNETA_PG_URL` is set. `scripts/postgres.sh` (repository root) runs a disposable Postgres in Docker and prints the variable to export:

```sh
eval "$(scripts/postgres.sh up)" && pnpm verify
scripts/postgres.sh down   # remove the container and its data
```

A database created by an earlier schema keeps its old tables, since the DDL is `CREATE TABLE IF NOT EXISTS`; `down` then `up` starts clean.

**Each suite has a database of its own**, and recreates its tables from the current `postgresSchema()` before it runs (`pgResetTables` in `@kyneta/postgres-store/testing`), so a schema change needs no reset of the container. `pnpm verify` runs packages in parallel, and two suites sharing one database truncate each other's tables mid-test. `pgTestDatabase(name)` returns the URL of database `name` on the `KYNETA_PG_URL` server, creating it if missing, and `pgTestServer()` is that server or `null`, which is how a suite decides to skip: this suite uses `kyneta_postgres_store`, and `tests/integration` one per storage tier (`kyneta_it_server`, `kyneta_it_client`).

**`KYNETA_PG_URL` is declared in `turbo.json`** (`env` on `verify` and `test`). Turbo 2 runs tasks in strict env mode, so an undeclared variable never reached them: `KYNETA_PG_URL=… pnpm verify` skipped every Postgres suite, and its cache could not tell the two runs apart.

Postgres-specific tests cover: `createPostgresStore` validation errors (missing tables, missing columns, wrong column types, a `doc_id` without `COLLATE "C"`), range-scan correctness on doc IDs containing `%` and `_`, fault-injected atomicity at every step (the fence read included), storage-domain isolation across two `tables` pairs, and seat allocation: concurrent opens take distinct seats without waiting on each other, and a seat freed by `pg_terminate_backend` is reused. The conformance seat section (`pooled`) runs on tables of its own, and every conformance test truncates `store_meta` too, so no pool leaks from one test into the next.
