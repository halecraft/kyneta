# @kyneta/sql-store-core — Technical Reference

> **Package**: `@kyneta/sql-store-core`
> **Role**: Pure helpers shared by every SQL-family `Store` backend (`@kyneta/sqlite-store`, `@kyneta/postgres-store`, `@kyneta/prisma-store`).
> **Depends on**: `@kyneta/exchange` (peer), `@kyneta/schema` (peer). Zero runtime dependencies.
> **Depended on by**: All three SQL-family store packages.
> **Canonical symbols**: `RowShape`, `EntryPayloadJson`, `toRow`, `fromRow`, `normalizeBlob`, `DEFAULT_TABLES`, `TableNames`, `resolveTables`, `AppendPlan`, `ReplacePlan`, `planAppend`, `planReplace`, `failOnNthCall`.
> **Key invariant(s)**: Pure code only — no SQL templates, no I/O, no driver knowledge. Every SQL-family backend that consumes `toRow`/`fromRow` produces a byte-identical (kind, payload, blob) triple in its records table; round-trip portability through `loadAll` is preserved across backends.

A driver-agnostic foundation for the SQL-family `Store` implementations. Holds the shared serialization core (`RowShape`, `toRow`, `fromRow`, `normalizeBlob`) and a pair of pure planning functions (`planAppend`, `planReplace`) that each backend executes inside a backend-specific transaction. Also exposes `failOnNthCall` for the conformance suite's fault-injection atomicity test.

## What this package is NOT

- **Not a `DatabaseAdapter` interface.** Each SQL-family backend implements `Store` directly with idioms native to its driver (sync `SqliteAdapter` for SQLite-family, async `pg` for Postgres, async Prisma client for Prisma). A unified adapter contract collapses on inspection — once enough SQL is pushed in to make it ORM-friendly, it converges on `Store` itself. The honest factoring is "share pure helpers, not a leaky abstraction."
- **Not a `Store` implementation.** This package exports zero `Store` classes. Each backend constructs its own.
- **Not a SQL-template library.** Each backend writes its own SQL — there are no shared `INSERT INTO …` templates here. Drivers differ (SQLite `?` parameters vs Postgres `$1`, `INSERT OR REPLACE` vs `ON CONFLICT … DO UPDATE`); the SQL stays where the dialect is known.

## The `(kind, payload, blob)` triple

Every SQL-family backend persists each `StoreRecord` as one row with three columns:

| Column | Type (SQLite) | Type (Postgres) | Carries |
|--------|---------------|-----------------|---------|
| `kind` | TEXT          | TEXT            | The discriminant: `"meta"` or `"entry"`. |
| `payload` | TEXT       | TEXT            | JSON. For meta rows: the `StoreMeta` JSON. For entry rows: the `EntryPayloadJson` envelope (without the data field if binary). |
| `blob` | BLOB          | BYTEA           | Binary payload bytes when the entry is `encoding: "binary"`. `NULL` otherwise. |

The split between `payload` and `blob` exists because `Uint8Array` payloads (e.g. Yjs CRDT updates) would have to be base64-wrapped to fit in JSON. Storing them in a separate binary column avoids the doubling cost on every read and write.

The records table is **byte-identical** across backends by construction — both `payload TEXT` and `blob BYTEA`/`BLOB` store the bytes `toRow` produced verbatim. The meta table is **round-trip portable** but not byte-identical: Postgres JSONB normalizes whitespace and key order at insert time, while SQLite TEXT stores the literal `JSON.stringify` output. `loadAll` returns structurally equal `StoreRecord`s either way.

## `DEFAULT_TABLES` and `resolveTables`

```ts
const DEFAULT_TABLES = { meta: "kyneta_meta", records: "kyneta_records" }
```

The `kyneta_` prefix avoids collisions with application tables and signals the storage role in dump output. Each backend's options shape accepts `tables?: Partial<TableNames>` and resolves it via `resolveTables(opts)` — full or partial overrides are honored.

## Pure planning helpers

`planAppend` and `planReplace` factor out validation and serialization from each backend's `append` / `replace` methods. They are the "plan" step in a gather → plan → execute split:

1. **Gather** (per-backend): read existing meta, look up next seq number.
2. **Plan** (pure, here): `planAppend(docId, record, existingMeta, nextSeq)` validates the record against existing meta and returns an `AppendPlan` describing the rows to write.
3. **Execute** (per-backend): run the plan inside a backend-specific transaction.

The win: validation, serialization, and seq math live in one tested place. Each backend's `append` / `replace` shrinks to ~5 lines of orchestration with no inline validation logic.

`AppendPlan.upsertMeta` is `{ data: string } | null` — the JSON-stringified meta, or `null` if the record is an entry. Each backend stringifies once and passes the result to its driver. Postgres uses the string directly with `INSERT … VALUES ($1::jsonb)` (Postgres parses to JSONB server-side); SQLite stores it verbatim. The string-typed plan field is uniform across backends.

`ReplacePlan` carries the per-row inserts (at array-index seqs) plus the resolved meta to upsert.

## `failOnNthCall`

```ts
export function failOnNthCall<T>(target: T, methodName: keyof T, n: number, error?: Error): T
```

Wraps `target` in a `Proxy` so that the `n`-th call to `target[methodName]` throws (or, for async methods, returns a rejected promise). Other methods pass through; calls 1..n−1 and n+1..∞ execute normally.

Used by the conformance suite's fault-injection atomicity test. Each backend constructs the wrapped target appropriate to its own seam — the SQLite adapter for sqlite-store, the `Client.query` method for postgres-store, `$transaction` for prisma-store. The conformance suite sees only "throws on Nth write" and asserts no partial state is observable on a fresh non-faulting Store.

## Key Types

| Type | Role |
|------|------|
| `RowShape` | The persisted (kind, payload, blob) triple. |
| `EntryPayloadJson` | The JSON envelope stored in `payload` for entry rows. |
| `TableNames` | The two table names every SQL store needs. |
| `AppendPlan` / `ReplacePlan` | Outputs of the pure planning helpers. |

## Testing

`src/__tests__/sql-store-core.test.ts` covers:

- `toRow` ↔ `fromRow` round-trips for meta records, JSON-string entries, binary entries, mixed sequences.
- `normalizeBlob` — plain `Uint8Array` (identity) and `Buffer` (constructor-converted).
- `resolveTables` — defaults, full overrides, partial overrides.
- `planAppend` — meta input, entry-with-prior-meta, entry-without-prior-meta (throws), incompatible-meta (throws).
- `planReplace` — valid batch, missing-meta (throws), conflicting-metas (throws).
- `failOnNthCall` — counts only matching method, throws on Nth, passes through to N+1, supports async, rejects `n < 1`.

Run with: `cd packages/exchange/stores/sql-core && pnpm verify`.
