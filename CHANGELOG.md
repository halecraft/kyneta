# Unreleased

  Schema — substrate write coherence unified across plain, Loro, and Yjs:
  - The projection law `σ ≡ Π(λ)` (the naturality condition of the materialisation catamorphism) now holds at every `prepare` boundary across every substrate. CRDT backends advance both the shadow σ AND the native container tree λ inside `prepare`, instead of buffering λ until flush. The pre-1.8 `queueMicrotask` deferral pattern around re-entrant reads or writes from subscriber callbacks (workaround for the buffered-write hole on CRDT substrates) is no longer needed on any backend.
  - **Loro: nested `change()` calls collapse into a single `doc.commit()` per outermost logical action.** A depth-counter `runBatch` bracket mirrors Yjs's `Y.transact` nesting manually; raw `LoroDoc` consumers (providers, persisters) see strictly fewer / smaller-equal commits than before. Outer-origin commit messages are preserved end-to-end — inner re-entrant origins still flow through the kyneta `Changeset.origin`, but only the outermost wins as the Loro commit message attribution.
  - **`struct.json` / `list.json` / `record.json` now store their subtree as a single plain JSON value in the parent CRDT container.** A new `JSON_BOUNDARY = Symbol.for("kyneta:json-boundary")` runtime marker is stamped on the `.json()` factories; `foldPath` short-circuits at boundary segments via plain-JS descent (symmetric with the existing sum boundary); backend coalescers stage full-value writes at the boundary key. Previously these factories silently produced nested CRDT containers — the `.json()` modifier was a type-level intent only.

  **Substrate contract:**
  - `SubstratePrepare.onFlush` → `SubstratePrepare.afterBatch`. The method is a post-batch lifecycle hook on every `executeBatch`, not a buffer-drain — flushes coalescing buffers on local writes and re-materialises the shadow on replay.
  - `SubstratePrepare.runBatch?` is a new optional transaction-bracket primitive that `executeBatch` invokes around the prepare-loop + flush block for local-write batches (replay batches bypass it). CRDT substrates install their native transaction primitive here.
  - `WritableContext.runBatch` is the corresponding context-level callable installed by `buildWritableContext`.
  - `syncShadow(target, source)` is the new shared helper used by both CRDT backends' replay paths to copy a fresh materialised shadow onto the substrate's live shadow without losing the reader's identity.

