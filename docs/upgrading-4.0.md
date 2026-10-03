# Upgrading to 4.0

_What changed, what it costs you, and what to write instead._

The [changelog](../CHANGELOG.md) says _what_ changed. This guide says _how_ to move, and _why_ each change was worth making. Sections are ordered by how likely you are to hit them, not by package.

<!--
Setup for the "4.0" snippets below, which are compiled out of this document so
that what you copy is known to work. The "3.x" snippets are marked uncompilable
on purpose: they show code that no longer exists, which is the point of them.
-->
<!-- ts-docs-prelude
import { Exchange, createInMemoryStore, initialize, whenHydrated, whenSettled } from "@kyneta/exchange"
import type { PeerIdentityDetails, Store } from "@kyneta/exchange"
import { Schema, batch, createDoc, deleted, json, subscribe, unwrap } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"

const TodoSchema = Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct({ text: Schema.string(), done: Schema.boolean() })),
})
const TodoDoc = loro.bind(TodoSchema)
const SettingsDoc = json.bind(
  Schema.struct({ theme: Schema.string(), tags: Schema.list(Schema.string()) }),
)
declare const exchange: Exchange
declare const store: Store
-->

---

## Before you start: every peer and every store moves together

4.0 cannot share a network with 3.x, and it cannot read every document 3.x stored. Plan the upgrade as one cutover, not a rolling deploy.

- **The sync protocol is 2.1.** It gains two messages: `accept`, with which a receiver confirms what it now holds (so a sender knows what it may compact away), and `refuse`, which tells a writer its offer was rejected. `establish` carries the peer's principal. A 3.x peer and a 4.0 peer still connect, and each reports a `protocol-mismatch` error, but their documents do not converge.
- **Stored `json` and Yjs documents written by 3.x do not load.** A plain document's payload now carries its position in the log (`["plain", 2, 0]`), which is what lets a restarted peer catch up by delta instead of duplicating entries. A Yjs version is now its state vector (`["yjs", 2, 0]`), which is what makes concurrent deletes and inserts converge. Neither can be read from the old format, so `whenHydrated(doc)` rejects, naming both formats, rather than presenting the document as empty.
- **Loro documents load unchanged.** Every peer derives a new, wider Loro peer number (64 bits, where it was 53), so a document gains one version-vector entry per peer that writes it again. Nothing else moves.
- **Ephemeral documents** use a new wire format for deletes and whole-record writes. Nothing ephemeral is stored, so there is nothing to migrate, but presence goes dark between a 3.x and a 4.0 peer.
- **Stores open as they are.** Every persistent store's format is now 1.1, and a 3.x store opens and gains a pool of seats. Postgres alone needs a migration ([below](#postgres-needs-two-migrations)).

### Bringing `json` and Yjs documents across

Read each document as a plain value under 3.x, and write it back under 4.0. Under 3.x, before you upgrade:

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x
const doc = exchange.get(docId, TodoDoc);
await whenSettled(doc);
saved.set(docId, JSON.stringify(doc()));
```

Then open a fresh storage under 4.0 (a new database, or the old one with the documents deleted) and write each one into a new document:

<!-- ts-docs-setup
declare const docId: string
declare const saved: Map<string, string>
const YjsDoc = TodoDoc
-->

```ts
// 4.0
type Todo = { title: string; items: { text: string; done: boolean }[] };
const value = JSON.parse(saved.get(docId) ?? "{}") as Todo;

const doc = exchange.get(docId, YjsDoc);
await initialize(doc, (d) => {
  d.title.insert(0, value.title);
  for (const item of value.items) d.items.push(item);
});
```

Write a CRDT document field by field: `insert` for text, `push` for a list, `set` for the rest. A `json` document's root also takes `d.set(value)`. The rewritten document starts a new history, so its peers must take it whole; another reason to move everyone at once.

---

## Read this part first: changes your compiler will not catch

Most of 4.0 announces itself: you upgrade, the build fails, you fix what it points at. These do not. Each compiles cleanly and behaves differently.

### A method passed as a callback throws

A ref's methods now live on one prototype shared by every ref of its schema node, which is most of why refs use about a thirteenth of the memory they did. A method reads its ref through `this`, so it needs to be called on its ref.

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x — worked
picker.onChange = settings.theme.set;
```

