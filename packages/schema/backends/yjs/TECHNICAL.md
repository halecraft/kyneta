# @kyneta/yjs-schema — Technical Reference

> **Package**: `@kyneta/yjs-schema`
> **Role**: Yjs CRDT substrate for `@kyneta/schema`. Wraps a `Y.Doc` as a `Substrate<YjsVersion>` with a single-root-`Y.Map` design, schema-guided live navigation via `instanceof` discrimination, imperative writes inside `Y.transact`, identity-keyed containers for cross-schema sync, and a persistent `observeDeep` event bridge so every mutation — local kyneta writes, `merge()`, `Y.applyUpdate()`, or raw Yjs API — fires the kyneta changefeed.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `yjs` (peer)
> **Depended on by**: `@kyneta/exchange` (dev), `@kyneta/react` (dev), `@kyneta/cast` (dev), application code that wants collaborative documents via Yjs
> **Canonical symbols**: `yjs` (binding target: `yjs.bind`, `yjs.replica`), `YjsLaws`, `YjsNativeMap`, `createYjsSubstrate`, `yjsSubstrateFactory`, `yjsReplicaFactory`, `YjsVersion`, `YjsPosition`, `yjsReader`, `resolveYjsType`, `stepIntoYjs`, `ensureContainers`, `applyChangeToYjs`, `eventsToOps`, `toYjsAssoc`, `STRUCTURAL_YJS_CLIENT_ID`, `DELETE_CLOCK`
> **Key invariant(s)**: Every schema field is a child of one root `Y.Map` obtained via `doc.getMap("root")`. This is what makes a single `observeDeep` call capture every mutation with correct relative paths — and what makes `instanceof` container discrimination reliable (Yjs shared types are native JS classes, not WASM handles). Every change to a substrate's `Y.Doc`, a delete included, advances its state vector, so the version is the state vector alone.

The Yjs backend for Kyneta. Hands you a substrate instance — stored state, versioning, export/import, and a `Reader` — in exchange for a `Y.Doc`. Every ref produced by the interpreter stack reads through schema-guided shared-type resolution; every write runs inside a `Y.transact` that tags its origin; every Yjs-visible mutation surfaces as a `Changeset` on the kyneta changefeed.

Consumed by applications that bind schemas with `yjs.bind(schema)`. Not imported by any other Kyneta package at runtime — `@kyneta/exchange`, `@kyneta/react`, and `@kyneta/cast` depend on it only in dev/test.

---

## Questions this document answers

