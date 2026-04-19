# @kyneta/leveldb-store — Technical Reference

> **Package**: `@kyneta/leveldb-store`
> **Role**: LevelDB persistence backend for `@kyneta/exchange` — implements the `Store` interface using `classic-level`, with a FoundationDB-style null-byte key space and a pure binary envelope for `StoreEntry`.
> **Depends on**: `classic-level`, `@kyneta/exchange` (peer), `@kyneta/schema` (peer)
> **Depended on by**: Applications that run a long-lived server process and want on-disk persistence behind an `Exchange`.
> **Canonical symbols**: `LevelDBStore`, `createLevelDBStore`, `encodeStoreEntry`, `decodeStoreEntry`
> **Key invariant(s)**: Every `Store` method is either an atomic LevelDB operation (`put`, `batch`) or a prefix iteration — no read-modify-write races. `replace()` is a single `batch` that deletes every existing entry for a doc and writes the replacement, so a crash cannot leave a partial state.

An on-disk implementation of `@kyneta/exchange`'s `Store` interface. Maps the exchange's per-doc append / replace / load API onto LevelDB keys using a FoundationDB-style null-byte separator and a zero-padded monotonic `seqNo` per doc. The seqNo is cached in memory and lazily discovered on first append after a cold start via a single reverse-iterator seek.

Consumed by server applications wiring `stores: [createLevelDBStore("./data")]` into a `new Exchange(...)`. Not imported by any other Kyneta package; it is a leaf.

---

## Questions this document answers

