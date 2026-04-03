# @kyneta/leveldb-store

Server-side persistent storage for `@kyneta/exchange`, backed by [LevelDB](https://github.com/google/leveldb) via [`classic-level`](https://github.com/Level/classic-level).

Implements the `Store` interface — pass directly to `Exchange({ stores: [...] })` for automatic document persistence and hydration.

## Install

```sh
pnpm add @kyneta/leveldb-store
```

## Quick Start

```ts
import { Exchange } from "@kyneta/exchange"
import { createLevelDBStore } from "@kyneta/leveldb-store/server"

const exchange = new Exchange({
  identity: { peerId: "my-server", name: "server" },
  stores: [createLevelDBStore("./data/exchange-db")],
  transports: [networkTransport],
})

// Documents are automatically persisted on mutation and hydrated on restart.
const doc = exchange.get("my-doc", TodoDoc)
```

That's it. The Exchange handles hydration (loading from storage on `get()` / `replicate()`) and persistence (saving incremental deltas via `onStateAdvanced`) — no manual save/load needed.

## API

### `createLevelDBStore(dbPath)`

Factory function that returns a `Store`. The `dbPath` is the directory where LevelDB stores its files.

```ts
import { createLevelDBStore } from "@kyneta/leveldb-store/server"

const store = createLevelDBStore("./data/exchange-db")
```

### `LevelDBStore`

The class implementing the `Store` interface. Use `createLevelDBStore` for most cases; use the class directly if you need access to `close()` outside of the Exchange lifecycle.

```ts
import { LevelDBStore } from "@kyneta/leveldb-store/server"

const store = new LevelDBStore("./data/exchange-db")

// ... use with Exchange ...

await store.close() // release file handles
```

### Binary Codec

The module also exports `encodeStoreEntry` and `decodeStoreEntry` for the compact binary envelope format. These are pure functions — useful for debugging, migration scripts, or building custom tooling over the LevelDB data files.

```ts
import { encodeStoreEntry, decodeStoreEntry } from "@kyneta/leveldb-store/server"

const bytes = encodeStoreEntry(entry)  // StoreEntry → Uint8Array
const entry = decodeStoreEntry(bytes)  // Uint8Array → StoreEntry
```

## Design

### Key-Space

Keys follow the [FoundationDB convention](https://apple.github.io/foundationdb/developer-guide.html#key-and-value-sizes) — null-byte (`\x00`) separated prefixes:

| Key pattern | Value |
|---|---|
| `meta\x00{docId}` | JSON-encoded `DocMetadata` |
| `entry\x00{docId}\x00{seqNo}` | Binary-encoded `StoreEntry` |

The `\x00` separator cannot appear in valid UTF-8 strings, so no docId validation is needed — the key-space imposes zero constraints on callers. Documents with overlapping name prefixes (e.g. `doc` vs `doc-extra`) are fully isolated.

### Sequence Numbers

Each document maintains a monotonic sequence counter for entry ordering. SeqNos are zero-padded to 10 digits, supporting up to 10 billion entries per document.

On reboot, the max seqNo for a document is lazily discovered via a single reverse-iterator seek on first `append` — no full scan needed.

### Binary Envelope

Entries are stored in a compact binary format (not JSON) for minimal overhead:

```
[1 byte flags] [4 bytes version length BE] [N bytes version UTF-8] [remaining: payload data]
```

Flags byte layout:
- bit 0: kind (0 = entirety, 1 = since)
- bit 1: encoding (0 = json, 1 = binary)
- bit 2: data type (0 = string, 1 = Uint8Array)

### Atomicity

`replace()` uses LevelDB's batch operation to atomically delete all existing entries and write the single replacement. A concurrent reader never observes an empty intermediate state.

## Testing

The package passes the full `Store` conformance suite from `@kyneta/exchange/testing`, plus LevelDB-specific tests for close/reopen persistence and binary codec edge cases.

```sh
pnpm test
```

To use the conformance suite for your own `Store` implementation:

```ts
import { describeStore } from "@kyneta/exchange/testing"

describeStore(
  "MyStore",
  () => new MyStore(),
  async (store) => { /* cleanup */ },
)
```

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/exchange": "^1.1.0",
    "@kyneta/schema": "^1.1.0"
  }
}
```

## License

MIT