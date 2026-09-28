# @kyneta/indexeddb-store

IndexedDB storage backend for `@kyneta/exchange` — browser-side persistent storage for documents that survive page refreshes, tab crashes, and temporary network loss.

Implements the `Store` interface — pass directly to `Exchange({ store: ... })` for automatic document persistence and hydration.

## Install

```sh
pnpm add @kyneta/indexeddb-store
```

## Quick Start

```ts
import { createIndexedDBStore } from "@kyneta/indexeddb-store"
import { Exchange } from "@kyneta/exchange"

const store = await createIndexedDBStore("my-app-db")
const exchange = new Exchange({
  principal: "alice",
  store,
  transports: [...],
})

// Documents are automatically persisted on mutation and hydrated on restart.
const doc = exchange.get("my-doc", TodoDoc)
```

That's it. The Exchange handles hydration (loading from storage on `get()` / `replicate()`) and persistence (saving incremental deltas via `onStateAdvanced`) — no manual save/load needed.

Note the `await` on `createIndexedDBStore`: opening the database and taking a seat are asynchronous.

## The peer's identity

The store issues the exchange's `peerId`, a **seat** from a pool kept in the database. A page that reloads gets its seat back, so it stays the same peer; two tabs open at once hold different seats; the pool never grows past the most tabs open at once. Seats are held with [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), which the browser releases when a page unloads or crashes, and every write checks that its seat has not been taken since.

- **Insecure origins and old browsers** have no Web Locks (they need a secure context: Chrome 69+, Firefox 96+, Safari 15.4+). The store warns once and issues a fresh seat per open: unique, but a new peer on every load.
- **Back/forward cache**: a page holding a Web Lock is usually not eligible for it, as is one with an open IndexedDB connection in several engines.
- **Workers** share an origin's Web Locks with its pages, so a store opened in a worker takes a seat like a tab.
- **If another tab takes this store's seat** while this page still runs (it happens only when the browser released the lock early), every write fails with `SeatLostError` and nothing more is written or sent. Reload.

## API

### `createIndexedDBStore(dbName, options?)`

Async factory function that returns a `Store`. The `dbName` is the IndexedDB database name visible in browser DevTools. `options.locks` is the lock manager seats are taken through: `navigator.locks` by default, or `null` for none (a fresh seat per open). Tests pass a model of an origin's pages here.

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

await store.close() // release the seat and the IDB connection
```

### `deleteIndexedDBStore(dbName)`

Delete an IndexedDB database entirely. Useful for test cleanup and development resets. The database must not be open — call `store.close()` before deleting.

```ts
import { deleteIndexedDBStore } from "@kyneta/indexeddb-store"

await store.close()
await deleteIndexedDBStore("my-app-db")
```

## Design

See [TECHNICAL.md](./TECHNICAL.md) for details on the database schema, seat allocation, transaction semantics, and structured clone strategy.

The on-disk format is 1.1: `store_meta` holds the seat pool. A 1.0 database opens as one with an empty pool.

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