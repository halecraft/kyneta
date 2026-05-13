# 1.5.1

  Fixes:
  - Schema: correct sum (discriminated union) interpretation — fix `NATIVE` double-define crash, Loro path resolution across sum boundaries, read-only interior types for sum variant fields
  - Changefeed: `ReactiveMap` callable returns snapshot copy for `useSyncExternalStore` compatibility

# 1.5.0

  Store — SQL store family (4 new packages):
  - @kyneta/sqlite-store: SQLite persistence backend via sync `SqliteAdapter` (`better-sqlite3`, `bun:sqlite`); atomic meta+record writes
  - @kyneta/postgres-store: Postgres persistence with async `createPostgresStore` factory, schema validation against `information_schema`, JSONB metadata
  - @kyneta/prisma-store: Prisma ORM adapter — plug an existing `PrismaClient` for teams that have standardized on Prisma
  - @kyneta/sql-store-core: shared pure helpers (`toRow`/`fromRow`, `planAppend`/`planReplace`) and `failOnNthCall` fault-injection test utility

  Wire — protocol v1:
  - Compact binary format: 6-byte header, numeric `u16` frame IDs, removed transport prefix and unused hash byte
  - DocId/schemaHash aliasing: receiver-meaningful integer aliases negotiated via `present`; per-message overhead reduced from ~45 bytes to ≤15 bytes
  - Wire-feature negotiation: `WireFeatures` map in `establish` for forward-compatible capability advertisement
  - Delivery-mode taxonomy: three named modes (muxed, streamed, datagram) — streamed and datagram implementation-deferred
  - Identifier length caps: `DOC_ID_MAX_UTF8_BYTES = 512`, `SCHEMA_HASH_MAX_UTF8_BYTES = 256` with typed rejection errors
  - Codec collapse: deleted `cborCodec`/`textCodec` as `ChannelMsg ↔ bytes` codecs; SSE integrated into alias-aware pipeline

  Exchange:
  - Cohort governance: `canCompact` predicate distinguishes durability-critical peers from ephemeral ones for compaction-safe replication
  - @kyneta/bridge-transport — new package: extracted from `@kyneta/transport` with codec-faithful message routing (all bridge-driven tests now exercise the production wire path)
  - Bridge routing by `transportId` instead of `transportType`

  Schema:
  - Variance-safe replica types: `Replica<V>`/`ReplicaFactory<V>` split into `ReplicaLike`/`ReplicaFactoryLike`, eliminating `any` casts in the synchronizer

  Fixes:
  - Transport: reset reassembler and alias state on reconnect; prevent unhandled rejections in SSE POST retry path

  Housekeeping:
  - @kyneta/random — new package: secure-context-free random ID primitives extracted from scattered implementations
  - Consolidated test packages into `@kyneta/test-integration` with SQLite integration suite
  - Example: `prisma-counter` — collaborative Loro counter with Prisma/Postgres persistence

