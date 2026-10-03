# 4.0.0

4.0 adds undo across documents, read-only documents, unloading documents from memory, and an identity that survives a restart. Documents use less memory, and large documents are much faster. Most changes since 3.x are breaking: some report as compile errors, and some change behaviour without one.

**Upgrade every peer and every store together.** The sync protocol changed, so a 4.0 peer and a 3.x peer cannot sync. A 4.0 peer cannot load `json` or Yjs documents that a 3.x peer stored; Loro documents load. [docs/upgrading-4.0.md](docs/upgrading-4.0.md) covers every breaking change with a before and after, and how to bring stored data across.

This release also publishes `@kyneta/perspective` 0.2.0 and, for the first time, `@kyneta/datalog` 0.1.0 and `@kyneta/zset` 0.1.0 ([below](#kynetaperspective-020-kynetadatalog-010-kynetazset-010)).

## New

### Undo

- **`createUndoStack`** (`@kyneta/exchange`) undoes this peer's own writes as they stand now, alongside everyone else's. Text a collaborator typed inside yours survives your undo, and a value someone else changed since is left alone. It works on plain, Loro and Yjs documents.
  - **One step per gesture**, across as many documents as it wrote: `stack.gesture(fn)`. Typing is grouped into words and pauses with `stack.typing(fn)`, and writes an editor binding makes directly are grouped with `stack.follow(docId)`.
  - **Undo by document.** `stack.undo({ docs: [cardId] })` undoes the newest step that wrote that card, even if steps in other cards are newer, so one stack can serve every editor in a tab. A step is never undone from under a newer step that changed the same thing.
  - **An undo says what it did.** It resolves `{ kind: "undone", step, stale, dropped }`, where `stale` lists the parts someone else had changed since. Pass `{ whole: true }` to undo a step entirely or not at all; a step that can't be undone whole resolves `{ kind: "refused", step, stale }`.
  - **`stack.top("undo", docs?)`** is the step an undo would try first, as a tracked read, so a button can enable itself.
  - **The stack is stored with a store.** It survives a reload, and a crash in the middle of an undo is finished on the next load without applying anything twice.
- **`useText(ref, { undo: stack })`** (`@kyneta/react`) wires Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Ctrl+Y) to a stack, and puts the caret where the change was.

### Read-only documents

- **`canWrite(docId, peer)`** is a new policy predicate (`@kyneta/exchange`): who may write a document. Register one rule on every peer, keyed by `principal`, and the document is writable on its writer and read-only everywhere else. On a peer the rule excludes, every write throws `NotAWriterError` before anything is applied, and an offer from such a peer is not accepted anywhere.
- **A refused writer is told.** When a peer rejects an offer (by `canAccept` or `canWrite`), it answers with a new `refuse` message. The writer reports an `offer-refused` warning and stops sending that document to that peer. If the refusing peer is the document's authority, the writer's writes throw `OfferRefusedError` until it reconnects.
- **`writeRefusal(doc)`, `writeRefusalFeed(doc)`** and `useWriteRefusal(doc)` (`@kyneta/react`) say why a document refuses writes: a policy, the authority, another tab writing it, an unload, a close, or a `json` document still loading. Every reason extends `WriteRefusal`. `useText` keeps its field read-only while the document refuses writes.

### Memory and lifecycle

- **`exchange.unload(docId)`** frees a stored document's memory and keeps it in the store. Peers still receive every write made before the unload. `get` or `open` loads it back, as it was.
- **`exchange.open(docId, bound)`** resolves the document if this exchange holds it (open, replicated or stored), and `undefined` otherwise. Unlike `get`, it never creates a document.
- **Closed documents free their memory.** `destroy`, `unload`, `reset` and `shutdown` release the native document (`LoroDoc`, `Y.Doc`), and a document nothing holds is garbage-collected. A ref you still hold reads the document's last value, and its writes throw `DocumentClosedError`.

### Identity and storage

- **You name a principal; the exchange issues its peer id.** `new Exchange({ principal: "alice" })`. The principal is who the peer speaks for, and several exchanges may share one. The peer id (its *seat*) is issued by the runtime, so two tabs or processes never write under the same id.
- **A store keeps your seat across restarts.** A reload over the same storage gets the same seat back, while two tabs open at once get different ones. A restarted server is the same peer, so a `Line` to it carries on with nothing lost or delivered twice.
- **A write reaches peers only after the store has it.** With a store, a crash can no longer leave peers holding writes the next session doesn't know it made. `persisted(doc)`, `whenPersisted(doc)` and `persistenceError(doc)` report whether a document's writes are stored. A failed store write is retried on its own.
- **Several tabs or processes can share one storage safely**: tabs over one IndexedDB database, processes over one Postgres schema. A `json` document is written by one of them, and the others read it (`WriterRefusedError` on their writes).
- **`whenPeer(exchange, predicate)`** resolves with the first connected peer that matches, so you can find a server by principal and open a `Line` to its seat.

### Smaller additions

- **`Feed<T>` and `createFeed`** (`@kyneta/changefeed`): one shape for a value you call to read and subscribe to observe. Ref flags, readiness terms and `Reactive` values are all `Feed`s. `signalFeed`, `settableFeed`, `firstDefined` and `cachedSnapshot` join it.
- **`DispatcherHandle.hold(fn)`** (`@kyneta/machine`) runs `fn` while the dispatcher is busy, then drains what was dispatched meanwhile, in order.
- **Type guards** (`@kyneta/schema`): `isScalarSchema`, `isProductSchema`, `isSequenceSchema`, `isMapSchema` and the other per-kind schema guards, and `hasSubstrate`, `hasBackingDoc`, `hasMigrationChain`, `hasPopulated` and `hasDeleted` for the symbol-keyed protocols.
- **`diffText`** moves to `@kyneta/schema`; `@kyneta/react` still re-exports it.
- **Testing helpers** (`@kyneta/schema/testing`, `@kyneta/exchange/testing`): `collectGarbage()`, `disposeConformance`, `undoConformance`, `createInMemoryStoreData()`, `recordsOf()` and `abandonSeat()`.

## Faster and smaller

- **Reading a large document is about 300 times faster.** A read returns the document's own frozen value instead of building a copy: reading a 10,000-row record went from about 400 ms and 300 MiB retained to about 1.3 ms and nothing retained.
- **A change from a peer costs what it touched.** At 10,000 rows, one remote keystroke went from 264 ms to 70 µs on Loro, 10.5 ms to 24 µs on Yjs, and 18.7 ms to 43 µs on ephemeral documents.
- **Writing one key of a record costs the same however large the record is.** It used to visit every key.
- **Refs use about a thirteenth of the memory**, and a list item's or record entry's ref is collected once nothing holds it.
- **Presence sends what changed.** One cursor move on a 200-peer roster went from 7,895 bytes to 150, and stays flat as the roster grows.
- **A sync merge delivers one changeset**, however many paths it touched.

## Breaking changes

[docs/upgrading-4.0.md](docs/upgrading-4.0.md) has a before and after for each.

### Everyone upgrades together

- **The sync protocol is version 2.1.** It adds `accept` (a receiver confirms what it now holds) and `refuse`, and `establish` carries the peer's principal. 3.x peers cannot sync with 4.0 peers.
- **Stored `json` and Yjs documents written by 3.x do not load.** The plain format is `["plain", 2, 0]` and the Yjs format is `["yjs", 2, 0]`; `whenHydrated` rejects for an older document. Loro documents load unchanged.
- **The ephemeral wire format changed**, for deletes and whole-record writes.
- **Every peer gets a new CRDT peer number.** Yjs client ids are 53 bits and Loro peer ids 64 bits, which makes collisions practically impossible. Existing Loro documents keep their history and add one version-vector entry per peer.

### Identity

- **`new Exchange({ principal })` replaces `id`.** `RuntimeParams.peerId`, `PeerIdentityInput` and the peer's `name` are gone; `PeerIdentityDetails` is `{ peerId, principal, type }`.
- **`persistentPeerId` and `releasePeerId` are removed.** A store issues a durable seat; without one, each session is a new peer.
- **Key policies on `principal`** when you mean who a peer is, and on `peerId` when you mean which replica.
- **A `Line` is addressed by seat.** Find a server with `whenPeer`, then `Chat.sender(exchange, server.peerId)`.
- **`useExchangeSingleton(principal, factory)`** (`@kyneta/react`) is keyed by principal, and `factory` may return a promise.

### Storage

- **One store per exchange:** `store: Store` replaces `stores: Store[]`.
- **Postgres needs two migrations:** a `writer` column on `kyneta_doc_meta`, and `COLLATE "C"` on both `doc_id` columns. `createPostgresStore` refuses a schema without them and names the SQL to run; `postgresSchema()` returns the full DDL.
- **Stores are opened by a function.** The `LevelDBStore`, `PostgresStore` and `PrismaStore` constructors are private: use `createLevelDBStore`, `createPostgresStore` or `createPrismaStore`. A Postgres store holds a connection until it closes, so close stores before ending the pool.
- **One process owns a SQLite database.** A second adapter on the same file waits `busyTimeout` (5 s) and is refused. Use Postgres for several processes.
- **Store formats are 1.1.** 3.x stores open, and gain a pool of seats.
- **A `json` document stored with a store refuses writes until it has loaded**, with `DocumentLoadingError`. Wait for `whenHydrated(doc)`, or seed it with `initialize`.

### Reading and writing

- **Reads are frozen, and keep their identity until something they read changes.** `doc.items()` returns the same object until a write changes it. Mutating a read throws, and `Plain<S>` is `readonly`. To change the document, write through the ref (`doc.tags.push(item)`), which is also the smallest change to merge and sync.
- **Methods need their ref.** `onChange={ref.set}` throws when it is called; write `onChange={v => ref.set(v)}`. The compiler catches a detached method you call yourself, but not one passed as a callback.
- **A deleted ref reads `undefined`**, whatever its type. Use `deleted(ref)` to ask.
- **`bytes` fields read as `Uint8Array`.**
- **Writes complete their values.** A partial struct written to a document gets the zeros of its missing fields, and keys the schema doesn't declare are dropped, on every backend.
- **`unwrap(doc)` throws when the document refuses writes**, with the same error: a native editor binding cannot write past a policy, a close, or a load. Render a read-only document through Kyneta refs.
- **Change constructors take `Owned` values** (`own(value)` or `trustAsOwned(value)`), for `sequenceChange`, `mapChange`, `mapClearChange`, `setOpChange` and `richTextChange` as for `replaceChange`.

### Subscriptions

- **One `batch()` reaches a subscriber as one changeset**, with its changes in the order they were made. Code that counted callbacks should read `changeset.changes`.
- **An op's `path` is a plain `RawPath`**, fixed when the op is made, so a held op always replays to the item it was written to.
- **Changesets are delivered after the native commit**, and own-path subscribers run before deep subscribers.
- **A native write is a local write.** An edit made through `unwrap` (an editor binding, say) is delivered with `replay: false`, and is synced and stored like any other write.
- **A write that replaces a subtree reaches subscribers inside it**, each with the change as seen from where it subscribed.
- **`ReactiveMap.current` is a snapshot** (`@kyneta/changefeed`), the same `Map` until the map changes. `exchange.peers`, `exchange.documents` and every `@kyneta/index` collection follow the same rule.
- **`Reactive.refresh(thunk)`** (`@kyneta/reactive`) takes the render's thunk, and re-runs only when the thunk or something it read changed.

### Document lifecycle

- **`destroy`, `reset` and `shutdown` close their documents.** A held ref reads its last value, and its writes and `unwrap` throw `DocumentClosedError`. `whenHydrated`, `whenSettled` and `whenPersisted` reject with it when the document closes first.
- **`initialize` rejects with the document's refusal** when the document refuses this peer's writes and holds no data.
- **`whenSettled` and `useDocReady` take `authority`**, not `peer`.
- **A `canShare` that returns `false` for everything also blocks fetching by id.** Return `undefined` for documents a policy doesn't govern; `Line` depends on it.

### Ephemeral documents

- **Writing a whole record, or `record.clear()`, removes every key written before it**, including keys this peer hadn't received yet. Use `.set(key, value)` and `.delete(key)` to change one entry.
- **`lastUpdated` is `null`** for a field nobody has written.
- **`SyncMode` has no `delivery` field.** Ephemeral documents sync both ways.

### Writing your own backend, store or transport

These matter only if you implement Kyneta's interfaces yourself.

- **Replicas** implement `dispose(reason?)`, `digest()` and `commitPending()`. `exportSince` returns `null` only when it cannot serve the cursor, and an empty delta when the peer is current. Versions implement `join`, and `reaches(ours, theirs)` tests holding one.
- **Substrates** report every local write through `subscribeLocalUpdates`, announce outside writes with `ctx.announce(ops, { origin, local })`, and receive each batch's `BatchOutcome` in `afterBatch`. `RecordInverseFn` is called once per forward write. A map change may carry `clear`; `mapChangeEffects` resolves it.
- **Factories** implement only `replica`, `upgrade` and, optionally, `createForHydration`. Build documents with `createSubstrate`, `substrateFromEntirety`, `replicaFromEntirety` and `upgradeReplica`. Plain documents are built through `plainSubstrateFactory` and `plainReplicaFactory`.
- **Resolvers** implement `resolveHasKey`.
- **Stores** issue a `seat`, take `WriteOptions` on `append` and `compact`, implement `mark`, `compact` and `writerOf` in place of `replace`, and declare `seats` to the conformance suite. `listDocIds(prefix)` returns exactly the ids starting with `prefix` (`prefixSuccessor` helps).
- **Refs** are one construction, `createRef`. The interpreter layers (`withReadable`, `withWritable`, `withChangefeed` and the rest) and the fluent builder are gone; `interpret` and `createInterpreter` remain for folds over a schema.

### Removed

`persistentPeerId`, `releasePeerId`, `resolveLease`, `plainInterpreter`, `Writable<S>`, `INTERPRETER`, `INVALIDATE`, `ADDRESS_TABLE`, `createNullishStore`, `CallableRef`, `SettleTerm`, `YjsVersion.fromDeleteSet`, `withoutTracking`, `writeByPath`, `Delivery`, the `duplicate-peer` diagnostic, and the changefeed delivery internals (`deliverNotifications`, `attachChangefeed`, `withChangefeed`). The upgrade guide lists each with its replacement.

## Fixed

- **`whenSettled` waits for the authority's data**, not only its first reply, over every transport. It also honours `Policy.authority`: a server with `authority: "self"` no longer waits forever.
- **`canShare` covers a peer that asks for a document by id**, which used to receive it regardless.
- **Edits made through an editor binding or `unwrap` are synced and stored.**
- **Concurrent Yjs deletes and inserts converge.**
- **A plain peer that restarts without a store no longer ends up with a duplicated copy.**
- **Two lineages of a `json` document converge on the newer one** and report a `lineage-collision` error, instead of the two peers swapping states.
- **Ephemeral documents**: a write always beats what it overwrites, a delete removes entries the deleting peer never saw, empty entries replicate, missing fields read as zeros, and deletes never come back as `null`.
- **Subscribers**: a write that rewrites a subtree reaches subscribers inside it, a remote change to a nested list keeps refs pointing at the right items, and a subscriber added during delivery doesn't receive the changeset already in flight.
- **Refs**: one ref per place in a document, which dies exactly when that place stops existing, and comes back if it is set again.
- **No value you pass to a write is shared with the document**, so changing it afterwards changes nothing.
- **`useValue`, `useSelector` and `useTracked` keep their value's identity** between renders, and `useChangefeed` works over schema refs, `exchange.peers` and `exchange.documents`.
- **`compact()` works for Loro and Yjs documents**, and for one-way documents a `Line` sends.
- **`listDocIds(prefix)` is exact** on SQLite (it ignored case), LevelDB and IndexedDB (they missed ids with characters beyond U+00FF), and Postgres under a locale collation (it found nothing).
- **Stores**: a destroy's delete runs after the writes before it, writes made while a document loads are stored, and a reloaded plain document's version matches the store's.
- **Destroying a document while it loads**, or creating one with the same id afterwards, no longer leaks writes between the two.
- **Loro** commits aborted batches, ignores native writes to containers the schema doesn't declare, and never announces a batch twice.
- **`BudgetExhaustedError`** (`@kyneta/machine`) names where a cascade started, however deeply it nests.

## Behind the scenes

The schema package's interpreters are now plain folds, and a ref's methods live on one shared prototype per schema node. The Runtime's document lifecycle is a single pure program, and suspend, unload and destroy leave the sync graph one way. An ephemeral relay recognises a peer that holds what it holds, so a reconnect sends nothing. Non-null assertions are a lint error across the repo.

## @kyneta/perspective 0.2.0, @kyneta/datalog 0.1.0, @kyneta/zset 0.1.0

These three are versioned on their own, outside the 4.0 line.

- **`@kyneta/datalog`** is the Datalog evaluator, now its own package: stratified, semi-naive and incremental, with negation, aggregation, guards, a join index, and relations and functions computed by host code. Every predicate and host function has one arity, checked when a program is built, so a wrong-width rule is an error instead of rows nothing matches. `nth` and `lookup` read an index or key you know is present.
- **`@kyneta/zset`** is the DBSP ℤ-set and its algebra, with no dependencies. `zsetPositive` filters to positive weights and is not DBSP's `distinct`.
- **`@kyneta/perspective` 0.2.0** depends on both, and its exports are only its own: import the Datalog language and evaluator from `@kyneta/datalog`, and ℤ-sets from `@kyneta/zset`. Conflict resolution always runs the rules in the store: a store with no rules resolves to structure with no values, and a rule set that cannot be evaluated throws instead of falling back to last-writer-wins. `createIncrementalPipelineFromBootstrap(result)` is `createIncrementalPipelineFromStore(result.store, result.config)`.
- **Fixed** (`@kyneta/datalog`, `@kyneta/perspective`): a rule whose only premise is a negation (`h :- not p.`) holds while `p` is empty; a retraction through a recursive rule over cyclic data no longer leaves facts behind; a fact inserted twice is retracted correctly; and a step that retracts and inserts at once no longer keeps a derivation it should drop.

# @kyneta/perspective 0.1.0

`@kyneta/perspective` graduates from `experimental/` to `packages/` and
publishes at 0.1.0, versioned independently of the core 3.x train.

## Added

- **`@kyneta/perspective@0.1.0` on npm** — Convergent Constraint Systems:
  agents assert constraints, merge is set union, and a stratified Datalog
evaluator derives the shared reality. Zero runtime dependencies. The full
Unified CCS Engine: Layer 0 kernel, incremental DBSP-grounded pipeline,
native LWW/Fugue fast paths, bootstrap with default solver rules.
- **Independent versioning** — perspective declares
  `"versioning": "independent"`; it is skipped by group and default bumps and
tags its releases `@kyneta/perspective@0.x` rather than `v<core-version>`.

## Changed

- **Release tooling is now `@halecraft/release`** (`release.config.ts`, the
  `release` script); `scripts/release.ts` is deleted. Publishing is idempotent
— versions already on the registry are skipped — and core releases still tag
`v<version>`.
- **Root `verify`/`test` now include perspective** (the
  `--filter='!@kyneta/perspective'` exclusions are removed); the publish gate
covers the package it ships.

# 3.0.0

Upgrading from 2.x? See [docs/upgrading-3.0.md](docs/upgrading-3.0.md) — it
opens with the three changes that alter behaviour without a compile error.

## Breaking

- **The readiness API is removed** (`@kyneta/exchange`, `@kyneta/react`). Gone: `waitForSync`, `sync(doc).settled()`, `hasSync`, `describeSyncStatus`, `SyncStatusSummary`, `createDerivedSyncStore`. Use `whenSettled(doc)` to wait and `docStatus(doc)` to ask; compose a status label from connectivity + `peerStates` + `docStatus`.
- **`populated(ref)` and `deleted(ref)` return booleans** (`@kyneta/schema`). The `[CHANGEFEED]` carriers are now `populatedFeed` / `deletedFeed`; `isPopulated` and `isDeleted` are removed. **`if (populated(ref))` changes meaning without a compile error** — a carrier is callable, so it was always truthy. Every other use of the pair is a type error until updated.
- **`ephemeral` is a field-level CvRDT** (`@kyneta/schema`). `ephemeral.bind(schema)` still compiles, but each scalar leaf now carries its own `[value, timestamp, deleted?]`, so concurrent writes to different fields both survive instead of the newest snapshot replacing everything. `StateVersion.compare` always reports `"concurrent"`, so no offer is ever discarded as stale. Nothing persists across a restart, which is what `durability: "transient"` always meant. The wire tag changed from `["plain", 1, 0]` to `["ephemeral", 1, 0]`, so 2.x and 3.0 peers cannot sync an ephemeral document — nothing is stored, so nothing needs migrating. `TimestampVersion` and the `buildUpgrade` barrel export are removed with it.
- **`createDoc` no longer takes a peer identity** (`@kyneta/schema`). Use `createDocAs(peerId, bound, payload?)` when identity matters; `createDoc(bound, payload?)` always uses a random one. Replace `createDoc(bound, undefined, "peer-a")` with `createDocAs("peer-a", bound)`.
- **`get()` promotes a replicate document when given its schema** (`@kyneta/exchange`). It previously threw. State accumulated while the document was headless carries across the upgrade.
- **`get()` returns a suspended document without resuming it** (`@kyneta/exchange`). It previously threw. Suspension is sync-graph membership, not local readability, so a read no longer restarts traffic peers can observe.
- **The two schema-compatibility laws are named** (`@kyneta/schema`). `supportsHash` is the primitive; `hashesIntersect` applies it pairwise. `mismatchForInterpretation` answers "can my schema read this document?"; `mismatchForSync` answers "is there a shape we both speak?". `supportedHashes` moves from `DocMetadata` to `ReadCapability` and is required there — a document has one shape, a peer has a set it can cope with.
- **`initialize` and `useInitialize` infer their draft** (`@kyneta/exchange`, `@kyneta/react`). The seed callback now receives the document's type instead of `unknown`. Callers who never named the type parameter gain typing and may find latent mistakes the `unknown` was hiding; callers who wrote `initialize<Foo>(…)` need `Foo` to be the document's type.
- **`Source.of` infers its document and item** (`@kyneta/index`). The accessor receives the real `DocRef` and the key function its item, instead of `any` and `unknown`. Same consequence: previously-unchecked callbacks are now checked.
- **`formatPath` is removed** (`@kyneta/schema`). Use `path.format()`.
- **`advanceSchema`, `findJsonBoundary` and `JsonBoundaryHit` are removed** (`@kyneta/schema`). Use `walkPath`, `findOpaqueBoundary` and `OpaqueBoundaryHit`.
- **`.decay()` below an opaque boundary is rejected at `bind()`** (`@kyneta/schema`). It never worked — a field inside a `sum` or `.json()` blob has no timestamp of its own, so the decay silently never fired. Move `.decay()` onto the sum or `.json()` node itself.

## Added

- **`whenSettled(doc)`, `docStatus(doc)` and `initialize(doc, seed)`** (`@kyneta/exchange`) — wait for every truth source, ask what a document holds, and seed defaults exactly once without overwriting stored data. Settle terms are extensible via a registry.
- **`useDocStatus` and `useInitialize`** (`@kyneta/react`) — the same two, as hooks.
- **`@kyneta/index` reads an exchange.** `Source.fromExchange(exchange, bound)` and `Source.of(...)` build live, incrementally-maintained views over every document matching a schema.
- **`exchange.replicate(docId)`** (`@kyneta/exchange`) — hold a document headlessly, then promote it later by calling `get()` with a schema.
- **`Policy.authority`** (`@kyneta/exchange`) — declare whose answer settles "is this document empty?".
- **Three ephemeral peers in a mesh no longer talk over each other** (`@kyneta/schema`, `@kyneta/exchange`). Opening an ephemeral document on three peers wedged the event loop, with nobody writing anything. Every merge advertised a state change whether or not the join moved, every import was relayed to all peers but the sender, and `StateVersion.compare` can never answer `"equal"` — so nothing declined a payload it already held. Two peers were immune, because excluding the sender leaves nobody to forward to; that is also why every test covering this used two. `mergeStateTree` now reports whether the join moved, and only an import that changed something is relayed.
- **A tombstone no longer ties with a live `null`** (`@kyneta/schema`). The LWW tie-break ranked a leaf by its value, and a tombstone's value is `null` with its marker in a separate slot — so a delete on one peer and a `null` write on another, in the same millisecond, ranked identically and each peer kept its own, diverging permanently and silently through the schema-blind merge that headless relays use. On a tie a live tuple now beats a tombstone.
- **A declared field survives a partial write, and an emptied record still reads as `{}`** (`@kyneta/schema`). The state tree applied one rule to every container — an absent key means "removed" — which is true of a record's keys and false of a struct's fields. A record emptied by deleting its last key vanished from replicated state, and a struct write omitting a field removed it outright. Both were invisible on the peer that caused them, because reads come from a local shadow and only the tree replicates; the field then reappeared from the next peer to sync, since absence carries no information in this merge.
- **Map deletes converge on `ephemeral`** (`@kyneta/schema`). A delete writes a tombstone, so a `Schema.record` used as a presence roster can lose members. Semantics are LWW-Element-Set: a later add beats an earlier delete.
- **`walkPath` / `PathWalk`** (`@kyneta/schema`) — the single schema-guided path traversal. It never throws; it reports where the walk stopped and the caller applies policy.

## Fixed

- **Transient documents never reach durable storage** (`@kyneta/exchange`). A `durability: "transient"` document used to get one empty write at creation, a store read on every open, and a delete on every teardown.
- **Deep subscription survives an unpopulated `.nullable()` field** (`@kyneta/schema`). Subscribing before an optional field was written captured the null variant's changefeed and never heard about writes inside the populated one — permanently. Because the exchange subscribes at creation time, this affected every synced document: the write reached the local substrate but did not replicate until some later unrelated write. `@kyneta/reactive` and React's `useValue` / `useTracked` were affected through the same channel.
- **Writes at or inside a `.nullable()` subtree work on the CRDT backends** (`@kyneta/loro-schema`, `@kyneta/yjs-schema`). They either threw or, on Loro, updated the local shadow while the CRDT never received the write — read back correctly and silently lost on replication.
- **`Schema.record` is usable on `ephemeral`** (`@kyneta/schema`). Every map write threw.
- **Two ephemeral peers writing in the same millisecond converge** (`@kyneta/schema`). The merge resolved timestamp ties by taking the remote value, which is not commutative, so each peer kept its own and neither ever converged — with no error. Which value survives a tie may differ from previous releases; that both peers agree is the fix.
- **The ephemeral substrate no longer decomposes an atomic register when a write targets its interior** (`@kyneta/schema`). Sibling fields the change did not mention were discarded, and replicated state could blend fields across two peers' `sum` variants. Local reads were unaffected, which is what hid it.
- **Schema path-mismatch errors name `stepSchema`**, the function that produces them, rather than a wrapper no traversal calls (`@kyneta/schema`).

## Changed

- **`NotificationPlan` gains a `paths` field** (`@kyneta/schema`), which deep delivery needs to walk ancestors structurally. Additive.

# 2.3.2

## Fixed

- **Op-log paths are frozen when authored** (`@kyneta/schema`). They aliased live addressing state, so an op could describe a location that had since moved.
- **Identity-keyed whole-value writes materialize correctly** (`@kyneta/schema`).

# 2.3.1

Released to npm but never tagged; its content is folded into 2.3.2 above.

# 2.3.0

## Breaking

- **`Version.epoch` is renamed `Version.lineage`** (`@kyneta/schema`, `@kyneta/exchange`, `@kyneta/wire`, `@kyneta/transport`). "Epoch" now means only the T3-migration axis. `SubstratePayload` carries `lineage` too.
- **`LEGACY_EPOCH` and its compatibility paths are removed** (`@kyneta/schema`, `@kyneta/exchange`).
- **`YjsVersion` encodes its delete-set as a fixed-size digest** rather than raw bytes (`@kyneta/yjs-schema`), bounding version size. Versions are not comparable across this change.

## Added

- **`applyTextInstructions(ref, instructions)`** (`@kyneta/schema`) — replay a `TextInstruction[]` onto a live `TextRef`.
- **A sender declares discontinuity explicitly.** `SubstratePayload.lineage` replaces the receiver-side heuristic that inferred a reset from payload shape.

## Fixed

- **Ephemeral documents no longer trigger a compaction reset** (`@kyneta/exchange`). They always send entireties, which the heuristic read as a lineage break.
- **Non-entirety payloads are no longer passed to `resetFromEntirety`** at a lineage boundary (`@kyneta/exchange`).

# 2.2.0

## Breaking

- **Replica identity is a first-class `epoch` on `Version`** (`@kyneta/schema`, `@kyneta/exchange`), replacing `PlainVersion.incarnation`. Renamed again to `lineage` in 2.3.0 — upgrading past this release, go straight to that name.

## Fixed

- **A standalone `Runtime` persists its local mutations** (`@kyneta/exchange`). Persistence ran only through the network shell, so a `Runtime` used without an `Exchange` — a documented, supported configuration — silently dropped writes on shutdown. Anything written after hydration completed, or to a document that already had stored data, was lost with no error.
- **Wrapping a populated `Runtime` in an `Exchange` registers the documents it already holds** (`@kyneta/exchange`). They were previously invisible to the sync graph for the life of the process.
- **Plain-substrate log resets are exact when adopting an entirety with an explicit version** (`@kyneta/schema`).

# 2.1.0

## Added

- **Passive presence timeouts (decay)**: The `ephemeral` substrate supports `.decay(ms)` via the schema DSL (e.g. `Schema.string().decay(2000)`). If a peer drops without explicitly un-setting its presence, the substrate performs a purely local sweep that projects expired fields back to their structural zero. The decay is a local projection and securely prevents "zombie states" from persisting. (`jj:nxxwqosl`)
- **Standalone `Runtime` export**: The local imperative shell has been extracted from `Exchange` into a new `Runtime` class. `Runtime` manages local document execution (Stores, Hydration, Changefeed Leases, and the new ticking clock) independently of the network. For purely local-first apps without any transports, you can now instantiate a `Runtime` instead of an `Exchange`. (`jj:vmrtlqsl`)

## Fixed

- **Reactive deletion tracking**: Fixed an issue where `isDeleted(ref)` / `deleted(ref)` would not trigger reactive re-renders when elements were deleted (e.g., from a sequence or map). (`jj:ttzlznnk`)
- **Proxy-based sum addressing**: Replaced eager variant carrier objects with a stateless Proxy for all Kyneta sum types (`.nullable()`, `union`, `discriminatedUnion`). This resolves a stale identity footgun in React: components holding a `SumRef` across a variant shift (e.g., from `absent` to `present`) no longer read stale shapes. `useValue` and `useTracked` now automatically react to variant shifts, and `doc.someSum` maintains a single, mathematically stable object identity. (`jj:plvpyzkq`)
- **Enforced `useSelector` reactivity**: `useSelector` now throws a descriptive runtime error if the selector accidentally returns a Kyneta `Ref` (which fails to trigger property reads and breaks reactivity), guiding developers to project the data or call `t => t()`. (`jj:nxxwqosl`)

# 2.0.0

**2.0 is a coordinated, breaking release.** All peers must upgrade together — 1.x ↔ 2.0 will not sync — and pre-2.0 on-disk stores belong to a prior epoch: both the schema-hash (`HASH_ALGORITHM_VERSION` → `"02"`) and the new store-format marker reset. Plan/design references are linked as `jj:<id>` for those who want the full rationale; the entries below carry what you need to upgrade.

## Breaking changes — APIs

- **`change(ref, fn)` → `batch(ref, fn)`.** *Migrate:* replace facade `change(...)` calls and `{ change }` imports with `batch`; prefer unwrapping a single mutation to a direct write (`doc.x.set(v)`) over `batch(doc, d => d.x.set(v))`. Same signature and semantics; re-exported under the new name from `@kyneta/schema`, `@kyneta/schema/basic`, `@kyneta/react`, and the Loro/Yjs backends. Since auto-commit-on-write (1.8.0) a single mutation commits on its own, so the facade's job is now batching, not committing. (`jj:rkwspltk`)

- **`SyncProtocol` → `SyncMode`** — it names a per-document sync *mode/policy*, not a wire protocol. *Migrate:* source-level rename — type `SyncProtocol` → `SyncMode`, field `syncProtocol` → `syncMode` (in `DocMetadata`, `bind` configs, `present` metadata), `requiresBidirectionalSync(protocol)` → `(mode)`, the wire helpers (`SyncProtocolWire*` → `SyncModeWire*`, `syncProtocolToWire` → `syncModeToWire`), the validator set `VALID_SYNC_PROTOCOLS` → `VALID_SYNC_MODES`, and the error code `"unknown-sync-protocol"` → `"unknown-sync-mode"`. Re-exported under the new names from `@kyneta/schema` and `@kyneta/exchange`. **No wire bytes change** (the compact key `ms` and its values `0x00`/`0x01`/`0x02` are untouched — a `present` round-trip is byte-identical), and the constants `SYNC_COLLABORATIVE` / `SYNC_AUTHORITATIVE` / `SYNC_EPHEMERAL` are unchanged. The only data effect: persisted metadata key `"syncProtocol"` → `"syncMode"` (operator query path `data->>'syncMode'`), covered by the 2.0 epoch reset. (`jj:yuvupozp`)

- **Sync ready-state vocabulary renamed.** *Migrate:* `ReadyState` → `PeerSyncState` (`.status` → `.state`, `.identity` → `.peer`, value `"absent"` → `"vacant"`); `SyncRef.readyStates` → `peerStates`; `onReadyStateChange` → `onPeerSyncChange`; `Synchronizer.getReadyStates` → `getPeerStates`; React `useSyncStatus` → `useSyncState`. Replace `s.status === "synced"` with `s.state === "synced"`, and prefer `useDocReady(doc)` (below) over deriving a gate from the per-peer array. The never-produced `"unknown"` variant is dropped. Source-level only — no wire/persistence change. (`jj:llosmrmq`)

- **Postgres store takes an injected adapter.** *Migrate:* `createPostgresStore(pool | client)` → `createPostgresStore(fromPool(pool))`, or `createPostgresStore(fromClient(client))` for a single connection. New exports `PgAdapter`, `fromPool`, `fromClient` from `@kyneta/postgres-store`. This also **fixes** the previously-broken bare-`Client` path, which used to throw on `release()`. (`jj:vzuwrotu`)

- **Stores now carry an on-disk format version, and per-doc metadata is renamed `doc_meta`.** *Migrate:* treat pre-2.0 stores as a prior epoch — there is no in-place migration, and a store written under an incompatible format major is now refused on open with a typed error. If you set the SQL `tables` option, rename its key `meta` → `docMeta`. The on-disk names change accordingly (SQL table `kyneta_meta` → `kyneta_doc_meta`, LevelDB key prefix `meta\x00` → `doc-meta\x00`, IndexedDB object store `meta` → `doc_meta`). This is the storage counterpart to the schema-hash epoch reset. (`jj:uvssotsy`)

- **Unix-socket leaderless peer is now a `Transport`, not an `Exchange` consumer.** *Migrate:* `createUnixSocketPeer(exchange, options)` → `createUnixSocketPeer(options)`, then pass it like any transport: `new Exchange({ transports: [peer] })`. `UnixSocketPeer.dispose()` is gone — `exchange.shutdown()` stops it; the `UnixSocketPeer` type becomes `UnixSocketPeerHandle` (`UnixSocketPeerTransport` is also exported). Healing is now in place under one stable `transportId` — the Exchange sees only channel add/remove and all CRDT state survives a heal; the connector defaults to immediate re-negotiation on disconnect (opt into bounded reconnect via `reconnect`). Wire/sync protocol unchanged. (`jj:llpxyzom`)

- **`establish` now carries a required protocol version.** *Migrate:* nothing on the wire — a 2.0 peer's `establish` is byte-identical (an absent version defaults to `(1, 0)`). The field is `EstablishMsg.protocolVersion: { major, minor }` with the `PROTOCOL_VERSION` constant (`@kyneta/transport`, re-exported from `@kyneta/exchange`). Compatibility is a rule, not a negotiation: features differ → silent, `minor` differs → **warning**, `major` differs → **error**. Detection never gates — an incompatible peer stays observable and enters the sync graph (the frozen `SyncRef`/`peerStates` surface is untouched). (`jj:yukrpnwm`)

## Breaking changes — formats

- **All schema hashes change; `HASH_ALGORITHM_VERSION` `"01"` → `"02"`.** *Migrate:* none at the API level — `computeSchemaHash`'s signature and 34-char shape are unchanged; the break is the hash *values*. Redeploy all peers together; 1.x ↔ 2.0 will not sync and a 1.x-persisted `schemaHash` won't match a 2.0 recompute. Canonicalization is now **injective** (field names / constraint values / discriminant keys can no longer forge structural delimiters — e.g. a field named `"a:s:string,b"` no longer collides with two fields `a`/`b`) and includes the `.json()` boundary, so `struct`/`list`/`record` hash distinctly from their `.json()` counterparts. Both were silent sync-incompatibility classes the hash is meant to catch. (`jj:qnmtvtwn`)

## Added

- **Monotonic doc-readiness latch:** `sync(doc).ready` (React `useDocReady(doc)`) flips `true` on first reconciliation — data **or** a terminal `vacant` reply — and never regresses across a reconnect re-handshake or a reconciled peer departing. `sync(doc).readyFor(pred)` / `useDocReady(doc, { peer })` require a matching reconciled peer (authority / quorum). The latch is flicker-free; prefer it over deriving a gate from `peerStates`.
- **`vacant` wire message** (`0x14`, additive): a peer that won't serve a requested doc emits a terminal negative ack; the requester records the peer `vacant` without tearing down its replica. Old peers reject the unknown discriminator harmlessly — wire-backward-compatible.
- **Sync observability:** `sync(doc).connectivity` (`"online" | "connecting" | "offline"`); `sync(doc).settled(opts?)`, which resolves (never rejects) to `{ via: "peer" | "local" | "offline" }`; the pure `describeSyncStatus(peerStates, connectivity, ready)` presentational helper (`@kyneta/exchange`, re-exported from `@kyneta/react`); and React `createDerivedSyncStore`.

## Fixed

- **LevelDB `append` is now atomic** — a single `batch` replaces the separate meta/record puts, so a crash can no longer leave metadata advanced past a missing record. (`jj:pzuytnvo`)

## Packaging

- **`@kyneta/cast` and `@kyneta/compiler` are no longer published.** Both are marked `private` and remain in-repo as experimental (joining `@kyneta/perspective`); they were published at 1.8.0, but there is no 2.0 release of either while they stabilize. (`jj:qyuqnppr`)

## Internal — for substrate & transport authors

- **`SessionEffect`** `{ type: "warning"; message }` → `{ type: "diagnostic"; severity: "error" | "warning"; message }` — the shape the future structured `onProtocolWarning` callback will reuse. Exchange-internal; no application-level or wire change. (`jj:yukrpnwm`)
- **Protocol-version layering:** the sync wire-contract revision (`protocolVersion`) is distinct from `WIRE_VERSION` (frame encoding) and `SyncMode` (per-doc policy). Additive evolution rides `WireFeatures`; `protocolVersion` carries only the one thing features can't express (base abandonment). On the wire it's sparse — `pv: [major, minor]` only when non-default. New `Synchronizer` surface: `declareVacant` / `hasReconciled` / `reconciledMatching` / `connectivity`. (`jj:yukrpnwm`, `jj:llosmrmq`)
- **Schema-hash internals:** `serializeConstraintValue` (`JSON.stringify`-based) is now shared by `hash` / `describe` / `validate` so the three can't drift. Canonicalization (`canonicalTuple`, arrays + strings only) carries a recursion depth cap that throws a clear error on an `as any`-forced cyclic schema graph (the grammar otherwise guarantees finite, eager, acyclic trees; recursive *data* uses `Schema.tree`). (`jj:qnmtvtwn`)
- **Store fault-injection unified on `makeArmedFault`** (`@kyneta/exchange/testing`); the orphaned `failOnNthCall` export is **removed** from `@kyneta/sql-store-core` (its coverage folded into the `makeArmedFault` test). `PostgresStore` no longer sniffs `Pool` vs `Client` — the two transaction behaviours live in `fromPool` / `fromClient`, and `pg` stays a type-only import. (`jj:vzuwrotu`, `jj:pzuytnvo`)
- **Unix-socket cleanup (no consumers):** removed `UnixSocketClientTransport.subscribeToTransitions`, the `UnixSocketClientStateTransition` type, and the unused `UnixSocketServerTransport` helpers (`getConnection` / `getAllConnections` / `isConnected` / `broadcast`); the low-level `UnixSocketConnection` constructor is now `(socket)`. (`jj:llpxyzom`)

# 1.8.0

  Schema — three-primitive substrate contract:
  - The transaction lifecycle (`beginTransaction` / `commit` / `abort` / `inTransaction` / `pending`) is removed from `WritableContext`. `change(doc, fn)` is now a thin wrapper around `ctx.runBatch` (a `runWriter` / `execWriter` pattern over the change-Writer monad). The public `change(doc, fn)` and `applyChanges(ref, ops)` APIs are unchanged. **Breaking** for code that constructed `WritableContext` by hand (test fixtures) or called `ctx.beginTransaction` / `ctx.commit` / `ctx.abort` directly.
  - **`change(doc, fn)` provides read-your-writes inside the block.** σ advances eagerly on every prepare, so two pushes in one block append in order. Pre-refactor, length-derived helpers read a stale σ and silently reordered.
  - **Atomic abort preserved across plain/Loro/Yjs via in-bracket inverse compensation.** When `fn` throws inside the outermost `change(doc, fn)`, the bracket replays the frame's recorded inverses LIFO inside the same commit. σ and λ both revert; one batched native event fires (Loro: one `doc.commit`; Yjs: one `observeDeep` event); the kyneta Changeset surfaces `aborted: true` and contains forward + inverse pairs that net to identity. The change algebra is a groupoid; abort is identity composition `c ∘ c⁻¹ = id`, not state rollback.
  - `WritableContext.dispatch` survives with redefined depth-aware semantics: outside any frame opens an implicit single-op `runBatch` (auto-commit); inside a frame just calls `prepare`. The 5 ref-helper files and the addressing layer's `REMOVE` handler are unchanged.
  - Kyneta-Changeset batching at the outermost-block boundary is preserved as an explicit contract — N helpers in one `change(doc, fn)` deliver one Changeset with N changes to each affected subscriber.
  - **Substrate cleanup**: Loro's per-substrate depth counter and outermost-origin tracking are deleted (ctx-level outermost detection via `frameStarts.length === 0` subsumes them). Yjs's dead `accumulatedDs` field and `afterTransaction` handler are deleted (the accumulator was already unused on the version path).
  - **New types**: `Changeset.aborted?: boolean` on `@kyneta/changefeed`; `BatchOptions.compensating?: boolean` and `BatchOptions.aborted?: boolean` on `@kyneta/schema`; `RECORD_INVERSE` symbol and `RecordInverseFn` type for the internal substrate→bracket inverse-recording protocol.
  - **New module**: `@kyneta/schema`'s `inverse.ts` with `invert(pre, change)` and per-type inverters (`invertReplace`, `invertIncrement`, `invertText`, `invertSequence`, `invertMap`, `invertSet`, `invertRichText`, `invertTree`) plus `deepClonePreState`. Every constructor's reverse arrow is pinned by the groupoid identity round-trip test.

  Schema — substrate write coherence unified across plain, Loro, and Yjs:
  - The projection law `σ ≡ Π(λ)` (the naturality condition of the materialisation catamorphism) now holds at every `prepare` boundary across every substrate. CRDT backends advance both the shadow σ AND the native container tree λ inside `prepare`, instead of buffering λ until flush. The pre-1.8 `queueMicrotask` deferral pattern around re-entrant reads or writes from subscriber callbacks (workaround for the buffered-write hole on CRDT substrates) is no longer needed on any backend.
  - **Loro: nested `change()` calls collapse into a single `doc.commit()` per outermost logical action.** A depth-counter `runBatch` bracket mirrors Yjs's `Y.transact` nesting manually; raw `LoroDoc` consumers (providers, persisters) see strictly fewer / smaller-equal commits than before. Outer-origin commit messages are preserved end-to-end — inner re-entrant origins still flow through the kyneta `Changeset.origin`, but only the outermost wins as the Loro commit message attribution.
  - **`struct.json` / `list.json` / `record.json` now store their subtree as a single plain JSON value in the parent CRDT container.** A new `JSON_BOUNDARY = Symbol.for("kyneta:json-boundary")` runtime marker is stamped on the `.json()` factories; `foldPath` short-circuits at boundary segments via plain-JS descent (symmetric with the existing sum boundary); backend coalescers stage full-value writes at the boundary key. Previously these factories silently produced nested CRDT containers — the `.json()` modifier was a type-level intent only.

  **Substrate contract:**
  - `SubstratePrepare.onFlush` → `SubstratePrepare.afterBatch`. The method is a post-batch lifecycle hook on every `executeBatch`, not a buffer-drain — flushes coalescing buffers on local writes and re-materialises the shadow on replay.
  - `SubstratePrepare.runBatch?` is a new optional transaction-bracket primitive that `executeBatch` invokes around the prepare-loop + flush block for local-write batches (replay batches bypass it). CRDT substrates install their native transaction primitive here.
  - `WritableContext.runBatch` is the corresponding context-level callable installed by `buildWritableContext`.
  - `syncShadow(target, source)` is the new shared helper used by both CRDT backends' replay paths to copy a fresh materialised shadow onto the substrate's live shadow without losing the reader's identity.

  Schema & Changefeed — identity-typed echo suppression and origin-free discriminator:
  - **`Changeset.source` for principled echo suppression.** Added an identity-typed `source?: unknown` field to `Changeset` (propagated from `CommitOptions.source`). Subscribers that issue changes can supply a unique token (e.g., a `Symbol`) and compare it against `cs.source` to suppress their own echoes.
  - **`origin` is pure app-level vocabulary.** The fragile `origin === "local"` string convention has been removed from `text-adapter` and `Line`. Kyneta no longer branches on `origin`'s value internally.
  - **Origin-free own-commit discriminator.** Both CRDT substrates now use their native event machinery to distinguish kyneta-issued commits from external writes, rather than colonizing the user-facing `origin` slot. Loro uses a `subscribePreCommit` hook; Yjs uses a `transaction.meta` mark. External code wrapping a kyneta `change()` in its own `Y.transact` is now correctly classified.

  Schema — optimizations and fixes:
  - **Sequence fixes:** Materialize sequence items when pushing structured objects on Loro. Reject `undefined` values in sequence `push` and `insert`. Bypassed `loro-wasm`'s 8-item insert limit and surfaced original errors during compensation.
  - **Typed `SubstrateCapabilities` bag:** Replaced producer-side `as any` casts on context monkey-patches. Substrates now declare optional capabilities (`nativeResolver`, `positionResolver`, `treeNodeAllocate`) via a typed bag passed to `buildWritableContext`.
  - **Runtime type guards:** Optimized runtime type guards and fixed type holes across the schema layer.
  - **Root document replacement:** Improved the error message when attempting to replace the root document.
  - **DocRef:** Preserved the call signature in `DocRef` when omitting `NATIVE`.

  Exchange — transport improvements:
  - **Shared Line session:** Refactored `Line` to share sessions with an exclusive receiver.

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
