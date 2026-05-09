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

Both models work on Postgres (`Json` → JSONB, `Bytes` → BYTEA), SQLite (`Json` → TEXT, `Bytes` → BLOB), and MySQL (`Json` → JSON, `Bytes` → LONGBLOB).

## Usage

```ts
import { PrismaClient } from "@prisma/client"
import { Exchange } from "@kyneta/exchange"
import { PrismaStore } from "@kyneta/prisma-store"

const prisma = new PrismaClient()
const store = new PrismaStore({ client: prisma })

const exchange = new Exchange({
  stores: [store],
  // ...
})

// On shutdown:
// await exchange.shutdown()
// await prisma.$disconnect()
```

The model accessors default to `prisma.kynetaMeta` and `prisma.kynetaRecord` (matching `model KynetaMeta` / `model KynetaRecord`). To use different model names:

```ts
const store = new PrismaStore({
  client: prisma,
  metaModel: "appMeta",      // matches `model AppMeta`
  recordModel: "appRecord",  // matches `model AppRecord`
})
```

## Why `unknown` typing?

`PrismaStoreOptions.client` is typed as `unknown`. Capturing Prisma's generic `findUnique<Args>` / `upsert<Args>` types without depending on `@prisma/client`'s types directly is genuinely hard, and depending on them pins this package to a specific Prisma major version. The `unknown`-with-internal-cast approach trades compile-time safety inside `@kyneta/prisma-store` for version-portability across Prisma releases.

The user-facing call site retains full type safety: the caller passes their own typed `PrismaClient` in. Internally, the store casts once to a minimal structural interface for the methods it calls (`findUnique`, `findMany`, `upsert`, `create`, `deleteMany`, `aggregate`, `$transaction`).

## Lifecycle

The caller owns the connection lifecycle. `PrismaStore.close()` is a no-op; the caller calls `prisma.$disconnect()` on shutdown.

## See also

- [`@kyneta/sql-store-core`](../sql-core/) — pure helpers shared with `sqlite-store` and `postgres-store`.
- [`@kyneta/sqlite-store`](../sqlite/) — universal SQLite backend (no Prisma).
- [`@kyneta/postgres-store`](../postgres/) — async-native Postgres backend (no Prisma, uses `pg` directly).
