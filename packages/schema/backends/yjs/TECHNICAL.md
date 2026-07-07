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
- What does `YjsVersion` include that a bare state vector doesn't? → [`YjsVersion` — state vector + delete-set digest](#yjsversion--state-vector--delete-set-digest)
- How do structural inserts (a whole struct into a map) commit atomically? → [The write path and populate-then-attach](#the-write-path-and-populate-then-attach)
- Why is there a reserved `clientID = 0` for structural operations? → [`STRUCTURAL_YJS_CLIENT_ID`](#structural_yjs_client_id)
- How does a remote `Y.applyUpdate` notify kyneta subscribers? → [The event bridge](#the-event-bridge)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Y.Doc` | Yjs's top-level document (from `yjs`). Owns shared types, client ID, update stream. | A kyneta `DocRef` — the `Y.Doc` is the substrate-native backing |
| `YjsLaws` | The composition-law set `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"`. Yjs supports text (`positional-ot`), structural (`lww-per-key`), scalars (`lww`), and rich text (`positional-ot` + `lww-tag-replaced`) — but not `"additive"` (counter), `"positional-ot-move"` (movable), `"tree-move"` (tree), or `"add-wins-per-key"` (set). | Yjs's full feature set — this is the subset kyneta exposes via composition-law tags |
| `YjsNativeMap` | The `NativeMap` functor mapping schema kinds to Yjs shared types (`text → Y.Text`, `list → Y.Array`, `struct → Y.Map`, `map → Y.Map`). Slots for unsupported kinds are `undefined`. | A JS `Map` — this is a type-level functor |
| `YjsVersion` | `@kyneta/schema`'s `Version` implementation wrapping a Yjs state vector plus a **fixed-size digest** of the delete set. | A bare state vector — SV-only versions cannot distinguish same-state from divergent-deletes. Also not a raw snapshot — the delete set is hashed, never stored verbatim, to keep serialized size bounded by peer count. |
| `YjsPosition` | `Position` implementation wrapping `Y.RelativePosition`. Stateless `transform` — resolution queries the CRDT directly. | A numeric index |
| `resolveYjsType` | Thin wrapper over the core `foldPath(stepIntoYjs, ...)` primitive (from `@kyneta/schema`). The two semantic invariants (identity-keying, sum-boundary short-circuit) live in `@kyneta/schema/src/fold-path.ts`, not here. | A cache lookup — resolution happens on every read |
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
- **Not a Yjs provider.** It does not talk to y-websocket, y-webrtc, y-indexeddb, or any other Yjs provider. The exchange owns sync; this package only exports/imports `SubstratePayload` when the exchange asks. Applications are free to attach their own Yjs providers in parallel — the event bridge will pick up their mutations.
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
| Write commit | Eager `applyDiff` in `prepare` (plain MapDiff writes coalesce into a per-CID buffer drained in `afterBatch`; structural inserts apply immediately). `runBatch` brackets with a depth counter + single `doc.commit()` on outermost release | Eager imperative mutations inside the ambient `Y.transact` opened by `runBatch` (origin-tagged `KYNETA_ORIGIN`); Yjs's native transact nesting collapses re-entries for free |
| Event bridge | `doc.subscribe` + pre-commit-hook discriminator + `BatchOptions.replay` directive | `observeDeep` + `transaction.meta` mark discriminator + `BatchOptions.replay` directive |
| Structural identity | Identity hash as Loro container key | Identity hash as `Y.Map` key within the root `Y.Map` |
| Structural creation | Lazy — creation happens on first typed accessor call | Eager — `ensureContainers` walks the schema on upgrade |
| Structural client ID | Not needed (Loro has no equivalent concern) | `STRUCTURAL_YJS_CLIENT_ID = 0` during `ensureContainers` |
| Composition laws | `LoroLaws` = `"lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"` | `YjsLaws` = `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` |
| Version | Wraps `VersionVector` | Wraps state vector + fixed-size digest of the delete set |
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

## `YjsVersion` — state vector + delete-set digest

Source: `packages/schema/backends/yjs/src/version.ts`.

Yjs's state vector tracks how many operations from each peer have been observed, but it only advances on *inserts*. Deletes (tombstones) do not bump the vector. A version based solely on the state vector cannot distinguish:

- Peer A: inserted 3 items, deleted 0 → state vector `{A: 3}`.
- Peer A: inserted 3 items, deleted 1 → state vector `{A: 3}` (same!).

This matters for sync: if the exchange compared SV-only versions, it would skip pushing deletes to peers with a matching SV.

`YjsVersion` pairs the state vector with a **fixed-size digest** of the full Yjs snapshot (state vector + delete set) so `compare` distinguishes same-state from divergent-deletes, without embedding the raw delete set:

| Method | Behaviour |
|--------|-----------|
| `serialize()` | `base64(stateVector)` + `"."` + `deleteSetDigest` (32-char hex). Only the state vector is base64-wrapped; the digest is already compact. |
| `compare(other)` | Compare SVs first via `versionVectorCompare`; if SVs agree, compare `deleteSetDigest` strings for equality; a mismatch with matching SVs → `"concurrent"`. |
| `meet(other)` | Component-wise minimum on state vectors via `versionVectorMeet`; delete set ignored for the lattice meet. |
| `YjsVersion.parse(s)` | Split on `"."`; decode SV, read the digest as-is (no re-hashing). Legacy format (no `"."`) decodes as SV-only for back-compat. |

### Why a digest, not raw snapshot bytes

Yjs's delete set (`Map<clientID, DeleteItem[]>`) only merges *adjacent* same-client deleted ranges. A workload with non-contiguous deletes — concretely, insert-then-correct cycles such as STT partial corrections (permanently commit a word, then insert-and-delete a corrected guess, repeat) — accumulates new, never-merging `DeleteItem` entries forever. Because the raw encoded snapshot was embedded directly in `serialize()`'s output (which flows into every wire offer, ack, and persisted `Store` version record), this caused the serialized version to grow **unboundedly with edit history** rather than with peer count — confirmed in production and via a minimal reproduction (a 500-cycle insert-then-delete-correction loop grew the raw snapshot from 150 to 1501 bytes while the state vector itself stayed flat at 4 bytes).

A version vector's serialized size must scale with the number of distinct peers alone, matching `PlainVersion` (O(1)) and `LoroVersion` (O(peers)). `YjsVersion` restores this invariant by reducing the delete-set component to a **128-bit FNV-1a digest** (`deleteSetDigest`, via `@sindresorhus/fnv1a`) — a fixed-size fingerprint used exclusively for equality comparison, never reconstructed from. This is the same fixed-size-fingerprint tradeoff already accepted elsewhere in `@kyneta/schema` (see `computeSchemaHash` in `packages/schema/src/hash.ts`): a digest collision would cause a genuine delete-only divergence to be misreported as `"equal"`, but at 128 bits this probability is negligible, and the alternative (unbounded growth) is a real, observed production defect.

### Backward compatibility with SV-only versions

A `YjsVersion` parsed from the legacy SV-only format has no delete-set component — its `deleteSetDigest` is computed from the state-vector bytes themselves, which is guaranteed to differ from any real snapshot's digest. When compared against a new-format version with the same SV but different deletes, the comparison yields `"concurrent"` — which causes the exchange to push an update. The push is redundant in cases where the deletes actually match, but it is always *safe*: a legacy peer receiving a push it didn't strictly need is merely bandwidth, never corruption.

### What `YjsVersion` is NOT

- **Not a bare `Uint8Array`.** It is a structured wrapper with a documented serialise/parse protocol.
- **Not a wall-clock timestamp.** Yjs versions are CRDT causal history, not physical time.
- **Not totally ordered.** Two concurrent peers can be `"concurrent"`. `compare` returns the full partial order.
- **Not interchangeable with `LoroVersion`.** They serialize differently and compare with different algorithms.
- **Not a store of the raw delete set.** `deleteSetDigest` is a one-way fingerprint — there is no way to recover the delete set from a `YjsVersion`, by design; that would defeat the whole point of bounding its size.

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

**Scope of the `clientID = 0` transaction**: only shared type containers (`Y.Text`, `Y.Map`, `Y.Array`) are created during this pass. Scalar and sum fields are *not* written with zero defaults — their default values are produced by the materializer's zero fallback on read. This keeps the structural pass minimal: it creates the CRDT containers that Yjs needs to exist, and nothing else.

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

Source: `packages/schema/backends/yjs/src/substrate.ts` → `prepare` / `afterBatch` / `runBatch`; `src/change-mapping.ts` → `applyChangeToYjs`; `src/populate.ts` → `populate`.

Yjs's natural programming model is imperative: open a `Y.transact`, mutate shared types, close. Kyneta's write path advances **both** σ (the shadow, read-visible) AND λ (the live `Y.Doc` tree, sync-visible) inside the ambient `Y.transact` opened by `runBatch`. The projection law `σ ≡ Π(λ)` (the naturality condition of `materializeYjsShadow`) holds at every prepare boundary.

```
batch(doc, d => { d.title.insert(0, "hi"); d.items.push(x) })
  │
  ├─ runBatch opens ONE Y.transact(doc, body, KYNETA_ORIGIN)
  │   (re-entrant runBatch calls nest natively — Yjs collapses them
  │   into the outermost transact; no depth counter needed)
  │
  ├─ prepare phase (per mutation, applies to both σ and λ EAGERLY):
  │    1. applyChange(shadow, path, change)        ── σ advances
  │    2. findJsonBoundary(path) ─► boundary?
  │       ├─ yes: stage the full σ snapshot at the boundary key
  │       │       in the json-boundary coalescing buffer
  │       └─ no:  applyChangeToYjs(rootMap, ...)   ── λ advances
  │
  └─ afterBatch (local writes):
       flushJsonBoundaryBuffer() — for each buffered entry:
         Y.Map parent → target.set(key, value)
         Y.Array parent → target.delete(index, 1); target.insert(index, [value])
       (runs inside the still-open Y.transact)
  │
  └─ runBatch's transact closes — Yjs fires ONE observeDeep batch
    covering all ops in the outermost logical action
```

`applyChangeToYjs` is straightforward imperative mutation: resolve the target via `resolveYjsType`, then call `Y.Text.insert` / `Y.Array.insert` / `Y.Map.set` / etc. depending on the change type.

### The json-boundary coalescing buffer

Writes targeting a path that crosses a `struct.json` / `list.json` / `record.json` boundary stage the full σ-snapshot at the boundary segment in the parent CRDT container, instead of generating per-leaf imperative mutations against nested shared types (which don't exist — the entire subtree is stored as a plain JSON value). Repeated writes inside the same subtree overwrite the buffered entry (last-write-wins by σ snapshot); `afterBatch` drains the buffer into λ inside the still-open transact via `target.set(key, value)` (Y.Map parents) or `delete+insert` (Y.Array parents).

Non-boundary writes bypass the buffer entirely and go straight to `applyChangeToYjs` during prepare — text, sequence, map, and replace changes all apply imperatively to their live targets.

### Nested-transact collapse under re-entry

Yjs's `Y.transact` natively collapses nesting: an inner `Y.transact` call inside an outer one runs as part of the outer transact and emits no separate `observeDeep` event. The substrate's `runBatch` just opens `Y.transact(work, KYNETA_ORIGIN)` without any depth counter — Yjs handles the collapse. Practical effect: a subscriber's re-entrant `batch(doc, ...)` from inside `deliverNotifications` opens a nested transact that folds into the outer one, producing a single batched `observeDeep` for the whole logical user action. External Yjs providers (y-websocket, y-webrtc) ship one binary update per outermost `batch(doc, fn)` — strictly fewer / smaller-equal updates than the pre-Phase-3 design.

`BatchOptions.origin` (the app-level provenance label) flows through the kyneta `Changeset.origin` channel only — it never reaches Yjs's transact origin, which is always `KYNETA_ORIGIN` so the event-bridge handler can recognise and skip its own writes.

### Populate-then-attach for structural inserts

Inserting a whole struct into a list or map is the one case that needs care. The naïve approach — attach an empty `Y.Map` to the parent, then set its fields — fires two `observeDeep` events (attach, then fields). That's two kyneta `Op` emissions for what logically is one structural insert.

**The populate-then-attach pattern**:

1. Create a fresh `new Y.Map()` (not yet attached to any parent).
2. Populate it: iterate the struct's fields (alphabetical over identity hashes), set entries — nested shared types as newly-created-and-populated sub-types. Scalar and sum fields are **not** written here; their `case "scalar"` / `case "sum"` branches in `ensureRootField` and `ensureMapContainers` are explicit no-ops (retained for switch exhaustiveness). Only shared type containers are created.
3. Attach the fully-populated map to the parent in one `set`/`insert` call.

One `observeDeep` event fires (the attach). `eventsToOps` expands it into the correct kyneta change at the structural boundary. Subscribers see one coherent `Op`, not two half-constructed states.

Source: `src/populate.ts` → `populate` (recursive), called from `applyChangeToYjs` for every nested structural insert.

### What the write path is NOT

- **Not asynchronous.** `Y.transact` is synchronous; the entire flush completes within one tick.
- **Not an `applyDiff`-style bulk operation.** Unlike Loro, Yjs has no single-call diff primitive. Mutations are imperative; the batching comes from `Y.transact`.
- **Reversible via in-bracket inverse compensation** (post-jj:ryquprut). The kyneta `WritableContext.runBatch` records inverses on every `substrate.prepare` and replays them inside the same `Y.transact` if `fn` throws. External `observeDeep` consumers see one batched event whose ops net to zero. The kyneta-Changeset surfaces `aborted: true` to its subscribers. Yjs's own `Y.UndoManager` is orthogonal — it observes COMMITTED transactions and applies compensating commits AFTER the fact; the kyneta inverse-compensation path happens INSIDE the same transact, producing a single batched event instead of two.

### Yjs lifecycle ordering inside the bracket

Under the eager-prepare model, `afterTransaction` fires AFTER `deliverNotifications` — `runBatch` opens the transact, the body's `ctx.flush` triggers `deliverNotifications` *inside* the transact body, and `afterTransaction` doesn't fire until the body returns. Concrete consequence: hooking `afterTransaction` for state that subscribers need at delivery time will see stale data. This is why `version()` derives the deleteSet from `doc.store` on every call rather than maintaining a separately-accumulated deleteSet via `afterTransaction` (the `accumulatedDs` accumulator and its `afterTransaction` handler were retired in jj:ryquprut — the accumulator they maintained was already unused on the version path). Useful for anyone trying to wire other Yjs-lifecycle hooks into the bracket later.

---

## The event bridge

Source: `packages/schema/backends/yjs/src/substrate.ts` → `rootMap.observeDeep(...)` handler; `src/change-mapping.ts` → `eventsToOps`.

The persistent `observeDeep` callback on the root `Y.Map` is the enforcement mechanism for the key invariant: every mutation fires the kyneta changefeed, regardless of source. Sources include:

- Local kyneta writes via `batch(doc, fn)` — suppressed by the `transaction.meta` mark.
- `exchange.merge(payload)` from remote peers — not suppressed; subscribers must see it.
- `Y.applyUpdate(doc, update)` from application code directly — not suppressed.
- Raw Yjs API writes (`doc.getMap("root").get(id).insert(0, "x")`) bypassing kyneta — not suppressed.
- Other Yjs providers (y-websocket, y-webrtc) attached to the same doc — not suppressed.

The handler:

1. If the transaction carries the `KYNETA_MARK` symbol in `transaction.meta` → skip (kyneta already notified during its own `change`).
2. Call `eventsToOps(events, schema, binding)` → pure translation from Yjs events to kyneta `Op[]`.
3. Dispatch the ops through the interpreter stack's notification pipeline.

### Own-commit discriminator via `transaction.meta`

`Y.transact` accepts an arbitrary `origin` value as its third argument. The substrate passes the user-provided `options?.origin` directly to `Y.transact`, freeing the user-facing `origin` slot for legitimate round-trips. To identify its own transactions, the substrate inscribes a unique per-substrate Symbol (`KYNETA_MARK`) into `transaction.meta` from inside the transact body.

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
1. `transaction.origin` is preserved as a transparent pass-through for `options.origin` — providers and `UndoManager.addTrackedOrigin` see the app's intent, not a kyneta sentinel.
2. External-wrap is correctly classified as own — strict improvement over the `KYNETA_ORIGIN` string design.
3. No string namespace to collide with — external code can use any string origin without triggering kyneta's bridge-skip.

### Known limitation: mixed mode

Mixing raw CRDT mutations with `batch()` calls inside the same atomic unit (a single Yjs `transact` body) is unsupported. The raw mutations will be silently absorbed into kyneta's own-commit skip and not bridged to the kyneta changefeed. To intermix, use separate transacts for raw mutations. This is a fundamental limit of commit-level discrimination.

During replay, `onFlush` re-materializes the `PlainState` shadow from the `Y.Doc` via `materializeYjsShadow`, ensuring that `ctx.reader` — which reads through `plainReader(shadow)` — is consistent with the merged Yjs state for any subscriber callbacks that fire during notification delivery. See [§The functional shadow](../../TECHNICAL.md#the-functional-shadow).

`materializeYjsShadow` itself uses the generic `createMaterializeInterpreter` from `@kyneta/schema` core with a Yjs-specific `MaterializeResolver` (created by `createYjsResolver`), rather than defining a bespoke interpreter. The resolver (~50 lines) handles only CRDT-specific value extraction (reading from `Y.Text`, `Y.Map`, `Y.Array`); the structural traversal, zero-default production for missing scalars/sums, and recursive descent are all handled by the shared core interpreter.

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
| `YjsLaws` | `src/bind-yjs.ts` | `"lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` — composition laws Yjs supports. |
| `YjsNativeMap` | `src/native-map.ts` | The `NativeMap` functor for Yjs. Unsupported kinds map to `undefined`. |
| `YjsVersion` | `src/version.ts` | `Version` over Yjs SV + a fixed-size digest of the delete set. |
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
| `src/yjs-resolve.ts` | 88 | `stepIntoYjs`; `resolveYjsType` is a thin wrapper over the core `foldPath` primitive. |
| `src/populate.ts` | 248 | `ensureContainers` (conditional structural creation) + `populate` (populate-then-attach). |
| `src/reader.ts` | 131 | `yjsReader` — reads via `resolveYjsType` + per-type extraction. |
| `src/version.ts` | 240 | `YjsVersion` (SV + delete-set digest), two-part serialisation, legacy SV-only compat. |
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