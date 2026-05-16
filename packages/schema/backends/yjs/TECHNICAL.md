# @kyneta/yjs-schema — Technical Reference

> **Package**: `@kyneta/yjs-schema`
> **Role**: Yjs CRDT substrate for `@kyneta/schema`. Wraps a `Y.Doc` as a `Substrate<YjsVersion>` with a single-root-`Y.Map` design, schema-guided live navigation via `instanceof` discrimination, imperative writes inside `Y.transact`, identity-keyed containers for cross-schema sync, and a persistent `observeDeep` event bridge so every mutation — local kyneta writes, `merge()`, `Y.applyUpdate()`, or raw Yjs API — fires the kyneta changefeed.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `yjs` (peer)
> **Depended on by**: `@kyneta/exchange` (dev), `@kyneta/react` (dev), `@kyneta/cast` (dev), application code that wants collaborative documents via Yjs
> **Canonical symbols**: `yjs` (binding target: `yjs.bind`, `yjs.replica`), `YjsLaws`, `YjsNativeMap`, `createYjsSubstrate`, `yjsSubstrateFactory`, `yjsReplicaFactory`, `YjsVersion`, `YjsPosition`, `yjsReader`, `resolveYjsType`, `stepIntoYjs`, `ensureContainers`, `applyChangeToYjs`, `eventsToOps`, `toYjsAssoc`, `STRUCTURAL_YJS_CLIENT_ID`
> **Key invariant(s)**: Every schema field is a child of one root `Y.Map` obtained via `doc.getMap("root")`. This is what makes a single `observeDeep` call capture every mutation with correct relative paths — and what makes `instanceof` container discrimination reliable (Yjs shared types are native JS classes, not WASM handles).

The Yjs backend for Kyneta. Hands you a substrate instance — stored state, versioning, export/import, and a `Reader` — in exchange for a `Y.Doc`. Every ref produced by the interpreter stack reads through schema-guided shared-type resolution; every write runs inside a `Y.transact` that tags its origin; every Yjs-visible mutation surfaces as a `Changeset` on the kyneta changefeed.

Consumed by applications that bind schemas with `yjs.bind(schema)`. Not imported by any other Kyneta package at runtime — `@kyneta/exchange`, `@kyneta/react`, and `@kyneta/cast` depend on it only in dev/test.

---

## Questions this document answers