# 1.7.0

  Schema — tree and set algebras realized end-to-end:
  - `Schema.tree` now works end-to-end on Loro. The write API ships `.create(id, parent, index, data?)`, `.move(id, parent, index)`, and `.delete(id)`; reads expose `.roots`, `.node(id)`, depth-first iteration, and a callable snapshot. Subscribers on `tree.node(id).field` receive precise notifications. Previously a manually-constructed `TreeChange` failed with *"unsupported change type 'tree'"* and Loro events at tree nodes arrived at the changefeed without their `TreeID`.
  - `Schema.set` is now value-addressed end-to-end. `SetRef<I>` exposes `.has(value)`, `.add(value)`, `.delete(value)`, `.clear()`, `.size`, `[Symbol.iterator]` over plain values, and is callable returning `Plain<I>[]`. For object-typed items, `.has(value)` uses content equality. There are no per-member child refs — sets are ref-layer leaf-shaped, not keyed-shaped.

  **Breaking — schema type shapes:**
  - `Plain<TreeSchema<I>>` is now `FlatTreeNode<Plain<I>>[]` (was incorrectly `Plain<I>`). `Zero` of a tree is `[]`. JSON-roundtrip a tree as a flat node array.
  - `Plain<SetSchema<I>>` is now `Plain<I>[]` (was inconsistently `Plain<I>[]` at the type level but produced `Record<string, V>` at runtime). Storage, materialize, zero, and reader all agree on the array shape.
  - `TreeSchema.nodeData` → `TreeSchema.item` for parity with every other container kind (`sequence.item`, `map.item`, `set.item`, `movable.item`).
  - `tree-position` module → `doc-position`: `resolveTreePosition` → `resolveDocPosition`, `flattenTreePosition` → `flattenDocPosition`, `ResolvedTreePosition` → `ResolvedDocPosition`. The algebra operates over a rooted document, not arbitrary schema trees, and the rename frees "tree" for the CRDT primitive.
  - Changefeed cluster: `subscribeTree` → `subscribeDescendants`, `TreeChangefeedProtocol` → `RecursiveChangefeedProtocol`, `HasTreeChangefeed` → `HasRecursiveChangefeed`, `hasTreeChangefeed` → `hasRecursiveChangefeed`. *This supersedes the `ComposedChangefeed*` → `TreeChangefeed*` rename from 1.6.0 — apologies for the consecutive churn; "Tree" is now reserved for the CRDT primitive, and `subscribe(Node|Descendants)` names the shallow/deep semantic without overloading the noun.*
  - `Segment.role` renormalized: `"key" | "index"` → `"field" | "entry" | "index"` (declared product field / runtime string key / runtime numeric index). Identity-keying applies at `seg.role === "field"` boundaries — purely segment-local, no parent-kind sniff. `Path.node(id)` is sugar over `Path.entry(id)`; `Path.field(name)` is reserved for declared product field names. App code that goes through the schema API is unaffected; if you constructed `Path`/`Segment` values directly, update role tags.

  Wire — protocol v2 (**protocol-breaking, lockstep upgrade required**):
  - `WIRE_VERSION` 1 → 2. Binary fragmentation now slices unframed payload bytes rather than framed bytes, saving 6 bytes per fragmented message and eliminating the receiver's double-decode. v1 Fragment frames from older peers produce a typed `unsupported_version` error. Complete frames (the 99% case) remain byte-identical. **Both peers must upgrade in lockstep.**
  - Asymmetric SSE encoding. Client uploads switch from JSON-over-text/plain to raw CBOR over `application/octet-stream`. Server downstream stays text JSON (substrate-forced). Eliminates the ~33% base64 bandwidth tax on `SubstratePayload.bytes`. Bundled with the SSE upgrade.
  - Trust boundary at the decoder. Every wire message is now shape-validated after CBOR/JSON parse via `validateWireMessage`. Malformed or hostile peer messages surface as typed `invalid-wire-message` errors through `Pipeline.onError` instead of crashing the channel or corrupting CRDT state. Identifier byte-length caps are enforced at insert time on the alias map; feature gates in `establish` use strict `=== true`.

  Wire / Transport — `Pipeline` unification:
  - One `Pipeline<S, R>` class replaces seven near-mirror assembly sites across WebSocket, WebRTC, SSE, Unix socket, and Bridge transports. Per-transport send/receive collapses to three lines plus I/O. The same class covers both binary and text substrates and supports asymmetric encodings (the SSE case above). `@kyneta/wire` becomes a leaf — concrete transport packages now import wire-derived symbols via `@kyneta/transport`. No drift between transports.
  - One `Reassembler<T>` replaces `FragmentReassembler` + `TextReassembler`; one `fragmentGeneric<T>` chunk loop replaces `fragmentPayload` + `fragmentTextPayload`.

  Transport reliability fixes:
  - 3-peer relay regression: synchronizer now owns the `channelId` namespace, fixing a regression in which relay topologies (peer A ↔ relay ↔ peer B + peer C) misrouted channel traffic.
  - Wire text codec: UTF-16 surrogate-pair codepoints are now sliced correctly across fragment boundaries; previously, multi-byte characters at fragment splits could be corrupted.
  - Wire version field: encoders now reject `version` values outside the encodable range up front.
  - Wire text frame: stopped a redundant `JSON.stringify`/`JSON.parse` round-trip on the hot text-encoding path.
  - Transport `_send` aborts on the first channel throw, instead of continuing to drive subsequent channels after a partial failure.
  - Transport `establishChannel`: guard failures now propagate (previously failed silently).
  - Transport channel directories: switched to an internal counter for channel IDs (previously vulnerable to ID collisions under concurrent open).
  - Wire fragment collector: now verifies received size when the `complete` marker arrives, rejecting fragmented payloads that under-deliver.
  - Transport `_initialize`: re-init no longer leaks reassembler timers, alias state, or pipeline state from the prior session.
  - Transport frame stream parser: corrected fragmentation handling across stream-boundary discovery (Unix socket).
  - Transport reconnect: proportional jittered backoff replaces fixed-interval retries; shared `tryReconnect` lifted to the base.
  - WebSocket / SSE client transport: `wasConnectedBefore` is reset correctly across reconnect cycles.

  Schema — foundations fixes:
  - Schema-migration support: `supportedHashes` now walks the full schema (previously stopped at the first sum boundary, so peer-set negotiation under heterogeneous schema hashes was incomplete). Hardened internal symbols against accidental enumeration. Library FNV hash now matches the spec exactly. Validation closes several edge cases at schema-construction time.

  Internal:
  - `foldPath` hoisted to `@kyneta/schema` core: the schema-guided path-resolution fold that Loro and Yjs each implemented separately is now one parameterized function. Per-backend code reduces to a small `stepInto*` plus a wrapper. The identity-keying rule (`seg.role === "field"`) and the sum-boundary short-circuit live in one place — no drift surface.
  - `PlainState` shadow is now the universal read surface for CRDT substrates: a single `plainReader(shadow)` covers every interpreter that needs to read substrate state, regardless of backend. Backend-specific readers retire.
  - Generic `MaterializeResolver`: the CRDT → `PlainState` materialization driver lives in core; each backend supplies only the per-kind value-extraction tail.

  Housekeeping:
  - `dist` / Vitest interop fixed; devDeps unified via the pnpm catalog; dead exports removed.
  - `bumper-cars` example: bugs fixed, type discipline restored, functional core fully pure.

