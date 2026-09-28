# @kyneta/prisma-store

`@kyneta/exchange` storage backend that takes a caller-supplied `PrismaClient` and uses Prisma's typed query API natively.

## Installation

```sh
pnpm add @kyneta/prisma-store
```

Peer dependencies: `@kyneta/exchange`, `@kyneta/schema`, `@kyneta/sql-store-core`, `@prisma/client`.

## Schema

Copy [`schema.prisma.example`](./schema.prisma.example) into your existing `schema.prisma` and run `prisma generate` and `prisma migrate dev`:

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

All models work on Postgres (`Json` → JSONB, `Bytes` → BYTEA), SQLite (`Json` → TEXT, `Bytes` → BLOB), and MySQL (`Json` → JSON, `Bytes` → LONGBLOB). **On MySQL, `doc_id` needs a binary collation.** MySQL's default collation compares text without regard to case, so two document ids differing only in case would be one primary key. Prisma cannot declare a column's collation, so edit the generated migration: `ALTER TABLE kyneta_doc_meta MODIFY doc_id VARCHAR(191) COLLATE utf8mb4_bin;`, and the same for `kyneta_records`. Postgres and SQLite need nothing: `listDocIds(prefix)` narrows with Prisma's `startsWith` and keeps only exact matches itself, whatever the database's collation. `KynetaStoreMeta` holds store-global metadata (the on-disk format version), distinct from the per-document `KynetaDocMeta`.

## Usage

```ts
import { PrismaClient } from "@prisma/client"
import { Exchange } from "@kyneta/exchange"
import { createPrismaStore } from "@kyneta/prisma-store"

const prisma = new PrismaClient()
const store = await createPrismaStore({ client: prisma })

const exchange = new Exchange({
  store,
  // ...
})

// On shutdown:
// await exchange.shutdown()
// await prisma.$disconnect()
```

`createPrismaStore` (or `PrismaStore.open`) checks the **store format** on open: it stamps a `{ major, minor }` version into `KynetaStoreMeta` and, on a later open, throws `StoreFormatVersionError` for an incompatible major or an unversioned store that already holds documents. No automatic migration is performed. The format is 1.1, shared with `sqlite-store` and `postgres-store`, which bumped it for their seat pools; a Prisma store writes no pool, and 1.0 and 1.1 read alike.

## The peer's identity: a new one per open

The store issues the exchange's `peerId`. Other stores keep one across restarts, under a lock held for the store's lifetime; Prisma pools connections and pins one only inside an interactive transaction, so it cannot hold such a lock. **Every open of a Prisma store is therefore a new peer**: a fresh seat, unique and never reused. The cost is one version-vector entry per process start per CRDT document it writes, and a new peer in every peer list. A `Line` to a Prisma-backed server does not survive the server's restart. If that matters, use [`@kyneta/postgres-store`](../postgres/), which keeps seats across restarts.

The model accessors default to `prisma.kynetaDocMeta`, `prisma.kynetaRecord`, and `prisma.kynetaStoreMeta` (matching the model names above). To use different model names:

```ts
const store = await createPrismaStore({
  client: prisma,
  metaModel: "appDocMeta",        // matches `model AppDocMeta`
  recordModel: "appRecord",       // matches `model AppRecord`
  storeMetaModel: "appStoreMeta", // matches `model AppStoreMeta`
})
```

## Why `unknown` typing?

`PrismaStoreOptions.client` is typed as `unknown`. Capturing Prisma's generic `findUnique<Args>` / `upsert<Args>` types without depending on `@prisma/client`'s types directly is genuinely hard, and depending on them pins this package to a specific Prisma major version. The `unknown`-with-internal-cast approach trades compile-time safety inside `@kyneta/prisma-store` for version-portability across Prisma releases.

The user-facing call site retains full type safety: the caller passes their own typed `PrismaClient` in. Internally, the store casts once to a minimal structural interface for the methods it calls (`findUnique`, `findMany`, `upsert`, `create`, `deleteMany`, `aggregate`, `$transaction`).

## Lifecycle

The caller owns the connection lifecycle: the caller calls `prisma.$disconnect()` on shutdown. `PrismaStore.close()` leaves the client alone; the closed store refuses every operation after it.

## See also

- [`@kyneta/sql-store-core`](../sql-core/) — pure helpers shared with `sqlite-store` and `postgres-store`.
- [`@kyneta/sqlite-store`](../sqlite/) — universal SQLite backend (no Prisma).
- [`@kyneta/postgres-store`](../postgres/) — async-native Postgres backend (no Prisma, uses `pg` directly).
