# @kyneta/sql-store-core

The pieces every SQL-family `Store` for `@kyneta/exchange` shares: how a record becomes a row, and how an append or a compaction is planned. It holds no SQL and does no I/O.

You need it only to write a SQL store of your own. To store documents in SQL, use one of the stores built on it:

- [`@kyneta/sqlite-store`](../sqlite) — SQLite, owned by one process.
- [`@kyneta/postgres-store`](../postgres) — Postgres, shared by many processes.
- [`@kyneta/prisma-store`](../prisma) — through a Prisma client you supply.

Every one of them writes a record as the same `(kind, payload, blob)` row through `toRow` and `fromRow`, so a dump from one loads into another.

| Export | What it does |
|--------|--------------|
| `toRow`, `fromRow`, `normalizeBlob` | Convert a `StoreRecord` to and from its row. Binary payloads go to `blob`, never base64 inside JSON. |
| `planAppend`, `planCompact` | Decide what an append or a compaction writes; your store runs the plan inside its own transaction. |
| `DEFAULT_TABLES`, `resolveTables`, `TableNames` | The three tables a SQL store owns (`kyneta_doc_meta`, `kyneta_records`, `kyneta_store_meta`) and how to rename them. |
| `STORE_FORMAT_VERSION` | The on-disk format version every SQL store writes and checks on open. |

See [TECHNICAL.md](./TECHNICAL.md) for the row format and the plans.