# 1.6.1

  Fixes:
  - Schema (discriminated unions): cache-invalidation handlers no longer accrete on repeated variant flips. Sum fields register invalidation handlers on both the parent product and the active variant product; the previous shape stored them in a left-folded closure keyed only by path, so re-interpreting a sum's current variant after each cache flush accumulated dead handlers (eventually risking a stack overflow via composed recursion). Handlers are now keyed by registrant path and replace on re-registration. No API change.
  - Substrate event bridge (Loro / Yjs): re-entrant writes during event-bridge replay are no longer silently dropped. Previously, when a remote sync payload was merged and a user subscriber wrote back to the doc inside the replay, the write reached the changefeed layer but was dropped at the native CRDT — producing an infinite re-delivery loop bounded only by `BudgetExhaustedError`. The bridge now uses a structural `replay` flag instead of a global re-entrancy guard.
  - Exchange echo suppression: `origin` is yours again. The Exchange previously used the string `"sync"` on `Changeset.origin` as its own control signal for suppressing local broadcast. This had two failure modes: (1) user code calling `change(doc, fn, { origin: "sync" })` accidentally suppressed broadcasts; (2) external Loro batches whose origin was not the literal string `"sync"` could echo back to peers. Echo suppression is now keyed on a structural `replay: true` flag in `BatchOptions`, leaving `origin` free for application use.

  **Migration note (if affected):** if any code passed `origin: "sync"` to `change()` to suppress broadcast, switch to `change(ref, fn, { replay: true })`. Application-defined origin strings (`"local"`, `"undo"`, `"llm"`, etc.) work exactly as before and now reliably don't collide with internal sync behavior.

  Diagnostics:
  - `BudgetExhaustedError` is actionable. The error now carries (a) the cascade's entry-point stack frame — typically your `change()` site or the transport boundary that opened the dispatch — (b) a histogram of the top message types contributing to the cascade, and (c) tick-deduplicated history so the recent-events tail shows real subscriber-driven work instead of routing housekeeping. When you hit a runaway, the error tells you which subscriber pair is oscillating.

  Internal:
  - `BatchOptions { origin, replay }` replaces the bare `origin` string at the substrate `prepare/flush` boundary. No public API change for `change()` callers other than the new `replay` flag.

