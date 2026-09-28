# @kyneta/test-integration

End-to-end integration tests covering combinations of `@kyneta/exchange`, transports, and stores that aren't tested in the per-package conformance suites.

## Layout

- `src/exchange-sqlite/` — SQLite-backed exchanges over real WebSocket transport. Always runs.
- `src/exchange-postgres/` — Postgres-backed exchanges over real WebSocket transport. Gated by `KYNETA_PG_URL`.
- `src/exchange-websocket/` — WebSocket-specific transport tests.
- `src/helpers/` — shared lifecycle, drain, exchange-pair, and Postgres helpers.

## Running

```sh
pnpm verify
```

Postgres-gated tests are skipped automatically when `KYNETA_PG_URL` is unset. To run them against a disposable Postgres in Docker (`scripts/postgres.sh` at the repository root):

```sh
eval "$(scripts/postgres.sh up)" && pnpm verify
```

The target database must allow `CREATE TABLE`, `TRUNCATE`, and `DROP TABLE`. Tests truncate state between runs; they don't drop the canonical schema. Use a dedicated test database.