<!-- ts-docs-setup
const settings = createDoc(SettingsDoc)
declare const picker: { onChange: (v: string) => void }
-->

```ts
// 4.0
picker.onChange = (v) => settings.theme.set(v);
```

The compiler catches a detached method you call yourself (`const set = ref.set; set(v)` is a type error), but not one handed to a callback slot. Search for `.set}`, `.push)`, `.insert)` and the like.

### Reads are frozen, and keep their identity

A read is now the document's own value, frozen in place, instead of a fresh copy. Reading a 10,000-row record went from about 400 ms to about 1.3 ms, and a read keeps its identity until something it read changes, which is exactly what `React.memo` and `useMemo` want.

`Plain<S>` is `readonly`, so mutating a read is a type error, and it throws at run time too. The compiler won't stop you only where you typed a value loosely yourself: a cast, an `any`, or a parameter declared mutable.

Code that mutated a read and wrote it back was always the long way round. **Write through the ref**: a ref names the smallest change, and the smallest change is what merges well with a collaborator's, syncs in fewest bytes, and undoes on its own.

<!-- ts-docs-setup
const settings = createDoc(SettingsDoc)
const doc = createDoc(TodoDoc)
-->

```ts
settings.tags.push("new"); // not: read, push, set the whole list
settings.tags.delete(0, 1); // not: read, splice, set
doc.items.at(0)?.done.set(true); // not: read, change one item, set the list
doc.title.insert(0, "Draft: "); // text is edited in place, never set
batch(doc, (d) => {
  // several writes, one commit and one changeset
  d.items.push({ text: "Milk", done: false });
  d.items.push({ text: "Eggs", done: false });
});
```

| You want to | Write |
| --- | --- |
| append to or insert into a list | `list.push(item)`, `list.insert(i, item)` |
| remove from a list | `list.delete(i, count)`, or `remove(itemRef)` |
| change one field of a list item or record entry | `list.at(i)?.field.set(v)`, `record.at(key)?.field.set(v)` |
| add, replace or remove a record entry | `record.set(key, v)`, `record.delete(key)` |
| edit text | `text.insert(i, s)`, `text.delete(i, n)` |
| count | `counter.increment(n)` |
| group several writes | `batch(doc, (d) => …)` |

Read a value to render it or to compute something new from it, such as a sorted copy (`[...settings.tags()].sort()`). Replace a whole value with `.set` only when the whole value is what changed, such as a `.json()` field, which merges as a unit anyway.

Payloads delivered to subscribers and the ops `batch()` returns are frozen too.

### A deleted ref reads `undefined`

Every ref whose place in the document is gone reads `undefined`, whatever its type says. A struct used to read its fields, a text `""` and a counter `0`. A dead list item no longer reads the item that took its index. Ask before reading:

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
batch(doc, (d) => d.items.push({ text: "a", done: false }))
const item = doc.items.at(0)
-->

```ts
if (item && !deleted(item)) render(item());

declare function render(value: { text: string; done: boolean }): void;
```

### One batch is one changeset

A deep subscriber (`subscribe`, as opposed to `subscribeNode`) used to be called once per changed path, so a batch writing four fields woke it four times. It is now called once per batch, with the changes in the order they were made. A sync merge, however many paths it touched, is one changeset too.

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->

```ts
subscribe(doc, (changeset) => {
  for (const op of changeset.changes) console.log(op.path.format());
});
```

If you counted callbacks, or assumed each changeset held one path, read `changeset.changes`. Own-path subscribers now all run before deep subscribers, and both run after the Loro commit or Yjs transaction has closed.

### A native write is a local write

An edit made on the native document (an editor binding such as y-prosemirror or loro-prosemirror, or your own edit through `unwrap`) is now delivered with `replay: false`, and the exchange syncs and stores it like any other write. Before, it reached neither peers nor the store. If your subscriber treated every native edit as remote, it now has to read `replay`.

