# @kyneta/prisma-store — Technical Reference

> **Package**: `@kyneta/prisma-store`
> **Role**: `Store` implementation for `@kyneta/exchange` that takes a caller-supplied `PrismaClient` and uses Prisma's typed query API natively.
> **Depends on**: `@prisma/client` (peer), `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer).
> **Depended on by**: Applications that have standardized on Prisma and don't want a parallel SQL library.
> **Canonical symbols**: `PrismaStore`, `createPrismaStore`, `PrismaStoreOptions`.
> **Key invariant(s)**: All multi-step writes run inside `client.$transaction(...)`, and read the document's meta and `MAX(seq)` inside it. A write that loses a race for a `seq` to another store over the same database is retried once. Model accessors are typed `unknown` deliberately; internally cast once to a narrow structural interface.

## Architecture

The caller supplies their own `PrismaClient` plus model names for the doc-meta, records, and store-meta tables. The store uses Prisma's typed query API natively — no raw SQL, no ORM-as-adapter abstraction. Sync constructor; the async `createPrismaStore` factory does no schema validation (Prisma's typed accessors enforce model presence at compile time) but does run the store-format gate on open (see *Store-format gate*).

## Schema fragment ownership

The caller owns DDL via Prisma migrations. The package ships [`schema.prisma.example`](./schema.prisma.example) — a fragment to copy into the caller's `schema.prisma`:

```prisma
model KynetaDocMeta {
  docId String @id @map("doc_id")
  data  Json
  @@map("kyneta_doc_meta")
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

model KynetaStoreMeta {
  key   String @id
  value Json
  @@map("kyneta_store_meta")
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
| `append` | `client.$transaction(async tx => { tx.<meta>.findUnique; tx.<record>.aggregate({ _max: { seq: true }}); planAppend; tx.<meta>.upsert(...) /* if applicable */; tx.<record>.create(...) })`, retried once on `P2002`. |
| `loadAll` | `<record>.findMany({ where: { docId }, orderBy: { seq: "asc" }})`. |
| `mark` | `<record>.aggregate({ where: { docId }, _max: { seq: true }})`. |
| `compact` | `client.$transaction(async tx => { tx.<meta>.findUnique; tx.<record>.aggregate; planCompact; tx.<record>.deleteMany({ where: { docId, seq: { lte: through }}}); for each: tx.<record>.create; tx.<meta>.upsert })`, retried once on `P2002`. |
| `delete` | `client.$transaction(async tx => { tx.<record>.deleteMany; tx.<meta>.deleteMany })`. |
| `currentMeta` | `<meta>.findUnique({ where: { docId }})`. |
| `listDocIds(prefix)` | `<meta>.findMany({ where: { docId: { startsWith: prefix }}, select: { docId: true }})`, then keeps only ids that `startsWith(prefix)` exactly. |
| `close` | No-op. Caller calls `prisma.$disconnect()`. |

`Json` field handling: Postgres/MySQL Prisma returns parsed objects; SQLite returns strings. The store's `parseMetaData` helper handles both — a string falls through `JSON.parse`; an object passes through.

## The `unknown` typing rationale

`PrismaStoreOptions.client` is typed as `unknown`. Capturing Prisma's generic typed accessors without depending on `@prisma/client` types directly is genuinely hard, and depending on them pins this package to a specific Prisma major version. The trade-off:

- **Cost**: less compile-time safety inside the package — internal access to model accessors casts once to narrow structural interfaces (`MetaModel`, `RecordModel`, `StoreMetaModel`) for the methods we call (`findUnique`, `findMany`, `upsert`, `create`, `deleteMany`, `aggregate`, `count`).
- **Win**: version-portable across Prisma releases. The package works with Prisma 5.x and 6.x without code changes.

The user-facing call site retains full type safety: the caller passes their own typed `PrismaClient` instance in. The cast is internal.

Renamed model accessors work via the `metaModel`, `recordModel`, and `storeMetaModel` options.

## Store-format gate

`createPrismaStore` (via `PrismaStore.open`) runs the store-format gate on open. It reads the `format` row from the store-meta model, probes the doc-meta model's `count()`, and via `@kyneta/exchange`'s `decideStoreFormat` either stamps a brand-new store, accepts a compatible major, or throws `StoreFormatVersionError`. The version value comes from `@kyneta/sql-store-core`'s `STORE_FORMAT_VERSION` (shared with sqlite/postgres). It is a compatibility check, **not** a migration. The bare `new PrismaStore({ client })` constructor skips the gate.

## Sequence numbers come from the table

Several stores may open one database. Each write reads the document's `MAX(seq)` inside its interactive transaction and inserts after it. Prisma offers no portable lock to hold between the read and the insert, so two stores can read the same `MAX` and the second insert then violates the `(docId, seq)` key (`P2002`). The whole transaction is retried once, reading afresh. An earlier version cached the next `seq` per document in memory, and two stores then collided on every write after the first.

No conformance run reaches Prisma (it would need `prisma generate` against a schema). Its unit test drives the store through a structural mock, including an injected collision.

## What this package is NOT

- **Not a replacement for Prisma's typed query API.** It uses Prisma natively. The store *is* a thin layer over `prisma.<meta>` and `prisma.<record>`.
- **Not a schema migration tool.** Caller owns migrations via `prisma migrate`.
- **Not pinned to a Prisma version.** The `unknown`-typed options are explicitly cross-version.

## Key Types

| Type | Role |
|------|------|
| `PrismaStore` | Sync-constructed Store. |
| `createPrismaStore` | Async factory (for ergonomic symmetry with postgres-store). |
| `PrismaStoreOptions` | `{ client: unknown, metaModel?: string, recordModel?: string, storeMetaModel?: string }`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | `PrismaStore` class, `createPrismaStore` factory, internal structural types, `parseMetaData`. |
| `schema.prisma.example` | Canonical model fragment — caller copies into their schema. |
| `src/__tests__/prisma-store.test.ts` | Structural-mock unit tests covering translation and the retry after a lost `seq` race. No end-to-end run reaches Prisma. |

## Testing

Per-package tests use a structural mock instead of spinning up a real `PrismaClient` (which would require schema generation). They verify:

- `PrismaStore` accepts an `unknown`-typed accessor object.
- Default model names (`kynetaDocMeta`, `kynetaRecord`, `kynetaStoreMeta`); overridable via options.
- Each `Store` method calls the expected mock methods.
- An append that loses its `seq` to another store retries, reading `MAX(seq)` afresh. The mock rolls back only what the failing transaction wrote, as a database does.
- `listDocIds(prefix)` returns exact matches only, though the mock's `startsWith` ignores case as SQLite's `LIKE` and MySQL's default collation do.

**Why `startsWith` and then an exact filter.** Prisma serves several databases, and no single query is exact on all of them. A range scan assumes code-point order, which a locale collation (Postgres's default) breaks, so it misses ids. `startsWith` becomes `LIKE`, which Prisma escapes, and which SQLite and MySQL's default collation match without regard to case, so it can return extra ids but never fewer. The database narrows; the store decides. On MySQL, `doc_id` still needs a binary collation, since the default would make two ids differing only in case one primary key (see the README).

No end-to-end run against a real Prisma+SQLite/Postgres setup exists: `tests/integration` lists the package as a dependency but does not exercise it, and the store conformance suite does not reach Prisma.
