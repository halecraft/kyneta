# @kyneta/indexeddb-store

IndexedDB storage backend for `@kyneta/exchange` — browser-side persistent storage for documents that survive page refreshes, tab crashes, and temporary network loss.

Implements the `Store` interface — pass directly to `Exchange({ stores: [...] })` for automatic document persistence and hydration.

## Install

```sh
pnpm add @kyneta/indexeddb-store
```

## Quick Start

```ts
import { createIndexedDBStore } from "@kyneta/indexeddb-store"
import { Exchange, persistentPeerId } from "@kyneta/exchange"

const store = await createIndexedDBStore("my-app-db")
const exchange = new Exchange({
  id: persistentPeerId("my-peer-id"),
  stores: [store],
  transports: [...],
})

// Documents are automatically persisted on mutation and hydrated on restart.
const doc = exchange.get("my-doc", TodoDoc)
```

That's it. The Exchange handles hydration (loading from storage on `get()` / `replicate()`) and persistence (saving incremental deltas via `onStateAdvanced`) — no manual save/load needed.

Note the `await` on `createIndexedDBStore` — unlike the synchronous LevelDB factory, IndexedDB requires an async open before the store is ready.

## API

### `createIndexedDBStore(dbName)`

Async factory function that returns a `Store`. The `dbName` is the IndexedDB database name visible in browser DevTools.

```ts
import { createIndexedDBStore } from "@kyneta/indexeddb-store"

const store = await createIndexedDBStore("my-app-db")
```

### `IndexedDBStore`

The class implementing the `Store` interface. Use `createIndexedDBStore` for most cases; use the class directly if you need access to `close()` outside of the Exchange lifecycle.

```ts
import { IndexedDBStore } from "@kyneta/indexeddb-store"

const store = await IndexedDBStore.open("my-app-db")

// ... use with Exchange ...

await store.close() // release the IDB connection
```

### `deleteIndexedDBStore(dbName)`

Delete an IndexedDB database entirely. Useful for test cleanup and development resets. The database must not be open — call `store.close()` before deleting.

```ts
import { deleteIndexedDBStore } from "@kyneta/indexeddb-store"

await store.close()
await deleteIndexedDBStore("my-app-db")
```

## Design

See [TECHNICAL.md](./TECHNICAL.md) for details on the database schema, transaction semantics, and structured clone strategy.

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/exchange": "^1.3.1",
    "@kyneta/schema": "^1.3.1"
  }
}
```

## License

MIT