# 1.6.0

  Schema:
  - Re-entrant `change()` inside subscribers now works. Calling `change(doc, ...)` (or `.set()`, `.push()`, `.delete()`, etc.) from inside a `subscribe(doc, ...)` or `subscribeNode(doc, ...)` callback no longer throws *"Mutation during notification delivery is not supported."* The substrate mutation is still synchronous (later reads in the same callback see the new state); subscribers receive a fresh `Changeset` in the next sub-tick of the same outer dispatch. You can delete any `queueMicrotask` wrappers around re-entrant `change()` calls.
  - Cross-doc cascade detection. A→B→A→B oscillations across multiple docs in the same Exchange now share one bounded budget and raise `BudgetExhaustedError` with diagnostic history. Standalone substrates (created outside any Exchange) use a private lease, so cross-substrate cascade detection is opt-in.
  - `subscribe(leafRef, cb)` now works on scalar / text / counter / richtext leaves — deep delivery on a leaf is vacuously the leaf's own changes. Previously this threw and required `subscribeNode` instead.

  Breaking renames (schema-protocol level):
  - `ComposedChangefeedProtocol` → `TreeChangefeedProtocol`
  - `HasComposedChangefeed` → `HasTreeChangefeed`
  - `hasComposedChangefeed` → `hasTreeChangefeed`

  If your code only uses `subscribe` / `subscribeNode` / `change` you are unaffected. The rename matters if you wrote a custom integration that branched on these type guards (e.g., a custom React store). *Note: 1.7.0 renames these again to `RecursiveChangefeed*` / `subscribeDescendants` — if you can upgrade through both, skip this step.*

  Housekeeping:
  - Consolidated random-id primitives — SSE, Unix-socket, and WebSocket server transports now use `@kyneta/random` directly (re-exported from `@kyneta/transport`).

# 1.5.2

  Fixes (no action required):
  - Index: materialized views built from `Source.union`, `Source.map`, or `Source.filter` no longer silently lose entries under composition. Three classes of bug are closed: (1) `Source.union` retracting a key that exists in both upstreams used to delete the entry instead of decrementing its refcount; (2) `Source.map` with a non-injective key function (multiple source keys → same target key) had the same problem; (3) `Source.filter` with a predicate that depends on a mutable value never re-evaluated, so entries never entered or left the filtered view as values changed. `Collection` now refcounts internally — existing combinators just start behaving correctly, no code change needed.
  - Exchange: mutations performed inside `exchange.peers` / peer-event subscribers (e.g., reacting to `peer-departed` by writing a doc) now propagate to remaining peers. Previously the mutation reached the local store but the sync input was stranded until the next external event triggered another dispatch pass.

  Additions (opt-in):
  - `Source.filter(source, pred, { watch })`: pass a `watch` function to re-evaluate the predicate when the watched portion of a value mutates — same contract as `KeySpec.watch` on `Index.by`. Use this whenever your filter predicate reads a field that can change after the entry is created. Without `watch`, filters still behave as before (fine for immutable values).
  - `Source.snapshotZSet()`: returns current state as a `SourceEvent` (delta + values) preserving ZSet multiplicity. For adapter and combinator authors who need the raw integrated ZSet; the existing weight-collapsed `snapshot()` is unchanged.

  Internal:
  - `@kyneta/machine`: extracted `createDispatcher` and `Lease` primitives; Synchronizer rewritten as a faithful `Program<Msg, Model, Fx>` with accumulator drains absorbed into the algebra. No public API change — this is the substrate that enabled the Exchange fix above.

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