- Why one root `Y.Map` instead of multiple root shared types? → [The single-root-`Y.Map` design](#the-single-root-ymap-design)
- How does this differ from `@kyneta/loro-schema` — same job, different substrate? → [Loro vs Yjs: what changes](#loro-vs-yjs-what-changes)
- Why `instanceof` here but `.kind()` there? → [`instanceof` container discrimination](#instanceof-container-discrimination)
- What does `YjsVersion` include that a bare state vector doesn't? → [`YjsVersion` — state vector + delete set](#yjsversion--state-vector--delete-set)
- How do structural inserts (a whole struct into a map) commit atomically? → [The write path and populate-then-attach](#the-write-path-and-populate-then-attach)
- Why is there a reserved `clientID = 0` for structural operations? → [`STRUCTURAL_YJS_CLIENT_ID`](#structural_yjs_client_id)
- How does a remote `Y.applyUpdate` notify kyneta subscribers? → [The event bridge](#the-event-bridge)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Y.Doc` | Yjs's top-level document (from `yjs`). Owns shared types, client ID, update stream. | A kyneta `DocRef` — the `Y.Doc` is the substrate-native backing |
| `YjsLaws` | The composition-law set `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"`. Yjs supports text (`positional-ot`), structural (`lww-per-key`), scalars (`lww`), and rich text (`positional-ot` + `lww-tag-replaced`) — but not `"additive"` (counter), `"positional-ot-move"` (movable), `"tree-move"` (tree), or `"add-wins-per-key"` (set). | Yjs's full feature set — this is the subset kyneta exposes via composition-law tags |
| `YjsNativeMap` | The `NativeMap` functor mapping schema kinds to Yjs shared types (`text → Y.Text`, `list → Y.Array`, `struct → Y.Map`, `map → Y.Map`). Slots for unsupported kinds are `undefined`. | A JS `Map` — this is a type-level functor |
| `YjsVersion` | `@kyneta/schema`'s `Version` implementation wrapping a Yjs **snapshot** (state vector + delete set). | A bare state vector — SV-only versions cannot distinguish same-state from divergent-deletes |
| `YjsPosition` | `Position` implementation wrapping `Y.RelativePosition`. Stateless `transform` — resolution queries the CRDT directly. | A numeric index |
| `resolveYjsType` | Pure left-fold over path segments accumulating `(currentType, currentSchema)`. The navigation primitive for every read. | A cache lookup — resolution happens on every read |
| `stepIntoYjs` | One step of `resolveYjsType`: given `(currentType, segment, identity?)`, return the child shared type or scalar. | `stepIntoLoro` from the Loro backend — same shape, different dispatch |
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
| Reads (shared type → value) | `src/reader.ts` — `yjsReader` |
| Writes (kyneta `Change` → Yjs mutations) | `src/change-mapping.ts` — `applyChangeToYjs`, `eventsToOps` |
| Substrate orchestration (prepare/flush, merge, events) | `src/substrate.ts` — `YjsSubstrate`, `yjsSubstrateFactory` |

Plus one Yjs-specific concern: `src/populate.ts` owns `ensureContainers`, the conditional structural-creation pass.

### What `@kyneta/yjs-schema` is NOT

- **Not a `Y.Doc` wrapper or subclass.** It accepts a user-owned or factory-created `Y.Doc` and adapts it to `Substrate<YjsVersion>`. The `Y.Doc` is still usable directly — `unwrap(doc)` returns it.
- **Not a Yjs provider.** It does not talk to y-websocket, y-webrtc, y-indexeddb, or any other Yjs provider. The exchange owns sync; this package only exports/imports `SubstratePayload` when the exchange asks. Applications are free to attach their own Yjs providers in parallel — the event bridge will pick up their mutations.
- **Not feature-complete relative to Yjs.** Yjs has types (`Y.XmlElement`, `Y.XmlText`) and features (undo manager, awareness) that kyneta doesn't model. They are accessible via `unwrap(doc)`; they just aren't first-class in the schema grammar.
- **Not an adapter library for multiple CRDTs.** This is Yjs-specific.

---

## Loro vs Yjs: what changes

The two backends implement the same `Substrate<V>` contract and share the overall shape (navigation / reader / change-mapping / substrate-orchestration). The differences are concentrated in a few places, summarised here so the rest of the document can focus on Yjs specifics without re-litigating what's shared.

| Concern | `@kyneta/loro-schema` | `@kyneta/yjs-schema` |
|---------|-----------------------|----------------------|
| Root layout | One Loro container per root field (typed accessors: `doc.getText(k)`, `doc.getMap(k)`, …) plus a reserved `_props` map for root scalars | One `Y.Map` at `doc.getMap("root")` holds *every* field (shared types and plain values alike) |
| Container discrimination | `.kind()` method (strings: `"Map"`, `"Text"`, `"List"`, …) | `instanceof Y.Map`, `instanceof Y.Array`, `instanceof Y.Text` |
| Why | Loro containers are WASM handles; `instanceof` is unreliable across module boundaries | Yjs shared types are native JS classes; `instanceof` is stable |
| Write commit | Accumulate `Diff[]` in `prepare`, apply via `doc.applyDiff` in `onFlush` | Imperative mutations inside `Y.transact` in `onFlush` (origin-tagged) |
| Event bridge | `doc.subscribe` + `inOurCommit` guard + `BatchOptions.replay` directive | `observeDeep` + `transaction.origin === KYNETA_ORIGIN` filter + `BatchOptions.replay` directive |
| Structural identity | Identity hash as Loro container key | Identity hash as `Y.Map` key within the root `Y.Map` |
| Structural creation | Lazy — creation happens on first typed accessor call | Eager — `ensureContainers` walks the schema on upgrade |
| Structural client ID | Not needed (Loro has no equivalent concern) | `STRUCTURAL_YJS_CLIENT_ID = 0` during `ensureContainers` |
| Composition laws | `LoroLaws` = `"lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"` | `YjsLaws` = `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` |
| Version | Wraps `VersionVector` | Wraps full snapshot (state vector + delete set) |
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

## `YjsVersion` — state vector + delete set

Source: `packages/schema/backends/yjs/src/version.ts`.

Yjs's state vector tracks how many operations from each peer have been observed, but it only advances on *inserts*. Deletes (tombstones) do not bump the vector. A version based solely on the state vector cannot distinguish:

- Peer A: inserted 3 items, deleted 0 → state vector `{A: 3}`.
- Peer A: inserted 3 items, deleted 1 → state vector `{A: 3}` (same!).

This matters for sync: if the exchange compared SV-only versions, it would skip pushing deletes to peers with a matching SV.

`YjsVersion` wraps the full **Yjs snapshot** (state vector + delete set) so `compare` distinguishes same-state from divergent-deletes:

| Method | Behaviour |
|--------|-----------|
| `serialize()` | `base64(stateVector)` + `"."` + `base64(snapshotBytes)`. The `.`-joined two-part format. |
| `compare(other)` | Compare SVs first via `versionVectorCompare`; if SVs agree, compare snapshot bytes; differing snapshots with matching SVs → `"concurrent"`. |
| `meet(other)` | Component-wise minimum on state vectors via `versionVectorMeet`; delete set ignored for the lattice meet. |
| `YjsVersion.parse(s)` | Split on `"."`; decode SV and snapshot separately. Legacy format (no `"."`) decodes as SV-only for back-compat. |

### Backward compatibility with SV-only versions

A `YjsVersion` parsed from the legacy SV-only format has no delete-set component. When compared against a new-format version with the same SV but different deletes, the comparison yields `"concurrent"` — which causes the exchange to push an update. The push is redundant in cases where the deletes actually match, but it is always *safe*: a legacy peer receiving a push it didn't strictly need is merely bandwidth, never corruption.

### What `YjsVersion` is NOT

- **Not a bare `Uint8Array`.** It is a structured wrapper with a documented serialise/parse protocol.
- **Not a wall-clock timestamp.** Yjs versions are CRDT causal history, not physical time.
- **Not totally ordered.** Two concurrent peers can be `"concurrent"`. `compare` returns the full partial order.
- **Not interchangeable with `LoroVersion`.** They serialize differently and compare with different algorithms.

---

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

### What `STRUCTURAL_YJS_CLIENT_ID` is NOT

- **Not a real peer.** No Yjs document has `clientID = 0` for its actual operations. The constant exists precisely so that structural ops cannot be confused with any peer's work.
- **Not shared across backends.** Loro doesn't have an equivalent. It is a Yjs-specific fix for a Yjs-specific concern.
- **Not required for correctness in single-peer scenarios.** A single peer would converge to itself either way. The constant matters as soon as a second peer appears.
- **Not a security boundary.** It is a coordination mechanism, not a capability.

---

## Identity-keyed containers

Same idea as in Loro (see `@kyneta/loro-schema/TECHNICAL.md` → "Identity-keyed containers"). Every product-field boundary uses the field's content-addressed identity hash as its `Y.Map` key, not its display name. Renames change display names; identity hashes survive the rename; stored data is untouched.

The binding is threaded through `resolveYjsType` (read path), `ensureContainers` (structural creation), and `applyChangeToYjs` (write path).

One Yjs-specific wrinkle: because everything lives inside the single root `Y.Map`, identity-keying applies *uniformly* at every level — root fields and nested struct fields are all `Y.Map` keys. Loro's asymmetry (typed root accessors vs. child `.get()`) does not exist here.

---

## The write path and populate-then-attach

Source: `packages/schema/backends/yjs/src/substrate.ts` → `onFlush`; `src/change-mapping.ts` → `applyChangeToYjs`; `src/populate.ts` → `populate`.

Yjs's natural programming model is imperative: open a `Y.transact`, mutate shared types, close. Kyneta batches mutations per kyneta transaction, then runs them inside one `Y.transact` with an origin tag.

```
change(doc, d => { d.title.insert(0, "hi"); d.items.push(x) })
  │
  ├─ prepare phase (per mutation):
  │    accumulate (path, change) pairs — no Yjs side effects
  │
  └─ flush phase (on commit):
       doc.transact(() => {
         for each (path, change) in accumulated:
           applyChangeToYjs(rootMap, path, change, schema, binding)
       }, OURS)                              // origin tag
```

`applyChangeToYjs` is straightforward imperative mutation: resolve the target via `resolveYjsType`, then call `Y.Text.insert` / `Y.Array.insert` / `Y.Map.set` / etc. depending on the change type.

### Populate-then-attach for structural inserts

Inserting a whole struct into a list or map is the one case that needs care. The naïve approach — attach an empty `Y.Map` to the parent, then set its fields — fires two `observeDeep` events (attach, then fields). That's two kyneta `Op` emissions for what logically is one structural insert.

**The populate-then-attach pattern**:

1. Create a fresh `new Y.Map()` (not yet attached to any parent).
2. Populate it: iterate the struct's fields (alphabetical over identity hashes), set entries — scalars as plain values, nested shared types as newly-created-and-populated sub-types.
3. Attach the fully-populated map to the parent in one `set`/`insert` call.

One `observeDeep` event fires (the attach). `eventsToOps` expands it into the correct kyneta change at the structural boundary. Subscribers see one coherent `Op`, not two half-constructed states.

Source: `src/populate.ts` → `populate` (recursive), called from `applyChangeToYjs` for every nested structural insert.

### What the write path is NOT

- **Not asynchronous.** `Y.transact` is synchronous; the entire flush completes within one tick.
- **Not an `applyDiff`-style bulk operation.** Unlike Loro, Yjs has no single-call diff primitive. Mutations are imperative; the batching comes from `Y.transact`.
- **Not reversible from the substrate.** Undo is an application concern (Yjs has its own `Y.UndoManager`; kyneta does not integrate it).

---

## The event bridge

Source: `packages/schema/backends/yjs/src/substrate.ts` → `rootMap.observeDeep(...)` handler; `src/change-mapping.ts` → `eventsToOps`.

The persistent `observeDeep` callback on the root `Y.Map` is the enforcement mechanism for the key invariant: every mutation fires the kyneta changefeed, regardless of source. Sources include:

- Local kyneta writes via `change(doc, fn)` — suppressed by origin tag.
- `exchange.merge(payload)` from remote peers — not suppressed; subscribers must see it.
- `Y.applyUpdate(doc, update)` from application code directly — not suppressed.
- Raw Yjs API writes (`doc.getMap("root").get(id).insert(0, "x")`) bypassing kyneta — not suppressed.
- Other Yjs providers (y-websocket, y-webrtc) attached to the same doc — not suppressed.

The handler:

1. If the transaction origin equals `OURS` and the re-entrancy guard is set → skip (kyneta already notified during its own `change`).
2. Otherwise, set the re-entrancy guard to block recursive entry.
3. Call `eventsToOps(events, schema, binding)` → pure translation from Yjs events to kyneta `Op[]`.
4. Dispatch the ops through the interpreter stack's notification pipeline.
5. Clear the guard.

### Origin tagging

`Y.transact` accepts an arbitrary `origin` value as its third argument. The substrate passes a unique per-substrate symbol (`OURS`) when wrapping its own writes; external `Y.transact` calls (or `Y.applyUpdate`, which does its own transact) carry whatever origin the caller supplied (often `null`).

The event handler's discriminant is `transaction.origin === OURS`, not a boolean flag set just-before / just-after `transact`. This means the bridge correctly handles nested or concurrent transactions from other sources — each event's `transaction.origin` is inspected independently.

### What the event bridge is NOT

- **Not a polling loop.** `observeDeep` is Yjs's own push-based event API.
- **Not filtered.** Every event Yjs emits reaches `eventsToOps`; subscription-level filtering is the interpreter-stack's concern.
- **Not subject to ordering constraints.** Yjs emits events synchronously within the transaction that caused them. The bridge fires in whatever stack frame Yjs used.

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

`yjs` is a `BindingTarget<YjsLaws, YjsNativeMap>` — a fixed bundle of `(factory, syncProtocol, allowedLaws)` built via `createBindingTarget` from `@kyneta/schema`. The ergonomic API:

```
import { yjs } from "@kyneta/yjs-schema"
import { Schema } from "@kyneta/schema"

const Todo = yjs.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct({ body: Schema.text(), done: Schema.boolean() })),
}))
```

`yjs.bind(schema)` returns a `BoundSchema<S, YjsNativeMap>`. Under the hood it delegates to `@kyneta/schema`'s `bind()` with `SYNC_COLLABORATIVE` as the sync protocol. The `YjsLaws` set (`"lww" | "positional-ot" | "lww-per-key" | "lww-tag-replaced"`) is applied as `RestrictLaws<S, YjsLaws>`, so binding a schema whose `ExtractLaws` includes `"additive"` (counter), `"positional-ot-move"` (movable), `"tree-move"` (tree), or `"add-wins-per-key"` (set) fails at compile time.

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
- **Not overridable.** Sync protocol for `yjs.bind` is always `SYNC_COLLABORATIVE`. For different sync semantics, use `@kyneta/schema`'s lower-level `bind()` directly.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `yjs` | `src/bind-yjs.ts` | The binding target: `.bind(schema)`, `.replica()`. |
| `YjsLaws` | `src/bind-yjs.ts` | `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` — composition laws Yjs supports. |
| `YjsNativeMap` | `src/native-map.ts` | The `NativeMap` functor for Yjs. Unsupported kinds map to `undefined`. |
| `YjsVersion` | `src/version.ts` | `Version` over Yjs snapshot (SV + delete set). |
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

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 64 | Public barrel. Re-exports generic API from `@kyneta/schema`; exports Yjs-specific symbols. |
| `src/bind-yjs.ts` | 171 | `yjs.bind` / `yjs.replica` binding target; `YjsLaws`. |
| `src/substrate.ts` | 499 | `YjsSubstrate`, factories, prepare/flush, `Y.transact` wrapping, `observeDeep` event bridge, origin-based suppression. |
| `src/change-mapping.ts` | 666 | `applyChangeToYjs` (per kyneta change type → Yjs mutations) + `eventsToOps` (Yjs events → kyneta `Op[]`). |
| `src/yjs-resolve.ts` | 126 | `resolveYjsType`, `stepIntoYjs`. |
| `src/populate.ts` | 248 | `ensureContainers` (conditional structural creation) + `populate` (populate-then-attach). |
| `src/reader.ts` | 131 | `yjsReader` — reads via `resolveYjsType` + per-type extraction. |
| `src/version.ts` | 240 | `YjsVersion` (SV + delete set), two-part serialisation, legacy SV-only compat. |
| `src/position.ts` | 45 | `YjsPosition` (wraps `Y.RelativePosition`), `toYjsAssoc`. |
| `src/native-map.ts` | 37 | `YjsNativeMap` type-level functor. |
| `src/__tests__/create.test.ts` | 665 | End-to-end: `createDoc(yjs.bind(schema))` → read/write round-trips. |
| `src/__tests__/substrate.test.ts` | 610 | Substrate contract conformance (subset of the `@kyneta/schema` suite). |
| `src/__tests__/reader.test.ts` | 685 | `yjsReader` over every Yjs shared type + scalar variants. |
| `src/__tests__/record-text-spike.test.ts` | 438 | Focus tests for `Schema.record(Schema.text())` and related combinations. |
| `src/__tests__/structural-merge.test.ts` | 419 | Two-peer `ensureContainers` convergence under concurrent upgrade; identity-keyed container compatibility. |
| `src/__tests__/position.test.ts` | 376 | `YjsPosition` cursor stability across concurrent edits. |
| `src/__tests__/bind-constraints.test.ts` | 325 | Compile-time composition-law enforcement (`counter`, `movable`, `tree`, `set` all rejected). |
| `src/__tests__/bind-yjs.test.ts` | 311 | `yjs.bind` API surface. |
| `src/__tests__/version.test.ts` | 380 | `YjsVersion` serialise/parse (both formats), `compare`, `meet`; delete-set distinguishing cases. |

## Testing

Tests use real `Y.Doc` instances from `yjs` — no mocks. Two-peer scenarios construct two `Y.Doc`s, mutate independently, and sync via `Y.encodeStateAsUpdate` + `Y.applyUpdate` (or via the substrate's `exportSince` + `merge`). The substrate contract suite from `@kyneta/schema` is replayed against `yjsSubstrateFactory` for conformance.

One test stdout line is expected: `[yjs] Changed the client-id because another client seems to be using it.` — this is Yjs's own warning when a test deliberately creates two peers with colliding IDs; Yjs auto-recovers by re-issuing an ID, which is the correct behaviour.

**Tests**: 217 passed, 4 skipped across 9 files (`bind-yjs`: 17, `bind-constraints`: included in `bind-yjs` coverage, `create`: 30, `position`: 27 passed + 4 skipped, `reader`: included in `create`/`substrate` coverage, `record-text-spike`: 20, `structural-merge`: 12, `substrate`: 29, `version`: ~82 — approximate per-file breakdown). Run with `cd packages/schema/backends/yjs && pnpm exec vitest run`.

## `richtext` support

`richtext` uses the same `Y.Text` shared type as `text`. The difference is in change-mapping:

- **Outbound** (`applyRichTextChange`): Same delta format as Loro — `format(N, marks)` → `{ retain: N, attributes: marks }`.
- **Inbound** (`richTextEventToChange`): `YTextEvent.delta` entries with `attributes` → `format` instructions; without → plain `retain`.

Yjs does not require explicit mark style configuration (unlike Loro's `configTextStyle()`). Formatting attributes are always inclusive by default. This is an asymmetry between the two substrates.

The `resolveYjsType` function returns `{ resolved, schema }` — this enables the reader to dispatch `Y.Text` → `.toJSON()` (text) vs `.toDelta()` (richtext).