# @kyneta/indexeddb-store — Technical Reference

> **Package**: `@kyneta/indexeddb-store`
> **Role**: IndexedDB persistence backend for `@kyneta/exchange` — implements the `Store` interface using the browser's native IndexedDB API, with two object stores (meta + records), structured clone serialization (no binary envelope), and transaction-based atomicity.
> **Depends on**: `@kyneta/exchange` (peer), `@kyneta/schema` (peer)
> **Depended on by**: Browser applications that want client-side persistent storage behind an `Exchange`.
> **Canonical symbols**: `IndexedDBStore`, `createIndexedDBStore`, `deleteIndexedDBStore`, `IndexedDBStoreOptions`, `SeatLocks`
> **Key invariant(s)**: Every mutating `Store` method executes within a single IDB `readwrite` transaction spanning the document stores and `store_meta`, and checks its seat's fence there — a crash or tab close mid-transaction leaves either the old state or the new state, never a partial write, and a store whose seat was taken again writes nothing. A seat lock is only ever requested while holding the database's allocation lock. `compact()` deletes a doc's records at or before a mark and writes the new ones in one transaction. Structured clone preserves `Uint8Array` and `string` natively, eliminating the binary envelope needed by LevelDB.

A browser-side implementation of `@kyneta/exchange`'s `Store` interface. Maps the exchange's per-doc append / compact / load API onto two IndexedDB object stores: `meta` (keyed by `docId`) and `records` (auto-increment primary key with a `byDoc` index). IDB's structured clone algorithm serializes `StoreRecord` values directly — no custom encoding step.

Consumed by browser applications wiring `store: await createIndexedDBStore("my-db")` into a `new Exchange(...)`. Not imported by any other Kyneta package; it is a leaf.

---

## Questions this document answers