- Why one root `Y.Map` instead of multiple root shared types? → [The single-root-`Y.Map` design](#the-single-root-ymap-design)
- How does this differ from `@kyneta/loro-schema` — same job, different substrate? → [Loro vs Yjs: what changes](#loro-vs-yjs-what-changes)
- Why `instanceof` here but `.kind()` there? → [`instanceof` container discrimination](#instanceof-container-discrimination)
- Why does a delete write to a `kyneta.clock` type? → [`YjsVersion` and the delete clock](#yjsversion-and-the-delete-clock)
- How do structural inserts (a whole struct into a map) commit atomically? → [The write path and populate-then-attach](#the-write-path-and-populate-then-attach)
- Why is there a reserved `clientID = 0` for structural operations? → [`STRUCTURAL_YJS_CLIENT_ID`](#structural_yjs_client_id)
- Why is the peer's own `clientID` claimed *after* hydration, not at construction? → [`clientID` and the order it is claimed in](#clientid-and-the-order-it-is-claimed-in)
- Why is a `clientID` 53 bits wide when Yjs's own ids are 32? → [`clientID` width](#clientid-width)
- How does a remote `Y.applyUpdate` notify kyneta subscribers? → [The event bridge](#the-event-bridge)
- Why does a default `Y.UndoManager` undo other peers' edits? → [Using `Y.UndoManager`](#using-yundomanager)
- How is a write undone, after others edited and after a reload? → [Undo](#undo)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Y.Doc` | Yjs's top-level document (from `yjs`). Owns shared types, client ID, update stream. | A kyneta `DocRef` — the `Y.Doc` is the substrate-native backing |
| `YjsLaws` | The composition-law set `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"`. Yjs supports text (`positional-ot`), structural (`lww-per-key`), scalars (`lww`), and rich text (`positional-ot` + `lww-tag-replaced`) — but not `"additive"` (counter), `"positional-ot-move"` (movable), `"tree-move"` (tree), or `"add-wins-per-key"` (set). | Yjs's full feature set — this is the subset kyneta exposes via composition-law tags |
| `YjsNativeMap` | The `NativeMap` functor mapping schema kinds to Yjs shared types (`text → Y.Text`, `list → Y.Array`, `struct → Y.Map`, `map → Y.Map`). Slots for unsupported kinds are `undefined`. | A JS `Map` — this is a type-level functor |
| `YjsVersion` | `@kyneta/schema`'s `Version` implementation over a Yjs state vector: `compare`, `meet` and `join` are the version-vector lattice. | A Yjs snapshot — it carries no delete set. The delete clock is what lets the state vector alone order Yjs documents. |
| Delete clock | The follow-up transaction the substrate writes to the `kyneta.clock` top-level type after any transaction that deleted without advancing any clock, so every change advances the state vector. | A clock of wall time, or anything the schema can see |
| `YjsPosition` | `Position` implementation wrapping `Y.RelativePosition`. Stateless `transform` — resolution queries the CRDT directly. | A numeric index |
| `resolveYjsType` | Thin wrapper over the core `foldPath(stepIntoYjs, ...)` primitive (from `@kyneta/schema`). The two semantic invariants (identity-keying, opaque-boundary stop) live in `@kyneta/schema/src/fold-path.ts`, not here. | A cache lookup — resolution happens on every read |
| `stepIntoYjs` | The Yjs `PathStepper`: per-step substrate dispatch. Given `(current, _nextSchema, segment, identity)` returns the child shared type or scalar (the `_nextSchema` slot is unused; Yjs's `instanceof` dispatch doesn't look ahead). | `stepIntoLoro` from the Loro backend — both are `PathStepper` instances, both driven by `foldPath`; the dispatch is what differs |
| `root Y.Map` | The single `Y.Map` at `doc.getMap("root")` that holds every schema field (shared types or plain values). | A per-field root container (that's the Loro model) |
| `ensureContainers` | Conditionally creates shared types for every schema field. Idempotent. Uses structural client ID during creation. | `populate` — creates containers; populate fills them |
| `applyChangeToYjs` | Pure-ish: apply a kyneta `Change` + path + schema to a Yjs shared type (inside an open transaction). | `changeToDiff` from Loro — Loro accumulates diffs then applies once; Yjs mutates incrementally inside `transact` |
| `eventsToOps` | Inverse: turn `observeDeep` events (after remote update or external mutation) into kyneta `Op[]`. | `applyChangeToYjs` — opposite direction |
| `yjsReader` | `Reader` implementation that reads by resolving the shared type at `path` and extracting its value. | Substrate state — the reader is a live view |
| `Y.transact` | Yjs's atomic-commit primitive. Multiple mutations inside one `transact` produce one combined update + one `observeDeep` event. | A database transaction — this is a batching/origin-tagging API |
| Transaction `origin` | A tag attached to a `Y.transact` call. The event bridge uses the origin to distinguish kyneta's own writes from external ones. | An `origin` on a kyneta `Changeset` — this is Yjs-level |
| `STRUCTURAL_YJS_CLIENT_ID` | Reserved `clientID = 0` used during container creation. Makes structural ops identical across peers. | A real peer's client ID (always non-zero) |
| Identity hash | Content-addressed 128-bit hex derived from `(path, generation)` via FNV-1a-128. The Y.Map key for every product-field boundary. | A field name |
| `SchemaBinding` | `{ forward: Map<string, Hash>, backward: Map<Hash, string> }` from `@kyneta/schema`. Threaded through `resolveYjsType` so every key lookup uses identity, not name. | A validation rule |

---

## Architecture

**Thesis**: Yjs already stores the state. This package is a thin, substrate-shaped lens that translates between kyneta's schema-guided API and Yjs's shared-type-and-transaction reality — with zero caching of its own, one `observeDeep` subscription that makes the substrate transparent to external mutations, and a single root `Y.Map` that keeps everything structurally uniform.

Four responsibilities, mirroring the Loro backend:

| Responsibility | Primary source |
|----------------|----------------|
| Navigation (schema → shared type) | `src/yjs-resolve.ts` — `resolveYjsType`, `stepIntoYjs` |
| Reads (shadow → value) | `plainReader(shadow)` — reads go through the `PlainState` shadow, not live Yjs types |
| Writes (kyneta `Change` → Yjs mutations) | `src/change-mapping.ts` — `applyChangeToYjs`, `eventsToOps` |
| Substrate orchestration (prepare/flush, merge, events) | `src/substrate.ts` — `YjsSubstrate`, `yjsSubstrateFactory` |

Plus one Yjs-specific concern: `src/populate.ts` owns `ensureContainers`, the conditional structural-creation pass.

### What `@kyneta/yjs-schema` is NOT

- **Not a `Y.Doc` wrapper or subclass.** It accepts a user-owned or factory-created `Y.Doc` and adapts it to `Substrate<YjsVersion>`. The `Y.Doc` is still usable directly — `unwrap(doc)` returns it.
- **Not a Yjs provider.** It does not talk to y-websocket, y-webrtc, y-indexeddb, or any other Yjs provider. The exchange owns sync; this package only exports/imports `SubstratePayload` when the exchange asks. Applications are free to attach their own Yjs providers in parallel — the event bridge will pick up their mutations, and a provider's delete is clocked where it lands (see [the delete clock](#yjsversion-and-the-delete-clock)).
- **Not feature-complete relative to Yjs.** Yjs has types (`Y.XmlElement`, `Y.XmlText`) and features (undo manager, awareness) that kyneta doesn't model. They are accessible via `unwrap(doc)`; they just aren't first-class in the schema grammar.
- **Not an adapter library for multiple CRDTs.** This is Yjs-specific.

---

## Loro vs Yjs: what changes

The two backends implement the same `Substrate<V>` contract and share the overall shape (navigation / reader / change-mapping / substrate-orchestration). The differences are concentrated in a few places, summarised here so the rest of the document can focus on Yjs specifics without re-litigating what's shared.

| Concern | `@kyneta/loro-schema` | `@kyneta/yjs-schema` |
|---------|-----------------------|----------------------|
| Navigation fold | `foldPath(stepIntoLoro, ...)` from `@kyneta/schema` | `foldPath(stepIntoYjs, ...)` from `@kyneta/schema` |
| Root layout | One Loro container per root field (typed accessors: `doc.getText(k)`, `doc.getMap(k)`, …) plus a reserved `_props` map for root scalars | One `Y.Map` at `doc.getMap("root")` holds *every* field (shared types and plain values alike) |
| Container discrimination | `.kind()` method (strings: `"Map"`, `"Text"`, `"List"`, …) | `instanceof Y.Map`, `instanceof Y.Array`, `instanceof Y.Text` |
| Why | Loro containers are WASM handles; `instanceof` is unreliable across module boundaries | Yjs shared types are native JS classes; `instanceof` is stable |
| Write commit | Eager `applyDiff` in `prepare` (plain MapDiff writes coalesce into a per-CID buffer drained in `afterBatch`; structural inserts apply immediately). `runBatch` brackets with a depth counter + single `doc.commit()` on outermost release | Eager imperative mutations inside the ambient `Y.transact` opened by `runBatch` (marked via `transaction.meta`); Yjs's native transact nesting collapses re-entries for free |
| Event bridge | `doc.subscribe` + pre-commit-hook discriminator; reconcile σ where the ops touched, then announce | `observeDeep` + `transaction.meta` mark discriminator; reconcile σ where the ops touched, then announce |
| Structural identity | Identity hash as Loro container key | Identity hash as `Y.Map` key within the root `Y.Map` |
| Structural creation | Lazy — creation happens on first typed accessor call | Eager — `ensureContainers` walks the schema on upgrade |
| Structural client ID | Not needed (Loro has no equivalent concern) | `STRUCTURAL_YJS_CLIENT_ID = 0` during `ensureContainers` |
| Composition laws | `LoroLaws` = `"lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"` | `YjsLaws` = `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` |
| Version | Wraps `VersionVector`, which Loro advances for every op, deletes included | Wraps the state vector, which Yjs advances only for inserts; the substrate's delete clock makes it advance for every change |
| Position | Wraps `Cursor` | Wraps `Y.RelativePosition` |

When a concept is structurally identical to Loro's (navigation fold, event bridge's purpose, identity-keying rationale, write-path FC/IS intent), the Loro document is the canonical reference. This document focuses on the Yjs-specific mechanics.

---

## The single-root-`Y.Map` design

Source: `packages/schema/backends/yjs/src/yjs-resolve.ts` (comments + resolution logic), `src/substrate.ts` (root acquisition: `doc.getMap("root")`).

Every schema field — whether it's a `text` CRDT, a nested `struct`, a list, or a plain scalar — lives as a child of one `Y.Map`:

```
Y.Doc
 └─ getMap("root")          // the single root Y.Map
     ├─ identityHash("title")    → Y.Text
     ├─ identityHash("settings") → Y.Map
     │    ├─ identityHash("darkMode") → true          (plain value)
     │    └─ identityHash("fontSize") → 14            (plain value)
     ├─ identityHash("items")    → Y.Array
     │    └─ [0]                 → Y.Map              (one struct per item)
     └─ identityHash("userName") → "alice"            (plain value)
```

There is no `_props` container as in Loro. A plain scalar is just an entry in the relevant `Y.Map` — either the root or a nested struct's map. This works because `Y.Map` natively supports mixed plain/shared-type values as entries.

### Why one root map

- **One `observeDeep` call captures everything.** A single subscription on the root `Y.Map` receives events for every descendant mutation, with event paths relative to the root. This makes the event bridge implementation direct: translate one event stream into kyneta `Op[]`.
- **Event paths map directly to kyneta `Path`.** `event.path` from `observeDeep` is an array of keys and indices exactly parallel to kyneta's `Segment[]`. The translation in `eventsToOps` is a rename, not a restructuring.
- **No root-field-typing ambiguity.** Because everything is a child of a `Y.Map`, there is no need to decide at creation time what type a root field is — the root map accepts any shared type or plain value as a value. `ensureContainers` handles creation; reads handle discrimination.
- **Structural-op ordering is canonical.** `ensureContainers` iterates fields in alphabetical order over identity hashes, so every peer creates the same sequence of root-map entries regardless of local schema definition order.

### What the single-root design is NOT

- **Not a performance optimisation.** It is a correctness/uniformity decision. Multiple root types would also work but would fragment `observeDeep` into N subscriptions and complicate path translation.
- **Not user-visible.** `unwrap(doc)` returns the `Y.Doc`, not the root map. Applications rarely need to reach past `doc.getMap("root")` directly.
- **Not a limitation on Yjs.** Applications may still call `doc.getMap("otherName")` or `doc.getText("direct")` for their own purposes — kyneta just won't see those mutations unless they happen on the root kyneta `Y.Map`.

---

## `instanceof` container discrimination

Source: `packages/schema/backends/yjs/src/yjs-resolve.ts` → `stepIntoYjs`.

```
if (current instanceof Y.Map)    return current.get(identity ?? segment.resolve())
if (current instanceof Y.Array)  return current.get(segment.resolve())
if (current instanceof Y.Text)   return /* terminal — cannot step further */
return undefined
```

Yjs shared types are native JavaScript classes imported from the `yjs` module. A single `yjs` build produces one class identity that every dependent consumes. `instanceof Y.Map` is reliable across module boundaries — unlike Loro, which crosses a WASM boundary where `instanceof` can fail.

### Why not `.kind()` here too

Yjs does not expose a uniform `.kind()` method. Each type has its own shape (`Y.Text` has `.length` and `.toString()`; `Y.Array` has `.length` and `.toArray()`; `Y.Map` has `.keys()` and `.get()`). The cheapest, stablest runtime tag is the class itself, and `instanceof` is the standard way to use it.

### What `instanceof` discrimination is NOT

- **Not a violation of the "prefer `.kind()`" principle from Loro.** The principle was "avoid `instanceof` when class identity is unreliable." Yjs class identity *is* reliable — `instanceof` is the correct tool here.
- **Not fragile against multiple `yjs` installs.** Package managers hoist `yjs` to one instance; peer-dep warnings fire if two versions coexist. The event bridge would also break under duplicate `yjs` installs (events would fire on a different class's subscription). Install hygiene is an operational requirement, not a code concern.

---

## `YjsVersion` and the delete clock

Source: `packages/schema/backends/yjs/src/version.ts`, and `installDeleteClock` in `src/substrate.ts`.

Yjs's state vector counts the items each client has inserted. It does not advance for a delete: a delete is recorded in the delete set, by the ID of the item deleted, not by who deleted it or when. So on its own a state vector does not order Yjs documents:

- Peer A inserted 3 items and deleted none → `{A: 3}`.
- Peer A inserted 3 items and deleted one → `{A: 3}` (the same).

A peer that lacks a delete could not tell from any version that it holds less. Concretely, when Bob deleted while Alice inserted, Alice's version was ahead of Bob's, she took his offer as holding nothing new, and skipped the delete it carried; they stayed apart until Bob wrote again.

**The delete clock.** After any transaction that deleted something without advancing any state-vector entry, the substrate runs one follow-up transaction that inserts one character into the `kyneta.clock` top-level `Y.Text` (`DELETE_CLOCK`) and deletes it. That advances this client's entry, so every change to the document advances its state vector:

- **The condition** is local or remote alike. A local delete-only change ticks, and so does a plain Yjs client's delete arriving through a parallel provider, which also advances no clock. A Kyneta delete arriving through the exchange does not tick again: the author's tick travels in the same payload, so that transaction advanced a clock.
- **A transaction that inserted** already advanced the clock, and its deletes travel in the same update, so it does not tick. The tick itself inserts, so it never triggers another.
- **A separate transaction.** It runs while the deleting transaction is cleaned up (`afterTransaction`), so the deleting call returns with the clock advanced. It fires a second `update` event. Yjs offers no way to write into the deleting transaction: a write from `beforeObserverCalls` starts a new transaction too.
- **Holding the tick means holding the delete.** A peer whose state vector reaches the deleter's holds the deleted item (the deleter held it, so its clock is in the deleter's vector) and the tick. Kyneta exports from a state vector, and a Yjs update exported from one always carries the whole delete set, so the tick and the delete arrive together.
- **Once per document.** A `WeakSet` guards the handler, so two substrates over one `Y.Doc` tick once per delete. A headless replica has none: it takes changes only through the exchange, whose payloads carry every author's tick, and makes none of its own.
- **Invisible to the schema.** `kyneta.clock` is a top-level type outside the root map, so the event bridge raises no changeset for it. It is visible in `doc.share`, and providers sync it like any other type.
- **A local write.** The tick is a local transaction, so it fires the local-update signal, and an exchange pushes and persists it like any local write: peers need it so their versions see the delete. A tick taken in by a merge can fire the signal twice: the bridge's read of a `YTextEvent` delta opens an empty transaction during Yjs's cleanup, and that transaction's update also carries the tick.
- **Parallel providers.** A provider that forwards Kyneta changes transaction by transaction delivers a delete before its tick, so each receiving Kyneta peer ticks once more: one tiny item per receiver per delete-only transaction. Loading stored updates in one transaction (the y-indexeddb shape) ticks nothing, since the stored updates carry their ticks.
- **Cost.** Each tick is one item and one delete-set entry, kept for the life of the document. With `gc` on, Yjs drops the tick's content, but not the item: it merges items only when their clock values are consecutive and they sit next to each other, so ticks merge into one run only when nothing else takes a clock value between them. Measured, per delete-only transaction: about 0 bytes when deletes run back to back (1000 of them add 11 bytes); about 5 bytes while typing (5000 keystrokes with a backspace every 10: 10973 → 13466 bytes, +23%); and up to about 13 bytes when the ticks also split a run of the client's own inserts, which would otherwise merge into one item (1000 cycles of appending and deleting elsewhere: 8524 → 21520 bytes). Nothing grows with the size of what was deleted, and the state vector does not grow at all. The type the tick writes to does not matter: a `Y.Array` or a `Y.Map` key costs the same, because the cost is the clock value the tick takes.

With every change clocked, `YjsVersion` is the state vector alone:

| Method | Behaviour |
|--------|-----------|
| `serialize()` | `base64(stateVector)`. |
| `compare(other)` | `versionVectorCompare` of the two state vectors. |
| `meet(other)` / `join(other)` | Component-wise minimum / maximum, through one private pair of projections to and from the vector. |
| `YjsVersion.parse(s)` | Decode base64, and check the bytes decode as a state vector; anything else throws. |
| `YjsVersion.fromDoc(doc)` | `Y.encodeStateVector(doc)`: O(clients). |

The version's size grows with the number of clients, never with edit history. An earlier version embedded the encoded snapshot, which grew without bound under non-contiguous deletes (insert-then-correct cycles, as in speech-to-text partial corrections), and then a fixed-size digest of it, which bounded the size but broke the lattice laws: a replica holding an offer plus deletes of its own compared `"concurrent"` to it, and `meet` was not a lower bound.

### What `YjsVersion` is NOT

- **Not a bare `Uint8Array`.** It is a structured wrapper with a documented serialise/parse protocol.
- **Not a wall-clock timestamp.** Yjs versions are CRDT causal history, not physical time.
- **Not totally ordered.** Two concurrent peers can be `"concurrent"`. `compare` returns the full partial order.
- **Not interchangeable with `LoroVersion`.** They serialize differently and wrap different vectors.
- **Not a snapshot.** It carries no delete set; the delete clock is what makes that sufficient.

---

## `advance`: the replica trims, the live substrate does not

Source: `src/substrate.ts` → `advance` on `createYjsSubstrate` and `createYjsReplica`.

Both follow `planAdvance` from `@kyneta/schema`, and throw only for a target beyond the current version. Yjs has no trim primitive: a relay's replica trims by re-projecting its state into a fresh `Y.Doc`, which it can do only at its current version, so a target short of it trims nothing. A live substrate never trims, and its `baseVersion()` stays empty: re-projecting would swap the `Y.Doc`, and editor bindings and `unwrap` callers hold its shared types. Compacting a live document still replaces its storage with the whole document.

## `STRUCTURAL_YJS_CLIENT_ID`

Source: `@kyneta/schema`'s `src/substrate.ts` → `STRUCTURAL_YJS_CLIENT_ID = 0`; consumed by `packages/schema/backends/yjs/src/populate.ts` → `ensureContainers`.

When `ensureContainers` creates a shared type in the root `Y.Map` (e.g. `rootMap.set(identityHash("title"), new Y.Text())`), the creation is a Yjs operation tagged with the document's current `clientID`. If every peer used its *own* client ID for structural creation, peers would produce different CRDT ops for the "same" structural creation — on merge, one of them would win arbitrarily, leaving everyone else's reference dangling.

**Solution**: temporarily set `doc.clientID = 0` during structural creation. Every peer produces identical ops; merge is a no-op on structure and the containers are identity-keyed into the same root-map slots.

```
ensureContainers(doc, schema, binding) {
  const originalClientID = doc.clientID
  try {
    doc.clientID = STRUCTURAL_YJS_CLIENT_ID
    // walk schema, create missing shared types for each field
    // (in alphabetical order over identity hashes)
  } finally {
    doc.clientID = originalClientID
  }
}
```

This happens inside `yjsSubstrateFactory.upgrade(replica, schema)` after hydration. The walk is **conditional** — if a shared type already exists for a field's identity hash, it is left alone; only missing ones are created. This preserves hydrated state and makes the operation idempotent.

**Scope of the `clientID = 0` transaction**: only shared type containers (`Y.Text`, `Y.Map`, `Y.Array`) are created during this pass. Scalar and sum fields are *not* written with zero defaults — their default values are produced by the materializer's zero fallback on read. This keeps the structural pass minimal: it creates the CRDT containers that Yjs needs to exist, and nothing else.

### What `STRUCTURAL_YJS_CLIENT_ID` is NOT

- **Not a real peer.** No Yjs document has `clientID = 0` for its actual operations. The constant exists precisely so that structural ops cannot be confused with any peer's work.
- **Not shared across backends.** Loro doesn't have an equivalent. It is a Yjs-specific fix for a Yjs-specific concern.
- **Not required for correctness in single-peer scenarios.** A single peer would converge to itself either way. The constant matters as soon as a second peer appears.
- **Not a security boundary.** It is a coordination mechanism, not a capability.

---

## `clientID` and the order it is claimed in

Source: `src/bind-yjs.ts` → `createForHydration`, `upgrade`, `create`.

Yjs addresses every operation by `(clientID, clock)`, and `clock` restarts at zero on a fresh `Y.Doc`. A peer that sets its stable `clientID` on an empty document and then writes therefore produces operations at addresses its *own* stored history already occupies — and `applyUpdate` deduplicates by address, because that is what makes applying the same update twice a no-op.

Measured, with a prior session that wrote three items under `clientID` 42:

| Sequence | Resulting `clientID` | Contents |
|---|---|---|
| claim → import | reassigned to random | `["p1","p2","p3"]` — intact |
| claim → **write** → import | reassigned to random | `["mine","p2","p3"]` — **`p1` lost** |
| import → claim → write | `42` | `["p1","p2","p3","mine"]` — complete |

Rows one and two show Yjs's own defence: when an update arrives carrying operations from the local `clientID` that this document did not author, Yjs concludes two live clients share an id and silently reassigns itself a random one. That is a correctness feature and it is what saves the data in row one — but it costs the peer its stable identity, and by row two it is too late, because the collision already happened at write time.

Row three is the order this binding uses. `createForHydration` builds the document without claiming, so the import lands cleanly against the throwaway id; `adopt()` then sets the stable `clientID`, and the clock resumes past the imported history rather than colliding with it. `create()` still claims immediately, which is correct for a document that imports nothing.

Note that this is **not** a Yjs quirk. Loro has the same collision for the same reason and also implements `createForHydration`; the difference is only in the symptom, since Loro does not defend and so keeps a stable `PeerID` while dropping the operation. See §"Peer identity and when a substrate may claim it" in `packages/schema/TECHNICAL.md` for the rule stated in terms of addressing.

## `clientID` width

Source: `src/bind-yjs.ts` → `yjsClientId`.

A peer's `clientID` is `yjsClientId(peerId)`, which is `Number(peerNumber(peerId, 53))` from `@kyneta/schema`. Two peer ids that share a `clientID` write different operations at the same `(clientID, clock)` addresses on every document they both touch, and a merge keeps only one of each pair. The chance of any collision among `n` peers is about `n² / 2^(bits+1)`: 1.2% for 10,000 peers at 32 bits, 5×10⁻⁹ at 53.

Yjs generates only 32-bit ids itself, but `clientID` is a JS `number`, and lib0's `writeVarUint` and `writeVarInt` divide rather than shift, so V1 and V2 updates, state vectors and relative positions carry any safe integer. 53 bits is the widest id a `number` holds exactly. `src/__tests__/wide-peer-id.test.ts` checks a `clientID` above 2³² through updates, state vectors and `YjsVersion`.

The number is never 0, which is `STRUCTURAL_YJS_CLIENT_ID`, and it is the low 53 bits of the same peer id's Loro `PeerID`. `peerNumber` reserves 0 once for both backends; see §"Peer identity and when a substrate may claim it" in `packages/schema/TECHNICAL.md`.

## Identity-keyed containers

Same idea as in Loro (see `@kyneta/loro-schema/TECHNICAL.md` → "Identity-keyed containers"). Every product-field boundary uses the field's content-addressed identity hash as its `Y.Map` key, not its display name. Renames change display names; identity hashes survive the rename; stored data is untouched.

The binding is threaded through `resolveYjsType` (read path), `ensureContainers` (structural creation), and `applyChangeToYjs` (write path).

One Yjs-specific wrinkle: because everything lives inside the single root `Y.Map`, identity-keying applies *uniformly* at every level — root fields and nested struct fields are all `Y.Map` keys. Loro's asymmetry (typed root accessors vs. child `.get()`) does not exist here.

---

## The write path and populate-then-attach

Source: `packages/schema/backends/yjs/src/substrate.ts` → `prepare` / `afterBatch` / `runBatch`; `src/change-mapping.ts` → `applyChangeToYjs`; `src/populate.ts` → `populate`.

Yjs's natural programming model is imperative: open a `Y.transact`, mutate shared types, close. Kyneta's write path advances **both** σ (the shadow, read-visible) AND λ (the live `Y.Doc` tree, sync-visible) inside the ambient `Y.transact` opened by `runBatch`. The projection law `σ ≡ Π(λ)` (the naturality condition of `materializeYjsShadow`) holds at every prepare boundary. It is pinned by `projectionConformance` (`@kyneta/schema/testing`), run from `src/__tests__/eager-write-coherence.test.ts`, which compares the substrate's shadow against a fresh `materializeYjsShadow` after each write.

```
batch(doc, d => { d.title.insert(0, "hi"); d.items.push(x) })
  │
  ├─ runBatch opens ONE Y.transact(doc, body, options.origin)
  │   (a Y.transact that external code wraps around batch() nests
  │   natively — Yjs collapses it into the outermost transact)
  │
  ├─ prepare phase (per mutation, applies to both σ and λ EAGERLY):
  │    1. applyChange(shadow, path, change)        ── σ advances
  │    2. findOpaqueBoundary(path) ─► boundary?
  │       ├─ yes: stage the full σ snapshot at the boundary key
  │       │       in the json-boundary coalescing buffer
  │       └─ no:  applyChangeToYjs(rootMap, ...)   ── λ advances
  │
  └─ afterBatch (at the depth 1→0 release, then the batch is sealed):
       flushJsonBoundaryBuffer() — for each buffered entry:
         Y.Map parent → target.set(key, value)
         Y.Array parent → target.delete(index, 1); target.insert(index, [value])
       (runs inside the still-open Y.transact)
  │
  ├─ runBatch's transact closes — Yjs fires ONE observeDeep batch
  │ covering all ops in the outermost logical action, then afterTransaction
  │
  └─ the sealed changeset is delivered to Kyneta subscribers
```

`applyChangeToYjs` is straightforward imperative mutation: resolve the target via `resolveYjsType`, then call `Y.Text.insert` / `Y.Array.insert` / `Y.Map.set` / etc. depending on the change type.

### The json-boundary coalescing buffer

Writes targeting a path that crosses a `struct.json` / `list.json` / `record.json` boundary stage the full σ-snapshot at the boundary segment in the parent CRDT container, instead of generating per-leaf imperative mutations against nested shared types (which don't exist — the entire subtree is stored as a plain JSON value). Repeated writes inside the same subtree overwrite the buffered entry (last-write-wins by σ snapshot); `afterBatch` drains the buffer into λ inside the still-open transact via `target.set(key, value)` (Y.Map parents) or `delete+insert` (Y.Array parents).

Non-boundary writes bypass the buffer entirely and go straight to `applyChangeToYjs` during prepare — text, sequence, map, and replace changes all apply imperatively to their live targets.

### Re-entry: each block is its own transaction

Kyneta subscribers run after `runBatch`'s transaction has closed (`packages/schema/TECHNICAL.md` §"The batch lifecycle"). A `batch(doc, ...)` a subscriber issues is therefore its own outermost block: its own `Y.transact`, its own `observeDeep` event, and its own origin. External Yjs providers (y-websocket, y-webrtc) ship one binary update per outermost block, re-entrant ones included. `src/__tests__/delivery-after-commit.test.ts` pins the transactions' origins and contents.

Yjs's `Y.transact` still collapses nesting when external code wraps a `batch()` in its own `Y.transact`: the inner transact runs as part of the outer one, and `KYNETA_MARK` travels with the shared transaction.

`CommitOptions.origin` (the app-level provenance label) flows through the kyneta `Changeset.origin` channel and becomes Yjs's `transaction.origin`, so Yjs ecosystem tools that key on origin see the app's label. The event-bridge handler recognises and skips its own writes by the `KYNETA_MARK` that `runBatch` sets in `transaction.meta`.

### Populate-then-attach for structural inserts

Inserting a whole struct into a list or map is the one case that needs care. The naïve approach — attach an empty `Y.Map` to the parent, then set its fields — fires two `observeDeep` events (attach, then fields). That's two kyneta `Op` emissions for what logically is one structural insert.

**The populate-then-attach pattern**:

1. `materializeValue(schema, value, binding, absPath, "leaf-containers")` (from `@kyneta/schema`) builds a pure, backend-agnostic `MaterializedNode` tree with every product-field boundary **already identity-hashed**.
2. `realizeYjs(node)` (in `src/change-mapping.ts`) walks that tree post-order: children are fully built, then their parent `Y.Map`/`Y.Array`/`Y.Text` is assembled — nothing is attached to the document mid-build. Scalar and sum leaves become plain `Y.Map` entries; only container kinds become shared types.
3. The applier (`applyReplaceChange` / `applyMapChange` / `applySequenceChange`) attaches the fully-populated shared type to the parent in one `set`/`insert` call under its own identity key.

One `observeDeep` event fires (the attach). `eventsToOps` expands it into the correct kyneta change at the structural boundary. Subscribers see one coherent `Op`, not two half-constructed states.

Source: `materializeValue` (shared, `@kyneta/schema/src/materialize-value.ts` — the write-side counterpart to `foldPath`) + `realizeYjs` (`src/change-mapping.ts`). The former hand-rolled helpers `createStructuredMap` / `maybeCreateSharedType` are gone; `src/populate.ts` retains only the doc-init eager pass (`ensureContainers`), not a `populate` helper.

> **Invariant (jj:vlnkqyvq).** Every write path routes product-field keys through the single `containerKey` producer and materializes structured values through the shared `materializeValue` unfold, so a whole-struct `.set({...})` lands under the same identity hashes the reader resolves — writer and reader keys agree by construction. The subtlety this guards: a nested product-field leaf written under its literal name would be invisible to the identity-keyed reader and never converge to a peer. `src/__tests__/struct-replace-convergence.test.ts` checks both the container-key level and cross-peer convergence.

### What the write path is NOT

- **Not asynchronous.** `Y.transact` is synchronous; the entire flush completes within one tick.
- **Not an `applyDiff`-style bulk operation.** Unlike Loro, Yjs has no single-call diff primitive. Mutations are imperative; the batching comes from `Y.transact`.
- **Reversible via in-bracket inverse compensation** (post-jj:ryquprut). The kyneta `WritableContext.runBatch` records inverses on every `substrate.prepare` and replays them inside the same `Y.transact` if `fn` throws. External `observeDeep` consumers see one batched event whose ops net to zero. The kyneta-Changeset surfaces `aborted: true` to its subscribers. Yjs's own `Y.UndoManager` is orthogonal — it observes COMMITTED transactions and applies compensating commits AFTER the fact; the kyneta inverse-compensation path happens INSIDE the same transact, producing a single batched event instead of two.

### Yjs lifecycle ordering around the bracket

`runBatch`'s transaction closes before Kyneta subscribers run: Yjs fires `observeDeep` and `afterTransaction` for our transaction first, then the changeset is delivered. Hooks on `afterTransaction` therefore see the finished transaction before any Kyneta subscriber does. If such a hook writes to the document, its transaction is announced by the event bridge after our changeset, in causal order.

`version()` is `YjsVersion.fromDoc(doc)`, the same derivation the replica uses: the state vector.

---

## The event bridge

Source: `packages/schema/backends/yjs/src/substrate.ts` → `rootMap.observeDeep(...)` handler; `src/change-mapping.ts` → `eventsToOps`.

The persistent `observeDeep` callback on the root `Y.Map` is the enforcement mechanism for the key invariant: every mutation under the root fires the kyneta changefeed, regardless of source. Sources include:

- Local kyneta writes via `batch(doc, fn)` — suppressed by the `transaction.meta` mark.
- `substrate.merge(payload)` with a peer's update — announced with `local: false`.
- `Y.applyUpdate(doc, update)` from application code or another Yjs provider (y-websocket, y-webrtc) — announced with `local: false`.
- Raw Yjs API writes (`doc.getMap("root").get(id).insert(0, "x")`) bypassing kyneta, such as an editor binding's (y-prosemirror, y-codemirror) — announced with `local: true`, so subscribers receive them with `replay: false`.

A write to a top-level type outside `root` raises no changeset, since the schema has no place for it. It is still pushed and persisted, through the substrate's `update` subscription (`subscribeLocalUpdates`).

The handler:

1. If the transaction carries this substrate's `KYNETA_MARK` in `transaction.meta` → skip (kyneta already notified during its own `change`).
2. Call `eventsToOps(events, schema, binding)` → pure translation from Yjs events to kyneta `Op[]`.
3. Reconcile the shadow from the `Y.Doc` at what the ops touched: `reconcileShadow(shadow, planReconcile(schema, touchedBy(ops)), resolver, materializer)`, over `createYjsResolver`. `touchedBy` pairs each op's path with how far below it the change reached (`planSubtreeEffect`). Only those parts are re-materialized, so the cost is the change's size and every other σ object keeps its identity (`@kyneta/schema` TECHNICAL.md, §The functional shadow). Undo (`revertible.observed`) reads σ before this step.
4. Announce the ops with `{ origin, local: transaction.local }`. `origin` is `transaction.origin` when it is a string: a merge passes its `options.origin` to `Y.applyUpdate`, so its transaction carries it, and a write an observer makes in reaction is a transaction of its own with its own origin. A merge without an origin reports `undefined`.

### Own-commit discriminator via `transaction.meta`

`Y.transact` accepts an arbitrary `origin` value as its third argument. The substrate passes the user-provided `options?.origin` directly to `Y.transact`, freeing the user-facing `origin` slot for legitimate round-trips. To identify its own transactions, the substrate inscribes a unique per-substrate Symbol (`KYNETA_MARK`, created in `createYjsSubstrate`) into `transaction.meta` from inside the transact body. Per substrate, so a second substrate over the same `Y.Doc` announces this one's batches as native local writes, and each keeps σ ≡ Π(λ).

#### Why the `transaction.meta` mark

Yjs's event-delivery semantics are synchronous: `beforeTransaction` fires synchronously inside `doc.transact()`; the body callback runs with access to the in-flight `Transaction` object; `observeDeep` fires synchronously after the body returns, before `transact` returns. Nested `transact` calls collapse — both outer and inner body callbacks receive the SAME Transaction object.

Yjs's `Transaction.meta: Map<any, any>` is a public per-transaction Map. Writing to it from inside the transact body inscribes the mark on the SAME Transaction object that `observeDeep` later receives — including the external-wrap case, since the inner kyneta `transact` body shares the outer's Transaction object via Yjs's nested-collapse semantics. The mark is data on the CRDT's own event machinery; `transaction.origin` is left untouched and carries `options.origin` verbatim.

#### Probe-verified empirical facts

| Property | Behavior |
|---|---|
| Nested transact callback identity | Inner and outer transact body callbacks receive the SAME `Transaction` object; outer's origin wins. |
| `transaction.meta` survives to observeDeep | `tr.meta.set(MARK, value)` from inside the body is visible to observeDeep on the same transaction. |
| External-wrap mark survival | External code wrapping a kyneta-style inner transact: the inner's mark reaches observeDeep on the outer's shared Transaction. |
| Mixed-mode collapse | External raw mutations + marked inner transact in one outer share ONE Transaction; observeDeep sees all events with mark set (all-or-nothing skip — known limitation). |
| Empty transact | `beforeTransaction` fires, `observeDeep` does NOT fire. No issue: mark is just data on a soon-to-be-GC'd Transaction. |

Three properties this gives us:
1. `transaction.origin` is preserved as a transparent pass-through for `options.origin` — providers and `UndoManager.addTrackedOrigin` see the app's intent, not a kyneta sentinel. Origin alone does not tell a local write from a merge, though; see [Using `Y.UndoManager`](#using-yundomanager).
2. External-wrap is correctly classified as own — strict improvement over the `KYNETA_ORIGIN` string design.
3. No string namespace to collide with — external code can use any string origin without triggering kyneta's bridge-skip.

### Using `Y.UndoManager`

Kyneta's own undo ([Undo](#undo)) is the supported path: it spans documents, survives a reload, and leaves formatting a peer typed inside a mark alone. For an app that uses Yjs's manager anyway: a `Y.UndoManager` with its defaults records other peers' edits as undoable. It tracks transactions whose origin is `null`, and `null` is what both a local write and a merge carry when no origin is given: `merge(doc, payload)` passes `undefined` to `Y.applyUpdate`, which defaults it to `null`. The exchange always merges with `origin: "sync"`, but any other caller of `merge` may not. Kyneta's delete clock also commits local `null`-origin transactions, on the top-level `kyneta.clock` text.

Tell local from remote by `transaction.local`, which a merge sets to `false`, and scope the manager to the schema's root map:

```ts
const undo = new Y.UndoManager(ydoc.getMap("root"), {
  captureTransaction: tr => tr.local,
})
```

Measured on a merge without an origin: with the defaults the first undo removed the peer's text; with this configuration it removed only the local writes.

### Known limitation: mixed mode

Mixing raw CRDT mutations with `batch()` calls inside the same atomic unit (a single Yjs `transact` body) is unsupported. The raw mutations will be silently absorbed into kyneta's own-commit skip and not bridged to the kyneta changefeed, so σ misses them. They are still pushed and persisted: the local-update signal covers the whole transaction. To intermix, use separate transacts for raw mutations. This is a fundamental limit of commit-level discrimination.

Before announcing (`ctx.announce`), the bridge reconciles the `PlainState` shadow from the `Y.Doc` where the ops touched it (`reconcileShadow`, over `createYjsResolver`), so `ctx.reader` — which reads through `plainReader(shadow)` — already reflects the merged Yjs state when any subscriber runs. The announcement never reaches `substrate.prepare` or `afterBatch`. See [§The functional shadow](../../TECHNICAL.md#the-functional-shadow).

`materializeYjsShadow` itself uses the generic `createMaterializeInterpreter` from `@kyneta/schema` core with a Yjs-specific `MaterializeResolver` (created by `createYjsResolver`), rather than defining a bespoke interpreter. The resolver (~50 lines) handles only CRDT-specific value extraction (reading from `Y.Text`, `Y.Map`, `Y.Array`); the structural traversal, zero-default production for missing scalars/sums, and recursive descent are all handled by the shared core interpreter.

### What the event bridge is NOT

- **Not a polling loop.** `observeDeep` is Yjs's own push-based event API.
- **Not filtered.** Every event Yjs emits reaches `eventsToOps`; subscription-level filtering is the interpreter-stack's concern.
- **Not subject to ordering constraints.** Yjs emits events synchronously within the transaction that caused them. The bridge fires in whatever stack frame Yjs used.

---

## Undo

Source: `src/undo/` — `record.ts` (the record, its rewrite and codec), `document.ts` (what is read of the `Y.Doc`), `capture.ts` (a transaction's draft), `plan.ts` (the pure revert planning) and `revertible.ts` (`createYjsRevertible`, the shell), wired in `src/substrate.ts`. The model is `packages/schema/TECHNICAL.md` § Undo; the measurements, `docs/findings/undo-probes.md`.

A record names content by Yjs identity, which survives edits, merges, gc and a reload:

| Part | What it holds | How a revert uses it |
|---|---|---|
| `inserted` | The ids this peer inserted into a text or list, by container | Deletes the ones still alive, so text a collaborator typed among them survives |
| `deleted` | Each run it deleted: ids in document order, the id of the item before it (`after`), the content (with marks), and the ids of texts inside a deleted list item | Re-inserts the content just after that item, unless some of its ids are alive again |
| `values` | Each map key or scalar it wrote: what it wrote, what was there | Restores the old value only while the key still holds what was written |
| `marks` | Each character it marked, per key: what it set, what was there | Restores per character, only where the character still holds what was set |

A container inside a list is addressed by a `StablePath`: its Kyneta path with each list index replaced by the list item's id, resolved at revert time through a relative position.

- **Capture has two routes, one builder.** A Kyneta batch is gathered in `prepare` (the σ before each op, the ids of doomed list items, the clocks around each insert), a direct write in the event bridge before it reconciles σ (`reconcileShadow`), so σ still holds the state before it. Both end in `afterTransaction`, which emits the record unless the batch aborted or it has no effect. Text deletions come from the same place for both: `toDelta` over the snapshot before the transaction and now (`computeYChange` names each removed item, in document order), read before gc.
- **Deleted rich text takes its marks from σ before the transaction.** Yjs renders deleted text without its formatting.
- **Marks are undone by state, never by deleting format items.** Yjs's own manager deletes the format items it inserted, and a peer's closing boundary then re-bolds text that was never bold (finding 18).
- **A revert gathers, plans, applies, settles.** `gather` reads what the record names as the document holds it now (`YjsGathered`: containers and their lengths, where each live id sits, whether a deleted run is back, what each value holds). `planYjsRevert(record, gathered)` decides purely: which inserts to delete, which runs to restore where, which marks and values still hold what was written. The plan applies as one authored batch, dispatched inside out (a change inside a list item before the list moves), carrying the caller's `origin` and `source`; its own record is the redo. `remapOfLanded` pairs, purely, the ids each restored run landed with.
- **A deleted run re-inserts after the item before it, not at its own tombstone.** A `Y.Text` insert goes past the tombstones to its right, so in a step of several deletions from one text (a word backspaced a key at a time) each restore anchored to its own tombstone would land before the one restored just above it. The item before is rewritten through the remap like every other id, so it names what an earlier revert in the step re-created (finding 28).
- **Remap.** A restored run's new ids are read back at the indices it landed on, and paired with its old ones in order; texts inside a restored list item pair the same way. `rewrite` substitutes them in every older record.
- **`position`** is `{ clientID, clock }`. The delete clock makes even a delete-only revert advance it, so `authoredSince` sees every revert.
- **Only public API.** `src/__tests__/yjs-surface.test.ts` pins every Yjs call the module makes: relative positions, `isDeleted` over `snapshot`, `getState`, the transaction's fields, `YEvent.changes`, and `toDelta` over snapshots.

### Known gaps

- **A list deleted by a direct write restores without a remap.** Yjs's public API gives no document order for its deleted items, so older steps inside those items are skipped.
- **A crashed revert that restored several runs** is recovered without a remap, for the same reason.
- **Types outside the schema** (y-prosemirror's `XmlFragment`) are not recorded: there is no shadow to read their inverse from.

---

## `YjsPosition`

Source: `packages/schema/backends/yjs/src/position.ts`.

Yjs provides `Y.RelativePosition` — an opaque reference to a location within `Y.Text` or `Y.Array` that survives concurrent edits. `YjsPosition` wraps it:

```
class YjsPosition implements Position {
  constructor(private rel: Y.RelativePosition, private doc: Y.Doc) {}

  resolve(): number {
    const abs = Y.createAbsolutePositionFromRelativePosition(this.rel, this.doc)
    return abs?.index ?? 0
  }

  transform(change: Change): void {
    // no-op — resolution queries Yjs directly
  }
}
```

Same pattern as `LoroPosition`: wrap a CRDT-native cursor type, delegate `resolve` to the substrate's own resolution function, make `transform` a no-op because the substrate handles position tracking internally.

`toYjsAssoc(side)` maps kyneta's `Side = "left" | "right"` to Yjs's `assoc` enum (`0` for left / `-1` for right in Yjs's convention).

### What `YjsPosition` is NOT

- **Not a numeric index.** `resolve()` returns one, but the underlying `Y.RelativePosition` is anchored to a Yjs item ID and survives edits that would shift any raw index.
- **Not stateful on the kyneta side.** All state lives in the Yjs `Y.RelativePosition`. `transform` does nothing by design.
- **Not serialisable by default.** Yjs does have `Y.encodeRelativePosition` / `Y.decodeRelativePosition`; applications that need to persist positions across sessions must use those at the Yjs layer.

---

## `yjs.bind` and `yjs.replica`

Source: `packages/schema/backends/yjs/src/bind-yjs.ts`.

`yjs` is a `BindingTarget<YjsLaws, YjsNativeMap>` — a fixed bundle of `(factory, syncMode, allowedLaws)` built via `createBindingTarget` from `@kyneta/schema`. The ergonomic API:

```
import { yjs } from "@kyneta/yjs-schema"
import { Schema } from "@kyneta/schema"

const Todo = yjs.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct({ body: Schema.text(), done: Schema.boolean() })),
}))
```

`yjs.bind(schema)` returns a `BoundSchema<S, YjsNativeMap>`. Under the hood it delegates to `@kyneta/schema`'s `bind()` with `SYNC_COLLABORATIVE` as the sync mode. The `YjsLaws` set (`"lww" | "positional-ot" | "lww-per-key" | "lww-tag-replaced"`) is applied as `RestrictLaws<S, YjsLaws>`, so binding a schema whose `ExtractLaws` includes `"additive"` (counter), `"positional-ot-move"` (movable), `"tree-move"` (tree), or `"add-wins-per-key"` (set) fails at compile time.

**`Schema.set` is not supported by Yjs.** The `case "set"` and `case "set-op"` branches in `change-mapping.ts` throw at runtime — they are unreachable from any bound Yjs substrate via the law restriction above, but the explicit throws guard against any future code path that bypasses the type-level check. See [§Set: value-addressed leaf](../../TECHNICAL.md#set-value-addressed-leaf) for the kyneta-level set semantics.

**`Schema.tree` is not supported by Yjs.** Rejected at `yjs.bind` time via the `"tree-move"` law restriction. `MaterializeResolver.resolveForest` returns `[]` defensively for any code path that reaches it.

`yjs.replica()` produces a `BoundReplica<YjsVersion>` — the replication-only variant for sync conduits that don't need to interpret state.

### Compile-time composition-law enforcement

```
const BadSchema = Schema.struct({ count: Schema.counter() })
yjs.bind(BadSchema)
// ^^ Type error: Schema contains "additive" law not supported by YjsLaws
```

This is the same mechanism as the Loro backend, exercised with a narrower law set. Tests in `src/__tests__/bind-constraints.test.ts` assert the negative cases.

### What `yjs.bind` is NOT

- **Not a factory.** It returns a `BoundSchema`, not a substrate. The substrate is constructed by `createDoc(bound)` at runtime.
- **Not asynchronous.** Fully synchronous; the schema and the Yjs factory builder are captured at call time.
- **Not overridable.** Sync mode for `yjs.bind` is always `SYNC_COLLABORATIVE`. For different sync semantics, use `@kyneta/schema`'s lower-level `bind()` directly.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `yjs` | `src/bind-yjs.ts` | The binding target: `.bind(schema)`, `.replica()`. |
| `yjsClientId` | `src/bind-yjs.ts` | A peer id's `clientID`: `Number(peerNumber(peerId, 53))`. See [`clientID` width](#clientid-width). |
| `YjsLaws` | `src/bind-yjs.ts` | `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` — composition laws Yjs supports. |
| `YjsNativeMap` | `src/native-map.ts` | The `NativeMap` functor for Yjs. Unsupported kinds map to `undefined`. |
| `YjsVersion` | `src/version.ts` | `Version` over the Yjs state vector. |
| `DELETE_CLOCK` | `src/substrate.ts` | The top-level type the delete clock writes to. |
| `YjsPosition` | `src/position.ts` | `Position` over `Y.RelativePosition`. |
| `toYjsAssoc` | `src/position.ts` | `Side → Yjs assoc` enum. |
| `yjsSubstrateFactory` / `yjsReplicaFactory` | `src/substrate.ts` | Factory instances. |
| `createYjsSubstrate` | `src/substrate.ts` | Construct a `Substrate<YjsVersion>` from a `Y.Doc` and schema. |
| `yjsReader` | `src/reader.ts` | `Reader` via live shared-type navigation. |
| `resolveYjsType` / `stepIntoYjs` | `src/yjs-resolve.ts` | The navigation primitives. |
| `ensureContainers` | `src/populate.ts` | Idempotent structural-creation pass (uses `STRUCTURAL_YJS_CLIENT_ID`). |
| `populate` | `src/populate.ts` | Recursive populate-then-attach helper. |
| `applyChangeToYjs` / `eventsToOps` | `src/change-mapping.ts` | Translators between kyneta and Yjs vocabularies. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Public barrel. Re-exports generic API from `@kyneta/schema`; exports Yjs-specific symbols. |
| `src/bind-yjs.ts` | `yjs.bind` / `yjs.replica` binding target; `YjsLaws`; `yjsClientId`. |
| `src/substrate.ts` | `YjsSubstrate`, factories, prepare/flush, `Y.transact` wrapping, `observeDeep` event bridge, origin-based suppression, the delete clock. |
| `src/change-mapping.ts` | `applyChangeToYjs` (per kyneta change type → Yjs mutations) + `realizeYjs` (`MaterializedNode` → Yjs shared type, populate-then-attach) + `eventsToOps` (Yjs events → kyneta `Op[]`). |
| `src/yjs-resolve.ts` | `stepIntoYjs`; `resolveYjsType` is a thin wrapper over the core `foldPath` primitive. |
| `src/populate.ts` | `ensureContainers` (conditional doc-init structural creation, `clientID:0`, identity-keyed via shared `containerKey`). Value-driven population lives in `realizeYjs` (`src/change-mapping.ts`), not here. |
| `src/reader.ts` | `yjsReader` — reads via `resolveYjsType` + per-type extraction. |
| `src/version.ts` | `YjsVersion`: the state vector, its lattice operations, serialisation. |
| `src/position.ts` | `YjsPosition` (wraps `Y.RelativePosition`), `toYjsAssoc`. |
| `src/undo/record.ts` | Undo records by Yjs identity: their shape, `rewriteYjsRecord`, the codec. |
| `src/undo/document.ts` | What undo reads of a `Y.Doc`: ids at indices, where an id sits, a text's ids in order, stable paths. The Yjs surface `yjs-surface.test.ts` pins. |
| `src/undo/capture.ts` | What a local transaction did: value, mark and list-deletion writes, a text's deletions and insertions. |
| `src/undo/plan.ts` | A revert's decisions, pure: `planYjsRevert`, `composeEdits`, `remapOfLanded`. |
| `src/undo/revertible.ts` | `createYjsRevertible`: drafts, gather, apply, settle. |
| `src/__tests__/undo.test.ts` | The shared undo suite (`undoConformance`). |
| `src/__tests__/yjs-surface.test.ts` | Every Yjs call undo depends on, pinned. |
| `src/__tests__/revert-plan.test.ts` | `planYjsRevert`, `composeEdits` and `remapOfLanded` on hand-built gathered state, with no document. |
| `src/native-map.ts` | `YjsNativeMap` type-level functor. |
| `src/__tests__/create.test.ts` | End-to-end: `createDoc(yjs.bind(schema))` → read/write round-trips. |
| `src/__tests__/substrate.test.ts` | Substrate contract conformance (subset of the `@kyneta/schema` suite). |
| `src/__tests__/reader.test.ts` | `yjsReader` over every Yjs shared type + scalar variants. |
| `src/__tests__/record-text-spike.test.ts` | Focus tests for `Schema.record(Schema.text())` and related combinations. |
| `src/__tests__/structural-merge.test.ts` | Two-peer `ensureContainers` convergence under concurrent upgrade; identity-keyed container compatibility. |
| `src/__tests__/position.test.ts` | `YjsPosition` cursor stability across concurrent edits. |
| `src/__tests__/bind-constraints.test.ts` | Compile-time composition-law enforcement (`counter`, `movable`, `tree`, `set` all rejected). |
| `src/__tests__/bind-yjs.test.ts` | `yjs.bind` API surface. |
| `src/__tests__/wide-peer-id.test.ts` | A `clientID` above 2³² round-trips through updates, state vectors and versions. |
| `src/__tests__/version.test.ts` | `YjsVersion` serialise/parse, `compare`, `meet`, and the lattice laws (`versionConformance`). |

## Testing

Tests use real `Y.Doc` instances from `yjs` — no mocks. Two-peer scenarios construct two `Y.Doc`s, mutate independently, and sync via `Y.encodeStateAsUpdate` + `Y.applyUpdate` (or via the substrate's `exportSince` + `merge`). The substrate contract suite from `@kyneta/schema` is replayed against `yjsSubstrateFactory` for conformance.

One test stdout line is expected: `[yjs] Changed the client-id because another client seems to be using it.` — this is Yjs's own warning when a test deliberately creates two peers with colliding IDs; Yjs auto-recovers by re-issuing an ID, which is the correct behaviour.

Run with `cd packages/schema/backends/yjs && pnpm exec vitest run`.

## `richtext` support

`richtext` uses the same `Y.Text` shared type as `text`. The difference is in change-mapping:

- **Outbound** (`applyRichTextChange`): Same delta format as Loro — `format(N, marks)` → `{ retain: N, attributes: marks }`.
- **Inbound** (`richTextEventToChange`): `YTextEvent.delta` entries with `attributes` → `format` instructions; without → plain `retain`.
- **Materialized** (`yTextToRichTextDelta`): adjacent spans whose marks agree are merged (`normalizeSpans`), so a re-materialized shadow reads as a stepped one does.

Yjs does not require explicit mark style configuration (unlike Loro's `configTextStyle()`). Formatting attributes are always inclusive by default. This is an asymmetry between the two substrates.

The `resolveYjsType` function returns `{ resolved, schema }` — this enables the reader to dispatch `Y.Text` → `.toJSON()` (text) vs `.toDelta()` (richtext).