A native document is also handed out only while the document accepts writes: `unwrap(doc)` throws the same error its writes would ([Refusals](#why-a-write-is-refused)). A stored `json` document refuses writes until it has loaded, so wait first:

<!-- ts-docs-setup
const settings = exchange.get("settings", SettingsDoc)
-->

```ts
await whenHydrated(settings);
const native = unwrap(settings);
```

A read-only document cannot drive a native editor binding. Render it through Kyneta refs, which `useText` and its siblings in `@kyneta/react` do.

### A destroyed document stays destroyed

`exchange.destroy(docId)`, `reset()` and `shutdown()` now release a document's memory, freeing its `LoroDoc` or `Y.Doc`. A ref you still hold reads the document's last value, and its writes, `unwrap`, `version` and `merge` throw `DocumentClosedError`. Before, a held ref kept a live document nobody synced or stored, and nothing was ever garbage-collected.

`whenHydrated`, `whenSettled` and `whenPersisted` reject with `DocumentClosedError` when the document closes before they resolve.

### `ReactiveMap.current` is a snapshot

`.current`, `()` and `[CHANGEFEED].current` return one `Map` that stays the same until the map changes, then a new one. Code that held `.current` and expected it to change underneath it now holds an old snapshot. This covers `exchange.peers`, `exchange.documents` and every `@kyneta/index` collection. Read the map again after each change instead of keeping it.

### A `canShare` that says `false` to everything blocks more

`canShare` now also gates a peer asking for a document by id, which used to return the document whatever the policy said. A policy that returns `false` for documents it doesn't govern blocks those fetches too, including `Line`'s, which fetches by id by design. Return `undefined` for anything outside the policy:

```ts
exchange.register({
  canShare: (docId, peer) =>
    docId.startsWith("private:") ? peer.principal === "admin" : undefined,
});
```

### Whole-record writes on ephemeral documents remove more

Writing an ephemeral record whole, or calling `record.clear()`, now removes every key written before it, including ones still on their way to this peer. That is what makes a clear converge. To change only this peer's entry, use `.set(key, value)` and `.delete(key)`, which touch nothing else.

`lastUpdated` returns `null` for a field nobody has written; it returned `0`.

### With a store, writes reach peers a little later

With a store, an own write now leaves the process only once the store has confirmed it. A crash in between used to leave peers holding writes the next session didn't know it had made, and the next session wrote over them. The cost is one store write of latency. `persisted(doc)` and `whenPersisted(doc)` say when a document's writes are stored. Without a store, writes are sent at once.

---

## Identity: a principal, and a seat the exchange issues

3.x let you choose the peer id. A CRDT needs a guarantee the caller cannot give: that no other live replica writes under the same id, and that the replica holds everything ever written under it. A page that reloaded without its store, or a duplicated tab, broke that, and the replicas silently stopped syncing.

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x
const exchange = new Exchange({ id: persistentPeerId("my-app") });
const server = new Exchange({ id: { peerId: "server", type: "service" } });
```

<!-- ts-docs-setup
declare const userId: string
-->

```ts
// 4.0
const client = new Exchange({ principal: userId, store });
const server = new Exchange({ principal: "server", type: "service", store });
```

- **The principal is who the peer speaks for**: a user, a service. Several exchanges may share one, and it is announced, not verified.
- **The peer id is a seat** the exchange issues itself. With a store it is the store's: a reload over the same storage gets it back, and two tabs open at once get different ones. Without a store, each session is a new peer.
- **Key policies on `principal`** when you mean who a peer is (`p.principal === "server"`), and on `peerId` when you mean which replica.
- `persistentPeerId`, `releasePeerId`, `resolveLease`, `RuntimeParams.peerId`, `PeerIdentityInput` and the peer's `name` are gone. `PeerIdentityDetails` is `{ peerId, principal, type }`.

### Addressing a `Line`

A `Line` is addressed by the other peer's seat, since each outbox has one writer and a user's two tabs are two seats. Find the seat with `whenPeer`:

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x
const sender = Chat.sender(exchange, "server");
```

<!-- ts-docs-setup
import { Line, whenPeer } from "@kyneta/exchange"
const Chat = Line.protocol({ topic: "chat", schema: Schema.struct({ text: Schema.string() }) })
-->

```ts
// 4.0
const server = await whenPeer(exchange, (p) => p.principal === "server");
const sender = Chat.sender(exchange, server.peerId);
sender.send({ text: "hello" });
```

A server with a store keeps its seat across restarts, so its `Line`s carry on. A server without one is a new seat after a restart, and clients open new `Line`s to it.

### React

`useExchangeSingleton` is keyed by principal, and its factory may be async, so it can open a store first. It returns `null` until the factory resolves.

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x
const exchange = useExchangeSingleton(user?.id, () => new Exchange({ id: user.id }));
```

<!-- ts-docs-setup
import { useExchangeSingleton } from "@kyneta/react"
import { createIndexedDBStore } from "@kyneta/indexeddb-store"
declare const user: { id: string } | undefined
-->

```ts
// 4.0
const app = useExchangeSingleton(user?.id, async () =>
  new Exchange({ principal: user?.id ?? "", store: await createIndexedDBStore("my-app") }),
);
```

React StrictMode's double mount creates two exchanges for one principal, which is harmless now: they are two seats.

---

## Storage

### One store

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x
new Exchange({ id: "server", stores: [store] });
```

```ts
// 4.0
new Exchange({ principal: "server", store });
```

A store issues the exchange's seat, which is why there is one per exchange. Several exchanges may still open one storage at once (tabs over one IndexedDB database, processes over one Postgres schema), and their writes interleave safely.

### Stores are opened by a function

The `LevelDBStore`, `PostgresStore` and `PrismaStore` constructors are private. Use `createLevelDBStore`, `createPostgresStore` or `createPrismaStore`, which open the store and take its seat. Close a store (`exchange.shutdown()` does) to release its seat.

### Postgres needs two migrations

A Postgres store records which seat writes each `json` document, and finds documents by prefix with a range scan that needs code-point order. `createPostgresStore` refuses a schema without either, and its error names the SQL:

```sql
ALTER TABLE kyneta_doc_meta ADD COLUMN writer TEXT;
ALTER TABLE kyneta_doc_meta ALTER COLUMN doc_id TYPE TEXT COLLATE "C";
ALTER TABLE kyneta_records ALTER COLUMN doc_id TYPE TEXT COLLATE "C";
```

`postgresSchema()` returns the whole DDL, for your own table names too. Each open Postgres store holds one connection, for its seat's lock, until it closes; close stores before `pool.end()`.

### One process per SQLite database

`fromBetterSqlite3` and `fromBunSqlite` lock the database file for as long as the adapter is open. A second adapter on the same file waits `busyTimeout` (5 s by default), then is refused. For several processes over one database, use Postgres.

### One writer per `json` document

Tabs or processes sharing one storage all read a `json` document, but only one of them writes it: the first whose own write reached the store. The others' writes throw `WriterRefusedError`. The writer keeps its seat across reloads, so it stays the writer. Loro and Yjs documents are unaffected, since concurrent writers is what a CRDT is for. A Prisma store cannot record a writer, so route a `json` document's writes to one process there.

---

## Why a write is refused

Writes can now be refused for several reasons, and every one of them is an error extending `WriteRefusal` (`@kyneta/schema`), thrown before anything is applied:

| Error | When |
| --- | --- |
| `DocumentLoadingError` | A stored `json` document is still loading. |
| `DocumentClosedError` | The document was destroyed, unloaded, or its exchange shut down. |
| `WriterRefusedError` | Another tab or process sharing the storage writes this `json` document. |
| `NotAWriterError` | A `canWrite` policy excludes this peer. |
| `OfferRefusedError` | The document's authority refused this peer's writes. |

`writeRefusal(doc)` returns the current one or `undefined`, and `writeRefusalFeed(doc)` notifies when it changes. `useText` keeps its field read-only while one applies; `useWriteRefusal(doc)` serves any other editor.

<!-- ts-docs-setup
import { writeRefusal } from "@kyneta/exchange"
import { DocumentLoadingError } from "@kyneta/schema"
const settings = exchange.get("settings", SettingsDoc)
-->

```ts
const refusal = writeRefusal(settings);
if (refusal instanceof DocumentLoadingError) await whenHydrated(settings);
```

`initialize` rejects with the refusal when the document refuses this peer's writes and holds no data, since it could never seed it.

---

## Reading and writing

### Writes complete their values

A partial value written to a document is completed before it is stored: a missing field gets its zero, and a key the schema doesn't declare is dropped. Every peer and every backend then reads the same complete value; before, an untyped partial entry read differently on the writer and on a Loro, Yjs or ephemeral receiver. Delivered ops carry the completed value.

### `bytes` fields are `Uint8Array`s

A `bytes` field reads as a `Uint8Array`. It read as a plain object keyed by index. A typed array can't be frozen, so copy it before changing it.

### Change constructors take owned values

If you build changes yourself, every constructor (`sequenceChange`, `mapChange`, `mapClearChange`, `setOpChange`, `richTextChange`, `replaceChange`) takes its values wrapped: `own(value)` to hand over a copy, `trustAsOwned(value)` to promise nobody else holds it. No value you pass to a write is shared with the document, so changing it afterwards changes nothing.

### An op's path is fixed when the op is made

`Op.path` is a `RawPath`, frozen when the op is made. It used to be the live path the op was written at, whose list indices moved as items were inserted before them, so a held op could replay to the wrong item. If you build an op from a ref's `[PATH]`, call `.toRaw()` on it.

`batch()` returns only the ops that survived: an inner `batch()` that threw and was caught is no longer in it.

---

## Waiting for a document

`whenSettled` and `useDocReady` take `authority`, where they took `peer`:

<!-- ts-docs-verifier:ignore -->

```ts
// 3.x
await whenSettled(doc, { peer: (p) => p.peerId === "server" });
```

<!-- ts-docs-setup
const doc = exchange.get("todos", TodoDoc)
-->

```ts
// 4.0
await whenSettled(doc, { authority: (p) => p.principal === "server" });
```

`whenSettled` also waits for the authority's data, not only its first reply: over a websocket it could resolve with the document still empty. And it follows `Policy.authority`, so a server with `authority: "self"` resolves at once instead of waiting forever.

---

## New in 4.0, worth adopting

### Undo

`createUndoStack` undoes this peer's own writes as they stand now: text a collaborator typed inside yours survives, and a value someone changed since is left alone. One step is one gesture, across as many documents as it wrote, and the stack lives in a document of its own, so with a store it survives a reload.

<!-- ts-docs-setup
import { createUndoStack } from "@kyneta/exchange"
const card = exchange.get("card:1", TodoDoc)
-->

```ts
const stack = await createUndoStack({
  exchange,
  docId: "undo:this-tab",
  key: "cards",
  scope: (docId) => docId.startsWith("card:"),
});

stack.gesture(() => card.items.push({ text: "Milk", done: false }));
const result = await stack.undo({ docs: ["card:1"] });
if (result.kind === "undone" && result.stale.length > 0) {
  // someone else had changed part of it; that part was undone as far as it stood
}
```

In React, `useText(ref, { undo: stack })` wires the keyboard shortcuts to it.

### Read-only documents

`canWrite` makes a document writable by one peer and read-only everywhere else. Register the same rule on every peer, keyed by principal:

```ts
const isHost = (p: PeerIdentityDetails) => p.principal === "host";
exchange.register({
  canWrite: (docId, p) => (docId === "layout" ? isHost(p) : undefined),
});
```

On every other peer, writes to `"layout"` throw `NotAWriterError` before anything is applied, and an offer of it from anyone but the host is refused.

### Unloading and opening

`exchange.unload(docId)` frees a stored document's memory and keeps it in the store; `get` or `open` loads it back. `exchange.open(docId, bound)` resolves a document only if this exchange holds it, and `undefined` otherwise, where `get` would create one.

```ts
exchange.unload("card:1");
const card = await exchange.open("card:1", TodoDoc);
```

---

## Writing your own backend, store or transport

Skip this section unless you implement Kyneta's interfaces.

**Replicas** (`ReplicaLike`) implement:

- `dispose(reason?)`: release everything native. Afterwards every member throws `DocumentClosedError`, except a substrate's reads, which return the last value.
- `digest()`: a string two replicas holding the same state agree on, or `undefined` to mean "compare versions".
- `exportSince` returns `null` only for a cursor it cannot serve, and an empty delta for a peer that is current. Returning `null` for a current peer sends it the whole document every time.
- `Version.join`, and `reaches(ours, theirs)` to test holding a version. `versionConformance` checks the lattice laws.
- `resetFromEntirety(payload)` takes only the payload, and `merge` and `resetFromEntirety` take `MergeOptions` (`{ origin? }`).

**Substrates** implement `commitPending()` and `subscribeLocalUpdates(listener)`, which must fire for every local write however it was made. They bring their state up to date themselves for anything that is not a local write, then call `ctx.announce(ops, { origin, local })`. `afterBatch(outcome)` receives the batch's `BatchOutcome`, and `RecordInverseFn` is called exactly once per forward write. A map change may carry `clear`; `mapChangeEffects(change, held)` resolves it. `resolveHasKey(path, key)` is required on a `MaterializeResolver`.

**Factories** implement only `replica`, `upgrade` and, optionally, `createForHydration`; replica factories implement `replicaType`, `historyFree`, `createEmpty` and `parseVersion`. Build with the functions instead of the methods:

| 3.x | 4.0 |
| --- | --- |
| `factory.create(schema)` | `createSubstrate(factory, schema)` |
| `factory.fromEntirety(payload, schema)` | `substrateFromEntirety(factory, payload, schema)` |
| `replicaFactory.fromEntirety(payload)` | `replicaFromEntirety(replicaFactory, payload)` |
| `factory.createReplica()` | `factory.replica.createEmpty()` |
| `factory.parseVersion(s)` | `factory.replica.parseVersion(s)` |
| `createPlainSubstrate`, `createPlainReplica` | `plainSubstrateFactory`, `plainReplicaFactory` |

**Stores** implement `seat` (one of `SessionSeat`, `OwnedSeat`, `PooledSeat`, built with the exported helpers), take `WriteOptions` (`{ authored }`) on `append` and `compact`, implement `mark`, `compact` and `writerOf` in place of `replace`, and declare `seats` to the conformance suite. `listDocIds(prefix)` must return exactly the ids starting with `prefix`; scan `[prefix, prefixSuccessor(prefix, order))`.

**Refs** are one construction, `createRef(schema, substrate, options?)`. The interpreter layers (`withNavigation`, `withReadable`, `withAddressing`, `withCaching`, `withWritable`, `withChangefeed`, `withTracking`), the fluent `interpret(schema, ctx).with(…).done()` builder, and their carrier types are gone. `interpret(schema, interpreter, ctx)` and `createInterpreter` remain, for folds over a schema such as materializing and validating.

**`SyncMode`** is `{ writerModel, durability }`: drop `delivery` from any literal.

---

## Removed symbols

| Removed | Use instead |
| --- | --- |
| `persistentPeerId`, `releasePeerId`, `resolveLease`, `LeaseState`, `LeaseDecision` | `principal`, and a store for a durable seat |
| `ExchangeParams.id`, `RuntimeParams.peerId`, `PeerIdentityInput` | `principal` and `type` |
| `ExchangeParams.stores` | `store` |
| `whenSettled(doc, { peer })` | `whenSettled(doc, { authority })` |
| `plainInterpreter` | `createMaterializeInterpreter(plainValueResolver(value))` |
| `Writable<S>`, `INTERPRETER`, `INVALIDATE`, `ADDRESS_TABLE` | — nothing read them |
| `withoutTracking`, `writeByPath` | — |
| `createNullishStore` (`@kyneta/react`) | `useValue`, which takes `null` and `undefined` |
| `CallableRef` (`@kyneta/react`) | `Feed<unknown>` |
| `SettleTerm` | `Feed<boolean>` |
| `Delivery`, `SyncMode.delivery` | — |
| `YjsVersion.fromDeleteSet` | `YjsVersion.fromDoc` |
| `expandMapOpsToLeaves` | `expandProductMapChanges` |
| `deliverNotifications`, `planNotifications`, `attachChangefeed`, `withChangefeed` | — internal |
| `Synchronizer.notifyLocalChange` | nothing: native writes are picked up |
| the `duplicate-peer` diagnostic | — one peer on several transports is supported |
