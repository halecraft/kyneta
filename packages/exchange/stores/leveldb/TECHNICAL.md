# @kyneta/leveldb-store — Technical Reference

> **Package**: `@kyneta/leveldb-store`
> **Role**: LevelDB persistence backend for `@kyneta/exchange` — implements the `Store` interface using `classic-level`, with a FoundationDB-style null-byte key space and a pure binary envelope for `StoreRecord`.
> **Depends on**: `classic-level`, `@kyneta/exchange` (peer), `@kyneta/schema` (peer)
> **Depended on by**: Applications that run a long-lived server process and want on-disk persistence behind an `Exchange`.
> **Canonical symbols**: `LevelDBStore`, `createLevelDBStore`, `encodeStoreRecord`, `decodeStoreRecord`
> **Key invariant(s)**: Every `Store` method is either an atomic LevelDB operation (`put`, `batch`) or a prefix iteration — no read-modify-write races. `replace()` is a single `batch` that deletes every existing record for a doc and writes the replacements, so a crash cannot leave a partial state.

An on-disk implementation of `@kyneta/exchange`'s `Store` interface. Maps the exchange's per-doc append / replace / load API onto LevelDB keys using a FoundationDB-style null-byte separator and a zero-padded monotonic `seqNo` per doc. The seqNo is cached in memory and lazily discovered on first append after a cold start via a single reverse-iterator seek.

Consumed by server applications wiring `stores: [createLevelDBStore("./data")]` into a `new Exchange(...)`. Not imported by any other Kyneta package; it is a leaf.

---

## Questions this document answers

