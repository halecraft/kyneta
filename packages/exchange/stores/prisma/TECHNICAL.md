# @kyneta/prisma-store — Technical Reference

> **Package**: `@kyneta/prisma-store`
> **Role**: `Store` implementation for `@kyneta/exchange` that takes a caller-supplied `PrismaClient` and uses Prisma's typed query API natively.
> **Depends on**: `@prisma/client` (peer), `@kyneta/exchange` (peer), `@kyneta/schema` (peer), `@kyneta/sql-store-core` (peer).
> **Depended on by**: Applications that have standardized on Prisma and don't want a parallel SQL library.
> **Canonical symbols**: `PrismaStore`, `createPrismaStore`, `PrismaStoreOptions`.
> **Key invariant(s)**: All multi-step writes run inside `client.$transaction(...)`, and read the document's meta and `MAX(seq)` inside it. A write that loses a race for a `seq` to another store over the same database is tried again until it does not; each loss means another writer committed. Every open issues a session seat. Model accessors are typed `unknown` deliberately; internally cast once to a narrow structural interface.

## Architecture

The caller supplies their own `PrismaClient` plus model names for the doc-meta, records, and store-meta tables. The store uses Prisma's typed query API natively — no raw SQL, no ORM-as-adapter abstraction. The constructor is private: `PrismaStore.open` (and `createPrismaStore`, which delegates to it) does no schema validation (Prisma's typed accessors enforce model presence at compile time) but checks the store format and issues the seat (see *Opening: the format and the seat*).

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
| `append` | `client.$transaction(async tx => { tx.<meta>.findUnique; tx.<record>.aggregate({ _max: { seq: true }}); planAppend; tx.<meta>.upsert(...) /* if applicable */; tx.<record>.create(...) })`, tried again on `P2002`. |
| `loadAll` | `<record>.findMany({ where: { docId }, orderBy: { seq: "asc" }})`. |
| `mark` | `<record>.aggregate({ where: { docId }, _max: { seq: true }})`. |
| `compact` | `client.$transaction(async tx => { tx.<meta>.findUnique; tx.<record>.aggregate; planCompact; tx.<record>.deleteMany({ where: { docId, seq: { lte: through }}}); for each: tx.<record>.create; tx.<meta>.upsert })`, tried again on `P2002`. |
| `delete` | `client.$transaction(async tx => { tx.<record>.deleteMany; tx.<meta>.deleteMany })`. |
| `currentMeta` | `<meta>.findUnique({ where: { docId }})`. |
| `listDocIds(prefix)` | `<meta>.findMany({ where: { docId: { startsWith: prefix }}, select: { docId: true }})`, then keeps only ids that `startsWith(prefix)` exactly. |
| `close` | Marks the store closed; it refuses every operation after. The caller calls `prisma.$disconnect()`. |

`Json` field handling: Postgres/MySQL Prisma returns parsed objects; SQLite returns strings. The store's `parseMetaData` helper handles both — a string falls through `JSON.parse`; an object passes through.

## The `unknown` typing rationale

`PrismaStoreOptions.client` is typed as `unknown`. Capturing Prisma's generic typed accessors without depending on `@prisma/client` types directly is genuinely hard, and depending on them pins this package to a specific Prisma major version. The trade-off:

- **Cost**: less compile-time safety inside the package — internal access to model accessors casts once to narrow structural interfaces (`MetaModel`, `RecordModel`, `StoreMetaModel`) for the methods we call (`findUnique`, `findMany`, `upsert`, `create`, `deleteMany`, `aggregate`, `count`).
- **Win**: version-portable across Prisma releases. The package works with Prisma 5.x and 6.x without code changes.

The user-facing call site retains full type safety: the caller passes their own typed `PrismaClient` instance in. The cast is internal.

Renamed model accessors work via the `metaModel`, `recordModel`, and `storeMetaModel` options.

## Opening: the format and the seat

`PrismaStore.open` reads the `format` row from the store-meta model, probes the doc-meta model's `count()`, and runs `@kyneta/exchange`'s `planStoreOpen` with `session` seating: it stamps a brand-new store, accepts a compatible major, or throws `StoreFormatVersionError`, and issues a **session seat**. The version value comes from `@kyneta/sql-store-core`'s `STORE_FORMAT_VERSION`, shared with sqlite/postgres, which bumped it to 1.1 for their seat pools; Prisma writes no pool, so 1.0 and 1.1 read alike. It is a compatibility check, **not** a migration.