- What is a `Store` and what does the exchange call into? → [The `Store` contract](#the-store-contract)
- Why `\x00` as a key separator? → [Key-space design](#key-space-design)
- Why zero-padded `seqNo` instead of a numeric index? → [Why zero-padded seqNo](#why-zero-padded-seqno)
- How is the seqNo counter recovered after a restart? → [SeqNo lifecycle](#seqno-lifecycle)
- How does `replace()` avoid a partial write? → [`replace` is one batch](#replace-is-one-batch)
- How is a `StoreEntry` laid out on disk? → [Binary envelope](#binary-envelope)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Store` | The interface defined in `@kyneta/exchange` — `lookup`, `ensureDoc`, `append`, `loadAll`, `replace`, `delete`, `listDocIds`, `close`. | A reactive store, a database with queries — this is an append/replace log keyed by doc |
| `LevelDBStore` | The concrete class that implements `Store` over `classic-level`. | LevelDB itself — this is a thin mapping layer |
| `classic-level` | The npm package that provides the LevelDB binding used here. | `level` (older abstract-level API), `leveldown` (C++ binding alone) |
| `DocMetadata` | JSON-serializable per-doc metadata from `@kyneta/schema`. Stored at `meta\x00{docId}`. | `StoreEntry`, which is the payload |
| `StoreEntry` | `{ payload: SubstratePayload, version: string }` — one appended piece of doc state. Stored at `entry\x00{docId}\x00{seqNo}`. | `DocMetadata` |
| `SubstratePayload` | The exchange's opaque state-transfer shape, with `kind: "entirety" \| "since"`, `encoding: "json" \| "binary"`, and `data`. Produced and consumed by the substrate; this package only serializes it. | The decoded `ChannelMsg` — payloads ride *inside* offers |
| `seqNo` | Zero-padded 10-digit monotonic counter per doc. Resets to 0 after `replace`. | A Lamport clock, a vector clock — this is only a local disk ordering |
| `SEP` | The `\x00` null-byte separator. | A newline, a slash, a dot — null is chosen because it cannot appear in valid UTF-8 text |
| `META_PREFIX` / `ENTRY_PREFIX` | The two top-level key namespaces: `"meta\x00"` and `"entry\x00"`. | Two separate databases — they share one LevelDB instance |

---

## Architecture

**Thesis**: the cheapest way to persist a "per-doc append log with atomic replace" is to map it directly onto LevelDB's sorted byte key space, using a null-byte separator so docIds never need validation and a zero-padded counter so lexicographic order equals numeric order.

The entire package is one class plus one factory plus a pair of pure envelope functions:

| Component | Role |
|-----------|------|
| `LevelDBStore` | Implements `Store`. Owns one `ClassicLevel` handle and an in-memory `Map<DocId, number>` seqNo cache. |
| `encodeStoreEntry` / `decodeStoreEntry` | Pure functions: `StoreEntry ↔ Uint8Array`. No LevelDB imports. Independently testable. |
| `createLevelDBStore(dbPath)` | Factory — `new LevelDBStore(dbPath)` behind a plain function signature. |

### What `LevelDBStore` is NOT

- **Not a reactive store.** There is no subscribe, no changefeed. The exchange wires its own reactive layer above the store.
- **Not a query engine.** The only lookup primitive is "give me everything for this doc" (`loadAll`) or "give me the metadata for this doc" (`lookup`). No predicates, no secondary indexes.
- **Not thread-safe across processes.** LevelDB is single-process. Two processes opening the same `dbPath` will conflict; the exchange assumes one-writer semantics.
- **Not a migration engine.** Schema migrations happen at the `@kyneta/schema` layer. This store just persists whatever payload bytes the substrate produced.

### What "`Store`" means here (and does NOT mean)

- **Not a KV store with arbitrary keys.** The caller never chooses keys; the caller names docs and the store names keys. `docId` is the only external naming primitive.
- **Not a cache.** `append` is durable on return (LevelDB `put` is sync-by-default). No eviction, no TTL.
- **Not a log of `ChannelMsg`.** What gets stored is a `StoreEntry` — a self-contained substrate payload + version, produced by `substrate.exportSince()` or `substrate.exportEntirety()`.

---

## The `Store` contract

Eight methods, each of which is either a single LevelDB op or a single prefix iteration:

| Method | LevelDB mapping |
|--------|-----------------|
| `lookup(docId)` → `DocMetadata \| null` | `db.get(metaKey)`; `LEVEL_NOT_FOUND` → `null` |
| `ensureDoc(docId, metadata)` | `get` then `put` if missing; first writer wins, no overwrite |
| `append(docId, entry)` | `nextSeqNo` (cached or discovered) → single `put(entryKey(seq), encoded)` |
| `loadAll(docId)` → `AsyncIterable<StoreEntry>` | `db.values({ gte: prefix, lt: prefix + "\xff" })` in key order |
| `replace(docId, entry)` | Collect existing entry keys, issue one `batch` that deletes all and writes `entryKey(0)` — atomic |
| `delete(docId)` | Collect `[metaKey, ...entryKeys]`, one `batch` of `del`s — atomic |
| `listDocIds()` → `AsyncIterable<DocId>` | Iterate `meta\x00*` keys, slice the prefix |
| `close()` | `db.close()` |

Every method is `async`. All writes go through LevelDB's single-writer guarantee — there is no in-memory write buffer to lose on crash.

---

## Key-space design

Source: `packages/exchange/stores/leveldb/src/index.ts` → `META_PREFIX`, `ENTRY_PREFIX`, `metaKey`, `entryKey`.

```
meta\x00{docId}                      → DocMetadata (JSON-encoded)
entry\x00{docId}\x00{seqNo-padded}  → StoreEntry (binary envelope)
```

Two observations drove this layout:

1. **`\x00` cannot appear in valid UTF-8 strings.** The null byte is not a legal continuation byte, not a legal start byte, and not representable in a well-formed UTF-8 string. This means no docId — whatever characters it contains — can collide with the separator or "escape" its prefix. The store imposes zero naming constraints on the exchange.
2. **LevelDB orders keys lexicographically.** Within an entry namespace, keys for one doc sort together; within one doc, keys sort by `seqNo`. Prefix iteration with `{ gte: prefix, lt: prefix + "\xff" }` scans exactly the keys in a prefix.

### What `\x00` separators are NOT

- **Not an escape scheme.** There is no escaping of null bytes in user data because user data is never a key component — only `docId` and the internal `seqNo` are. Both are guaranteed null-free.
- **Not a delimiter for parsing values.** Values are opaque bytes (binary envelope for entries, JSON for metadata). `\x00` exists only in keys.
- **Not FoundationDB's tuple layer.** It is the idea from FoundationDB (null-byte separators in key namespaces), not the full tuple encoding. We do not need variable-length integer encoding; our only numeric component is the zero-padded `seqNo`.

---

## Why zero-padded seqNo

Source: `packages/exchange/stores/leveldb/src/index.ts` → `SEQ_PAD = 10`, `entryKey`.

`seqNo` is stored as a 10-digit zero-padded decimal string: `"0000000001"`, `"0000000002"`, …, `"9999999999"`. LevelDB sorts keys lexicographically; zero-padding makes lexicographic order equal to numeric order. A prefix scan over `entry\x00{docId}\x00` returns entries in strict insertion order without any secondary index or manual sort.

Ten digits is enough for 10^10 appends per doc, which is ~3× the per-second peak of almost any conceivable workload times the lifetime of a human civilization. The cost is 10 bytes per key versus the 3–4 bytes a binary-encoded uint would take — a non-issue at LevelDB's typical scale.

### What zero-padding is NOT

- **Not a format choice.** It is a sorting correctness requirement. Un-padded seqNos would sort `"10"` before `"2"`.
- **Not a uniqueness mechanism.** `seqNo` is unique per doc, not global. The docId prefix provides isolation.

---

## SeqNo lifecycle

Source: `packages/exchange/stores/leveldb/src/index.ts` → `#seqNos`, `#nextSeqNo`.

The store maintains `#seqNos: Map<DocId, number>` — the most recently used seqNo per doc, cached in memory. Three phases:

| Phase | Mechanism |
|-------|-----------|
| Steady state | `#nextSeqNo(docId)` reads the cache, increments, writes back. One `put` per `append`. |
| Cold start (first `append` to a doc after process restart) | Cache miss. Issue a single reverse-iterator seek: `db.keys({ gte: prefix, lt: prefix + "\xff", reverse: true, limit: 1 })`. Parse the one returned key to get `maxSeq`, cache `maxSeq + 1`. |
| After `replace(docId, entry)` | Batch atomically deletes every existing entry and writes the replacement at `seqNo = 0`. Cache is reset to `0`. |

The cold-start seek is **one** reverse iteration limited to one result. It is O(log n) in LevelDB's LSM structure, not O(n). No full scan.

### What the cache is NOT

- **Not a write buffer.** Values are written straight through to LevelDB. The cache only holds the next seqNo to assign.
- **Not consulted on reads.** `loadAll` iterates keys directly; the cache exists only to avoid a seek per append.
- **Not shared across processes.** Single-writer assumption — another process appending to the same dbPath would fork the seqNo space and break ordering.

---

## `replace` is one batch

Source: `packages/exchange/stores/leveldb/src/index.ts` → `replace`.

`replace(docId, entry)` is used when the substrate has compacted its state — the new entry represents the entire doc and all previous entries are now redundant. The implementation:

1. Iterate the doc's entry prefix and collect existing keys into an array.
2. Construct a single `batch` operation: one `del` per existing key, plus one `put` for `entryKey(docId, 0)`.
3. Call `db.batch(ops)` — LevelDB guarantees atomicity across the entire batch.
4. Reset `#seqNos.set(docId, 0)`.

A crash during the batch leaves either the old state (batch not committed) or the new state (batch committed). There is no intermediate state where some deletes have happened and the new entry has not been written.

### What `replace` is NOT

- **Not a compaction.** It is a caller-level operation. LevelDB's own SST compaction is independent and opaque.
- **Not a transaction over metadata.** Metadata at `meta\x00{docId}` is untouched — `replace` only affects the entry prefix.
- **Not reversible.** Previous entries are gone after the batch commits. The substrate is responsible for ensuring the replacement entry is itself a valid full state.

---

## Binary envelope

Source: `packages/exchange/stores/leveldb/src/index.ts` → `encodeStoreEntry`, `decodeStoreEntry`.

A `StoreEntry` has a `payload: SubstratePayload` and a `version: string`. The payload itself has `kind: "entirety" \| "since"`, `encoding: "json" \| "binary"`, and `data: string \| Uint8Array`. The on-disk layout packs all four variables into one bytestring:

```
┌─────────┬──────────────────────┬──────────────────────┬─────────────────────┐
│ flags   │ version length       │ version bytes        │ data bytes          │
│ 1 byte  │ u32 big-endian (4B)  │ UTF-8                │ UTF-8 or raw bytes  │
└─────────┴──────────────────────┴──────────────────────┴─────────────────────┘
```

The `flags` byte encodes three bits:

| Bit | Meaning when set |
|-----|------------------|
| 0 | `payload.kind === "since"` (otherwise `"entirety"`) |
| 1 | `payload.encoding === "binary"` (otherwise `"json"`) |
| 2 | `payload.data` was a `Uint8Array` (otherwise a `string`, UTF-8-encoded) |

Bit 2 exists independently of bit 1 because `encoding: "binary"` describes the *payload's interpretation* while bit 2 describes the *storage representation we chose*. In practice they correlate, but keeping them separate lets the envelope round-trip any `(encoding, data)` combination without loss.

### Why a custom envelope instead of JSON

`SubstratePayload.data` may be a `Uint8Array` (CRDT binary state). Wrapping that in JSON requires base64 — doubling the stored size. A flat header + raw bytes saves the base64 round-trip on every read and every write.

### Round-trip

`encodeStoreEntry` and `decodeStoreEntry` are pure — no LevelDB imports, no side effects. They are tested directly with synthetic `StoreEntry` values covering every `(kind, encoding, data-type)` combination.

### What the envelope is NOT

- **Not versioned.** Changing the layout would require either a version byte at offset 0 (breaking existing databases) or a migration. This is acceptable for now — the format is simple enough that a future rewrite can coexist by inspecting the first byte's value space.
- **Not CBOR or Protobuf.** Those tools solve structured, extensible, self-describing encoding. This envelope solves only "one known record type, packed as tightly as possible." The scope is why the code is ~50 lines.
- **Not exposed to the exchange.** The exchange sees `StoreEntry`; the envelope is this package's internal representation.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `LevelDBStore` | `src/index.ts` | The `Store` implementation. Owns one `ClassicLevel` + seqNo cache. |
| `createLevelDBStore(dbPath)` | `src/index.ts` | Factory returning a `Store`. |
| `encodeStoreEntry(entry)` | `src/index.ts` | Pure `StoreEntry → Uint8Array`. |
| `decodeStoreEntry(bytes)` | `src/index.ts` | Pure `Uint8Array → StoreEntry`. |

Types imported (not defined here): `Store`, `StoreEntry`, `DocId` from `@kyneta/exchange`; `DocMetadata` from `@kyneta/schema`.

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 296 | Entire public surface: envelope, key helpers, `LevelDBStore`, `createLevelDBStore`. |
| `src/__tests__/leveldb-storage.test.ts` | 207 | Full integration tests: `ensureDoc` idempotence, append ordering, `loadAll` iteration order, cold-start seqNo discovery, `replace` atomicity, `delete`, `listDocIds`, envelope round-trips. |

## Testing

Tests open a real `ClassicLevel` at a temp directory per test, exercise the public `Store` surface, and close + clean up afterward. The pure envelope functions are tested directly with synthetic values. There are no mocks; LevelDB is the simplest fast-opening database for this purpose.

**Tests**: 24 passed, 0 skipped across 1 file (`leveldb-storage.test.ts`: 24). Run with `cd packages/exchange/stores/leveldb && pnpm exec vitest run`.