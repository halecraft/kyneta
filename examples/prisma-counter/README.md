# Collaborative Counter (Prisma + Postgres)

A single collaborative counter that persists to **Postgres** via **Prisma**.

Open two browser tabs, click `+`/`−` in either tab — the count updates in real time. Kill the server, restart it — the count is still there.

## What This Demonstrates

- **Prisma persistence** — `@kyneta/prisma-store` wired into an Exchange with a `PrismaClient`
- **Prisma migrations** — `npx prisma migrate dev` creates the `kyneta_meta` / `kyneta_records` tables
- **Loro Counter CRDT** — `Schema.counter()` with `loro.bind()` — concurrent increments merge additively
- **Server restart resilience** — counter value survives process restart (persisted in Postgres)
- **Multi-tab sync** — WebSocket transport + Exchange synchronizes state across browser tabs

## Prerequisites

- **Node** 22+
- **Postgres** running locally (see Docker one-liner below)

## Quick Start

### 1. Start Postgres

If you don't have Postgres running:

```bash
docker run -d --name kyneta-pg \
  -e POSTGRES_USER=kyneta \
  -e POSTGRES_PASSWORD=kyneta \
  -e POSTGRES_DB=kyneta \
  -p 5432:5432 \
  postgres:16
```

### 2. Set up the environment

```bash
cp .env.example .env
```

The default `.env` points at `postgresql://kyneta:kyneta@localhost:5432/kyneta` — matches the Docker command above.

### 3. Install dependencies

```bash
cd examples/prisma-counter
pnpm install
```

### 4. Generate Prisma client and run the migration

```bash
pnpm run generate
pnpm run migrate
```

This creates the `kyneta_meta` and `kyneta_records` tables in Postgres.

### 5. Start the dev server

```bash
pnpm run dev
```

Open http://localhost:5173 in two browser tabs. Click `+`/`−` in either tab — the count updates in both.

### 6. Test persistence

Kill the server (Ctrl+C) and restart it (`pnpm run dev`). The count survives.

## Architecture

```
Browser Tab A                    Browser Tab B
┌──────────────────┐             ┌──────────────────┐
│  React App       │             │  React App       │
│  useValue(count) │             │  useValue(count) │
│  count() → number│             │  count() → number│
│  .increment(n)   │             │  .increment(n)   │
│       ↕          │             │       ↕          │
│  Exchange        │             │  Exchange        │
│       ↕ WebSocket│             │       ↕ WebSocket│
└───────┬──────────┘             └───────┬──────────┘
        │                                │
        └──────────┐   ┌─────────────────┘
                   ↓   ↓
           ┌──────────────────┐
           │  Server Exchange  │
           │  (sync hub)      │
           │       ↕          │
           │  PrismaStore     │
           │       ↕          │
           │  Postgres        │
           │  (kyneta DB)     │
           └──────────────────┘
```

## What's Here

```
prisma-counter/
├── prisma/
│   └── schema.prisma    # KynetaMeta + KynetaRecord models, Postgres datasource
├── src/
│   ├── schema.ts        # Schema.struct({ count: Schema.counter() }) + loro.bind
│   ├── server.ts        # Vite middleware + WebSocket + Exchange + PrismaStore
│   ├── app.tsx          # Counter UI — useDocument, useValue, +/− buttons
│   └── main.tsx         # Client bootstrap — ExchangeProvider + WebSocket
├── index.html
├── style.css
├── .env.example
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## The Schema

```ts
import { Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"

export const CounterSchema = Schema.struct({
  count: Schema.counter(),
})

export const CounterDoc = loro.bind(CounterSchema)
```

## The Key Pattern

```tsx
import { useDocument, useValue } from "@kyneta/react"

function App() {
  const doc = useDocument("counter", CounterDoc)

  // useValue on a counter leaf ref returns the current count as a number.
  // Re-renders on every increment (local or remote).
  const count = useValue(doc.count) as number

  return (
    <>
      <span>{count}</span>
      <button onClick={() => doc.count.increment(1)}>+</button>
      <button onClick={() => doc.count.increment(-1)}>−</button>
    </>
  )
}
```

- `useValue(doc.count)` returns a `number` — the counter's current value
- `doc.count.increment(n)` mutates the counter directly — no `change()` wrapper needed
- Counter refs auto-commit on each `.increment()` call
- The UI re-renders on every increment, local or remote

## Tearing Down Postgres

```bash
docker rm -f kyneta-pg
```