# 1.4.0

  Exchange — architecture overhaul:
  - Session/sync split: Synchronizer decomposed into session program (peer lifecycle, channel topology) and sync program (document convergence); four-state peer lifecycle (joined/disconnected/reconnected/departed); `depart` wire message for intentional departure; `establish-request`/`establish-response` collapsed into single `establish` message
  - Governance reform: `DocPolicy` → `Policy` (gates only, no notification callbacks); gate predicates renamed `canShare`/`canAccept`/`canConnect`/`canReset`; `exchange.destroy(docId)` replaces `dismiss()`; new `exchange.suspend(docId)` / `resume(docId)` for reversible sync-graph departure; `exchange.documents` reactive collection replaces `onDocCreated`/`onDocDismissed` callbacks; policy `dispose` hook and per-Exchange Line registry for clean shutdown
  - Durable Line: Lines survive transient disconnects and process restarts; `close()` is local-only teardown (documents preserved), `destroy()` is permanent; automatic compaction at quiescence; `nextSeq` persisted for resume
  - Peer ID: per-tab unique peer IDs via localStorage CAS lease (`persistentPeerId`); `peerId` required at the type level (`ExchangeParams.id: string | PeerIdentityInput`), runtime guard removed

  Schema — new algebras and compiler evolution:
  - Position algebra + useText: Substrate-agnostic `Position` interface with sticky-side semantics; `transformIndex` (gap-addressing) and `textInstructionsToPatches` (offset-based DOM ops); `PlainPosition`, `LoroPosition`, `YjsPosition` with shared conformance suite; `change(ref, fn, { origin })` for echo suppression
  - Rich text: `Schema.richText(markConfig)` — 11th schema kind with `MarkConfig` for mark vocabulary + Peritext expand behavior; `RichTextInstruction` (retain/insert/delete/format); marks as first-class algebra with composable extension model
  - Tree-position algebra: flat ↔ tree position mapping for editor bindings (ProseMirror-style flat integer positions to `{ path, offset }` pairs)
  - Sequence algebra unification: shared indexed-coalgebra helpers (text/sequence/movable) and keyed-coalgebra helpers (map/set), eliminating copy-paste across interpreter transformers
  - Schema migrations: identity-stable migrations with tier-derived coordination (T0 additive, T1a rename, T2 lossy projection, T3 epoch boundary); `supportedHashes` in `present` messages for heterogeneous-peer sync
  - Composition-law binding: algebraic `[LAW]` tags (`"lww"`, `"additive"`, `"positional-ot"`, etc.) replace kind-name `[CAPS]`; `RestrictLaws` enforces substrate/sync-protocol fidelity; blocks the "silent weakening" fourth outcome

  Store:
  - Store contract v2: unified `StoreRecord` stream (discriminated `meta` | `entry`); materialized metadata index; `replace()` atomic compaction; store-program Mealy machine for coordination; `storeVersion` advances only on write success
  - @kyneta/indexeddb-store — new package: IndexedDB persistence backend for browser-side Exchange

  React:
  - `useText(textRef)`: React hook for collaborative textarea/input binding with model-as-source-of-truth, surgical remote patching, IME-safe composition, and cursor preservation; browser undo/redo interception
  - todo-react upgraded to collaborative inline editing with `Schema.text()` + `useText`

  Fixes:
  - Yjs: include delete set in `YjsVersion` comparison
  - React: intercept Shift+Cmd+Z (redo) in `attach()` keydown handler

  Housekeeping:
  - Build: migrated bundler from tsup to tsdown (Rolldown-based)
  - Extracted shared Bun build + static serving into `internal/bun-server`
  - LLM-optimized rewrite of ARCHITECTURE.md + all per-package TECHNICAL.md files

# 1.3.1

  - Line.protocol: first-class protocol objects for Line (`protocol.open` / `protocol.listen`)
  - ensure-* idempotency: renamed open commands to `ensure-*` and formalized idempotency invariant across exchange and machine
  - WebSocket transport: runtime-agnostic WebSocket constructor injection — eliminated `globalThis.WebSocket` default and Bun-specific cast

# 1.3.0

  - @kyneta/index — new package: Reactive document indexing with Catalog, secondary indexes, joins, and DBSP-grounded algebraic redesign (ZSet, Source,
  Collection, Index)
  - Schema.tree: Full tree CRDT support with navigation, mutation, and observation (Loro-backed)
  - added the [REMOVE] symbol: Structural self-removal for container-child refs in schema
  - Source.flatMap: New combinator + Source.of convenience for the index package
  - Wire fix: Replaced @levischuck/tiny-cbor with internal CBOR codec (UTF-8 string encoding bug)
  - Schema refactors: Generic createDoc, typed [NATIVE] functor, Schema.doc → Schema.struct rename
  - Housekeeping: experimental packages moved to experimental/

# 1.2.0

  - Transport layer — 3 new packages: @kyneta/transport (base), @kyneta/unix-socket-transport (stream-oriented), @kyneta/webrtc-transport (BYODC
  DataChannel)
  - @kyneta/machine: TEA-like state machine--universal Mealy machine with effect interpreter; transport clients rewritten as pure Programs
  - @kyneta/changefeed: Extracted as independent reactive contract package; promoted to developer-facing type
  - Storage: StorageBackend interface + InMemoryStorageBackend + LevelDB persistent backend; storage-first sync
  - Replica / Substrate split: Factored Replica from Substrate; ReplicaFactory for all substrate types; two-phase construction
  - Sync protocol: Structural merge with schema fingerprint verification; document disposition (Interpret / Replicate tiers); version comparison
  - exchange.peers: Peer lifecycle as a Changefeed; duplicate peerId detection
  - Line: Reliable bidirectional message stream between two peers
  - advance(): Universal history trimming across all substrates
  - Schema overhaul: First-class native leaf types, symbol-keyed metadata ([KIND], [TAGS]), json.bind() / loro.bind() namespace API, dissolved LoroSchema
  namespace
  - onDocCreated / onUnresolvedDoc: Exchange lifecycle hooks
  - Example: unix-socket-sync — leaderless TUI config sync over unix sockets with Loro CRDT
