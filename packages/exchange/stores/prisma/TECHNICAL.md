# @kyneta/prisma-store — Technical Reference

> **Package**: `@kyneta/prisma-store`
> **Role**: `Store` implementation for `@kyneta/exchange` that takes a caller-supplied `PrismaClient` and uses Prisma's typed query API natively.
> **Depends on**: `@prisma/client` (peer), `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer).
> **Depended on by**: Applications that have standardized on Prisma and don't want a parallel SQL library.
> **Canonical symbols**: `PrismaStore`, `createPrismaStore`, `PrismaStoreOptions`.
> **Key invariant(s)**: All multi-step writes run inside `client.$transaction(...)`. The seq-tracker mutation in `replace` runs lexically after the awaited `$transaction` — a rejection propagates past it. Model accessors are typed `unknown` deliberately; internally cast once to a narrow structural interface.

## Architecture

The caller supplies their own `PrismaClient` plus model names for the meta and records tables. The store uses Prisma's typed query API natively — no raw SQL, no ORM-as-adapter abstraction. Sync constructor; an async `createPrismaStore` factory is provided for symmetry with `@kyneta/postgres-store` but does no schema validation (Prisma's typed accessors enforce model presence at compile time).

## Schema fragment ownership

The caller owns DDL via Prisma migrations. The package ships [`schema.prisma.example`](./schema.prisma.example) — a fragment to copy into the caller's `schema.prisma`:

```prisma
model KynetaMeta {
  docId String @id @map("doc_id")
  data  Json
  @@map("kyneta_meta")
}

model KynetaRecord {
  docId   String  @map("doc_id")
  seq     Int
  kind    String
  payload String?
  blob    Bytes?
  @@id([docId, seq])
  @@map("kyneta_records")
}
```

Prisma's `Json` and `Bytes` types map per database:

| Prisma type | Postgres | SQLite | MySQL |
|-------------|----------|--------|-------|
| `Json`      | JSONB    | TEXT   | JSON  |
| `Bytes`     | BYTEA    | BLOB   | LONGBLOB |

Round-trip portability through `loadAll` works across all of these. Byte-level identity holds where the underlying type matches across backends (TEXT, BLOB, BYTEA); JSONB on Postgres normalizes meta JSON whitespace and key order.

## The `Store` contract mapping

| Method | Prisma calls |
|--------|--------------|
| `append` | `aggregate({ _max: { seq: true }})` (cold start only) → `planAppend` → `client.$transaction(async tx => { tx.<meta>.upsert(...) /* if applicable */; tx.<record>.create(...) })`. |
| `loadAll` | `<record>.findMany({ where: { docId }, orderBy: { seq: "asc" }})`. |
| `replace` | `client.$transaction(async tx => { tx.<record>.deleteMany; for each: tx.<record>.create; tx.<meta>.upsert })`. |
| `delete` | `client.$transaction(async tx => { tx.<record>.deleteMany; tx.<meta>.deleteMany })`. |
| `currentMeta` | `<meta>.findUnique({ where: { docId }})`. |
| `listDocIds(prefix)` | Range filter: `<meta>.findMany({ where: { docId: { gte, lt }}, select: { docId: true }})`. |
| `close` | No-op. Caller calls `prisma.$disconnect()`. |

`Json` field handling: Postgres/MySQL Prisma returns parsed objects; SQLite returns strings. The store's `parseMetaData` helper handles both — a string falls through `JSON.parse`; an object passes through.

## The `unknown` typing rationale

`PrismaStoreOptions.client` is typed as `unknown`. Capturing Prisma's generic typed accessors without depending on `@prisma/client` types directly is genuinely hard, and depending on them pins this package to a specific Prisma major version. The trade-off:

- **Cost**: less compile-time safety inside the package — internal access to model accessors casts once to a narrow structural interface (`MetaModel`, `RecordModel`) for the methods we call (`findUnique`, `findMany`, `upsert`, `create`, `deleteMany`, `aggregate`).
- **Win**: version-portable across Prisma releases. The package works with Prisma 5.x and 6.x without code changes.

The user-facing call site retains full type safety: the caller passes their own typed `PrismaClient` instance in. The cast is internal.

Renamed model accessors (e.g. `prisma.appKynetaMeta`) work via the `metaModel` and `recordModel` options.

## seq-tracker post-commit ordering

In `replace`, `this.#seqNos.reset(docId, records.length - 1)` runs **lexically after** the awaited `client.$transaction(...)`. Prisma's `$transaction` callback returning successfully does not guarantee COMMIT succeeded — a failed commit propagates as a rejected promise from `$transaction`. Placing the reset after the await ensures a transaction rejection's throw propagates past the cache mutation, preventing a stale seq cache from corrupting a future append.

## What this package is NOT

- **Not a replacement for Prisma's typed query API.** It uses Prisma natively. The store *is* a thin layer over `prisma.<meta>` and `prisma.<record>`.
- **Not a schema migration tool.** Caller owns migrations via `prisma migrate`.
- **Not pinned to a Prisma version.** The `unknown`-typed options are explicitly cross-version.

## Key Types

| Type | Role |
|------|------|
| `PrismaStore` | Sync-constructed Store. |
| `createPrismaStore` | Async factory (for ergonomic symmetry with postgres-store). |
| `PrismaStoreOptions` | `{ client: unknown, metaModel?: string, recordModel?: string }`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | `PrismaStore` class, `createPrismaStore` factory, internal structural types, `parseMetaData`, `prefixUpperBound`. |
| `schema.prisma.example` | Canonical model fragment — caller copies into their schema. |
| `src/__tests__/prisma-store.test.ts` | Structural-mock unit tests covering translation. End-to-end Prisma+SQLite/Postgres tests live in `tests/integration` (when configured). |

## Testing

Per-package tests use a structural mock instead of spinning up a real `PrismaClient` (which would require schema generation). They verify:

- `PrismaStore` accepts an `unknown`-typed accessor object.
- Default model names (`kynetaMeta`, `kynetaRecord`); overridable via options.
- Each `Store` method calls the expected mock methods.
- Transaction rejection leaves observable state unchanged (the seq-tracker post-commit ordering claim).
- Range-scan `listDocIds` matches `%` and `_` literally.

End-to-end coverage against a real Prisma+SQLite/Postgres setup is the responsibility of `tests/integration` (deferred — see Learnings in the project plan).