- What is a `Store` and what does the exchange call into? → [The `Store` contract](#the-store-contract)
- Why `\x00` as a key separator? → [Key-space design](#key-space-design)
- Why zero-padded `seqNo` instead of a numeric index? → [Why zero-padded seqNo](#why-zero-padded-seqno)
- How is the seqNo counter recovered after a restart? → [SeqNo lifecycle](#seqno-lifecycle)
- How does `replace()` avoid a partial write? → [`replace` is one batch](#replace-is-one-batch)
- How is a `StoreRecord` laid out on disk? → [Binary envelope v2](#binary-envelope-v2)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Store` | The interface defined in `@kyneta/exchange` — `append`, `loadAll`, `replace`, `delete`, `currentMeta`, `listDocIds`, `close`. | A reactive store, a database with queries — this is an append/replace log keyed by doc |
| `LevelDBStore` | The concrete class that implements `Store` over `classic-level`. | LevelDB itself — this is a thin mapping layer |
| `classic-level` | The npm package that provides the LevelDB binding used here. | `level` (older abstract-level API), `leveldown` (C++ binding alone) |
| `StoreMeta` | JSON-serializable per-doc metadata from `@kyneta/exchange`. Materialized at `meta\x00{docId}` and also stored as a `meta`-kind record in the stream. | `StoreRecord`, which is the union of meta and entry records |
| `StoreRecord` | Discriminated union: `{ kind: "meta", meta: StoreMeta }` or `{ kind: "entry", payload: SubstratePayload, version: string }` — one appended piece of doc state. Stored at `record\x00{docId}\x00{seqNo}`. | `StoreMeta` — a `StoreRecord` *contains* a `StoreMeta` when `kind === "meta"` |
| `SubstratePayload` | The exchange's opaque state-transfer shape, with `kind: "entirety" \| "since"`, `encoding: "json" \| "binary"`, and `data`. Produced and consumed by the substrate; this package only serializes it. | The decoded `ChannelMsg` — payloads ride *inside* offers |
| `seqNo` | Zero-padded 16-digit monotonic counter per doc. Resets to 0 after `replace`. | A Lamport clock, a vector clock — this is only a local disk ordering |
| `SEP` | The `\x00` null-byte separator. | A newline, a slash, a dot — null is chosen because it cannot appear in valid UTF-8 text |
| `META_PREFIX` / `RECORD_PREFIX` | The two top-level key namespaces: `"meta\x00"` and `"record\x00"`. | Two separate databases — they share one LevelDB instance |

---

## Architecture

**Thesis**: the cheapest way to persist a "per-doc append log with atomic replace" is to map it directly onto LevelDB's sorted byte key space, using a null-byte separator so docIds never need validation and a zero-padded counter so lexicographic order equals numeric order.

The entire package is one class plus one factory plus a pair of pure envelope functions:

| Component | Role |
|-----------|------|
| `LevelDBStore` | Implements `Store`. Owns one `ClassicLevel` handle and an in-memory `Map<DocId, number>` seqNo cache. |
| `encodeStoreRecord` / `decodeStoreRecord` | Pure functions: `StoreRecord ↔ Uint8Array`. No LevelDB imports. Independently testable. |
| `createLevelDBStore(dbPath)` | Factory — `new LevelDBStore(dbPath)` behind a plain function signature. |

### What `LevelDBStore` is NOT

- **Not a reactive store.** There is no subscribe, no changefeed. The exchange wires its own reactive layer above the store.
- **Not a query engine.** The only lookup primitive is "give me everything for this doc" (`loadAll`) or "give me the metadata for this doc" (`currentMeta`). No predicates, no secondary indexes.
- **Not thread-safe across processes.** LevelDB is single-process. Two processes opening the same `dbPath` will conflict; the exchange assumes one-writer semantics.
- **Not a migration engine.** Schema migrations happen at the `@kyneta/schema` layer. This store just persists whatever payload bytes the substrate produced.

### What "`Store`" means here (and does NOT mean)

- **Not a KV store with arbitrary keys.** The caller never chooses keys; the caller names docs and the store names keys. `docId` is the only external naming primitive.
- **Not a cache.** `append` is durable on return (LevelDB `put` is sync-by-default). No eviction, no TTL.
- **Not a log of `ChannelMsg`.** What gets stored is a `StoreRecord` — either a metadata snapshot or a self-contained substrate payload + version, produced by `substrate.exportSince()` or `substrate.exportEntirety()`.

---

## The `Store` contract

Seven methods, each of which is either a single LevelDB op or a single prefix iteration:

| Method | LevelDB mapping |
|--------|-----------------|
| `append(docId, record: StoreRecord)` | If `record.kind === "meta"`: validate via `resolveMetaFromBatch`, `put(metaKey, JSON)` + `put(recordKey(seq), encoded)`. If `record.kind === "entry"`: require existing meta, `nextSeqNo` (cached or discovered) → single `put(recordKey(seq), encoded)` |
| `loadAll(docId)` → `AsyncIterable<StoreRecord>` | `db.values({ gte: prefix, lt: prefix + "\xff" })` in key order |
| `replace(docId, records: StoreRecord[])` | Collect existing record keys, issue one `batch` that deletes all and writes the replacements starting at `recordKey(0)` — atomic. Must contain at least one `meta` record; materialized index is updated. |
| `delete(docId)` | Collect `[metaKey, ...recordKeys]`, one `batch` of `del`s — atomic |
| `currentMeta(docId)` → `StoreMeta \| null` | `db.get(metaKey)`; `LEVEL_NOT_FOUND` → `null` |
| `listDocIds(prefix?)` → `AsyncIterable<DocId>` | Iterate `meta\x00{prefix}*` keys, slice the prefix |
| `close()` | `db.close()` — required, releases file handles |

Every method is `async`. All writes go through LevelDB's single-writer guarantee — there is no in-memory write buffer to lose on crash.

---

## Key-space design

Source: `packages/exchange/stores/leveldb/src/index.ts` → `META_PREFIX`, `RECORD_PREFIX`, `metaKey`, `recordKey`.

```
meta\x00{docId}                        → StoreMeta (JSON-encoded, materialized index)
record\x00{docId}\x00{seqNo-padded}   → StoreRecord (binary envelope v2)
```

Two observations drove this layout:

1. **`\x00` cannot appear in valid UTF-8 strings.** The null byte is not a legal continuation byte, not a legal start byte, and not representable in a well-formed UTF-8 string. This means no docId — whatever characters it contains — can collide with the separator or "escape" its prefix. The store imposes zero naming constraints on the exchange.
2. **LevelDB orders keys lexicographically.** Within a record namespace, keys for one doc sort together; within one doc, keys sort by `seqNo`. Prefix iteration with `{ gte: prefix, lt: prefix + "\xff" }` scans exactly the keys in a prefix.

The `meta\x00{docId}` key is a **materialized index** — it stores the resolved `StoreMeta` for fast lookup without scanning the record stream. It is updated on every `meta`-kind `append` and during `replace`.

### What `\x00` separators are NOT

- **Not an escape scheme.** There is no escaping of null bytes in user data because user data is never a key component — only `docId` and the internal `seqNo` are. Both are guaranteed null-free.
- **Not a delimiter for parsing values.** Values are opaque bytes (binary envelope for records, JSON for the materialized metadata index). `\x00` exists only in keys.
- **Not FoundationDB's tuple layer.** It is the idea from FoundationDB (null-byte separators in key namespaces), not the full tuple encoding. We do not need variable-length integer encoding; our only numeric component is the zero-padded `seqNo`.

---

## Why zero-padded seqNo

Source: `packages/exchange/stores/leveldb/src/index.ts` → `SEQ_PAD = 16`, `recordKey`.

`seqNo` is stored as a 16-digit zero-padded decimal string: `"0000000000000001"`, `"0000000000000002"`, …, `"9999999999999999"`. LevelDB sorts keys lexicographically; zero-padding makes lexicographic order equal to numeric order. A prefix scan over `record\x00{docId}\x00` returns records in strict insertion order without any secondary index or manual sort.

Sixteen digits is enough for 10^16 appends per doc — far beyond any conceivable workload. The cost is 16 bytes per key versus the 3–4 bytes a binary-encoded uint would take — a non-issue at LevelDB's typical scale. The pad was widened from 10 to 16 digits to provide headroom without any practical cost.

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
| After `replace(docId, records)` | Batch atomically deletes every existing record and writes the replacements starting at `seqNo = 0`. Cache is reset to `records.length - 1`. |

The cold-start seek is **one** reverse iteration limited to one result. It is O(log n) in LevelDB's LSM structure, not O(n). No full scan.

### What the cache is NOT

- **Not a write buffer.** Values are written straight through to LevelDB. The cache only holds the next seqNo to assign.
- **Not consulted on reads.** `loadAll` iterates keys directly; the cache exists only to avoid a seek per append.
- **Not shared across processes.** Single-writer assumption — another process appending to the same dbPath would fork the seqNo space and break ordering.

---

## `replace` is one batch

Source: `packages/exchange/stores/leveldb/src/index.ts` → `replace`.

`replace(docId, records)` is used when the substrate has compacted its state — the new records represent the entire doc and all previous records are now redundant. The batch must contain at least one `meta`-kind record (validated by `resolveMetaFromBatch`). The implementation:

1. Iterate the doc's record prefix and collect existing keys into an array.
2. Construct a single `batch` operation: one `del` per existing key, plus one `put` per new record at `recordKey(docId, 0)`, `recordKey(docId, 1)`, etc. Also `put` the resolved `StoreMeta` at `metaKey(docId)`.
3. Call `db.batch(ops)` — LevelDB guarantees atomicity across the entire batch.
4. Reset `#seqNos.set(docId, records.length - 1)`.

A crash during the batch leaves either the old state (batch not committed) or the new state (batch committed). There is no intermediate state where some deletes have happened and the new records have not been written.

### What `replace` is NOT

- **Not a compaction.** It is a caller-level operation. LevelDB's own SST compaction is independent and opaque.
- **Not a transaction over metadata.** The materialized metadata index at `meta\x00{docId}` *is* updated as part of the same batch — the resolved `StoreMeta` from the replacement records is written atomically alongside the record keys.
- **Not reversible.** Previous records are gone after the batch commits. The substrate is responsible for ensuring the replacement records constitute valid full state.

---

## Binary envelope

Source: `packages/exchange/stores/leveldb/src/index.ts` → `encodeStoreRecord`, `decodeStoreRecord`.

A `StoreRecord` is a discriminated union: either `{ kind: "meta", meta: StoreMeta }` or `{ kind: "entry", payload: SubstratePayload, version: string }`. The on-disk binary envelope uses a single flags byte to distinguish record kinds and encode entry-specific fields.

### Flags byte layout

```
  Bit 7       Bit 3       Bits 2-0
  ┌───┐       ┌───┐       ┌───────┐
  │ F │ . . . │ K │ . . . │ E E E │
  └───┘       └───┘       └───────┘
    │           │           │
    │           │           └─ Entry-specific (kind, encoding, data-type)
    │           └───────────── Record kind: 0 = entry, 1 = meta
    └───────────────────────── Future-format flag (reserved, must be 0)
```

| Bit | Meaning |
|-----|---------|
| 7 | Future-format flag. Reserved, must be `0`. If set, `decodeStoreRecord` throws (forward-compatibility guard). |
| 3 | Record kind: `0` = entry, `1` = meta |
| 2 | (entry only) `payload.data` was a `Uint8Array` (otherwise a `string`, UTF-8-encoded) |
| 1 | (entry only) `payload.encoding === "binary"` (otherwise `"json"`) |
| 0 | (entry only) `payload.kind === "since"` (otherwise `"entirety"`) |

Bits 4–6 are reserved (zero).

### Meta records (bit 3 = 1)

```
┌─────────┬──────────────────────────────┐
│ flags   │ JSON-encoded StoreMeta       │
│ 1 byte  │ remaining bytes              │
└─────────┴──────────────────────────────┘
```

The flags byte has bit 3 set (`0x08`). The remaining bytes are the UTF-8 JSON encoding of the `StoreMeta` object. Bits 0–2 are unused (zero) for meta records.

### Entry records (bit 3 = 0)

```
┌─────────┬──────────────────────┬──────────────────────┬─────────────────────┐
│ flags   │ version length       │ version bytes        │ data bytes          │
│ 1 byte  │ u32 big-endian (4B)  │ UTF-8                │ UTF-8 or raw bytes  │
└─────────┴──────────────────────┴──────────────────────┴─────────────────────┘
```

The flags byte has bit 3 clear. Bits 0–2 encode the entry-specific fields (kind, encoding, data-type). The version string is length-prefixed as a 4-byte big-endian uint32, followed by the version UTF-8 bytes, followed by the payload data.

Bit 2 exists independently of bit 1 because `encoding: "binary"` describes the *payload's interpretation* while bit 2 describes the *storage representation we chose*. In practice they correlate, but keeping them separate lets the envelope round-trip any `(encoding, data)` combination without loss.

### Why a custom envelope instead of JSON

`SubstratePayload.data` may be a `Uint8Array` (CRDT binary state). Wrapping that in JSON requires base64 — doubling the stored size. A flat header + raw bytes saves the base64 round-trip on every read and every write. Meta records use JSON because `StoreMeta` is small and schemaless; the overhead is negligible.

### Round-trip

`encodeStoreRecord` and `decodeStoreRecord` are pure — no LevelDB imports, no side effects. They are tested directly with synthetic `StoreRecord` values covering both meta and entry kinds, every `(kind, encoding, data-type)` combination for entries, and edge cases (empty data, empty version, large payloads, flags-byte bit assertions).

### What the envelope is NOT

- **Not unversioned.** Bit 7 (future-format flag) provides a forward-compatibility escape hatch. A future format can set bit 7 and use a different layout; current decoders will reject it with a clear error instead of silently misinterpreting.
- **Not CBOR or Protobuf.** Those tools solve structured, extensible, self-describing encoding. This envelope solves only "one known discriminated-union record type, packed as tightly as possible." The scope is why the code is ~80 lines.
- **Not exposed to the exchange.** The exchange sees `StoreRecord`; the envelope is this package's internal representation.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `LevelDBStore` | `src/index.ts` | The `Store` implementation. Owns one `ClassicLevel` + seqNo cache. |
| `createLevelDBStore(dbPath)` | `src/index.ts` | Factory returning a `Store`. |
| `encodeStoreRecord(record)` | `src/index.ts` | Pure `StoreRecord → Uint8Array`. |
| `decodeStoreRecord(bytes)` | `src/index.ts` | Pure `Uint8Array → StoreRecord`. |

Types imported (not defined here): `Store`, `StoreRecord`, `StoreMeta`, `DocId` from `@kyneta/exchange`.

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | ~350 | Entire public surface: envelope v2, key helpers, `LevelDBStore`, `createLevelDBStore`. |
| `src/__tests__/leveldb-storage.test.ts` | ~300 | Full integration tests: conformance suite, close+reopen persistence, `currentMeta` lookup, append ordering, `loadAll` iteration order, cold-start seqNo discovery, `replace` atomicity, `delete`, `listDocIds` with prefix, envelope round-trips (meta + entry kinds, edge cases, flags-byte assertions). |

## Testing

Tests open a real `ClassicLevel` at a temp directory per test, exercise the public `Store` surface, and close + clean up afterward. The pure envelope functions are tested directly with synthetic values covering both meta and entry record kinds. There are no mocks; LevelDB is the simplest fast-opening database for this purpose.

**Run with**: `cd packages/exchange/stores/leveldb && pnpm exec vitest run`