**Serialized documents are not enforced.** The exchange's rule that one seat of a storage writes each serialized document (§"Serialized documents: one writer seat per storage" in `packages/exchange/TECHNICAL.md`) needs a record naming a seat that returns; a session seat never does, so a record would lock the document for good. `writerOf` is `null`, and `append` and `compact` ignore `WriteOptions`. Route a serialized document's writes to one process.

**Why a session seat.** A durable seat needs a lock held for the store's lifetime (see §"Durable seats" in `packages/exchange/TECHNICAL.md`). Prisma pools connections and pins one only inside an interactive transaction, so a session-level lock cannot outlive one call. Every open is therefore a fresh seat: unique, never reused, never fenced. The cost is one version-vector entry per process start per document written, and a `Line` to a Prisma-backed peer does not survive its restart.

## Sequence numbers come from the table

Several stores may open one database. Each write reads the document's `MAX(seq)` inside its interactive transaction and inserts after it. Prisma offers no portable lock to hold between the read and the insert, so two stores can read the same `MAX` and the second insert then violates the `(docId, seq)` key (`P2002`). The whole transaction is tried again, reading afresh, until it does not collide: each collision means another store's transaction committed, so while writers are finite the retries end. (It once retried only once, which several concurrent writers of one document could exhaust.) An earlier version cached the next `seq` per document in memory, and two stores then collided on every write after the first.

No run against a real database reaches Prisma (it would need `prisma generate` against a schema). The conformance suite runs over the structural mock, including its `session` seat section and two stores appending to one document at once.

## What this package is NOT

- **Not a replacement for Prisma's typed query API.** It uses Prisma natively. The store *is* a thin layer over `prisma.<meta>` and `prisma.<record>`.
- **Not a schema migration tool.** Caller owns migrations via `prisma migrate`.
- **Not pinned to a Prisma version.** The `unknown`-typed options are explicitly cross-version.

## Key Types

| Type | Role |
|------|------|
| `PrismaStore` | The Store; opened by `PrismaStore.open`. |
| `createPrismaStore` | Async factory, delegating to `PrismaStore.open`. |
| `PrismaStoreOptions` | `{ client: unknown, metaModel?: string, recordModel?: string, storeMetaModel?: string }`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | `PrismaStore` class, `createPrismaStore` factory, internal structural types, `parseMetaData`. |
| `schema.prisma.example` | Canonical model fragment — caller copies into their schema. |
| `src/__tests__/prisma-store.test.ts` | Structural-mock unit tests covering translation and the retry after a lost `seq` race, and the conformance suite over the mock. No end-to-end run reaches Prisma. |

## Testing

Per-package tests use a structural mock instead of spinning up a real `PrismaClient` (which would require schema generation). They verify:

- `PrismaStore` accepts an `unknown`-typed accessor object.
- Default model names (`kynetaDocMeta`, `kynetaRecord`, `kynetaStoreMeta`); overridable via options.
- Each `Store` method calls the expected mock methods.
- An append that loses its `seq` to another store retries, reading `MAX(seq)` afresh. The mock rolls back only what the failing transaction wrote, as a database does: each transaction records its own writes, so concurrent ones do not undo each other's.
- The conformance suite passes over the mock, with `session` seats.
- `listDocIds(prefix)` returns exact matches only, though the mock's `startsWith` ignores case as SQLite's `LIKE` and MySQL's default collation do.

**Why `startsWith` and then an exact filter.** Prisma serves several databases, and no single query is exact on all of them. A range scan assumes code-point order, which a locale collation (Postgres's default) breaks, so it misses ids. `startsWith` becomes `LIKE`, which Prisma escapes, and which SQLite and MySQL's default collation match without regard to case, so it can return extra ids but never fewer. The database narrows; the store decides. On MySQL, `doc_id` still needs a binary collation, since the default would make two ids differing only in case one primary key (see the README).

No end-to-end run against a real Prisma+SQLite/Postgres setup exists: `tests/integration` lists the package as a dependency but does not exercise it, and the store conformance suite does not reach Prisma.