- What is a `Store` and what does the exchange call into? → [The `Store` contract](#the-store-contract)
- Why two IDB object stores instead of one? → [Architecture](#architecture)
- Why no binary envelope? → [Why structured clone eliminates the binary envelope](#why-structured-clone-eliminates-the-binary-envelope)
- Why auto-increment keys instead of zero-padded seqNo? → [Why auto-increment keys replace zero-padded seqNo](#why-auto-increment-keys-replace-zero-padded-seqno)
- What are the IDB Promise wrappers? → [IDB Promise wrappers](#idb-promise-wrappers)
- How does `compact()` avoid a partial write? → [`compact` is one transaction](#compact-is-one-transaction)
- Can several tabs open one database? → [Why auto-increment keys replace zero-padded seqNo](#why-auto-increment-keys-replace-zero-padded-seqno)
- Why does a reloaded page keep its `peerId`, and a duplicated tab not share it? → [Seats](#seats)
- Can two tabs share one store? → [What `IndexedDBStore` is NOT](#what-indexeddbstore-is-not)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Store` | The interface defined in `@kyneta/exchange` — `seat`, `append`, `loadAll`, `mark`, `compact`, `delete`, `currentMeta`, `listDocIds`, `close`. | A reactive store, a database with queries — this is an append log keyed by doc, compacted by mark |
| `IndexedDBStore` | The concrete class that implements `Store` over the browser's IndexedDB API. | IndexedDB itself — this is a thin mapping layer |
| `StoreMeta` | JSON-serializable per-doc metadata from `@kyneta/exchange`. Stored as a row in the `meta` object store and also present as a `meta`-kind record in the `records` stream. | `StoreRecord`, which is the union of meta and entry records |
| `StoreRecord` | Discriminated union: `{ kind: "meta", meta: StoreMeta }` or `{ kind: "entry", payload: SubstratePayload, version: string }` — one appended piece of doc state. Stored as a `RecordRow` value in the `records` object store. | `StoreMeta` — a `StoreRecord` *contains* a `StoreMeta` when `kind === "meta"` |
| `SubstratePayload` | The exchange's opaque state-transfer shape, with `kind: "entirety" \| "since"`, `encoding: "json" \| "binary"`, and `data`. Produced and consumed by the substrate; this package only stores it. | The decoded `ChannelMsg` — payloads ride *inside* offers |
| `MetaRow` | Internal row shape in the `meta` object store: `{ docId: string, meta: StoreMeta }`. Keyed by `docId`. | `RecordRow` |
| `RecordRow` | Internal row shape in the `records` object store: `{ id?: number, docId: string, record: StoreRecord }`. `id` is the auto-increment primary key. | `MetaRow` |
| `structured clone` | The browser's native serialization algorithm used by IndexedDB to persist JavaScript values. Handles `Uint8Array`, `Date`, `Map`, `Set`, etc. without manual encoding. | JSON serialization — structured clone is a superset |

---

## Architecture

**Thesis**: in the browser, IndexedDB is the only durable storage API with real transaction semantics. Structured clone eliminates the need for a custom binary envelope, and auto-increment keys eliminate manual seqNo management — the result is a simpler implementation than LevelDB at the cost of being single-tab.

The database (version 2) contains three object stores:

```
Object store "doc_meta":   (per-document metadata)
  keyPath: "docId"
  value: MetaRow { docId, meta: StoreMeta }

Object store "records":
  keyPath: "id" (autoIncrement)
  index "byDoc": keyPath "docId" (non-unique)
  value: RecordRow { id?, docId, record: StoreRecord }

Object store "store_meta": (store-global metadata: format version, seat pool)
  keyPath: "key"
  value: { key, value }
```

The `doc_meta` store is a **materialized index** — it stores the resolved `StoreMeta` for fast lookup via `currentMeta()` without scanning the record stream. Updated on every `meta`-kind `append` and during `compact`. (Renamed from `meta` to disambiguate from `store_meta`.) The `store_meta` store holds store-global facts keyed by an opaque `key` (the on-disk format version under `key = "format"`, the seat pool under `key = "seats"`), read on open and by each write's fence check — never through the `Store` interface. `DB_VERSION` was bumped 1 → 2 to introduce both via `onupgradeneeded`; that structural version is orthogonal to the data-format version held in `store_meta`.

The entire package is one class plus two factories plus three IDB Promise wrappers:

| Component | Role |
|-----------|------|
| `IndexedDBStore` | Implements `Store`. Owns one `IDBDatabase` handle and one seat lock. |
| `createIndexedDBStore(dbName, options?)` | Async factory — `IndexedDBStore.open(dbName, options)` behind a plain function signature. |
| `openPooledSeat`, `openSeat`, `holdLock` | Seat allocation: see [Seats](#seats). |
| `deleteIndexedDBStore(dbName)` | Deletes an IndexedDB database entirely. For test cleanup and development. |
| `req(request)` | Wraps an `IDBRequest` in a `Promise`. |
| `txDone(tx)` | Wraps an `IDBTransaction`'s completion in a `Promise`. |
| `openDatabase(dbName)` | Opens (or creates) the database with the schema above. |

### What `IndexedDBStore` is NOT

- **Not a reactive store.** There is no subscribe, no changefeed. The exchange wires its own reactive layer above the store.
- **Not a query engine.** The only lookup primitive is "give me everything for this doc" (`loadAll`) or "give me the metadata for this doc" (`currentMeta`). No predicates, no ad-hoc secondary indexes beyond the built-in `byDoc` index.
- **Not shared across tabs as an instance.** Each browser tab opens its own store, with its own connection and its own seat. Several tabs over one `dbName` see the same data, and their writes interleave at transaction boundaries, which the store contract allows.
- **Not a migration engine.** Schema migrations happen at the `@kyneta/schema` layer. The format check `IndexedDBStore.open` runs is a *compatibility check*, not a migration: it stamps a `{ major, minor }` version into `store_meta` on a brand-new store, accepts a compatible one, or throws `StoreFormatVersionError` (releasing the connection so the refusal doesn't block `deleteDatabase`) — but never rewrites. This store just persists whatever `StoreRecord` values the substrate produced.

### What "`Store`" means here (and does NOT mean)

- **Not a KV store with arbitrary keys.** The caller never chooses keys; the caller names docs and the store names keys internally. `docId` is the only external naming primitive.
- **Not a cache.** `append` is durable on transaction commit. No eviction, no TTL.
- **Not a log of `ChannelMsg`.** What gets stored is a `StoreRecord` — either a metadata snapshot or a self-contained substrate payload + version, produced by `substrate.exportSince()` or `substrate.exportEntirety()`.

---

## The `Store` contract

A `seat`, and eight methods, each of which is either a single IDB transaction or a single index query. Every `readwrite` transaction also covers `store_meta`, and first reads the pool and calls `assertSeatHeld` (aborting and throwing `SeatLostError` when the seat has been taken again):

| Method | IDB mapping |
|--------|-------------|
| `append(docId, record: StoreRecord)` | One `readwrite` transaction over both stores. If `record.kind === "meta"`: validate via `resolveMetaFromBatch`, `put` into `meta` store, `add` into `records` store. If `record.kind === "entry"`: require existing meta (read from `meta` store), `add` into `records` store. Transaction commits atomically. |
| `loadAll(docId)` → `AsyncIterable<StoreRecord>` | One `readonly` transaction. `index("byDoc").getAll(docId)` returns `RecordRow[]` in auto-increment key order (insertion order). Yields each `row.record`. |
| `mark(docId)` → `StoreMark \| null` | One `readonly` transaction. A reverse key cursor over `byDoc` for `docId` gives the highest primary key: the mark of the doc's last record. |
| `compact(docId, records, through)` | One `readwrite` transaction. Read existing meta, validate via `resolveMetaFromBatch`. Delete the doc's `RecordRow`s whose key is at or before `through` (none when `through` is `null`), `add` the new records, update `meta` store with resolved `StoreMeta`. Atomic. |
| `delete(docId)` | One `readwrite` transaction. Delete from `meta` store, delete all `RecordRow`s for this doc via `byDoc` index keys. |
| `currentMeta(docId)` → `StoreMeta \| null` | One `readonly` transaction. `meta.get(docId)` → `MetaRow \| undefined`. Return `row.meta` or `null`. |
| `listDocIds(prefix?)` → `AsyncIterable<DocId>` | One `readonly` transaction on the `meta` store. If `prefix` is given, scope the scan to `IDBKeyRange.bound(prefix, prefixSuccessor(prefix, "code-unit"), false, true)`: IndexedDB compares strings by UTF-16 code unit. (The `prefix + "\uffff"` bound it replaced cut off an id continuing with U+FFFF.) `getAllKeys(range)` returns matching `docId` strings. |
| `close()` | `db.close()`, and releases the seat lock. Required before `deleteIndexedDBStore`. |

Every method is `async`. All writes go through IDB's transaction guarantee — there is no in-memory write buffer to lose on crash.

---

## Seats

Source: `packages/exchange/stores/indexeddb/src/index.ts` → `IndexedDBStore.open`, `openPooledSeat`, `openSeat`, `holdLock`.

The store issues its Runtime's `peerId`: a **pooled** seat (see §"Durable seats" in `packages/exchange/TECHNICAL.md`). The pool, and each seat's fence, live in `store_meta` under `seats`, beside the format marker, so deleting the database deletes the seats that vouched for its history.

Seats are held with Web Locks, which every page and worker of an origin shares and which the browser releases at a page's unloading-document cleanup, crash or close. Names start with `kyneta:`, clear of the specification's reserved `-` prefix:

- `kyneta:${dbName}:alloc`, the allocation lock;
- `kyneta:${dbName}:seat:${peerId}`, held for the store's lifetime.

**A seat lock is only ever requested while holding `alloc`.** So while an open holds it, the set of held seats can shrink but not grow, and one snapshot is authoritative:

1. **Gather**, under `alloc`: `store_meta`'s format marker and pool, and `navigator.locks.query()`, keeping this database's seat locks.
2. **Plan**: `planStoreOpen` with `pooled` seating: the oldest seat not held, or a fresh one appended, with its fence incremented; or a format refusal.
3. **Execute**, still under `alloc`: request the seat lock with `ifAvailable`. A `null` lock means the invariant was broken (a lock taken outside `alloc`), so the open rejects rather than return a seat another holder may have. Then write the marker and the pool in one `readwrite` transaction.

The seat lock's `request()` promise settles only when the lock is released, so the `alloc` callback cannot await it; `holdLock` reports the grant through a promise of its own, and hands back the function that releases it.

**Why the fence.** Nothing in the Web Locks or IndexedDB specifications orders a dying page's last transaction before its lock release. Every write transaction covers `store_meta` and checks the fence, so a late commit from the previous holder, landing after the new holder hydrated, fails instead of putting a second operation at one address. Write transactions over `store_meta` are serialized by IndexedDB, so the check and an allocation cannot interleave.

**Without Web Locks** (an insecure origin, an old browser, or `locks: null`), the store warns once and issues a session seat: unique, never stored, never fenced.

**The writer of a serialized document** lives on its `doc_meta` row, as `writer` (absent while unclaimed). Each write transaction reads the row after the fence: an authored `append` or `compact` (`WriteOptions.authored`) records the store's seat when none is recorded, and aborts with `WriterRefusedError` when another seat is; an unauthored write keeps the record; `delete` aborts when another seat is the writer. `writerOf` reads the row. The same transaction serializes two tabs' first claims. Only a pooled seat records anything (see §"Serialized documents: one writer seat per storage" in `packages/exchange/TECHNICAL.md`).

The lock manager is `createIndexedDBStore(name, { locks })`, `navigator.locks` by default: `SeatLocks` is the part of `LockManager` the store uses. The tests pass `FakeLockManager` pages (`src/__tests__/fake-locks.ts`), whose `terminate()` releases a page's locks as the browser does.

---

## Why structured clone eliminates the binary envelope

Source: `packages/exchange/stores/indexeddb/src/index.ts` — `RecordRow`.

LevelDB stores opaque `Uint8Array` values, so the LevelDB store needs a custom binary envelope to serialize `StoreRecord` (flags byte, length-prefixed version, raw data bytes). This exists primarily because `SubstratePayload.data` may be a `Uint8Array`, and JSON would require a lossy or bloated base64 round-trip.

IndexedDB uses the browser's **structured clone algorithm** to persist values. Structured clone handles `Uint8Array` natively — it survives a write/read cycle without any encoding step. `string` values likewise survive unchanged. The entire `StoreRecord` object — including nested `SubstratePayload` with either `string` or `Uint8Array` data — is stored directly as a `RecordRow` property.

Result: zero encoding functions, zero decoding functions, zero flags bytes. The `IndexedDBStore` source has no `encode` or `decode` symbols at all.

---

## Why auto-increment keys replace zero-padded seqNo

Source: `packages/exchange/stores/indexeddb/src/index.ts` — `RECORDS_STORE` object store with `autoIncrement: true`.

LevelDB sorts keys lexicographically, so the LevelDB store zero-pads a per-doc counter (`"0000000000000001"`) to make lex order equal numeric order. This requires a seqNo cache and cold-start recovery via reverse seek.

IndexedDB's auto-increment key generator produces monotonically increasing integers within an object store, and `getAll` on an index returns results ordered by primary key (the auto-increment `id`). This means:

1. **Insertion order is preserved automatically.** Records appended first have lower `id` values and sort first.
2. **No counter to manage.** No in-memory cache, no cold-start seek.
3. **No padding.** IDB keys are typed — numeric comparisons, not lexicographic.
4. **Several tabs can open one database.** The key generator belongs to the object store, shared by every connection, so appends from several tabs get distinct keys. An in-memory counter per connection would hand two tabs the same position. The key is also the store's `StoreMark`.

A `compact` deletes the rows at or before its mark and `add`s new ones, which get fresh keys higher than any before, so they sort after every row that remains, including rows another tab appended after the mark.

---

## IDB Promise wrappers

Source: `packages/exchange/stores/indexeddb/src/index.ts` → `req`, `txDone`, `openDatabase`.

IndexedDB's native API is event-based (`onsuccess`, `onerror`, `oncomplete`). Three small wrappers convert this to Promises:

| Wrapper | Input | Output | Listens to |
|---------|-------|--------|------------|
| `req<T>(request: IDBRequest<T>)` | Any `IDBRequest` | `Promise<T>` resolving to `request.result` | `onsuccess`, `onerror` |
| `txDone(tx: IDBTransaction)` | An `IDBTransaction` | `Promise<void>` resolving on commit | `oncomplete`, `onabort`, `onerror` |
| `openDatabase(dbName: string)` | Database name | `Promise<IDBDatabase>` | `onupgradeneeded` (schema creation), `onsuccess`, `onerror` |

`req` is used for individual reads (`get`, `getAll`, `getAllKeys`) and does not wait for the enclosing transaction to complete — only for that one request's result. `txDone` is awaited at the end of every mutating method to ensure the transaction has committed before returning to the caller.

`openDatabase` handles schema creation in `onupgradeneeded`: it creates the `meta` store (keyPath `"docId"`) and the `records` store (keyPath `"id"`, auto-increment) with the `byDoc` index. The `if (!db.objectStoreNames.contains(...))` guards make the upgrade idempotent.

---

## `compact` is one transaction

Source: `packages/exchange/stores/indexeddb/src/index.ts` → `compact`.

`compact(docId, records, through)` is used when the exchange has compacted a document: it read the records up to the mark `through`, took them in, and writes the whole document. Records at or after the mark that it did not read (another tab's) stay. The batch must contain at least one `meta`-kind record (validated by `resolveMetaFromBatch`). The implementation:

1. Open a `readwrite` transaction spanning both `meta` and `records` stores.
2. Read existing `StoreMeta` from the `meta` store inside the transaction for consistency.
3. Validate via `resolveMetaFromBatch(records, existingMeta)` — at least one meta present, immutable fields match.
4. Query the `byDoc` index for this `docId`'s primary keys, and delete each at or before `through`.
5. `add` each new record as a new `RecordRow`.
6. `put` the resolved `StoreMeta` into the `meta` store.
7. Await `txDone(tx)` — IDB guarantees atomicity across the entire transaction.

A crash or tab close during the transaction leaves either the old state (transaction not committed) or the new state (transaction committed). There is no intermediate state where some deletes have happened and the new records have not been written.

### What `compact` is NOT

- **Not a background process.** It is a caller-level operation. IDB has no background compaction concept.
- **Not a transaction over metadata alone.** The materialized metadata in the `meta` store *is* updated as part of the same transaction — the resolved `StoreMeta` from the new records is written atomically alongside the record rows.
- **Not a deletion of what it did not read.** Only records at or before the mark go.
- **Not reversible.** Deleted records are gone after the transaction commits. The exchange is responsible for having taken in everything it deletes.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `IndexedDBStore` | `src/index.ts` | The `Store` implementation. Owns one `IDBDatabase` handle. |
| `createIndexedDBStore(dbName, options?)` | `src/index.ts` | Async factory returning a `Store`. |
| `IndexedDBStoreOptions`, `SeatLocks` | `src/index.ts` | The lock manager seats come from. |
| `deleteIndexedDBStore(dbName)` | `src/index.ts` | Deletes the named IndexedDB database. |
| `MetaRow` | `src/index.ts` | Internal row shape: `{ docId, meta }`. Not exported. |
| `RecordRow` | `src/index.ts` | Internal row shape: `{ id?, docId, record }`. Not exported. |

Types imported (not defined here): `Store`, `StoreRecord`, `StoreMeta`, `DocId`, `Seat`, `resolveMetaFromBatch`, `planStoreOpen`, `assertSeatHeld` from `@kyneta/exchange`.

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Entire public surface: IDB wrappers, row shapes, `IndexedDBStore`, `createIndexedDBStore`, `deleteIndexedDBStore`. |
| `src/__tests__/indexeddb-storage.test.ts` | Conformance suite (`describeStore`) + IndexedDB-specific tests: close+reopen persistence, append-after-reopen ordering, compact+reopen, `listDocIds` after reopen, database isolation between separate `dbName`s, `deleteDatabase` cleanup. |
| `src/__tests__/indexeddb-seats.test.ts` | Seat allocation against a model of an origin's pages: a duplicated tab, a reload, a crash, overlapping reloads, concurrent first opens, a lock taken outside `alloc`, and no Web Locks. |
| `src/__tests__/fake-locks.ts` | `FakeLockManager`: exclusive named locks, `ifAvailable`, `query()`, and a page's `terminate()`. |
| `src/__tests__/setup.ts` | Imports `fake-indexeddb/auto` to provide the `indexedDB` global in Node.js test environments. |

## Testing

Tests run against `fake-indexeddb` — a spec-compliant in-memory IndexedDB implementation for Node.js, imported globally via the setup file. Each test creates a unique database name (`kyneta-test-{timestamp}-{counter}`) and all databases are deleted in `afterAll`. The reusable `describeStore` conformance suite validates the full `Store` contract on Node's real `navigator.locks`, and its seat section (`pooled`) on `FakeLockManager` pages, since one process cannot make a page die: exclusive and reused seats, fenced writes after a page's locks are terminated, and two connections to one database. Additional test blocks cover close+reopen persistence, append ordering across reopens, compact+reopen, `listDocIds` after reopen, two-store isolation, and `deleteDatabase` cleanup. There are no mocks beyond `fake-indexeddb` and the lock model.

**Run with**: `cd packages/exchange/stores/indexeddb && pnpm exec vitest run`
