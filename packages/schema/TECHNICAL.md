# @kyneta/schema — Technical Reference

> **Package**: `@kyneta/schema`
> **Role**: The schema interpreter algebra — one recursive grammar for document structure, a reactive observation surface (`[CHANGEFEED]` on every ref, with tree-level composed changefeeds for composites), a substrate boundary that separates state management from replication, a migration system that derives stable identity from structure, and a position algebra for cursor-stable text and sequences.
> **Depends on**: `@kyneta/changefeed`
> **Depended on by**: `@kyneta/exchange`, `@kyneta/loro-schema`, `@kyneta/yjs-schema`, `@kyneta/index`, `@kyneta/react`, `@kyneta/compiler`, `@kyneta/cast`, `@kyneta/transport`
> **Canonical symbols**: `Schema`, `Schema.*` constructors, `KIND`, `LAWS`, `bind`, `BoundSchema`, `BoundReplica`, `BindingTarget`, `createBindingTarget`, `metadataOf`, `json`, `ephemeral`, `Interpret`, `Replicate`, `Defer`, `Reject`, `interpret`, `Interpreter`, `InterpreterLayer`, `createDoc`, `createDocAs`, `createRef`, `change`, `applyChanges`, `subscribe`, `subscribeNode`, `Substrate`, `SubstrateFactory`, `SubstrateCapabilities`, `beginHydration`, `HydrationHandle`, `DocMetadata`, `ReadCapability`, `supportsHash`, `mismatchForInterpretation`, `mismatchForSync`, `MetadataAxis`, `MetadataMismatch`, `Replica`, `ReplicaFactory`, `SubstratePayload`, `Version`, `SyncMode`, `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`, `requiresBidirectionalSync`, `computeSchemaHash`, `BACKING_DOC`, `Op`, `RecursiveChangefeedProtocol`, `Change`, `ChangeBase`, `TextChange`, `SequenceChange`, `MapChange`, `TreeChange`, `ReplaceChange`, `IncrementChange`, `RichTextChange`, `transformIndex`, `textInstructionsToPatches`, `Migration`, `MIGRATION_CHAIN`, `deriveIdentity`, `deriveManifest`, `deriveSchemaBinding`, `deriveTier`, `validateChain`, `Position`, `POSITION`, `PlainPosition`, `hasPosition`, `decodePlainPosition`, `Side`, `NATIVE`, `SUBSTRATE`, `NativeMap`, `unwrap`, `versionVectorMeet`, `versionVectorCompare`, `Zero`, `validate`, `tryValidate`, `SchemaValidationError`, `walkPath`, `PathWalk`, `foldPath`, `pathSchema`, `findOpaqueBoundary`, `OpaqueBoundaryHit`, `PathStepper`, `PathFoldResult`, `extendSchemaPathKey`, `materializeValue`, `MaterializedNode`, `EagerPolicy`, `containerKey`, `fieldAbsPath`, `needsContainer`, `withTracking`, `tracking`, `withReadScope`, `reportRead`, `withoutTracking`, `currentScope`, `dependencyKey`, `Dependency`, `Aspect`
> **Key invariant(s)**: The schema grammar is one recursive type with eleven node kinds; substrates declare *closed* composition-law sets via phantom `[LAWS]` brands; `bind()` enforces law compatibility at compile time. Four named binding targets (`json`, `ephemeral`, `loro`, `yjs`) each bundle a substrate factory, a `SyncMode`, and a set of allowed laws. No runtime law dispatch; no open-world subtyping; no hidden backend coupling.

The algebraic core of every document in Kyneta. You write a schema once — a tree of structural composites and CRDT leaves — and hand it to a substrate (plain JS, Loro, Yjs). The substrate stores state; the interpreter stack gives you a typed, navigable, writable reference (`Ref<S>`) over that state, with reactive observation baked in — every ref carries a `[CHANGEFEED]` that emits one `Changeset<Op>` per transaction covering own-path + descendants via `subscribeDescendants`. Migration primitives derive a content-addressed identity from the schema tree so that documents can evolve across schema versions without losing peer-to-peer identity.

Imported by every other Kyneta package that touches documents: the CRDT backends to implement `Substrate<V>`, the exchange to sync `SubstratePayload` blobs, the index to build live views, react to bind refs into hooks, compiler/cast to detect reactive references at compile time.

---

## Questions this document answers

- What is a `Schema` and how does it relate to TypeScript types? → [The grammar](#the-grammar)
- Why are `text`, `counter`, `set`, `tree`, `movable` first-class and not annotations? → [First-class CRDT types](#first-class-crdt-types)
- What does a `Substrate` do that a `Replica` does not? → [The substrate / replica split](#the-substrate--replica-split)
- What is `bind()` enforcing at compile time? → [Binding a schema to a substrate](#binding-a-schema-to-a-substrate)
- What is the six-layer interpreter stack? → [The interpreter stack](#the-interpreter-stack)
- How does `batch(ref, fn)` end up as a wire `offer`? → [The write path](#the-write-path)
- What is a `Position` and why can't I just use an integer index? → [Position algebra](#position-algebra)
- How do migrations keep a document's identity stable across schema changes? → [Migration and identity](#migration-and-identity)
- How does the exchange decide whether two peers' docs are compatible? → [`schemaHash` and compatibility](#schemahash-and-compatibility)
- What is the `CHANGEFEED` surface over a composite ref? → [Tree-observable changefeeds](#tree-observable-changefeeds)

---

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Schema` | The recursive union type `ScalarSchema \| ProductSchema \| SequenceSchema \| MapSchema \| SumSchema \| TextSchema \| CounterSchema \| SetSchema \| TreeSchema \| MovableSequenceSchema \| RichTextSchema`. Every node carries `[KIND]` and `[LAWS]` phantom brands. | A JSON Schema, a TypeScript type, a Zod schema — this is an interpreter *grammar*, not a validator |
| `Schema.*` constructors | `Schema.struct`, `Schema.list`, `Schema.record`, `Schema.string`, `Schema.number`, `Schema.boolean`, `Schema.union`, `Schema.discriminatedUnion`, `Schema.text`, `Schema.counter`, `Schema.set`, `Schema.tree`, `Schema.movableList`, `Schema.richText`, plus low-level `Schema.scalar`, `Schema.product`, `Schema.sequence`, `Schema.map`, `Schema.sum`. Fluent `.nullable()` is available on all plain schema types. | Any per-backend namespace — the `Schema.*` constructors are backend-agnostic |
| `[KIND]` | `Symbol("kyneta:kind")` — runtime discriminant on every schema node. Narrows in TypeScript via structural matching. | A string tag, a class `instanceof` check |
| `[LAWS]` | `Symbol("kyneta:laws")` — phantom type-level composition-law accumulator. Never populated at runtime. Tags are algebraic properties of the merge semantics: `"lww"`, `"additive"`, `"positional-ot"`, `"positional-ot-move"`, `"tree-move"`, `"lww-per-key"`, `"lww-tag-replaced"`, `"add-wins-per-key"`. | A capability flag on the runtime object |
| `PlainSchema` | The subset of `Schema` that excludes all CRDT kinds (`text`, `counter`, `set`, `tree`, `movable`, `richtext`). Used where a plain-JSON substrate is the only option (inside `.json()`, sum variants). | `Schema` — `PlainSchema ⊂ Schema` |
| `Substrate<V>` | State-management + transfer interface: `version()`, `exportEntirety()`, `exportSince(since?)`, `merge(payload, options?)`, `context()`, plus `reader()`, `writable()`, `prepare()`. `V` is the substrate's version type (Lamport vector, Loro version, wall clock, …). | A database, a backend — this is an *interface* the backends implement |
| `Replica<V>` | The replication surface *alone* — `version`, `exportEntirety`, `exportSince`, `merge`. No schema knowledge. | `Substrate<V>`, which adds `reader`, `writable`, `prepare`, and schema awareness |
| `ReplicaFactory<V>` / `SubstrateFactory<V>` | Constructors for replicas / substrates. Every `SubstrateFactory` exposes a `replica` accessor yielding a `ReplicaFactory`. | A runtime singleton — factories are reusable and stateless |
| `BindingTarget<AllowedLaws, N>` | A fixed `(substrate factory, sync mode, allowed laws)` bundle. Named targets: `json` (authoritative, all laws), `ephemeral` (LWW-family only), `loro` (CRDT laws), `yjs` (Yjs-supported laws). Each exposes `.bind(schema)` → `BoundSchema` and `.replica()` → `BoundReplica`. | `SubstrateFactory` — the target *wraps* a factory; it is not one |
| `BoundSchema<S>` | The triple `(schema, factory, syncMode)` captured at module scope via `target.bind(schema)`. The static declaration of a document type. | A runtime instance — `BoundSchema` is a value describing *how* to make one |
| `BoundReplica<V>` | `BoundSchema` minus the schema — used by replication conduits that persist state without reading it. | `BoundSchema` |
| `Interpret` / `Replicate` / `Defer` / `Reject` | The four variants of an exchange `resolve` callback outcome. Return values from application-level logic that decides how to handle an unknown doc. | Handlers, error types — these are discriminated-union constructors |
| `Interpreter<Ctx, A>` | The F-algebra: one method per `[KIND]` value, collapsing a schema tree into a value of type `A`. | A parser, a visitor, a validator alone |
| `InterpreterLayer` | A typed transformer from one interpreter to another (e.g. `withReadable` transforms `Interpreter<Ctx, R>` into `Interpreter<Ctx, R & Readable>`). | A middleware — layers compose statically via `.with()` |
| `Ref<S>` | The developer-facing handle: callable, navigable, readable, writable, observable. The result of `interpret(schema, ctx)...done()`. | A React ref, a DOM ref — this is a substrate-backed document reference |
| `Change` | The universal currency of change — discriminated union with `type` (`"text" \| "sequence" \| "map" \| "tree" \| "replace" \| "increment" \| "richtext" \| "set-op"`, and extensible). Flows both inbound (intent) and outbound (notification). | A diff, a patch — `Change` is applied atomically by the substrate |
| `SubstratePayload` | `{ kind: "entirety" \| "since", encoding: "json" \| "binary", data: string \| Uint8Array }` — opaque state carrier. Produced by the substrate, carried by the exchange. | A `ChannelMsg` — payloads ride *inside* `offer` messages |

| `SyncMode` | Structured record decomposing sync semantics into two orthogonal axes: `WriterModel` (`"serialized"` / `"concurrent"`) and `Durability` (`"persistent"` / `"transient"`). Three constants: `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`. `requiresBidirectionalSync(mode)` is `writerModel === "concurrent"`. `durability: "transient"` is a commitment the exchange enforces — such a document is never read from, written to, or deleted from a store. | A string enum, a CRDT algorithm |
| σ / λ / Π | The three names the write path and the substrates share. **σ** is the *shadow*: a plain JS object the Reader closes over, where every `ref[CALL]` read bottoms out. **λ** is the *native container tree* — `LoroDoc` and its containers, `Y.Doc` and its shared types; for the plain substrate λ ≡ σ. **Π** is the *materialisation*: the one-pass catamorphism that produces σ from λ. The projection law `σ ≡ Π(λ)` holds at every prepare boundary. | Greek letters as decoration — each names a specific object the code holds |
| `NativeMap<S>` | Type-level functor mapping each schema kind to its substrate-native type (e.g. Loro's `LoroText`, Yjs's `Y.Text`, plain JS `string`). | A runtime `Map<K,V>` |
| `NATIVE` / `SUBSTRATE` / `BACKING_DOC` | Symbol-keyed accessors for the underlying native container, the substrate instance, and the backing document object. | User-facing APIs — these are escape hatches |
| `Position` | Substrate-mediated stable reference to a location within text or a sequence. Survives concurrent edits. | A numeric index, a character position |
| `POSITION` | Capability symbol: `hasPosition(ref)` returns true when the substrate supports positions for this ref. | The `Position` interface |
| `Migration` | The namespace of 14 migration primitives (`renameField`, `dropField`, `extractField`, `mergeFields`, `splitField`, `transformField`, `setDefault`, `addField`, `wrapField`, `unwrapField`, `promoteField`, `demoteField`, `epoch`, `identity`) organized into four tiers. | A database migration — this is a pure algebraic operation on schema + data |
| `MIGRATION_CHAIN` | Symbol-keyed slot on a `ProductSchema` carrying its `MigrationChain` (sequence of migration steps + epochs). Invisible to `JSON.stringify` / `Object.keys`. | The chain's content — the symbol is just the slot |
| `SchemaBinding` | `{ forward: Map<string, NodeIdentity>, inverse: Map<NodeIdentity, string> }` — the identity map from human-facing field names to content-addressed identity hashes for one schema snapshot. | Schema validation rules |
| `Op` | The expanded-to-leaves notification emitted by the composed changefeed. `{ path, change }`. | `Change` alone — `Op` adds the path |

---

## Architecture

**Thesis**: one recursive grammar for structure, one composition-law phantom for compile-time safety, one substrate interface for state, one interpreter algebra for capabilities, one change vocabulary for updates. Everything else — backends, transports, reactive bindings, compilers — lives above this surface.

Five orthogonal sub-systems:

| Sub-system | Source file | Role |
|-----------|-------------|------|
| Grammar | `src/schema.ts` | The recursive `Schema` type and its constructors. |
| Binding | `src/bind.ts` | `BoundSchema`, `BindingTarget`, `createBindingTarget`, `json`, `ephemeral`, `bind()`, law enforcement. |
| Interpretation | `src/interpret.ts`, `src/interpreters/*`, `src/layers.ts`, `src/ref.ts` | The six-layer interpreter stack. |
| Substrate | `src/substrate.ts`, `src/substrates/*` | The state / replication interface. |
| Migration | `src/migration.ts`, `src/hash.ts` | Identity derivation and schema evolution. |

Plus three cross-cutting facilities:

- **Change** (`src/change.ts`, `src/step.ts`, `src/facade/batch.ts`) — the universal delta vocabulary and `batch(ref, fn)` transaction facade.
- **Position** (`src/position.ts`) — cursor-stable references inside text and sequences.
- **Observation** (`src/changefeed.ts`, `src/interpreters/with-changefeed.ts`, `src/facade/observe.ts`) — the composed changefeed layer over refs.

### What a `Schema` is NOT

- **Not a JSON Schema.** JSON Schema describes *valid* JSON; `Schema` describes the *structure and capabilities* of a document that is not necessarily JSON. A `Schema.text()` node is not a string — it is a live CRDT with its own change vocabulary.
- **Not a TypeScript type.** `Schema` values are runtime values. TypeScript types are derived *from* schemas via `Plain<S>`, `Ref<S>`, `Op<S>`, not the other way around.
- **Not a validator.** `validate(schema, value)` exists (`src/interpreters/validate.ts`), but validation is one *interpretation* of the schema, not its identity. The same schema drives validation, reading, writing, observation, and migration.
- **Not extensible at the grammar layer.** Users compose schemas; they do not add new `[KIND]` values. Extending the grammar requires a new `[KIND]`, a new interpreter case, and substrate support — a Kyneta-level change.

### What a `Substrate` is NOT

- **Not a database.** It is an interface. Plain JS objects, Loro CRDTs, and Yjs docs all satisfy it.
- **Not a backend in the framework sense.** No framework choices leak through the substrate boundary — there is no "Loro mode" that propagates upward. The interpreter stack treats every substrate identically.
- **Not responsible for sync.** The substrate produces and consumes `SubstratePayload`. The exchange owns *when* and *to whom* to send it.
- **Not symmetric across sync modes.** A collaborative substrate (Loro, Yjs) has concurrent versions (`SYNC_COLLABORATIVE`); an authoritative substrate (json) has a total order (`SYNC_AUTHORITATIVE`); an ephemeral substrate has wall-clock-timestamped per-field registers and no total order at all (`SYNC_EPHEMERAL`). The `SyncMode` — decomposed into `WriterModel`, `Delivery`, and `Durability` axes — tells the exchange which mode shape to run. `requiresBidirectionalSync(mode)` is the predicate the exchange uses to decide whether to establish a bidirectional causal exchange or a unidirectional push.

  The ephemeral case carries no peer identity at all. `StateVersion` is `(incarnation, installSeq)` — a marker for one replica *instance* and its own intake count, not a per-peer vector, and the binding target hands back a shared `ephemeralSubstrateFactory` rather than constructing one per peer, so the exchange's `peerId` never reaches it. It can afford that because it merges field by field and never orders two writes by their author. This is also why nothing about a transient document's continuity depends on storage — there is no identity for a store to preserve. If a per-peer identity is ever added there, see the note on `StateVersion` (`src/substrates/ephemeral.ts`) for why it must be derived from the exchange's stable `peerId` rather than minted per session.
- **Not a monolithic capability provider.** Producer-side capability attachment uses a typed bag (`SubstrateCapabilities`); consumer-side capability discovery uses optional fields on `RefContext` plus the `HasTreeNodeAllocation` marker interface. The asymmetry is deliberate — substrates declare what they have; consumers ask only when they need it.

---

## The grammar

Source: `packages/schema/src/schema.ts`. The recursive type `Schema` has eleven cases distinguished by `[KIND]`:

| `[KIND]` | Constructor | Category | Children | Role |
|----------|-------------|----------|----------|------|
| `scalar` | `scalar(kind, constraint?)` | Structural leaf | — | Leaf values (string, number, boolean, null, bytes, any) |
| `product` | `product(fields)` | Structural composite | `Record<string, () => Schema>` | Fixed-key record (struct) |
| `sequence` | `sequence(item)` | Structural composite | `() => Schema` | Ordered list with plain array semantics |
| `map` | `map(item)` | Structural composite | `() => Schema` | Dynamic-key record |
| `sum` | `sum(variants)` | Structural composite | `SumVariants` | Tagged or positional union |
| `text` | `text()` | CRDT | — | Character-level collaborative text |
| `counter` | `counter()` | CRDT | — | Additive counter |
| `set` | `set(item)` | CRDT | `() => Schema` | Add-wins unordered collection |
| `tree` | `tree(item)` | CRDT | `() => Schema` | Hierarchical forest with move operations; each node carries `item`-typed data |
| `movable` | `movableList(item)` | CRDT | `() => Schema` | Ordered collection with move operations |
| `richtext` | `richText(marks)` | CRDT | — | Collaborative rich text with formatting marks |

Five structural kinds describe composition. Six CRDT kinds are first-class leaves or composites that carry merge semantics.

`Schema.*` also exposes ergonomic aliases: `Schema.struct(fields)` = `product`, `Schema.list(item)` = `sequence`, `Schema.record(item)` = `map`, `Schema.string()` / `Schema.number()` / `Schema.boolean()` wrap `scalar`, `Schema.union` / `Schema.discriminatedUnion` wrap `sum`. Fluent `.nullable()` is available on all plain schema types: `Schema.string().nullable()` produces a positional sum `[null, string]`. Not available on CRDT types (text, counter, set, tree, movableList, richText). See `src/schema.ts` for the full list.

### First-class CRDT types

Why `text`, `counter`, `set`, `tree`, `movable`, `richtext` are grammar nodes rather than annotations on structural types:

- Their **change vocabulary** differs. A `sequence` has `SequenceChange` (retain / insert / delete of items); a `movable` has that *plus* move operations.
- Their **composition-law requirements** differ. A `text` node carries the `"positional-ot"` law; a `counter` carries `"additive"`; a plain JSON substrate only satisfies `"lww"`. Encoding this as a phantom `[LAWS]` tag on the grammar means the type system catches incompatibilities at `bind()`, not at runtime.
- Their **identity semantics** differ. Two concurrent insertions into a `sequence` are ordered arbitrarily; two concurrent insertions into a `movable` carry identity-bearing positions.
- Rich text has the same positional algebra as text but extends the instruction stream with `format` — a cursor instruction that annotates characters with marks.
- `tree` carries a per-item `data: I` slot — the schema-level "data" that hangs off each tree node. Each substrate stores that slot in its own way: the plain substrate keeps it as a property on the flat-forest entry, and the Loro substrate stores it in the node's `.data` `LoroMap` (so per-node field writes dispatch as ordinary map navigation). The `TreeChange { create, delete, move }` vocabulary is uniform across substrates; the per-item storage strategy is a substrate detail.

Each CRDT kind contributes to the `[LAWS]` phantom of every ancestor node. A `Schema.struct({ body: Schema.text() })` has `"positional-ot"` in its `[LAWS]` accumulator even though `struct` itself is structural. The tags are algebraic properties (`"lww"`, `"additive"`, `"positional-ot"`, `"positional-ot-move"`, `"tree-move"`, `"lww-per-key"`, `"lww-tag-replaced"`, `"add-wins-per-key"`), not kind names.

### Set: value-addressed leaf

`Schema.set(item)` is structurally distinct from `Schema.record(item)`. Where map is a key→value relation (`Record<string, V>` at the user surface), set is an unordered uniqued bag of values:

- **`Plain<SetSchema<I>>` is `Plain<I>[]`.** The user-facing shape is an array, not a keyed record. Storage on the plain substrate is also `T[]`; `materialize.set` projects CRDT-backed storage to `T[]` for shadow construction.
- **Change vocabulary is `SetChange { add, remove }`** — value-addressed, not key-addressed. Distinct from `MapChange { set, delete, clear }`. On overlap (an item appears in both `add` and `remove`), **remove-wins** (mirrors `stepMap`'s asymmetric set-wins-on-set-then-delete).
- **`stepSet` is total over arbitrary input** and produces normalized output: no duplicates (via `samePlainValue`), stable order (existing members retain relative position; new adds appended in `add[]` order). The `setOpChange(add?, remove?)` constructor is a thin passthrough — the invariant lives at the operation boundary, not the constructor.
- **`SetRef` is leaf-shaped at the ref layer.** The interface is `.has(value)`, `.add(value)`, `.delete(value)`, `.clear()`, `.size`, `[Symbol.iterator]` over plain values, and a callable returning `T[]`. **No `.at(value)` and no per-member child refs** — sets have no addressable positions, and writing through a member ref would silently violate the set's uniqueness invariant.
- **Membership is content-equal** (via `samePlainValue` in `guards.ts`) — single source of truth shared by `stepSet`, `validate`, and `SetRef.has(value)`. `Schema.set(Schema.struct({...}))` correctly recognises structurally-equal object members as duplicates; native JS `Set` (which uses identity equality for objects) is *not* used because it can't fulfil this contract.
- **Native JS `Set<T>` is not the plain shape.** Three concrete reasons: (1) `JSON.stringify(new Set([1,2,3])) === "{}"` breaks the plain substrate's export/merge; (2) `new Set([1,2]) !== new Set([1,2])` — referential inequality breaks structural test comparisons and identity-based caching; (3) `Set.prototype.has` uses identity equality for objects. `SetRef` provides native-Set-like *ergonomics* at the ref boundary; storage stays JSON-compatible `T[]`.
- **Currently plain-substrate-only.** Both `LoroLaws` and `YjsLaws` exclude `"add-wins-per-key"`, so `loro.bind(schema)` / `yjs.bind(schema)` reject any set-bearing schema at compile time. The `case "set-op"` branches in the Loro/Yjs change-mapping modules are intentionally unreachable today — they throw a clear "not supported" error and are kept against the new `SetChange` vocabulary in case the law restriction is dropped in the future.

### `PlainSchema`: the no-CRDT subset

`PlainSchema` is `Schema` restricted to structural kinds. It appears in two places:

1. **`.json()` modifier.** `Schema.struct({...}).json()` marks a product as a plain-JSON merge boundary — the entire subtree is replaced atomically on write, not composed CRDT-style. Inside `.json()`, only `PlainSchema` is permitted. The boundary is part of the schema's identity: `computeSchemaHash` emits it as a `["j", …]` tag, so `struct` and `struct.json` of the same fields hash differently (they materialize differently — nested CRDT containers vs. one opaque JSON value).
2. **Sum variants.** Variants of a `sum` must all be `PlainSchema` because discriminated-union semantics are structural — a union of CRDTs would require merging *across* variants, which is not well-defined.

### Composition-law enforcement

```
type ExtractLaws<S> = /* walk S, collect every node's [LAWS] */
type RestrictLaws<S, AllowedLaws> = ExtractLaws<S> extends AllowedLaws ? S : never
```

Each binding target declares its closed law set:

| Target | Laws | Algebraic meaning |
|--------|------|-------------------|
| `json` | `AllowedLaws = string` (all) | Authoritative — any law is fine because writes are serialized. |
| `ephemeral` | `EphemeralLaws = "lww" \| "lww-per-key" \| "lww-tag-replaced"` | Field-level LWW map (CvRDT) — concurrent merge for presence state. |
| `loro` | `LoroLaws = "lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"` | Full CRDT law set minus `"add-wins-per-key"`. |
| `yjs` | `YjsLaws = "lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` | Text and structural laws — no `"additive"`, `"positional-ot-move"`, `"tree-move"`, `"add-wins-per-key"`. |

`target.bind(schema)` applies `RestrictLaws<S, AllowedLaws>` at the type level. A schema with `"additive"` in its `[LAWS]` (from `Schema.counter()`) cannot be bound to the `yjs` target — the compiler refuses.

No runtime dispatch, no substrate-specific error messages. The type system is the enforcement mechanism, and `[LAWS]` is a phantom brand — reading it at runtime is a bug.

The `ephemeral` substrate carries a runtime counterpart anyway, and the reason is worth knowing before adding one elsewhere. A caller holding an `any`, or one writing JavaScript, reaches a substrate without ever meeting `tsc`. Behind that guard, a change the `StateTree` could not record used to be dropped in silence. The counterpart asks a different question from a different table — what this substrate's storage can hold, read off `node[KIND]` rather than `[LAWS]` — so the two can drift, and `bind-constraints-ephemeral.test.ts` §4 pins them against each other as data.

Each row of that table has an executable form. `packages/schema/backends/loro` and `.../yjs` carry a `bind-constraints` suite for their own law sets, and `src/__tests__/bind-constraints-ephemeral.test.ts` covers `ephemeral` — accepted shapes as ordinary assertions, rejected ones under `@ts-expect-error`, where **`tsc` is the assertion rather than the test runner**: a directive that stops suppressing an error becomes unused and fails the build. Without those suites the contract holds only by review, which is how a defect against this target once came to be filed against behaviour the compiler had already ruled out.

### What the grammar is NOT

- **Not closed.** `sum` variants are open (you can add more) and `product` fields are open (you can nest arbitrary schemas). The eleven *kinds* are closed; user composition is not.
- **Not validated at construction**, but **finite, eager, and acyclic by typing.** Product fields are eager `Schema` values — there is no lazy/thunk field variant and no `lazy`/`recursive` constructor — so a cyclic schema *graph* cannot be built through the typed API (`struct({ next: () => self })` does not typecheck). Recursive/hierarchical *data* is modeled via `Schema.tree(item)`, whose schema is finite. `canonicalizeSchema` relies on this precondition; an `as any`-forced cycle is the only way to violate it, and it is caught by a depth cap that throws a clear error (not an opaque stack overflow).
- **Not self-describing at runtime.** `[KIND]` is the only tag. Fields, variants, etc. are discovered structurally. Never `Object.keys(schema)` to enumerate its kind — pattern-match on `[KIND]`.

---

## Binding a schema to a substrate

Source: `packages/schema/src/bind.ts`.

### The four binding targets

Kyneta exports four pre-configured binding targets:

| Target | Package | `syncMode` | Allowed Laws | Mechanism |
|--------|--------|----------------|--------------|-----------|
| `json` | `@kyneta/schema` | `SYNC_AUTHORITATIVE` | all (`string`) | Plain JS objects, Lamport version |
| `ephemeral` | `@kyneta/schema` | `SYNC_EPHEMERAL` | `EphemeralLaws` (`"lww"`, `"lww-per-key"`, `"lww-tag-replaced"`) | State-based CRDT, wall-clock version, field-level merge (`sum`/`.json()` stored as atomic registers) |
| `loro` | `@kyneta/loro-schema` | `SYNC_COLLABORATIVE` | `LoroLaws` (full CRDT set minus `"add-wins-per-key"`) | Loro CRDT doc |
| `yjs` | `@kyneta/yjs-schema` | `SYNC_COLLABORATIVE` | `YjsLaws` (text + structural laws) | Yjs doc |

`ephemeral` is the one target whose substrate this document describes in
full — see [The ephemeral substrate](#the-ephemeral-substrate). `json` is
[the plain substrate](#the-plain-substrate); `loro` and `yjs` have their own
documents.

Usage:

```
import { json, ephemeral, Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import { yjs } from "@kyneta/yjs-schema"

const Config = json.bind(Schema.struct({ theme: Schema.string() }))
const Cursor = ephemeral.bind(Schema.struct({ x: Schema.number(), y: Schema.number() }))
const MeshPresence = ephemeral.bind(Schema.struct({ alice: Schema.string(), bob: Schema.string() }))
const Todo = loro.bind(Schema.struct({ title: Schema.text(), done: Schema.boolean() }))
const Note = yjs.bind(Schema.struct({ body: Schema.text() }))
```

No strategy parameter — the sync mode is fixed per target.

### Low-level `bind()`

`bind({ schema, factory, syncMode })` returns a `BoundSchema<S>`. It captures three decisions at module scope:

1. **Which schema** — the recursive `Schema` value.
2. **Which factory builder** — `(context: { peerId, binding }) => SubstrateFactory<V>`. The builder receives the peer's identity and the schema binding; this is how a fresh factory instance is produced per exchange.
3. **Which sync mode** — a `SyncMode` value (one of `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`, or a custom record).

The result is a static value: `const Todo = loro.bind(schema)`. The exchange consumes it as `exchange.get(docId, Todo)`.

```
type BoundSchema<S extends Schema> = {
  schema: S
  factory: FactoryBuilder<V>
  syncMode: SyncMode
  manifest: IdentityManifest
  schemaHash: string
}
```

The `manifest` is derived eagerly by `deriveManifest(schema)` — a pure function over the canonicalized schema tree. The `schemaHash` is `computeSchemaHash(manifest)`. Both are cached on the `BoundSchema` value.

### `createBindingTarget` — building custom targets

```
export function createBindingTarget<AllowedLaws, N>(config: {
  factory: FactoryBuilder<any>
  replicaFactory: ReplicaFactory
  syncMode: SyncMode
}): BindingTarget<AllowedLaws, N>
```

Custom substrate authors use `createBindingTarget` to build their own targets. The built-in `json`, `ephemeral`, `loro`, and `yjs` are all constructed this way.

### What `bind` is NOT

- **Not lazy.** Both `manifest` and `schemaHash` are computed on construction. Binding at module scope does the work once at import time.
- **Not runtime-variable.** The schema, factory, and sync mode are all captured as values; `BoundSchema` has no runtime parameters.
- **Not magic.** `bind` validates the migration chain (if any) via `validateChain`, derives the binding, and stores the fields. No side effects on the schema or the factory.

### `BoundReplica<V>`: replication-only binding

A pure replication conduit (a routing server, a CDN edge, a store-only peer) does not need to interpret document state. It only needs to receive, persist, and re-emit payloads. `BoundReplica<V>` is `BoundSchema<S>` minus the schema — it carries the replica factory, sync mode, and schema hash, but not the grammar itself.

This is the three-tier participation model:

| Tier | Interface | Typical role |
|------|-----------|--------------|
| Opaque conduit | None beyond `SubstratePayload` | Object store, relay |
| Replication conduit | `BoundReplica<V>` + `ReplicaFactory<V>` | Sync server, durability layer |
| Full interpreter | `BoundSchema<S>` + `SubstrateFactory<V>` | Any participant that reads, writes, or observes state |

---

## The substrate / replica split

Source: `packages/schema/src/substrate.ts`.

Three interfaces, connected by the variance-safe `-Like` convention:

```
interface ReplicaLike {
  version(): Version
  baseVersion(): Version
  exportEntirety(): SubstratePayload
  exportSince(since: Version): SubstratePayload | null
  advance(to: Version): void
  merge(payload: SubstratePayload, options?: MergeOptions): void
  resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void
}

interface Replica<V> extends ReplicaLike {
  version(): V
  baseVersion(): V
  // exportSince, advance, merge inherited from ReplicaLike
}

interface SubstratePrepare {
  readonly reader: Reader
  prepare(path: Path, change: ChangeBase, recordInverse: RecordInverseFn | null): void
  afterBatch(): void
  runBatch?(work: () => void, options: CommitOptions): void
}

interface Substrate<V> extends Replica<V>, SubstratePrepare {
  context(): WritableContext
  tick?(now: number): void
}
```

**`ReplicaLike`** is the minimal replication contract — what the synchronizer needs. All version-typed positions use the base `Version` type so the synchronizer can hold heterogeneous replicas in a single `Map` without variance escapes. Named after the TypeScript `-Like` convention (`PromiseLike`, `ArrayLike`): a structural interface that the full `Replica<V>` satisfies.

**`Replica<V>`** extends `ReplicaLike` with concrete version types. External consumers (binding targets, factories) use this for compile-time version-type safety on return values (`version(): V`, `baseVersion(): V`). Input methods (`exportSince`, `advance`) inherit the wider `Version` parameter type from `ReplicaLike`.

**`ReplicaFactoryLike`** / **`ReplicaFactory<V>`** follow the same pattern: a variance-safe structural interface and a narrow extension with concrete return types. A factory declares its format's `replicaType` and whether the format is `historyFree`: its state carries its whole meaning, so there is nothing to trim (the ephemeral CvRDT). That is a property of the format, shared by every replica of a document; whether one replica can `advance` is not (a live Loro substrate cannot, a relay's Loro replica can). The exchange uses it to skip `accept` and to exclude such documents from the compaction-reset trigger.

The split exists because TypeScript treats generics as invariant: `Replica<LoroVersion>` is NOT assignable to `Replica<Version>`, even though `LoroVersion extends Version`. The `-Like` interfaces solve this by using `Version` in all positions, making them assignable from any concrete `Replica<V>`.

Every replica exposes six methods:

- `version()` → the current state's version.
- `baseVersion()` → the earliest version retained (trimmed history starts here).
- `exportEntirety()` → full state as an opaque payload.
- `exportSince(since)` → delta relative to the given version, or `null` when the cursor **cannot be served** (history trimmed past it, or an epoch this replica did not mint). `null` is not "nothing to send": the caller answers it with a whole document, so a peer that is merely current must get an empty delta instead. Conflating the two makes every agreement cost a full resend.
- `advance(to)` → trim history as far as possible without passing `to`; a `to` the base has already passed, or one the replica cannot place, trims nothing.
- `merge(payload, options?)` → fold an incoming payload into local state. Whether it was taken in is whether the replica's version now reaches the version the payload was offered at (`reaches(version(), offered)`): a plain delta that does not continue the log is refused and applies nothing, and a CRDT holds back ops whose dependencies are missing, so both leave the version short. A full substrate then brings σ up to date and announces the ops (see [The functional shadow](#the-functional-shadow)); subscribers receive them with `replay: true`, so layered consumers (e.g. the exchange's echo filter) can discriminate the merge from a local write. `options.origin` propagates as an app-level label. `MergeOptions` has no `source`: an echo token names a local caller and never survives a merge.

A `Substrate` adds interpretation:

- `reader` → plain reads by path, over σ.
- `prepare` / `afterBatch` / `runBatch` → the mutation primitives the `WritableContext` is built over. They see only local writes and their compensations.
- `context()` → the `WritableContext` the interpreter stack closes over.
- `tick(now)` → optional heartbeat for time-based projections (ephemeral decay).

### The `SubstratePrepare` pipeline

The substrate boundary knows nothing about provenance: `prepare`, `afterBatch` and `runBatch` are called only for local writes and their compensations. Mutations apply eagerly per the σ-eager design. For each `prepare(path, change, recordInverse)`:

1. If `recordInverse` is present (a forward write), read `pre = path.read(σ)`, compute `inverse = invert(pre, change)` — the reverse arrow in the change groupoid — and record it on the active runBatch frame's inverse stack.
2. Advance σ via `applyChange(shadow, path, change)`.
3. Advance λ via the substrate-native path (Loro: applyDiff or coalescing buffer; Yjs: applyChangeToYjs inside the ambient transact).

The inverse stack belongs to the bracket primitive (`WritableContext.runBatch`'s wrapper). On the bracket's depth-0 success release, the frame's inverse range is discarded, `afterBatch` runs, and the batch is sealed. On a throw, the catch path replays the frame's inverses LIFO through `ctx.prepare(path, inverse, { ingress: "compensate" })`, which reaches the substrate with `recordInverse === null`, then seals the batch with `aborted: true`, then rethrows. The bracket's commit contains forward + inverse ops with net-zero delta when the outermost throws.

This is how `batch(doc, d => { d.title.insert(0, "hi"); d.items.push(x); })` becomes one atomic changefeed emission with read-your-writes inside the block, and how a throwing block becomes one batched native event with net-zero delta plus one `Changeset` with `aborted: true`.

### Path resolution and sum boundaries

`resolveContainer` in substrate backends (e.g. `loro-resolve.ts`) handles opaque boundaries by switching to plain JS property navigation for the remaining path segments. This is sound because neither boundary kind can contain a CRDT container: sum variants are always `PlainSchema`, and a `.json()` subtree is one inert blob. The Yjs backend's `resolveYjsType` follows the same pattern.

Both get this for free from `walkPath`, which reports a `boundary` stop rather than letting the descent run on into the sum. `stepSchema` still has an answer for a path that steps *through* a sum — it reports a `mismatch` reading "cannot advance through a sum" — and that answer is still correct, because a sum resolves by inspecting the value rather than by reading the next path segment. It is simply unreachable from any traversal, since every traversal honours the boundary first.

### Version vector algebra

Source: `packages/schema/src/version-vector.ts`.

For substrates whose `V` is a map of `PeerId → number` (Lamport-style vectors), two helpers are provided:

- `versionVectorMeet(a, b)` → the greatest lower bound. Component-wise minimum.
- `versionVectorJoin(a, b)` → the least upper bound. Component-wise maximum.
- `versionVectorCompare(a, b)` → `"behind" | "equal" | "ahead" | "concurrent"`. Determines whether one version strictly precedes the other, equals it, or is concurrent.

All are pure. Loro and Yjs versions use them over their native vectors, through one private pair of projections each (to and from the vector), so `compare`, `meet` and `join` agree by construction.

**`Version` is a lattice.** `meet` and `join` are commutative, associative and idempotent, bound their arguments from below and above, and absorb each other; `versionConformance` (`@kyneta/schema/testing`) checks the laws for any version type against samples of its own. `join` is defined within one lineage: a plain replica holds one, so two real lineages have no join and `PlainVersion.join` throws, and `StateVersion`'s counters from two incarnations have none either. **`reaches(ours, theirs)`** — `ours` ahead of or equal to `theirs` — is the one test of holding a version: whether an offer was taken in, and whether a stored delta loaded. It never reads a digest, which can answer only "equal".

`PlainVersion` (the plain substrate's version, below) **is** a version vector — a single authored *lineage* entry `{lineage: value}`, with genesis (`DEFAULT_LINEAGE`) projecting to the **empty** vector ⊥. Its `compare`/`meet` delegate to `versionVectorCompare`/`versionVectorMeet` over that projection (`PlainVersion.#toVector`) — the same lattice Loro/Yjs use, with no Plain-specific case matrix. `Version.lineage` is the version-vector *lineage key* (the writer/identity coordinate), not a scalar bolted on beside the counter. A serialized writer holds at most one authored lineage at a time (prune-on-reset), so the vector is single-entry.

`Version.lineage` (formerly `Version.epoch`) is the identity coordinate on every `Version`: for `PlainVersion` a REAL lineage minted on the first authored write (genesis ⊥ before that); for Loro/Yjs/StateVersion a constant `DEFAULT_LINEAGE` (their identity lives in their own native vectors). The lattice operations never branch on the raw string — `PlainVersion` projects it to a vector and `versionVectorCompare` does the rest; genuine cross-lineage divergence surfaces as `"concurrent"`. **The word `epoch` is now reserved for the deliberate T3 _migration_ boundary** (`.epoch()` / `EpochStep` / `MigrationTier` T3 — see [Migration and identity](#migration-and-identity)): *lineage* (writer identity, per-VV-key, minted automatically) and *epoch* (migration generation, global, developer-declared) are now distinct axes with distinct names.

---

## The plain substrate

Source: `packages/schema/src/substrates/plain.ts`.

The built-in substrate. Stores state as plain JS objects, tracks a monotonic integer version scoped to an lineage (see `PlainVersion` below), and merges by total-order last-writer-wins within an lineage. Used for:

- The default binding when no CRDT is needed (`Schema.string`, small configs, ephemeral UI state).
- Reference implementation for testing the `Substrate<V>` contract.

All substrates now share the same read semantics: reads go through `plainReader` backed by a `PlainState` object. For the plain substrate this is trivially the substrate's own state. For CRDT substrates (Loro, Yjs), the `PlainState` is a shadow that is kept in sync — eagerly on local writes, re-materialized from the CRDT doc before every announcement. See [§The functional shadow](#the-functional-shadow).

**A plain substrate is its replica's core plus σ and a changefeed.** The core (`createPlainCore`) holds the base offset, the op log retained after it, and a `PlainClock`. `buildUpgrade` seeds the substrate from the replica's materialized state and its history, so `create` (`upgrade(createReplica())`), `fromEntirety` (`upgrade(replica.fromEntirety(payload))`) and promotion of a replicate document all keep the replica's version and log. Nothing restarts history.

Key functions (in `src/substrates/plain.ts`):

- `plainSubstrateFactory` / `plainReplicaFactory` — the public construction surface. `plainContext(doc)` is a test shorthand.
- `createPlainClock(lineage)` → `PlainClock`: the lineage, `adopt` (its only mutator), and the flush-count ↔ version mapping (`version`, `logOffset`).
- `createPlainSubstrate(doc, clock, history)` / `createPlainReplica(clock)` — module-level constructors, not exported from the package.
- `objectToReplaceOps(obj)` → one `ReplaceChange` op per top-level key; how an entirety payload, structural defaults, and ephemeral reprojections become ops. `movedRootKeys(current, next)` → the top-level keys whose value differs, which is what an adoption or a reprojection announces.
- `decodePlainPayload(payload)` → `PlainPayload`, and the pure `planMerge(position, lineage, payload)` → `gap | append | adopt | none` (see below).

A headless replica materializes base + log on demand, cached per core revision. `applyChange` steps containers in place, so the replay runs on a deep copy of the base and copies each logged payload; replaying onto the base itself would re-apply the retained log on every rematerialization after a trim.

### `PlainVersion`

```
class PlainVersion {
  constructor(value: number, lineage: string)
  readonly value: number
  readonly lineage: string
}
```

A **single-entry version vector**: at most one authored *lineage* `{lineage: value}`, with genesis (`DEFAULT_LINEAGE`) as the empty vector ⊥ (see [§Version vector algebra](#version-vector-algebra)). `serialize()` produces `"lineage:value"` (genesis serializes as `"kyneta.genesis:0"`), and `parseVersion` accepts only that form.

`lineage` is the version-vector *lineage key* — the identity coordinate, universal to every `Version` (see [§Version vector algebra](#version-vector-algebra)). Plain is the substrate where the lineage changes during normal operation (a fresh REAL lineage is minted on the first authored write, or on a writer restart with no persisted store); CRDT substrates (Loro, Yjs) and `ephemeral` hold a constant `DEFAULT_LINEAGE`, their identity living in their own native vectors.

`compare()`/`meet()` delegate to `versionVectorCompare`/`versionVectorMeet` over `#toVector()` (`DEFAULT_LINEAGE` → empty map; REAL → `{lineage: value}`) — **no** Plain-specific case matrix:
- Two genesis versions → `equal` (both ⊥); genesis vs a REAL lineage → `behind`/`ahead` (⊥ is a subset).
- Same REAL lineage → total order on `value`.
- Two different REAL lineages → `concurrent` (disjoint keys); their `meet` is the empty vector → genesis (a valid compaction floor).

**Op-free genesis.** A freshly created doc is the empty vector: `buildUpgrade` applies structural defaults directly to the doc *without* flushing them into the log (structure is schema-derived and reconstructed by every interpreter), so `version()` starts at `DEFAULT_LINEAGE:0`. Identity is minted lazily by `createPlainSubstrate.afterBatch` on the first authored flush (via `clock.adopt(randomHex(8))`) — never in `clock.version()` (a pure projection), and never on a merge, which appends to the log without reaching `afterBatch`. Absorbed content never causes a peer to invent an identity; a document built by `fromEntirety` from a genesis payload stays genesis until its own first write.

`merge()` adopts an incoming lineage (via `clock.adopt`) only while the current lineage is still `DEFAULT_LINEAGE` — accepting the substrate's first real lineage. Genuine lineage-boundary resets (a REAL lineage transitioning to a *different* REAL lineage) are handled by `resetFromEntirety` (see `Substrate.resetFromEntirety` and `@kyneta/exchange`'s [Compaction and lineage boundaries](../exchange/TECHNICAL.md#compaction-and-lineage-boundaries)), which the Synchronizer invokes on an explicit mismatch — `merge()` never adopts across two REAL lineages. The incoming lineage is `SubstratePayload.lineage`.

Genesis still precedes the whole authored log: a genesis cursor is served from offset 0 while nothing is trimmed, and with the whole document once the base has moved past it. Answering every genesis cursor with the whole document was tried and reverted: a document's first push is a delta from genesis too, and a whole document from a peer that is already synced is what the Synchronizer reads as a compaction reset.

### Positioned payloads, and merging by plan

A plain log is addressed by position within a lineage, so a payload has to say where it belongs, or a receiver cannot tell whether it continues what it holds:

```ts
{ from: number, batches: SerializedOp[][] }   // "since": the batches after log position `from`
{ at: number, state: PlainState }              // "entirety": the document at log position `at`
```

Merging is decode → decide → execute, once in `createPlainCore` for the substrate and the headless replica:

- `decodePlainPayload` reads either shape into a `PlainPayload`.
- `planMerge(position, lineage, payload)` is pure. A delta that starts at or before `position` appends the batches we lack, skipping the ones we hold, so a redelivered delta is harmless. One that starts past `position` is a **`gap`**: nothing is applied, which leaves the version short of the one the delta was offered at, and the receiver asks for the rest. A whole document ahead of `position` is **adopted**; at or behind it, nothing changes. A payload from a different REAL lineage is a gap, since it continues nothing we hold.
- One core `adopt` replaces the state, takes the lineage and restarts the log at `at`. `merge`'s adopt plan, `resetFromEntirety` (which adopts unconditionally) and `plainReplicaFactory.fromEntirety` all use it, so a document built from a peer's whole document is at the peer's version, not at count 1. A substrate announces only the top-level fields that moved (`movedRootKeys`).

Why this matters: a push is a delta from the version the sender believes the receiver will hold, and a peer that restarted without its state no longer holds that version. Appending the delta anyway corrupted it permanently (entries duplicated when the catch-up landed on top). A whole-document merge that appended one batch left the receiver's count disagreeing with the sender's, so every later delta mismatched.

`exportSince` returns an empty delta for a cursor at or ahead of the current position, and `null` only when the cursor is behind the trimmed base — the contract's "cannot serve". `advance(to)` trims nothing for a target from another lineage or one the base has already passed (genesis included), and throws only beyond the current position.

The format change moved the plain replica type to `["plain", 2, 0]`.

### Wire-codec opacity

The plain substrate's `serializeOps` / `deserializeOps` embed `Op.change` by reference — the change is JSON-stringified as-is and passed through `WireOfferMsg.d` (an opaque `string | Uint8Array` payload). The exchange wire codec never inspects schema-level change types; it carries them as JSON inside the substrate payload. Adding a new `ChangeBase` variant (e.g. `SetChange { type: "set-op" }`) is purely additive — no exchange codec change required. The only caveat is for out-of-monorepo consumers parsing the plain JSON wire format with a strict change-type whitelist: those need to extend their whitelist when new change variants land.

The lineage now travels as an explicit field, `SubstratePayload.lineage`, set by every substrate's `exportEntirety`/`exportSince` (Plain sets it to the current lineage; Loro/Yjs/`ephemeral` set it to `DEFAULT_LINEAGE`). Plain's own `data` payload is `{ at, state }` for entirety and `{ from, batches }` for since (see §"Positioned payloads, and merging by plan") — positions, but no lineage. This is a simplification from an earlier design where Plain's JSON payload wrapped state/ops in an inline envelope (`{ i: string, s: PlainState }` / `{ i: string, b: SerializedOp[][] }`); that inline lineage field duplicated information already available via the parsed `Version` (which encodes as `"${lineage}:${value}"`) and via the new `SubstratePayload.lineage` field, creating a desync hazard between the wire-level version and the body-embedded lineage.

### The op-log holds immutable `RawPath` (authoring-time freeze)

**Invariant: the op-log is history — immutable values, never references into the live addressing registry.** A logged `Op` is a fact about the past; a since-deleted key is still the correct thing that op did. `AddressedPath` segments are memoized, *mutable* `Address` objects (an entry delete sets `dead = true`; a sequence edit advances `index` — both in place, see [§The interpreter stack](#the-interpreter-stack) addressing and `change.ts` `advanceAddresses`). If the log stored the live path, a later mutation would corrupt a historical op: `exportSince` → `serializeOps` would throw `"Ref access on deleted map entry"` on a tombstoned entry segment, or silently serialize a *drifted* index.

The fix is a one-token change at the authoring seam: `PlainSubstrate.prepare` (and the `ephemeral` substrate's) pushes `{ path: path.toRaw(), change }`, not `{ path, change }`. `Path.toRaw()` (`path.ts`) is a pure projection — `RawPath.toRaw()` returns `this`; `AddressedPath.toRaw()` reads each segment's **`coord()`** (never `resolve()`, so it succeeds even for a dead address). It is the named inverse of `resolveToAddressed`. Two consequences worth internalizing:

- **Freeze at *push*, not flush.** Index addresses advance in place *within* a batch, before `afterBatch` appends the pending ops to the log, so freezing later would capture the post-advance index. Push-time captures the coordinate as-authored. (The addressing prepare-handler fires *before* `substrate.prepare` for the same change, but an op's own path coordinate is stable under its own change — structural effects live in the change *payload* at the container path, not in the op's path segments; `index`/`entry` segments appear only on *nested* writes, which don't advance the address they sit on.)
- **The log is now byte-shape-homogeneous.** Local-write ops and merge ops (which were already `RawPath` via `deserializeOps`) are the same value type, replayed by the same `applyChange`. `serializeOps` needs no special case: its `seg.resolve()` runs only on total `RawSegment`s and never throws — the defect was the *input*, not the code.

### `resolve()` vs `coord()` — liveness assertion vs coordinate projection

A path segment (`RawSegment` | `Address`, `path.ts`) exposes two coordinate accessors, and the distinction is load-bearing:

- **`coord()`** — total, pure, never throws (even for a dead `Address`). The coordinate is an *invariant* of the segment (`readonly key` / `index`). Use it for **history, diagnostics, identity, and reads**: serialization, `format()`, the `\0`-joined `key`, schema/position walks (`fold-path.ts`, `doc-position.ts`, `schema.ts` — a deleted *instance* keeps its static *schema*), and `AbstractPath.read`.
- **`resolve()`** — projects the coordinate but *asserts liveness*, throwing on a dead `Address`. This is the loud-failure backstop for a **stale ref that tries to navigate or write**. It survives only at the genuine guard sites: the `Address` factories themselves, `writeByPath` (writing through a deleted path must fail), and the live ref-navigation surface.

Two totality rules follow:

- **Diagnostics never throw.** `format()`/`key` route through `coord()`. Previously they used `resolve()`, so formatting a path with a dead segment threw *while building an error message* (e.g. `withAddressing`'s `onRefCreated` throw), masking the original error.
- **Reads are total; a deleted key is absent.** `path.read(store)` of a deleted key returns `undefined` (via the natural `store[key]` miss), **not** a throw. Deletion remains observable via `deletedFeed(ref)` (or `deleted(ref)` for a plain boolean); **writes** still throw (that guard belongs on the write path, not the read). This is the intended contract — see the `with-addressing` "delete → read undefined, write throws, deleted is true" tests.

---

## The ephemeral substrate

A **field-level LWW map**, and a state-based CRDT (CvRDT) — peers exchange whole
states and reconcile them with a join, rather than shipping an op log. The
substrate keeps a `Live` tuple, `[value, timestamp]`, for every scalar leaf, so
concurrent writes merge field by field, and marks a deleted or wholly replaced
key with a `Horizon` (see [Deletion](#deletion)).

That granularity is the whole point. A presence roster where each peer writes
only its own key is the motivating case, and it is unusable under
whole-document last-writer-wins, where whichever peer wrote most recently
clobbers everyone else. Kyneta shipped exactly that substrate through 2.x under
this same name with a different implementation. See the CHANGELOG.

Two properties follow from being log-free and transient:

- A `sum`/discriminated-union variant and a `.json()` blob are stored as a
  **single atomic register** tuple holding the whole value, not decomposed — so
  a concurrent variant switch resolves to one coherent variant and never blends
  fields across two.
- There is no op log, so nothing accumulates and nothing is persisted.
  `.decay()` can retire a leaf on a timer, which is meaningful only here.

### Two clocks, and only one of them is a clock

A live leaf is `[value, timestamp, installedAt]`, and a horizon is `[content, horizon, installedAt, deleted]`.

`timestamp` (a horizon's `horizon`) is a wall clock: it orders LWW and it is what `.decay()` measures. It is never earlier than the writer's clock at the write, and may be later (see [A local write is later than what it overwrites](#a-local-write-is-later-than-what-it-overwrites)). `installedAt` is this replica's **install ordinal** — which batch *we* took the node in — and it answers a different question. A peer returning from an hour offline sends leaves written an hour ago that we are installing now; a delta filtered by write time would drop exactly those, and the peer that relayed them would never learn they had not arrived.

The ordinal is local and never crosses the wire. `encodeTree` strips it: a live leaf travels as `[value, timestamp]` and a horizon as `[content, horizon, deleted]`, so a deletion with nothing written since is `[null, horizon, true]`, the tombstone peers have always spoken. `decodeTree` restores the slot at 0, and the merge stamps only what it actually adopts, so **"the counter moved" and "our state changed" are one fact**.

Both conversions walk the tree explicitly rather than passing a replacer to `JSON.stringify`, which would have been free. A replacer descends into every array including a leaf's *value*, and a register value may itself be an array — indistinguishable from a tuple by any test. Walking descends only through container keys and horizon content, and stops at a leaf.

Nothing that decides agreement may read the ordinal. Two peers holding identical state stamp it differently, so `joinTuples`, `compareExistence` and `stateTreeDigest` all skip it. The join is the dangerous one: it decides whether a merge moved, and reading the ordinal there would report a change on every merge — which is the three-peer cycle described under "A merge reports whether it moved", arrived at from the opposite direction.

`StateVersion` is `(incarnation, installSeq)`: which replica instance is counting, and how far. That is structurally `PlainVersion`, so this substrate is no longer an exception to the version-vector family. `lineage` stays `DEFAULT_LINEAGE` deliberately — `classifyResetTrigger` reads two differing non-default lineages as a lineage boundary, and every instance mints a distinct incarnation, so surfacing it there would make *every pair of peers* a boundary and delta sync would silently never happen.

`compare` still answers `"concurrent"`, now for an honest reason: an install count describes intake, not state, so two peers holding the same tree report different numbers. Equality is answered by `stateTreeDigest`, carried beside the version on the wire and read by the classifier.

### A local write is later than what it overwrites

A state-based CRDT converges only if two things hold. The join must be a lattice, and every **local write must be inflationary**: the tree after a write must sit at or above the tree before it, `before ⊑ after`. The second is not something the join can provide. A write that lowers the tree leaves the writer holding a state no join produces, and a peer still holding `before` computes `before ⊔ after`, which is not `after`. The writer shows its write, every other peer keeps what it replaced, and once sync runs back the other way the writer adopts that too, so the write is undone.

Stamping writes with `Date.now()` and overwriting in place broke this three ways:

- **A same-millisecond rewrite.** The tie goes to the old tuple whenever the new one ranks lower: a delete after a set (a tombstone loses a tie to a live value), or a smaller value written over a larger one.
- **Clock skew.** A replica whose clock is behind a tuple it has already merged loses outright. A write that is causally *after* another loses to it, with no coincidence needed. This is the serious one.
- **Timestamp regression.** A whole-value write rewrote unchanged leaves with older timestamps, so digests disagreed.

The fix is that **every write is stamped strictly past what it replaces**. The shell reads the clock once, in the substrate's `prepare`, and hands it down as `WriteStamp.notBefore`: the earliest timestamp the write may install. `stampOver` moves it to `newestTimestamp(replaced) + 1` wherever the write replaces something newer. The new node then wins the join on timestamp alone, so the tie rule is never consulted, and nothing in `state-tree.ts` reads the clock.

The floor also climbs through horizons. A write beneath a horizon is stamped at or above it, because a peer with a fast clock can set a horizon ahead of ours, and a write below it would be pruned the moment it was made.

Two alternatives were rejected:

- **Breaking ties toward tombstones** fixes set→delete and breaks delete→re-add. It addresses a symptom of the tie rule, not the missing invariant.
- **A replica-wide hybrid logical clock**, taking `max(now, clock + 1)` for every write, is correct, but one fast-clocked peer drags every later write on every leaf forward, and decay measures from leaf timestamps. The per-leaf rule moves time only on the nodes that were actually contended. A write already past what it overwrites stores exactly its wall-clock stamp.

**Timestamps from peers are validated.** Every guarantee above rests on `timestamp + 1 > timestamp`, which fails for `Infinity` (`JSON.parse("1e400")`) and above 2^53. `decodeTree` refuses a payload with any timestamp that is not a non-negative safe integer, before anything is mutated. What remains is inherent to last-writer-wins: it trusts clocks, so a peer can still pin a node with a far-future timestamp. That is the same stance the digest takes on adversarial peers.

### The merge rule, in full

For two live leaves: highest timestamp wins; **on a tie, the greater `JSON.stringify(value)` wins**. State both halves — the tie is the half a reader will meet in production and not in testing, and getting it wrong is invisible.

The tie rule is not a detail. A merge that resolved ties by preferring "the remote value" would be deterministic but *not commutative*: each peer would keep its own value and the two would diverge permanently, with no error raised and no convergence to follow. Commutativity, associativity and idempotence are pinned as laws in `ephemeral-lattice.test.ts`.

On a tie the greater **value** wins, not the later writer. A tie is two different writers in the same millisecond: one writer's own writes cannot tie, because each is stamped past what it replaces. Comparing serialisations is sound because both peers compare the same pair of strings and so reach the same verdict, and because string comparison is a total order, which is what makes the join associative across three or more tied peers. Only the value tie pays for `stringify`.

**Existence has one tie rule.** A live leaf claims presence at its timestamp; a horizon claims `!deleted` at its horizon. `compareExistence` orders two claims by timestamp, and on a tie **present beats absent**: a tie carries no reason to prefer the deletion, and that direction discards less. It is how a live value beats a deletion on a tie, and how a replacement beats a deletion at the same horizon. The rank must cover every slot that replicates; ranking the value alone once left a deletion and a live `null` indistinguishable, and two peers diverged permanently.

| local ⊔ remote | result |
|---|---|
| live ⊔ live | timestamp, then value rank |
| live ⊔ deletion with nothing since | `compareExistence` |
| horizon ⊔ horizon | existence from `compareExistence`; content joined, and pruned at the winning horizon |
| horizon ⊔ container | the container joins the content, pruned at the horizon |
| container ⊔ container | union keys, recurse |
| live ⊔ container, or live ⊔ horizon with content | the peers disagree about a node's shape |

The last row is reachable only by a malformed or mismatched-schema payload. It compares the newest timestamp on each side and keeps the winner whole: commutative, but not associative, since the loser's contents cannot be recovered by a later merge. Well-formed peers never disagree about shape, because shape comes from the schema and a horizon joins a container by pruning it rather than replacing it.

### Deletion

`mergeStateTree` unions keys, so **absence carries no information**: a key one peer lacks is indistinguishable from a key it has never seen. Simply removing a key therefore survives only until the next merge with anyone who still holds it. A `Schema.record` used as a roster could gain members but never lose them.

A delete writes a **horizon**: `[content, horizon, installedAt, deleted]`. It says that everything under the key written before `horizon` is gone, and `content` holds what has been written under the key since. A replacement, a container written whole, is the same statement plus "the key exists". `(horizon, deleted)` is itself a last-writer-wins value (`compareExistence`), and the horizon lives in a tuple rather than under a reserved key of the container because any string is a valid record key, while arrays are a channel user data cannot reach.

A delete therefore reaches what the deleter never saw. Deleting a record entry is one tuple whatever the entry holds, stamped past everything the deleter holds under the key. An entry it never saw, or an inner key another peer wrote before the delete, falls below the horizon when the join meets it, and is dropped. Something written *after* the delete survives and brings the entry back.

Writing a whole record, or clearing one, raises a horizon on the record itself. That is last-writer-wins on the container: older keys the writer never saw are removed with the rest. The per-key calls, `.set(k, v)` and `.delete(k)`, remove nothing else.

**This is LWW-Element-Set, not OR-Set.** Concurrent add and remove resolve by timestamp: a later add beats an earlier delete, and a later delete beats an earlier add. Anyone who reads "tombstone" is likely to assume observed-remove semantics, where a concurrent add always wins regardless of clock — that is *not* what this does. LWW is the correct reading for a target advertising `lww-per-key`, OR-Set would require per-element causal metadata this substrate does not carry, and for presence it is the behaviour you want: a peer removed and rejoining should be present again.

`clear()` follows the same rule, which is where ephemeral and the CRDT backends part. `MapChange.clear` carries intent, "every key goes, seen or not", and each substrate's merge law decides what that reaches. Loro and Yjs remove the keys the container holds, which is observed-remove: `mapChangeEffects` expands the clear against those keys. Ephemeral raises a horizon, which also removes older entries still in flight. The conformance profiles declare each substrate's reach as `clearReach: "observed" | "older"`, and `tests/conformance` holds each to it.

**Collection is pruning.** `prune(node, floor)` drops everything stamped strictly before a horizon above it, and a horizon only ever rises, so whatever is below one now is below it for good. A peer that sends such a leaf again has it dropped again, the join reports no change, and nothing is relayed. That is collection without causal stability: a max-register's dominance is permanent, which OR-Set tombstones do not have. A deleted subtree is one tuple, and alternating delete and add on a key leaves one node. `.decay()` still cannot collect anything, because it never mutates the tree (see below).

**Every tree is kept in normal form**, which the join relies on and the digest and `encodeTree` assume:

- no live leaf below its floor, the highest horizon above it;
- no horizon below its enclosing floor;
- no empty plain container other than the root, because an empty container carries no timestamp and can be neither ordered nor hashed; existence is expressed only by horizons;
- a horizon's content is `null` exactly when it is a deletion with nothing written since, and a replacement always has a container, even an empty one: that is how an empty entry exists;
- no structural zeros: every node was written by someone.

`decodeTree` is the only thing that normalises foreign input, and local writes produce normal form by construction, so the merge prunes only where a joined horizon rises above one side's own.

### What `.decay()` is

A **read-time projection**, not a deletion mechanism. It is the `withDecay` decorator over the projection's fold (`interpreters/with-decay.ts`): a node whose schema declares `decayMs`, and whose newest write is older than that, reads as its structural zero, without its subtree being walked. That one rule covers a leaf and a container alike; a product or map past its window reads as its structural zero, not as a mix of expired and unexpired fields. A node never written does not decay, since it is already the zero.

`tick(now)` re-projects, writes the root fields that moved into σ, and announces them. The tree is untouched, the version clock does not advance, and nothing is broadcast; subscribers receive the changeset with `replay: true`, because no local writer authored it.

A field expiring is one event, not a standing condition. The announcement names what *changed*, so an expired field is reported once; a tick that moves nothing is silent, however many fields are currently being masked.

Decay removes nothing. It is the rule *"when reading, treat a node older than `decayMs` as its zero value"*, and it converges across peers with **no communication at all**, because every peer applies the same age test to the same stored timestamps and therefore reaches the same answer. A horizon counts as a write: a container's age is its newest leaf or horizon. A horizon does not decay itself, and decay cannot collect one.

### Where `.decay()` may be attached

Decay works **per stored node**: it compares one node's newest timestamp against `now`. That fixes where it can legally sit.

An atomic register — a `sum` variant or a `.json()` blob — is stored as ONE tuple holding the whole value, so a field inside it has no timestamp of its own and can never age out independently. `decayMs` is therefore **legal at or above an opaque boundary and illegal strictly below one**. Attaching it to the sum or `.json()` node itself is supported and means what it says: the whole variant decays to its structural zero together.

Two rules enforce this, and they are split by **scope** rather than by subject. *"`.decay()` needs a transient substrate"* is about the schema *and* the `SyncMode`; it is meaningless once you are inside an ephemeral substrate, so it lives in `validateEphemeralSchema` (`bind.ts`) alone. *"not below a register"* is a fact about how a `StateTree` stores things, so it lives with the other storage facts in `stateTreeViolation` (`state-tree.ts`) and runs at both seams a schema enters by.

The split is what closed a gap. While the placement rule ran only from `bind()`, reaching a substrate through `ephemeralSubstrateFactory.create` skipped it, and the failure the rule exists to prevent — binds cleanly, never fires — was still reachable.

The pairing rule is reported first, and the order is what a caller sees. A schema can break both at once, and the two are independent, so leading with a storage message would tell a caller to restructure a field when their real problem is that the substrate supports no decay at all.

Before this check existed, `decayMs` below a boundary bound cleanly and then silently never fired — no throw, no log, just a field that never decayed.

### Node kinds in the StateTree

A node is `Live`, `Horizon` or `Container`, and `nodeKind` says which. A `Live` is an array of three slots and a `Horizon` an array of four whose last is a boolean; a container is a plain object. Sequences are not a supported container here, so every array in a tree is one of ours.

A horizon's `deleted` marker lives in its own slot rather than in the value because it has to be **out-of-band from the value domain**: `null` is a legitimate value under a nullable schema, and any in-band sentinel is something a `.json()` blob could legitimately contain.

`nodeKind` throws on anything else, and every walker switches on it exhaustively, closed with a `never`. Treating an unknown shape as a container is quiet and expensive: its slots are walked as keys, and the characters of a string value after them. A malformed fixture once did exactly that, and the walk recursed until the stack ran out.

### A merge reports whether it moved

`mergeStateTree` returns `{ tree, changed }`. `changed` is a lattice question rather than bookkeeping: `a ⊔ b = a` exactly when `b ≤ a`, so a false answer means the incoming payload was already subsumed. A horizon that rises or flips is a change; a leaf the join prunes on arrival is not. The substrate advances its version only when the join moved, and the synchronizer relays only an import that changed something.

Getting this wrong is not a waste of bytes, it is a cycle. Each peer relays an import to every peer except the sender. With two peers that closes immediately — the sender is the only candidate — which is why announcing every merge was survivable and why every ephemeral test in the suite passed. With three peers there is always somewhere left to forward to, and because `StateVersion.compare` can never answer `"equal"`, no receiver can decline a payload it already holds. Three peers opening the same ephemeral document wedged the event loop before this was fixed, with nobody writing anything.

A related requirement sits underneath it: the version must advance *strictly*, or two changes inside one millisecond would share a version and a caller comparing versions would read a real change as none. The version is the install ordinal, which every write and every moving merge increments, so it is strict by construction; a merge that moves nothing gives its ordinal back.

### Two key spaces

Where a node's keys come from decides what their absence means, and the two answers are opposites.

| | keys come from | an absent key means |
|---|---|---|
| `product` — **declared** | the schema | nothing was written there; the projection supplies the zero |
| `map` — **dynamic** | whatever was written | removed, or never there |

"Absence carries no information" is the rule for a *map*, and it is why a removal has to be recorded rather than left as a missing key. It is false for a product, whose fields exist because the type says so. `keySpace` (`state-tree.ts`) is the one place that decides, and two things follow from it:

- **Writes.** `writeNode` writes a map, or a product at a dynamic key, as a replacement: the writer may not have seen every key, and an entry's existence is itself last-writer-wins. A product at a declared key is written field by field by `writeProduct`, and a field the value omits is left alone.
- **Presence.** At a dynamic key a node is present if it is a live leaf or a replacement, or if anything beneath it is. A deletion with something written since is present because of that something. A declared key is always present, and its value comes from the fold.

**Zeros come from the fold, not the tree.** The reader is schema-blind, so it cannot fill a declared field the tree does not hold. The projection can, because it is the schema's F-algebra: a declared field that is absent, pruned below a horizon, or missing from a partial entry reads as `Zero.structural` of its schema. A delta carries only the leaves that changed, so a peer can legitimately hold an entry with some of its fields.

Three defects came from the missing distinction, and all were invisible locally because reads come from σ. A record whose last key was deleted dropped out of the projection. A partial struct value dropped the fields it did not mention from the tree, where they then resurrected from the next peer that still held them. And a deleted entry holding a nested struct stayed present on other peers, because presence was decided field by field against the schema and a declared nested container counted as present even with every leaf in it tombstoned.

### How a node is stored

How a node is stored has one definition, `stateTreeRole` (`state-tree.ts`), in the sense `storageClass` is for substrates generally. It answers three ways, not two: `decompose` for `product`/`map` (that is what gives `ephemeral` its field-level merge), `register` for `scalar`, `sum` and `.json()` nodes stored as one leaf tuple, and `unrepresentable` for everything else. Its consumers hold no logic of their own: `childSchemaForKey`, `writeNode`, `stateTreeViolation`, and the map-change guard in `applyChangeToStateTree`.

Three answers rather than two, because *register* and *unrepresentable* are different and were previously the same `default` arm. A sequence reaching `childSchemaForKey` got the answer meant for a sum — "no child here" — and then decomposed schema-blind one level down. The accepted set is enumerated rather than the rejected one, so a schema kind added later lands in `unrepresentable` instead of joining the storable set silently.

**A schema the tree cannot hold is refused before a document exists.** `stateTreeViolation` walks a schema and reports the first node with no representation, or the first `.decay()` below a register. Both seams a schema enters by call it: `bind()`, for the error site a caller expects, and `createStateSubstrate`, which `ephemeralSubstrateFactory` reaches without `bind()`. The second is not belt-and-braces: the first write to an unrepresentable field would store it in a shape the schema never declared. `.json()` is the escape hatch the message names, and a wrapped list keeps its `push`/`insert`/`delete` surface while replicating as one register value.

The write path requires a schema, and a write whose path does not fit it throws rather than guessing a shape for the tree. The substrate always has a schema; the headless replica, which only merges, is the schemaless form.

Only `.json()` launders an unrepresentable kind. A `sum` also stores as one tuple, but `.nullable()` is not a request for opaque storage the way `.json()` is, so a list inside one still means the list semantics the schema asked for. `EphemeralLaws` draws the line in the same place, and `bind-constraints-ephemeral.test.ts` §4 pins the two against each other — that test found this exact disagreement.

`refuseUnstorableChange` enumerates every member of `BuiltinChange` and closes with a `never`. A ninth member is a compile error there until someone decides whether this tree can store it. A `default` arm would swallow it into the refusal silently, which is how an unhandled change type came to fall off the end of `applyChangeToStateTree`: σ advanced, λ did not, and the writing peer read back perfectly while every other peer saw nothing. Storing a register whole is deliberate — a sum variant is an opaque LWW value (variant fields are not independently addressable; a switch is one whole-value `.set()`, per the `WritableDiscriminantProductRef` contract), so decomposing it would let the schema-blind `mergeStateTree` interleave fields from different variants.

A write aimed *at or inside* a register is re-aimed at the register itself before it reaches the tree (`prepare` in `ephemeral.ts`, via the same `findOpaqueBoundary` the CRDT backends use). Applying such a write literally would split the tuple into per-field tuples and drop every sibling field the change never mentioned. This is easy to miss in testing: `prepare` updates the plain-object shadow that local reads are served from, so the document reads back correctly on the peer that made the write, and only replicated state is damaged. Assert on the exported tree, not on the document — and see [The functional shadow](#the-functional-shadow) for the suite that now asserts it for you.

The property this buys — a concurrent variant switch resolving to one coherent variant, never a blend of two — is asserted across every substrate in `tests/conformance`, not just for `ephemeral`. If you change how registers are stored, that is where the cross-substrate guard lives.

### The projection

Π for ephemeral is the materializer the CRDT backends use: `projectStateTree` is `interpret(schema, withDecay(createMaterializeInterpreter(resolver), …))` over `createStateTreeResolver(tree)`. The resolver is schema-blind, as theirs are. Every method resolves its path with `stateTreeAt`, which descends through horizons and continues into a live leaf's value for the rest of a path, so a register's fields are read from inside its one tuple. For a value held as plain JSON, a `.json()` list's length or a `.json()` record's keys, it answers with `plainResolution`, the same answers Loro and Yjs give for their plain values. The fold holds the schema, so it supplies every zero and applies decay.

A projection returns register values by reference from the tree, so it is never kept or handed out as it is. A reprojection, after a merge or on a tick, is an announcement:

1. gather: `projectStateTree(tree, schema, now)`;
2. plan: `movedRootKeys(σ, next)`, the root fields whose values differ;
3. execute: write a copy of each moved value into σ, then `announce` one replace op per moved field.

Each moved value is copied twice, once into σ and once into the op payload that subscribers receive, so neither shares a register value with the tree or with the other. An unchanged root field is neither cloned nor rewritten. That is the shape of Loro's and Yjs's event bridge, native state → σ → `Op[]` → announce, with a diff against the projection standing in for their CRDT events.

### One way in

Peer data enters the tree only through `decodeTree`, which refuses a malformed node or an unstorable timestamp and brings the rest into normal form. That includes `upgrade`, which builds a substrate from a headless replica by decoding the replica's entirety. It once parsed that entirety with `JSON.parse`, reading the wire shape as the in-memory one: the wire's deletion marker sits where the install ordinal lives in memory, so every deletion became a live `null`, which then beat the deletion on every peer. `createDoc(bound, payload)` and an exchange promoting a relayed document both reach `upgrade`.

### The state digest

`stateTreeDigest` (`state-tree.ts`) fingerprints everything that replicates: each live leaf's path, value and timestamp, and each horizon's path, horizon and `deleted` flag, with its content beneath the same path. A horizon folds a marker no live leaf can produce, so the two never collide at one path. Two peers holding the same tree hold the same digest, whatever order they reached it in, because the per-node hashes are combined with XOR.

It exists to answer the question `StateVersion.compare` cannot. An install count describes intake, not state, so two peers holding the same tree report different versions; the digest is a function of the tree alone, so peers that converged by opposite routes agree and stop exchanging.

Three properties are load-bearing, and each has a test:

- **Order independence.** XOR is commutative, so peers that converge by opposite merge orders agree. Without this the comparison reports divergence forever and the digest is worse than useless. Normal form is what makes equal states equal trees: an empty container or a redundant horizon left behind on one peer would otherwise split them.
- **Path sensitivity.** The same value under a different key must not fold alike. The path is encoded *structurally*: four lanes of the path prefix travel down the recursion as plain numbers with each key folded in, so no path string is ever built. That is also what keeps the walk allocation-free — an early version that allocated a digest per node cost 29.7 ms over 5000 leaves against 3.8 ms for this one.
- **Nothing local.** `.decay()` is a read-time projection that never touches the tree, so two peers configured with different `decayMs` hold identical trees and must agree. `decayMs` is excluded from the schema hash for the same reason.

The digest is deliberately **not** part of `Version`. A version orders things and supports `meet` and `join`, which `exchange.compact` and the exchange's push baselines rely on; digests have neither, so putting one inside a version string would leave them with no defined answer. The Yjs substrate reached the same conclusion from the other side: its version once carried a delete-set digest, and broke the lattice laws; it now advances its clock after every delete instead (see the Yjs backend's §"The delete clock").

Collision resistance is four independent FNV-1a-32 lanes, which is ample against ordinary divergence and is not a claim of adversarial resistance. A peer that can choose leaf values could attack one lane at a time. Making this hostile-safe needs a real multiset hash.

### Atomicity is shape, not logic

Crucially, atomicity is encoded in the tree's *shape* (register = leaf tuple), **not** in the merge logic, and so are deletion and replacement (horizon = tuple around content). That is why `mergeStateTree` stays schema-blind: a headless relay/store merges raw entirety payloads by timestamp without ever needing the schema. The schema is consulted only when translating between plain values and the tree (build via `applyChangeToStateTree`, extract via `projectStateTree`), which always runs on a schema-aware peer. Register values are deep-cloned (`deepClonePlain`) on the way into the tree, and copied on the way out to σ by the reprojection's ops, so the two never alias.

---

## The functional shadow

CRDT substrates (Loro, Yjs) maintain a **shadow**: a `PlainState` object that serves as the canonical read surface for all interpreter-stack reads. The architecture separates four surfaces:

| Surface | Backing | Purpose |
|---------|---------|---------|
| **Read surface** | `PlainState` + `plainReader` | All `ref.field()` reads, subscriber reads, interpreter-stack caching |
| **Sync surface** | CRDT doc (`LoroDoc` / `Y.Doc`) | `exportSince`, `merge`, `import` — replication and conflict resolution |
| **Position surface** | CRDT doc | `positionResolver` — cursor / relative-position operations that require CRDT structure |
| **Native escape hatch** | CRDT doc | `nativeResolver` — direct access to the underlying CRDT container for advanced use |

**On local writes**, `prepare` calls `applyChange(shadow, path, change)` — the same σ-advance the plain substrate uses — making the write immediately visible to reads, and advances the CRDT doc in the same call (Loro coalesces plain map writes until `afterBatch`; Yjs defers `.json()` boundary writes the same way).

**On everything else** (a merge, a raw native write), the CRDT doc holds the ops first (via `doc.import`, `Y.applyUpdate`, or the native call). The event bridge re-materializes the shadow from the CRDT doc and only then announces the ops, so `ctx.reader` already reflects the new state when any subscriber runs.

**A substrate announces only after λ and σ agree.** Every change that a local writer did not author reaches the changefeed as an announcement, `ctx.announce(ops, origin)` (`src/interpreters/writable.ts`), issued after the substrate has taken the ops into λ and brought σ up to date. The announcement never calls `substrate.prepare` or `afterBatch`; it only feeds the changefeed layers and delivers. Those layers work from the ops alone, so σ is final for every observer.

| announcer | reconcile λ | reconcile σ |
|---|---|---|
| Yjs / Loro event bridge | CRDT import or native write, already done | `syncShadow(shadow, materialize(λ))` |
| plain `merge` | apply each op to the doc, `core.append(batch)` | σ is λ |
| plain `resetFromEntirety` | apply replace ops, `core.resetLog(remote)` | σ is λ |
| ephemeral `merge` | `core.merge` joins the tree | write copies of the moved root values |
| ephemeral `tick` | none | write copies of the moved root values |

**Initialization.** The shadow is created at substrate construction time via `materializeLoroShadow` (Loro) or `materializeYjsShadow` (Yjs). These functions now delegate to `createMaterializeInterpreter` with a backend-specific `MaterializeResolver`, rather than defining bespoke 370-line interpreters. The resolver closes over the CRDT doc and binding; the generic materializer walks the schema and calls resolver methods to produce a plain JS object matching the schema's shape. The shadow is also re-materialized on upgrade and before every bridge announcement.

The ephemeral substrate builds its shadow with the same fold, over a resolver for its `StateTree` (see [The projection](#the-projection)). Its announcements have the same shape too: all three bring σ up to date, turn native state into `Op[]`, and announce it. Loro and Yjs take the ops from their CRDT events; ephemeral has no event bridge, so `movedRootKeys` diffs σ against a fresh projection instead. For a value a backend holds as plain JSON, such as the inside of a `.json()` register, every resolver answers with `plainResolution` (`interpreters/materialize.ts`), so they cannot disagree about it.

**`Reader` vs `MaterializeResolver`.** `Reader` (5 methods) is the runtime read interface backed by the `PlainState` shadow — schema-blind, live. `MaterializeResolver` (7 methods) is the materialization interface backed by the native store — schema-aware via catamorphism dispatch, one-shot. They share a conceptual lineage — the resolver is what a CRDT Reader would look like if it were schema-aware and didn't need liveness.

This design makes the read-your-writes invariant true by construction for all substrates: reads always go through `plainReader(shadow)`, and local writes always land in the shadow eagerly. No coordination, no flags, no special-casing per substrate.

### The projection law, and where it is pinned

A shadow-carrying substrate holds the document twice, and the law is that the two agree:

```
σ ≡ Π(λ)
```

Π is the substrate's own materialiser — `projectStateTree`, `materializeLoroShadow`, `materializeYjsShadow`. `projectionConformance` (`src/testing/projection-conformance.ts`) applies a sequence of writes and compares the two derivations after each one. `ephemeral`, `loro` and `yjs` run it.

The comparison is not a function against itself. On the write path σ is advanced by `applyChange` and λ by `applyChangeToStateTree` or `changeToDiff` — different code reading the same change. A substrate uses its materialiser only when it announces, so reprojecting after a local write crosses from one derivation to the other. `plain` does not run the suite: σ *is* the document there, so Π is the identity and the comparison would hold for a reason unrelated to any substrate behaviour.

Before this suite existed the law was tested twice by hand, in the Loro and Yjs `eager-write-coherence` files, and not at all for `ephemeral` — which is where it broke. Both hand-written versions compared Π(λ) against an object literal and spot-checked two fields of σ, so neither compared the two derivations at all.

The suite found one violation on its first run, since fixed: deleting a record's last key left `{}` in σ while the projection dropped the record entirely. The cause was the projection applying a map's rule to a declared field — see [Two key spaces](#two-key-spaces).

---

## `foldPath` — schema-guided path resolution

Source: `packages/schema/src/fold-path.ts`.

`walkPath` is the one schema-guided traversal, and `foldPath` is its value-resolving projection — the schema-guided sibling of `Path.read(state)`. Where `Path.read` walks a plain JS object by segment-resolved keys, this walks a substrate-native container tree by composing a total single-step descent with a backend-supplied `PathStepper` (per-step substrate dispatch). Backends carry only the `PathStepper`; the traversal lives once in core.

```
walkPath              reports where the walk stopped; never throws
  ├─ foldPath         resolves a substrate value; throws on a bad path
  ├─ pathSchema       returns just the schema
  └─ findOpaqueBoundary   reports where an opaque subtree begins
```

The `ephemeral` substrate's schema lookup (`state-tree.ts:schemaAtPath`) is a fourth projection. `walkPath` returns a `PathWalk`: `complete`, `boundary` (with `consumed` marking where value-level resolution takes over), or `mismatch` (carrying a ready-to-throw reason rather than raising). Each projection picks its own policy — `foldPath` throws on `mismatch`, the `ephemeral` lookup answers `undefined` — which is the functional-core / imperative-shell split: the traversal reports what happened, its callers decide what to do about it.

```ts
type PathStepper = (
  current: unknown,
  nextSchema: SchemaNode,
  segment: Segment,
  identity: string | undefined,
) => unknown

function foldPath(
  root, rootSchema, path, stepInto, binding?
): { resolved, schema }
```

`stepInto` is the only substrate-specific piece. The Loro backend's `stepIntoLoro` dispatches on `LoroDoc` (root) vs. container `.kind()`; the Yjs backend's `stepIntoYjs` dispatches on `instanceof Y.Map | Y.Array | Y.Text`. `resolveContainer` / `resolveYjsType` are 1-line wrappers around `foldPath(..., stepInto*, ...)`.

### Two semantic invariants live in `walkPath`, in one place

1. **Identity-keying at product-field boundaries only.** When `seg.role === "field"`, the absolute schema path is extended via `extendSchemaPathKey(prev, segment)` and used to look up `binding.forward.get(key)`. `entry` (map/set/tree) and `index` (sequence/movable) segments pass through with the raw key — they are not identity-keyed. The writer side of this contract — `deriveBindingRecursive` in `migration.ts` — uses the same `extendSchemaPathKey` accumulator, so the writer/reader key construction is byte-identical by construction.

2. **Opaque-boundary stop.** Some subtrees are stored as ONE plain value in the parent container rather than as nested CRDT containers, and once a walk reaches one the schema has nothing further to offer — remaining segments resolve against the *value*. `walkPath` reports this as a `boundary` stop; each projection decides what to do about it. Two schema shapes qualify:

   - A `sum` (which is what `.nullable()` expands to). Sum variants are `PlainSchema` by construction, so no CRDT container can exist inside one.
   - A `.json()` node. The whole subtree is one plain JSON blob by definition of the modifier.

   These were once documented as *two* invariants, and the split was itself the bug: a walker could learn the json half and miss the sum half, which is exactly what happened. They are one rule because they describe one storage decision.

   **That constraint is now retired rather than restated.** This document used to say the walk-side predicate and `needsContainer` (`materialize-value.ts`) "must agree", which is the same kind of prose invariant the section below diagnoses — a rule living in a doc comment, enforced by review. Both are now one-line derivations of `storageClass` (`schema.ts`), the single place the decision is made: `isOpaqueBoundary` asks it the walk-side question, `needsContainer` the write-side one. They cannot disagree, so nothing has to remember that they must.

   There is now a third consumer outside the traversal entirely: `stateTreeViolation` (`state-tree.ts`) uses `isOpaqueBoundary` to find where a register begins, because `.decay()` is illegal below one (see §"Where `.decay()` may be attached"). Under the old arrangement that would have meant a third hand-written copy of the rule, since `isJsonBoundary` and `KIND` are both public and the disjunction is one line away. Sharing the predicate is what makes the validator agree with the traversal by construction rather than by review — and note that `!needsContainer` is *not* a substitute for it, because that is also false for scalars, which are leaves rather than boundaries.

   That same validator asks `isJsonBoundary` separately, for its other rule. Decay uses the wider boundary because a `sum` shares one timestamp across its variant's fields; representability uses the narrower one because only `.json()` is a request for opaque storage.

   The cost of the old arrangement was paid: `richtext` was classified as a container by one and a leaf by the other, which broke the `EagerPolicy` subset relation described in §"Value materialization — the write-side unfold".

### `pathSchema` — the schema-only specialization

`pathSchema(rootSchema, path, binding?)` is `foldPath` with a no-op stepper, returning only `.schema`. Used by callers that need the schema at a path but not the substrate value: changefeed kind classification (`changefeed.ts:resolveSchemaKindAtPath`), change-mapping target resolution (Loro `changeToDiff` / `batchToOps`, Yjs `applySequenceChange` / `applyMapChange` / `applyReplaceChange` / `eventToChange`). The opaque-boundary rule applies uniformly — on a path leading into a sum or a `.json()` subtree, `pathSchema` returns the boundary node's own schema, because the variant cannot be determined without a value at parse time.

### Why one traversal, not many

Before this primitive, both Loro's `resolveContainer` and Yjs's `resolveYjsType` re-implemented the same left-fold over `Path.segments`, and four schema-only walks (one in `changefeed.ts`, one in `yjs/change-mapping.ts`, two inline in `loro/change-mapping.ts`) re-implemented the schema-only variant with subtly different sum-boundary handling (three explicit short-circuits, one try/catch).

**That consolidation did not hold, and how it came apart is the most useful thing in this section.** This document previously claimed:

> After the consolidation, `advanceSchema` has exactly one production caller — `foldPath` itself — and the sum-boundary rule is structural, not exception-based.

At one point there were three production callers. `findJsonBoundary` arrived with the `.json()` boundary work as a *second* hand-rolled walk, and learned only the json half of the boundary rule; `schemaAtPath` (`state-tree.ts`) arrived as a third and reached for `try/catch`. Each shipped a different bug from the same missing case: one crashed on a legitimate path, one silently discarded fields from replicated state.

The claim was true when written. What made it decay is that nothing enforced it — the rule lived in a doc comment, and `advanceSchema` was exported, so hand-rolling a fourth walk was the path of least resistance. **A stated invariant is not an enforced one.**

The current arrangement is structural instead. `walkPath` is the only traversal; `foldPath`, `pathSchema`, `findOpaqueBoundary`, and the `ephemeral` substrate's schema lookup are projections of it that differ only in policy. The single-step primitive underneath (`stepSchema`) is package-internal and deliberately *not* exported, because handing it out is what made a divergent walker easy to write.

`advanceSchema` — the public throwing wrapper over that primitive — has been removed. It was retained through 2.x on the reasoning that it had lost its callers but was still public, and it was pinned with tests so its behaviour could not drift. That retention was the last piece of the decayed arrangement still standing: an exported single-step descent is precisely what the paragraph above identifies as the hazard, and keeping it meant the package's most thorough descent tests pointed at a function nothing called. Those tests now target `stepSchema` directly (`src/__tests__/step-schema.test.ts`), including the `descend`-versus-`boundary` distinction the wrapper could not express. `walkPath` is the supported replacement for outside callers.

Notably, the boundary rule needed no separate implementation once the walkers were consolidated. Reporting a `boundary` from one place meant every projection inherited it — the rule was never a policy anyone had to write down, only a question that had been asked in three places instead of one.

---

## The interpreter stack

Source: `packages/schema/src/interpret.ts`, `src/interpreters/*`, `src/layers.ts`, `src/ref.ts`.

An `Interpreter<Ctx, A>` is an F-algebra over the schema functor — one method per `[KIND]`:

```
interface Interpreter<Ctx, A> {
  scalar: (ctx: Ctx, path: Path, schema: ScalarSchema) => A
  product: (ctx: Ctx, path: Path, schema: ProductSchema, fields: Record<string, () => A>) => A
  sequence: (ctx: Ctx, path: Path, schema: SequenceSchema, item: (i: number) => A) => A
  map: (ctx: Ctx, path: Path, schema: MapSchema, item: (k: string) => A) => A
  sum: (ctx: Ctx, path: Path, schema: SumSchema, variants: SumVariants<A>) => A
  text: (ctx: Ctx, path: Path, schema: TextSchema) => A
  counter: (ctx: Ctx, path: Path, schema: CounterSchema) => A
  set: (ctx: Ctx, path: Path, schema: SetSchema, item: (k: string) => A) => A
  tree: (
    ctx: Ctx,
    path: Path,
    schema: TreeSchema,
    nodes: () => readonly FlatTreeNode<A>[],
    node: (id: string) => A,
  ) => A
  movable: (ctx: Ctx, path: Path, schema: MovableSequenceSchema, item: (i: number) => A) => A
}
```

`interpret(schema, ctx)` walks the schema tree, invoking the interpreter at each node. The child thunks (`() => A`, `(i) => A`, `(k) => A`) preserve laziness — composite interpreters can short-circuit recursion when capability requirements are not met.

### The six-layer stack

Pre-built layers compose fluently via `InterpretBuilder.with(layer).done()`:

| Layer | Transformer | Adds capability |
|-------|-------------|-----------------|
| 1. Bottom | `bottomInterpreter` | Identity ref: `[CHANGEFEED]`, `[NATIVE]`, `[SUBSTRATE]`, `[CALL]` carrier |
| 2. Navigation | `withNavigation` | Structural descent (`.fieldName`, `.index(i)`, `.key(k)`) |
| 3. Readable | `withReadable` | `.current`, `()`, `read(path)` — requires navigation |
| 4. Addressing | `withAddressing` | Stable identity: `[ADDRESS_TABLE]` — requires navigation |
| 5. Caching | `withCaching` | `INVALIDATE` + identity-preserving memoization — interposes above readable. `registerCacheHandler` **composes** handlers at the same path key (rather than overwriting), which is critical for sum fields where the parent product and the variant product both register handlers at the same path — both must fire on invalidation. |
| 6. Writable | `withWritable` | Mutation primitives: `REMOVE`, `TRANSACT`, `insert`, `delete`, `replace`, `increment`, text/sequence builders |

**Substrate Capabilities:** Substrates declare optional capabilities (`nativeResolver`, `positionResolver`, `treeNodeAllocate`) via the `SubstrateCapabilities` bag — the builder (`buildWritableContext`) attaches them as non-enumerable, non-writable properties keyed by the canonical names (or symbols, for `TREE_NODE_ALLOCATE`). Consumers narrow via type guards (`hasTreeNodeAllocation`) or the typed optional fields on `RefContext`.

**DevTools history (`DEVTOOLS_HISTORY`):** an optional, substrate-neutral **pull** capability (sibling of `BACKING_DOC`/`TREE_NODE_ALLOCATE`) for DevTools — `summary()` (serialized version + `opCount` + per-actor counters) and optional `valueAt(version)` time-travel. Guard with `hasDevtoolsHistory()`; absence is graceful. Loro implements it deeply (`fork()`-based `valueAt`), Yjs gives a summary, plain omits it. Read lazily via `exchange.docHistory(docId)` — never pushed through the observation bus.

**`WritableDiscriminantProductRef`** — the writable surface for discriminated unions. For a `DiscriminatedSumSchema<D, V>`, the writable ref exposes all fields (discriminant and non-discriminant) as `Plain<F[K]>` — that is, **read-only** values. Non-discriminant fields are callable (you can read them) but carry no `.set()`. The only mutation primitive is `.set()` on the union ref itself (via `ProductRef`) for whole-value replacement. This follows from sum interiors being opaque LWW values: variant fields are not independently addressable CRDT positions, and individual field mutation would violate the atomic replacement semantics of `lww-tag-replaced`.

Plus the orthogonal observation layer:

| Layer | Transformer | Adds |
|-------|-------------|------|
| Observation | `observation` | `subscribe`, `subscribeNode`, `RecursiveChangefeedProtocol<S>` |

(`observation` wraps an internal transformer, `withChangefeed`, which this document names where it discusses the layer's internals. Only `observation` is exported.)

The canonical "everything" stack:

```
const ref = interpret(schema, ctx)
  .with(navigation)
  .with(readable)
  .with(addressing)
  .with(writable)
  .with(observation)
  .done()
```

Or equivalently, `createRef(schema, ctx)` which produces this stack.

### Sum Addressing

Kyneta schemas support discriminated unions (`Schema.discriminatedUnion`), positional unions (`Schema.union`), and nullable sugar (`.nullable()`). All sum types resolve dynamically to a specific active variant.

However, Kyneta `Ref`s are designed to be stable, capable pointers to a topological location. If a `SumRef` bound eagerly to the active variant shape at creation time (e.g. producing an `AbsentRef`), it would become stale if the underlying CRDT data later shifted to a new variant (e.g. `PresentRef`). A React component holding that stale `AbsentRef` would fail to navigate the new fields, leading to incorrect runtime shapes and dropped data.

To solve this, **Sum nodes use "Sum Addressing" via a stateless Proxy.** 
Instead of returning a specific variant's carrier, `with-navigation` produces a Proxy that late-binds to the currently active variant on every property access (`Reflect.get(getActive(), prop)`). 

- **Perfect Identity:** The `SumRef` never changes identity. It can be safely held across renders.
- **Implicit Tracking:** The Proxy's `getActive()` closure executes `ctx.reader.read(path)` to evaluate the discriminant. This means any reactive computation (like `useTracked`) automatically subscribes to variant shifts simply by attempting to read a field on the sum.
- **Type Compatibility:** The runtime Proxy correctly acts as a mathematical discriminated union, mirroring the TypeScript type signatures (where reading a non-existent field on the inactive variant gracefully returns `undefined`).
- **Disparate Shapes:** The Proxy is strictly necessary for sums like `.nullable()`, where the `null` variant is a property-less scalar but the inner variant could be a rich composite (like a `Sequence` with `.at()`, `.length`, and iterators). A static carrier cannot model this safely.

To prevent the Proxy from recalculating and instantiating the full nested carrier stack for every property access, `with-caching` wraps the `variants` thunks (`byKey` and `byIndex`) in a simple `Map`-based memoizer before passing them down to `with-navigation`. The result is a rock-solid, type-safe, and highly performant union dispatch mechanism.

### Materialization

Source: `packages/schema/src/interpreters/materialize.ts`.

`createMaterializeInterpreter(resolver)` produces a generic `Interpreter<void, unknown>` that builds plain values from any CRDT backend. The `MaterializeResolver` interface abstracts the 6 backend-specific operations into two families:

**Leaf resolvers** (return typed value or `undefined` = not present):
- `resolveValue(path)` — scalar and sum values
- `resolveText(path)` — text content as string
- `resolveCounter(path)` — counter value as number
- `resolveRichText(path)` — rich text delta

**Container shape resolvers** (return structure metadata):
- `resolveLength(path)` — item count for sequences and movable lists
- `resolveKeys(path)` — key enumeration for maps and sets

The 11 interpreter cases partition into **container cases** (product, tree — structurally identical for all backends, no resolver calls) and **resolution cases** (the remaining 9, each calling one of the 6 resolver methods). Zero fallback is delegated to `zeroInterpreter` (scalars) and `Zero.structural` (sums), making the materializer the canonical consumer of zero defaults for CRDT substrates.

Three resolution cases — `sequence`, `movable`, `set` — share an array-collection pattern, factored into `collectArrayByLength(length, item)` and `collectArrayByKeys(keys, item)`. Sequence and movable use the length-based helper; set uses the keys-based helper. All three produce `Plain<I>[]` — `materialize.set` is **not** identical to `materialize.map`: sets project to `T[]` while maps project to `Record<string, T>`. The catamorphism's separate `set` branch carries semantic weight here, even though the storage-layer key enumeration is the same as map's.

Each backend provides a thin resolver factory (~50 lines): `createLoroResolver(doc, schema, binding)` and `createYjsResolver(rootMap, schema, binding)`. The closure-based design parallels `plainReader(state) → Reader` — the resolver closes over backend state, eliminating Ctx threading.

### Value materialization — the write-side unfold

Source: `packages/schema/src/materialize-value.ts` → `materializeValue`, `MaterializedNode`, `containerKey`, `fieldAbsPath`, `needsContainer`.

`createMaterializeInterpreter` (above) reads a CRDT container tree **into** a plain value. `materializeValue` is its write-side counterpart — it unfolds a plain value **into** a backend-agnostic container-shape IR (`MaterializedNode`), the operation behind `structRef.set({...})` and structured inserts. Where `foldPath` (`fold-path.ts`) owns the identity-keying rule for *navigation*, `materializeValue` owns it for *construction*: at every product-field boundary it keys the child by `containerKey(binding, extendSchemaPathKey(prefix, field), field)`, and map/set entries and list items keep their runtime key/index (matching `foldPath`'s "only `field` segments contribute to the abs-path" rule via the shared `fieldAbsPath`). Sum and json-boundary schemas short-circuit to an opaque `{kind:"plain"}` node.

`materializeValue` is **pure** — no substrate handles, no synthetic ContainerIDs, no global counters — so the identity-keying is unit-testable without any backend (`src/__tests__/materialize-value.test.ts`). Each backend supplies a thin realizer that turns the IR into native form: `realizeYjs` (post-order populate-then-attach) and `realizeLoro` (pre-order, minting Loro synthetic CIDs). Backends never compute a container key or read `binding`, so writer keys and reader keys agree **by construction** — a whole-struct write cannot land under a key the reader won't look up. The `EagerPolicy` argument (`"leaf-containers"` for Yjs, `"all-containers"` for Loro) selects how aggressively declared-but-absent container fields are pre-created; the two backends genuinely differ (Loro needs the container to exist before a nested write can land on it).

`"leaf-containers"` is a strict **subset** of `"all-containers"`, as the names promise: the first creates only the leaf containers (`text`, `richtext`), the second creates those *and* the structural ones. That relation now holds structurally, because both branches are expressed against the single `storageClass` classification (`schema.ts`) rather than against two switches that happened to line up. It did not always hold — `richtext` was missing from `needsContainer`'s switch and fell through its `default`, so `"all-containers"` skipped a container the narrower policy created. `materialize-value.test.ts` asserts the subset relation directly rather than per-kind expectations, so it keeps holding as kinds are added.

### What an `Interpreter` is NOT

- **Not a visitor pattern.** Interpreters return values; visitors mutate state. `interpret` is a catamorphism, not a traversal.
- **Not layered dynamically.** Layers compose at the type level. Once `.done()` is called, the stack is fixed.
- **Not framework-aware.** No React, no DOM. The `Ref<S>` the stack produces is a pure object with a `[CHANGEFEED]` surface; framework bindings (`@kyneta/react`, `@kyneta/cast`) adapt it.

### Interpreter duplication families

The 11 interpreter cases fall into four structural categories. The first three are **duplication families** — groups of cases that share identical logic across every transformer, captured by shared helper modules. The fourth has unique per-case logic.

| Family | Cases | Shared helpers | Shared algebra |
|--------|-------|---------------|----------------|
| **Indexed** (positional) | `text`, `sequence`, `movable`, `richtext` | `sequence-helpers.ts` — `at()`, `installTextWriteOps`, `installListWriteOps`, `installRichTextWriteOps`, `installSequenceReadable`, `installSequenceNavigation`, `installSequenceCaching` | `Instruction`, `foldInstructions`, `transformIndex`, `advanceAddresses` |
| **Keyed** (named) | `map` | `keyed-helpers.ts` — `installKeyedWriteOps`, `installKeyedReadable`, `installKeyedNavigation`, `installKeyedCaching` (address-table exposure is `installAddressTable` in `with-addressing.ts`, shared with sequences) | `MapChange`, keyed addressing/tombstoning |
| **Leaf** (terminal) | `scalar`, `text`, `counter`, `richtext`, **`set`** | `wireChangefeed` in `with-changefeed.ts` unifies changefeed boilerplate; `set-helpers.ts` provides `installSetReadable` and `installSetWriteOps` for the value-addressed set surface | `createNodeChangefeed`, `SetChange`, `samePlainValue` |
| **Structural** (unique) | `product`, `sum`, `tree` | None — each has unique per-case logic | Product: schema-driven fields + discriminant. Sum: store-based variant dispatch. Tree: thin pass-through. |

**`text` and `richtext` straddle two families.** They are indexed for writable (share `at()` and the retain/insert/delete instruction stream with sequence/movable) but leaf for readable, navigation, and changefeed (return `string` / delta directly, not a fold over children). Characters are not independently addressable refs.

The straddle is about these interpreter families and nothing else. For **storage** both are plainly containers — each is its own CRDT type — and `storageClass` (`schema.ts`) classifies them that way without qualification. Worth stating because the leaf half is the memorable one: `richtext` was once classified as a leaf for storage on the strength of it, which is the defect §"Value materialization — the write-side unfold" describes.

**`set` is leaf-shaped at the ref layer.** Although the catamorphism dispatches set children by string key (mirroring `map`), there are no per-member child refs at the user-facing API. The surface is `.has(value)`, `.add(value)`, `.delete(value)`, `.clear()`, `.size`, `[Symbol.iterator]`, callable returning `Plain<I>[]` — narrower than `map`'s, and value-addressed (no `.at(value)`). Invalidation is whole-carrier on any `SetChange` (same pattern as text/counter). See [§Set: value-addressed leaf](#set-value-addressed-leaf).

The `Interpreter` interface retains separate cases per kind — the sharing is internal to the built-in transformers. Substrate authors implement one case per kind; they never see the shared helpers.

The materialize interpreter is another duplication family — all CRDT backends share the same 11-case structure, varying only in resolution. The `MaterializeResolver` abstraction captures this by decomposing resolution into leaf resolvers (value, text, counter, richtext) and container shape resolvers (length, keys) that mirror the indexed/keyed duplication families.

**`attachNative` is intentionally skipped for sums in `interpretImpl`.** Sums are structurally transparent — the result carrier is the dispatched variant's carrier, which already has the correct `[NATIVE]` from its own interpreter case (product, scalar, etc.). Calling `attachNative` on the sum would double-define the property, crashing in substrates where the product resolves to a real container but the sum resolves to `undefined` (`configurable: false` + different value → `TypeError`).

### `NativeMap` and the escape hatch

`NativeMap<S>` is a type-level mapping from schema kinds to substrate-native types. `ref[NATIVE]` returns the underlying container — `LoroText` for a `text` on Loro, `Y.Map` for a `product` on Yjs, a plain object for the plain substrate. `unwrap(ref)` (`src/unwrap.ts`) is the typed escape hatch that returns `NativeMap<S>`.

Application code rarely touches `[NATIVE]`. Backends use it to dispatch to substrate-specific APIs. It is the only path through which substrate-specific behaviour leaks through the interpreter stack — and it is explicit at the call site.

### Read tracking — `withTracking` + the tracking context

Source: `src/interpreters/with-tracking.ts` (the layer) + `src/tracking.ts` (the pure context). Consumed by `@kyneta/reactive` for fine-grained auto-tracked reactivity (`useSelector`/`useValue` ultimately rest on it).

`withTracking` is the **outermost** layer in the canonical `createRef` stack (`.with(readable).with(writable).with(observation).with(tracking)`). When a *tracking scope* is active, every user-facing read reports a `Dependency` (a stable handle + an `Aspect`); when no scope is active, every wrapped accessor is a one-guard passthrough (the full suite passes unchanged either way). Subscription *policy* (aspect → changefeed primitive) lives in the runtime, not here.

**The pure context (`tracking.ts`)** is the functional core: a save/restore scope discipline (`withReadScope(fn) → { value, deps }`), a single mutation point (`reportRead`, a no-op when no scope is active), and `withoutTracking` (suppresses reports while a composite `()` folds its snapshot). FC/IS exemplars: `@kyneta/index`'s `integrate` and `@kyneta/machine`'s `Program`/runtime.

**Aspect inference** (read-method × node-kind):

| Read | Node kind | Aspect |
|------|-----------|--------|
| `()` | leaf (scalar/text/counter/richtext/**set**) | `value` |
| `()` | composite (product/sequence/map/tree) | `deep` (fold suppressed — the dep subsumes the subtree) |
| `.at` / `.length` / iteration / `.keys` / `.has` / `.size` / `.entries` / `.values` | sequence/movable/map | `structure` |

Products report nothing on field navigation (fixed fields); the child carrier reports its own reads. **`identity` is folded into `structure` for v1**: navigating a dynamic container reports `structure`, which soundly catches moves/deletes — so the runtime needs only `subscribeNode`/`subscribeDescendants`, no `address.listeners` wiring. Completeness (no missed reads) is verified against the helpers: every accessor that touches the substrate is wrapped, or delegates to one that is (`.get`/iteration route through `.at`; map `.has`/`.keys`/`.size`/`.entries`/`.values` read `reader.keys`/`hasKey` directly, so all are wrapped).

**Stable keys without addressing internals.** Dependency keys are derived from the carrier's *object identity* (a `WeakMap<carrier, id>`), which is already **cursor-stable** — `.at(i)` is backed by the address table keyed on `Address.id` (`installSequenceCaching` in `sequence-helpers.ts`), so the same logical element yields the same carrier object across structural change. A dep key is therefore invariant under inserts/deletes (an insert before a tracked element does not change its key) while keying transitively on `Address.id` — no addressing-internals integration needed.

The aspect vocabulary harmonizes with `@kyneta/compiler`'s `DependencyClassification` (`experimental/compiler/src/classify.ts` — `structural`/`item`/`external`): `structural` is shared; `value`/`identity` refine the compiler's `item`; the compiler's `external` (reading another reactive source) is the runtime's plain-`HasChangefeed` `.subscribe` branch, not a schema-ref read. One classification model — the compiler is its AOT face, `withTracking` its JIT face.

---

## Validation

Source: `packages/schema/src/interpreters/validate.ts`.

A separate interpreter — not required by the stack, not automatic. `validate(schema, value)` returns `ValidationResult` collecting every error in the tree; `tryValidate` throws on the first. `SchemaValidationError` carries a structured `path` and a human-readable `message`.

Validation is an *interpretation* of the schema. The same `Schema` value that builds a ref also validates untrusted input. Errors format via `path.format()` for human-readable output.

Not used by the exchange. Not automatic on `bind`. Opt-in at boundaries where untrusted data enters the system.

---

## Zero / defaults

Source: `packages/schema/src/zero.ts`.

`Zero(schema)` computes a default `Plain<S>` value for any schema. Defaults:

- `string` → `""`, `number` → `0`, `boolean` → `false`, `null` → `null`, `bytes` → empty `Uint8Array`.
- Product → each field's default.
- Sequence / movable → `[]`.
- Map → `{}`.
- Set → `[]` (matches `Plain<SetSchema<I>> = Plain<I>[]` — distinct from map, which is `Record<string, T>`).
- Sum → first variant's default.
- Text → empty text.
- Counter → `0`.
- Tree → empty forest `[]` (matches `Plain<TreeSchema<I>> = readonly PlainFlatTreeNode<I>[]`).

`scalarDefault(kind)` is the scalar-only version. Used by `createDoc` when no initial state is supplied, by migrations' `setDefault` primitive, and by tests.

The materializer is the canonical consumer of zeros for every shadow-carrying substrate: the `zeroInterpreter` is the single source of truth, and no substrate writes zeros into its native state. CRDT initialization routines (`ensureRootContainer`, `ensureContainers`) only create structural containers, and the ephemeral substrate's tree starts empty. A zero is what the fold answers for a node nothing has been written to, or one decay has retired.

---

## Describe

Source: `packages/schema/src/describe.ts`.

`describe(schema)` returns a human-readable ASCII tree of the schema structure. Used in tests, logs, and documentation. Not used at runtime by any interpreter.

---

## Change vocabulary

Source: `packages/schema/src/change.ts`.

Every mutation flows through a `Change` — a discriminated union identified by `type`. The built-in types:

| `type` | Shape | Composition law | Used by |
|--------|-------|-----------------|---------|
| `"text"` | `{ instructions: TextInstruction[] }` — retain / insert / delete over characters | `positional-ot` | Text CRDTs |
| `"sequence"` | `{ instructions: SequenceInstruction[] }` — retain / insert / delete over items | `positional-ot` | Lists, movable lists |
| `"map"` | `{ set?, delete?, clear? }` — set / delete over keys, or clear the map | `lww-per-key` | Records, and products' fields |
| `"tree"` | `{ instructions: TreeInstruction[] }` — create / move / delete nodes | `tree-move` | Trees |
| `"replace"` | `{ value: unknown }` — overwrite this node | `lww` | Scalars, plain JSON sub-trees |
| `"increment"` | `{ delta: number }` — counter increment | `additive` | Counters |
| `"richtext"` | `{ instructions: RichTextInstruction[] }` — retain / insert / delete / format over characters | `positional-ot` | Rich text CRDTs |

**A map change's `clear` is intent, not a key list.** It says every key goes, seen or not, before `delete` and `set` apply, and which keys that reaches is the substrate's merge law to decide. `mapChangeEffects(change, held)` is the single definition of what a map change removes and writes, given the keys a consumer holds: a key named in both `delete` and `set` ends up set, and a clear removes every held key the change does not set. `step`, `invert`, the address table and the Loro and Yjs bridges all read map changes through it, each against its own keys, which is what observed-remove is. The ephemeral substrate is the one reader that does not expand a clear: it raises a horizon over the whole map (see [Deletion](#deletion)). `record.clear()` dispatches the intent every time, even on a record that looks empty.

Note: `TextChange` and `SequenceChange` are parameterizations of the same positional algebra, unified by the `Instruction` type. Both use `retain`/`insert`/`delete` cursor instructions; the only difference is the content type (`string` vs `T[]`). The shared algebra is captured by `foldInstructions`, `transformIndex`, and `advanceAddresses`, which operate on `Instruction` generically.

`ChangeBase` is re-exported from `@kyneta/changefeed` — the open protocol base. Third-party backends may extend with additional `type` values; the exchange and interpreters treat unknown types as opaque, passing them through.

### `Change` flows both ways

- **Inbound** (developer → substrate): the proxy in `batch(doc, fn)` records changes describing *intent*.
- **Outbound** (substrate → subscribers): the substrate's changefeed emits changes describing *what happened*.

The shapes are identical. The substrate's `prepare` pipeline consumes the inbound changes, applies them, and re-emits (potentially transformed) outbound changes.

### Constructors, guards, and transforms

For every built-in change type:

- Constructor: `textChange(instructions)`, `sequenceChange(instructions)`, `mapChange(set, delete)`, `mapClearChange(set)`, etc.
- Type guard: `isTextChange(change)`, `isSequenceChange(change)`, etc.
- Pure transformer: `foldInstructions(instructions)`, `advanceIndex(index, instructions)`, `advanceAddresses(addresses, instructions)`.

`applyTextInstructions(target, instructions)` replays a `TextInstruction[]` delta onto a live `TextRef`. It is the **imperative shell over `textInstructionsToPatches`** — it converts the cursor-based instructions to absolute-offset patches, then dispatches each to `TextRef.insert`/`.delete` (the `TextRef` counterpart to applying those patches to a DOM `Text` node via `insertData`/`deleteData`; see [Position algebra](#transformindex-and-textinstructionstopatches)). It is *not* built on `foldInstructions`: that is a dual source/target cursor fold for diffs, whose `insert` case carries only a length, not content — the wrong sibling for single-cursor, content-carrying replay.

These are the primitives `step`, `with-changefeed`, and `Position` build on.

---

## The write path

Source: `packages/schema/src/facade/batch.ts`, `src/step.ts`, `src/inverse.ts`, `src/interpreters/with-changefeed.ts`, `src/interpreters/writable.ts`.

`batch(doc, fn)` is the atomic mutation facade. `ctx.runBatch` returns the authored ops its frame captured, so `batch` is one line:

```ts
batch(doc, fn, opts) = ctx.runBatch(() => fn(doc), opts)
```

**Convention.** A single mutation needs no `batch()` — a bare helper call (`doc.x.set(v)`) opens an implicit single-op `runBatch` and auto-commits. Reach for `batch()` only to (a) group ≥2 writes into one atomic commit + one `Changeset`, (b) capture the returned `Op[]`, or (c) attach `origin`/`source` provenance. The name leads with batching; the atomic-abort guarantee (a throwing block compensates LIFO and emits one `Changeset` with `aborted: true`) is the contract that makes a multi-write batch safe — it is still a *transaction in the algebraic sense*, just not a DB-style transaction with isolation/durability.

End-to-end flow:

1. `change` resolves `ref[TRANSACT]` → the `WritableContext`.
2. `ctx.runBatch(work, opts)` opens a frame (push on `frameStarts`/`inverseStack`). At depth-0 entry it opens the batch's **trace** and invokes the substrate's `runBatch` bracket (Loro `doc.commit()` after the body, Yjs `Y.transact`) inside the delivery dispatcher's `hold`.
3. `fn(doc)` runs. Inside `fn`, each helper (`.set`, `.push`, `.insert`, …) routes through `ctx.dispatch(path, change)` — the depth-aware combinator. Inside a frame, dispatch is just `ctx.prepare`; outside any frame it opens an implicit single-op runBatch (auto-commit).
4. `ctx.prepare(path, change, { ingress: "author" })` calls `substrate.prepare(path, change, recordInverse)` and appends the op to the trace. The substrate captures σ at the change's target path, computes the inverse via `invert(pre, change)` and records it on the active frame, then advances σ and λ in lockstep.
5. After `fn` returns, still inside the bracket, the depth-0 release calls `substrate.afterBatch()` and **seals** the batch: the trace becomes a `SealedBatch` (`{ options, ops }`) and is dispatched for delivery. The native commit closes, the `hold` ends, and the delivery dispatcher calls `ctx.deliver(batch)` → `planDelivery` → `deliverNotifications`. One `Changeset` per affected subscriber.
6. If `fn` throws, the catch path replays this frame's recorded inverses LIFO through `ctx.prepare(path, inverse, { ingress: "compensate" })` (reaching the substrate with `recordInverse === null`), runs `afterBatch`, seals the batch with `aborted: true`, then rethrows once it has been delivered. External observers see one batched native event whose ops net to zero.

The substrate's `runBatch` bracket invocation is gated on `frameStarts.length === 0`: substrate.runBatch is invoked at most once per outermost block, regardless of how deeply `dispatch` nests. The exchange sees the transaction as a single `merge` source: after commit the substrate's `exportSince()` captures the entire delta.

### Depth-aware `dispatch`

`WritableContext.dispatch` is a depth-aware combinator. The 5 ref-helper files (`scalar.set`, `sequence.push`, etc.) and the addressing layer's `REMOVE` handler all route through it, and it branches on one local condition: `dispatch = frameStarts.length === 0 ? implicitSingleOpRunBatch : justPrepare`. Inside a batch a dispatch is just a prepare, because the outer frame owns the seal; outside one it opens an auto-committing single-op `runBatch`.

Keeping the combinator rather than converting every helper is what lets in-block helpers collapse into one substrate commit and one `Changeset`, with no per-helper bracket re-entry.

**Reads inside `fn` see earlier writes in the same block.** σ advances on every prepare, so `d.todos.push("a"); d.todos.push("b")` appends in order. Length-derived helpers depend on this: a helper that read a stale σ would compute the wrong position.

---

### `runBatch` — one bracket, three handlers

Under the three-primitive substrate contract, `ctx.runBatch` is **one bracket primitive with three handlers**, not three concentric brackets. Inside the bracket, `prepare` is the single effect; the three handlers all key off the same `frameStarts.length` depth:

1. **Substrate handler** — invoked only at the depth-0 entry. Loro: `doc.commit()` after the body, in a `finally` so an aborted batch is committed too. Yjs: `Y.transact(doc, work, options.origin)`. PlainSubstrate omits this method; the ctx-level wrapper invokes the body directly. The Loro per-substrate depth counter is no longer needed — ctx-level outermost detection subsumes it.

2. **Seal handler** — fires exactly once at the depth 1→0 transition, inside the bracket. It runs `substrate.afterBatch()` and seals the batch: success path `{ ...opts, ingress: "author" }`, catch path with `aborted: true`. Inner frames push/pop without sealing — the depth-0 release is the single seal per outermost block. Delivery happens after the bracket closes (see below).

3. **Inverse-stack handler** — every successful authored `prepare` pushes an `InverseEntry` (path + reverse arrow). On throw, the frame's range is replayed LIFO through `ctx.prepare(path, inverse, { ingress: "compensate" })`, which hands the substrate no recorder, so the inverse of an inverse is never recorded. External observers see one batched native event whose ops net to zero.

The three handlers are co-extensive — they all open and close at the same boundary. Every authored write goes through `ctx.runBatch` (`batch`, `applyChanges`, or `dispatch`'s auto-commit); `announce` bypasses it, because the substrate has already applied those ops and there is nothing to bracket.

Substrate.runBatch is invoked at most once per outermost `batch(doc, fn)`. Re-entrant subscriber writes run after the outer native commit has closed, so each opens its own outermost runBatch: each block is its own atomic abort unit, with its own native commit and its own origin.

### The batch lifecycle: capture, seal, release

Source: `src/interpreters/writable.ts` (`buildWritableContext`, `authoredSince`, `seal`).

**Changesets are delivered in seal order, each after every native commit that was open when it was sealed.** The writable context owns the whole lifecycle, because it is the one place that sees both which ops belong to which batch and when a native commit is open:

- **Capture.** A stack of **traces**, each a list of `{ op, authored }`. The outermost `runBatch` frame opens one, and so does `announce`. The base `prepare` appends every op to the top trace; with no trace open it throws. An announcement made while an authored batch is open gets its own trace, so neither batch can pick up the other's ops.
- **The trace is also `batch()`'s return value.** Each frame notes the trace length on entry and returns `authoredSince(trace, start)`: the authored ops, without compensations. The sealed changeset carries every entry.
- **Seal.** At the end of the outermost frame, inside the bracket, `afterBatch` runs and `seal(trace, options)` makes a `SealedBatch`. The trace is popped at once, so a stray prepare afterwards throws instead of joining a sealed batch.
- **Release.** Each context has one delivery dispatcher (`createDispatcher`, label `"changefeed"`, message `{ type: "deliver", batch }`, the context's `lease`), created on first use. `runBatch` runs the substrate bracket inside `deliveries.hold(...)`: anything sealed while it runs — the batch itself, and any announcement a native listener triggers during the commit — queues, and drains in seal order when the commit closes. The dispatcher's handler calls `ctx.deliver(batch)`, which the changefeed layer wraps.

Two consequences worth knowing:

- **A re-entrant `batch()` during delivery** runs its bracket at once (`hold` inside a drain just runs its function), so its writes land synchronously; its changeset queues behind the one being delivered.
- **A merge inside a `batch()` body** is announced and sealed before the surrounding batch seals, so it is delivered first, as its own `replay: true` changeset.

### The step function, and its mutating dual

Source: `packages/schema/src/step.ts`.

`step(state, change)` → `state` is the pure transition function — the algebra's arrow. It handles every built-in change type (`stepText`, `stepSequence`, `stepMap`, `stepReplace`, `stepIncrement`, `stepRichText`, `stepSet`, `stepTree`). Tests use it to verify change semantics without constructing a substrate.

Purity has a cost that only shows up in bulk: returning a fresh σ' means rebuilding the whole carrier, so *k* writes into a container of size *n* cost O(n·k) — a batch that fills a list or a record is quadratic in its own size.

Every container case of `step` is already `copy-then-mutate`. Those mutating cores are factored out, `step`'s container cases are defined as copy ∘ core, and `stepInPlace(state, change)` is the same arrow without the copy. There is one implementation of the semantics and two entry points into it; `src/__tests__/step.test.ts` pins both halves — that `step` never reaches through its copy into σ, and that the two duals agree.

`stepInPlace` returns the σ it was given when δ's carrier is a container (map, sequence, set, tree), and a new value otherwise (text, scalar, counter, rich-text delta, or a δ whose carrier contradicts the σ at the path). `applyChange` compares identities and writes back only in the second case.

Substrates use `stepInPlace`, and may, because each one owns its document: the reader is a documented live view of it (see the liveness invariant on `plainReader`), and `prepare` takes the inverse from σ *before* the write. Advancing a container's contents and replacing the container are therefore the same observation — at O(|δ|) instead of O(|σ|).

### Inverse algebra

Source: `packages/schema/src/inverse.ts`.

The change algebra `⟨State, Change, step⟩` is extended into a groupoid by `invert(pre, change)`: a reverse arrow such that `step(step(pre, change), invert(pre, change)) = pre`. This is the groupoid identity law `c ∘ c⁻¹ = id` written in coordinates; the per-type test table pins it for every `ChangeBase` constructor.

| Type | Inverse shape |
|------|---------------|
| `replace` | swap value (`replaceChange(pre)`) |
| `increment` | negate amount |
| `text` | OT inverse: retain → retain, insert → delete, delete → insert (text from pre at preCursor) |
| `sequence` | OT inverse with deep-cloned items |
| `map` | restore prior entries; new keys → delete; overwritten keys → set to prior value; a clear restores every entry held before it |
| `set` | swap add/remove (set membership equality, not order) |
| `richtext` | OT inverse with mark restoration |
| `tree` | per-instruction inverse with pre-state topology lookup; reversed instruction order for LIFO undo |

Substrates read `pre = path.read(σ)` before applying the forward change — no copy, because `invert` snapshots whatever it retains — compute the inverse, and push it onto the active runBatch frame's stack via the `recordInverse` callback `prepare` receives for a forward write. On throw, the bracket's catch path replays inverses LIFO inside the same commit — observers see one batched event with net-zero delta.

### The projection law

The substrate is a functor `Π : ChangeGroupoid → NativeStateCategory` (σ, λ and Π are defined in [Vocabulary](#vocabulary)). The **projection law** `σ ≡ Π(λ)` is the naturality of `Π` between the abstract state and the CRDT-native state. It holds at every prepare boundary. Stated as two naturality conditions over the change groupoid:

- Forward: `Π ∘ step_λ(c) = step_σ(c) ∘ Π`
- Inverse: `Π ∘ step_λ(invert(c)) = step_σ(invert(c)) ∘ Π`

Both must hold. Naturality over `invert` is what makes the abort path correct: when the bracket replays inverses inside the same commit, the σ-side compensation matches the λ-side compensation step-for-step, so external observers see one batched event with net-zero delta simultaneously on σ AND λ. A backend whose `applyChange` is not natural over `invert` would fail abort silently (σ revert, λ partial — or vice versa).

Substrate-implementation contract: **any backend whose `applyChange` is a natural transformation over the change groupoid (forward AND inverse arrows) automatically gets correct abort for free.** PlainSubstrate is the degenerate case (σ ≡ λ, Π = id; both naturality squares hold trivially). Loro and Yjs satisfy naturality by design.

A bridged change can't use incremental σ-step: CRDT merge is a lattice join with no sequential decomposition. The correct response is `syncShadow(materialize(λ))` in the event bridge, before the announcement — re-materialise σ from λ in one Π pass.

### Op payloads are snapshots, not views

An op's payload is a value, not a window onto the store. Two independent copies make that true, and one alone cannot: there are three parties — the caller, the op, and the store — and each of the latter two must be immune to mutation by the others.

- **`own(value)`**, at construction, in the `.set()` family. Copies the caller's object so the op keeps a value. Enforced by the type system: `replaceChange` takes `Owned<T>`, so a construction site must call either `own` (copy) or `trustAsOwned` (assert nobody else holds it). The brand covers object payloads only — a primitive cannot be aliased, and branding them multiplied the call-site edits sixfold for no safety.
- **`ownedForStore(change, options)`**, at the store boundary, in each substrate's `prepare`. Copies the payload before `applyChange` writes it in, so a later write into that subtree cannot rewrite an op a subscriber is still holding.

The store edge applies to **all four `PlainState`-backed substrates**: plain, ephemeral, and both CRDT backends, whose shadow (σ) is a plain object mutated by the same `applyChange` even though their native tree (λ) is not.

Merged changes are copied too. It is tempting to skip them, since a wire-built op has no local caller — but that is a fact about the *caller* edge. The store still takes the payload and later mutates it, and a merge's changesets reach subscribers like any other. Nothing is exempt, decay ticks included: a tick names the fields its re-projection moved and carries their values, so its payload and σ take separate copies.

**The cost, measured end-to-end, is a few percent on small writes and a large *improvement* on writes into a big collection** — because removing the inverse-path clone below matters more than adding the ownership copies. That clone captured pre-state at the write's path, which for a record entry is the *whole record*: the old cost scaled with collection size, and the new one does not.

Comparing clone costs in isolation predicts the opposite, and is misleading twice over: `batch()` carries fixed overhead that dwarfs a small copy, and it ignores what the change removes. Measure the whole write.

**The inverse path does not need its own copy.** Each substrate used to `deepClonePlain` the pre-state before handing it to `invert`. `invert` already snapshots whatever it retains — `invertReplace`, `invertMap`, `invertSequence` and the rich-text marks each clone what they capture — so the substrate-side copy protected nothing and cost a deep clone of the written subtree on every local write.

**Finding every aliasing site.** Reading the code is not sufficient here; it missed a whole substrate. The reliable method is to make the hazard loud: wrap `replaceChange`'s payload in a deep freeze and run the suites, and every mutation through an alias throws at the frame responsible. Three paths hand the store a value they legitimately own and must be excluded from such a run, or they report artifacts rather than defects: genesis (`objectToReplaceOps` in `buildUpgrade`, applied directly and never delivered), and the ephemeral substrate's two wake-up triggers.

### `applyChanges(ref, changes)`: declarative application

Source: `src/facade/batch.ts`.

Sometimes changes arrive as data (from the network, from undo history, from tests). `applyChanges(ref, changes)` applies a `readonly Change[]` via the same substrate write path — no prepare facade, just direct substrate writes + notification planning.

### `remove(ref)`: ergonomic self-removal

Source: `src/facade/batch.ts`.

A container's child ref carries `[REMOVE]()` (a symbol method — see `Removable<T> = T & HasRemove` in `src/ref.ts`), symbol-keyed for collision safety: a child can be any schema kind, including a struct with a user field literally named `remove`, so a plain `.remove()` method would shadow it. `remove(ref)` is the free-function facade over that symbol — the same collision-safe symbol-protocol + free-function-facade pattern as `unwrap` (`[NATIVE]`), `changefeed` (`[CHANGEFEED]`), and `batch` (`[TRANSACT]`). Prefer `remove(ref)` at call sites; reach for `ref[REMOVE]()` only when you already hold the symbol. Like any single mutation, a lone `remove()` auto-commits (no `batch()` needed). It throws on a dead ref, and its `HasRemove` parameter type rejects non-removable refs (product fields, top-level docs) at compile time.

### What the write path is NOT

- **Not async.** `batch()` is synchronous. The substrate's writes happen synchronously during `fn`. Notifications for the originating transaction fire after its native commit and before `batch()` returns; re-entrant `batch()` calls from inside a subscriber queue their changesets on the delivery dispatcher, which drains them before the outer call returns — still synchronous from the caller's perspective.
- **Not an effect system.** Side effects inside `fn` (network calls, DOM writes) run where they are called. Only the substrate-writable mutations are captured.

---

## Abort and re-entry

Two guarantees that follow from one boundary: the bracket belongs to the *outermost* block. A block that throws is compensated inside its own bracket, so observers see one event whose ops net to zero. A `batch()` issued from inside a subscriber runs after the outer bracket has closed, so it is an outermost block of its own — its own bracket, its own commit, its own `Changeset`, delivered after the one that triggered it.

### `Changeset.aborted`

A Changeset with `aborted: true` is the bracket's signal that the outermost `batch(doc, fn)` block threw and was wholly compensated via inverse replay. The op list contains forward + inverse pairs that net to identity at every path. Inner `batch()`s that threw and were caught by an outer `batch()`'s try/catch produce a NON-aborted outermost Changeset; the absorbed forward + inverse pair sits in the op list alongside surviving outer ops. Consumers needing to identify absorbed inner aborts pair the ops semantically (the framework doesn't surface a separate flag for this).

The `aborted` flag is tightened: `true` iff the outermost block threw. Auto-commit blocks and successful outermost blocks have `aborted: undefined` (== falsy). Replay batches have `aborted: undefined`.

### Compensation and buffered substrates

**On a buffered substrate, compensation can mask the original error.** If a substrate (like Loro) buffers changes (e.g., `coalesceBuffer`) or throws synchronously during `prepare`, Kyneta's eager inverse recording causes the compensation loop to apply inverses for changes that were never actually committed to the substrate. This can cause the compensation loop itself to crash (e.g., throwing "Index out of bound" when attempting to revert an uncommitted insert). A `try/catch` in the compensation loop ensures the original error is chained via `Error.cause`, but the architectural mismatch between eager inverse recording and buffered substrate application remains a known limitation.

**Future Direction:** This will eventually be resolved by a deeper architectural shift, such as a "two-phase prepare" (recording inverses only after successful substrate application) or by pushing transaction boundaries and rollback responsibilities down to the substrate.

### Re-entrant `batch()` inside subscriber callbacks (drain-to-quiescence)

Subscriber callbacks may mutate freely. `batch()` invoked from inside `subscribe(doc, ...)` or `subscribeNode(doc.field, ...)` does *not* throw. The outer batch's native commit has already closed, so the inner `batch()` is an outermost block: its bracket runs at once, and its sealed changeset queues on the context's delivery dispatcher (from `@kyneta/machine`'s `createDispatcher`), whose drain-to-quiescence loop delivers it after the originating Changeset.

Substrate writes inside the re-entrant `batch()` remain **synchronous** — subsequent reads see the new state.

When the host is an `Exchange`, every per-doc delivery dispatcher shares the Exchange's `Lease` with the Synchronizer. Cross-doc A→B→A cascades, and tick-induced re-entry through the synchronizer, are bounded by one cooperating budget. A runaway oscillation throws `BudgetExhaustedError` whose message names the cascade's entry-point frame, a top-N message-type histogram, and a recent-event tail — the label histogram is the cascade *topology* and the count distribution names the *hot path*, so users can locate the responsible subscriber without ad-hoc instrumentation.

See `@kyneta/machine`'s TECHNICAL.md §"Drain to quiescence and shared leases" for the primitive.

### Subscriber visibility of mid-batch re-entry

`deliverNotifications` iterates subscribers `[S1, S2, S3]`. If S1 calls `batch(doc, ...)` synchronously, S1's substrate writes land *before* S2 fires. S2 receives the `Changeset` describing the originating transaction, but reads from — and may write through — a substrate that already includes S1's mutations.

This invariant is uniform across all substrates — plain, Loro, Yjs — because every substrate now advances **both** of its state stores in lockstep at prepare-time:

- σ (the shadow, the reader's view) advances eagerly via `applyChange(shadow, path, change)`.
- λ (the native container tree, the change-mapping's view) advances eagerly too: PlainSubstrate has λ ≡ σ; CRDT substrates run their native mutation primitive immediately during `prepare` (Loro coalesces plain MapDiff writes and applies structural inserts on the spot; Yjs invokes `applyChangeToYjs` against the live `Y.Doc` inside the ambient transact opened by `runBatch`).

Concretely, the projection law `σ ≡ Π(λ)` (the naturality condition of the materialisation catamorphism) holds at every prepare boundary. A re-entrant subscriber may either read through σ (via the Reader / the ref `[CALL]`) or write through λ (via re-entrant `batch()`, which itself walks λ through `changeToDiff`/`applyChangeToYjs`) — both views are coherent.

When the outer batch is an **announcement** (e.g. an incoming sync merge), S1's re-entrant write during its delivery is an ordinary authored batch, so the substrate's `prepare`/`afterBatch` apply it natively. This is why `ingress` is a required parameter on every batch rather than an ambient flag around the event bridge: a flag would cover S1's write too, and the substrate would silently drop it. See [Batch metadata](#batch-metadata).

Two guidances:

- The `Changeset` you receive describes the transaction that triggered your callback.
- The substrate state you read (and can safely write through) reflects everything up to now, including re-entrant writes from earlier subscribers in the same deliver batch.

To derive "pure pre-mutation state," consume the `Changeset` semantically; do not infer it by reading the substrate. This was always true in spirit — subscribers run after substrate commit — and the dispatcher is what makes re-entry from S1 succeed rather than throw.

---

## Batch metadata

Source: `src/substrate.ts`, `src/interpreters/writable.ts`, `src/interpreters/with-changefeed.ts`.

Every batch declares how it reached the changefeed, in a **required** `ingress`. Nothing defaults: a call site that forgets to say it is a compile error rather than a silent claim of local authorship.

```ts
type BatchIngress = "author" | "announce"
type PrepareIngress = BatchIngress | "compensate"

type BatchOptions =                                   // SealedBatch.options
  | (CommitOptions & { ingress: "author"; aborted?: boolean })
  | { ingress: "announce"; origin?: string }
interface PrepareOptions { ingress: PrepareIngress }  // ctx.prepare
interface CommitOptions { origin?: string; source?: unknown } // batch, applyChanges, runBatch
interface MergeOptions { origin?: string }            // merge, resetFromEntirety
```

| ingress | how it arrives | `substrate.prepare` | `batch()` return value | `substrate.afterBatch` | `Changeset.replay` |
|---|---|---|---|---|---|
| `author` | `dispatch` (inside `runBatch`, or auto-committing) | `(path, change, recordInverse)` | forward op | at the depth-0 seal | `false` |
| `compensate` | the undo handler inside `runBatch` | `(path, change, null)` | not returned | (the author seal) | — |
| `announce` | `ctx.announce(ops, origin)` | not called | not returned | not called | `true` |

The union encodes two contracts. Only an authored batch carries `source` (an echo token names a local caller and never survives a merge), and only an authored batch can be `aborted`.

`BatchOptions` does not extend `BatchMetadata`. The four `Changeset` channels are derived from it by one pure function, `changesetMetadata` (`with-changefeed.ts`), at delivery:

- **`origin`** — opaque application-level label. Propagates to `Changeset.origin` so subscribers can categorize batches (`"sync"`, `"undo"`, `"migration"` — or anything else). The schema layer and the exchange **never branch on origin's value**. It is *free vocabulary* for app code.

- **`replay`** — `ingress !== "author"`: true iff no local writer authored the batch (a substrate event bridge, a `merge` payload, an ephemeral decay tick). **User-facing APIs (`batch`, `applyChanges`) cannot produce it**: they only ever build `author` batches.

- **`source`** — identity-typed echo-suppression token. Compared with `===` by subscribers that issued the change. Unlike `origin` (app vocabulary) and `replay` (kyneta-internal), `source` is a kyneta-managed handshake between writer and reader: the originating `batch()` caller mints a token (`Symbol("...")` or `{}`), passes it via `options.source`, and the same token round-trips to `Changeset.source` so the caller's subscriber can identify and skip its own writes. The schema layer NEVER branches on `source`'s identity. An announcement has no `source`, so any value reaching a subscriber is from a local `batch()` on this peer.

- **`aborted`** — kyneta-internal outcome directive. See §"`Changeset.aborted`" above.

These four fields are *orthogonal* — they form a two-axis classification (app-set / subscriber-set / kyneta-set × provenance / outcome). See `BatchMetadata` in `@kyneta/changefeed`'s TECHNICAL.md for the full table.

Layered consumers that need to discriminate "echo from sync" from "local write" — notably `@kyneta/exchange`'s auto-subscribe filter — read `Changeset.replay` rather than parsing the `origin` string. This closes a fragile string-collision surface where `batch(doc, fn, { origin: "sync" })` was accidentally suppressed and `doc.import(payload, "from-some-other-pubsub")` would echo to peers.

The "schema layer and exchange never branch on origin's value" invariant is **structurally true** — a conflation that once crept into `text-adapter` (`origin === "local"` for echo suppression) and `Line` (a dead `origin === "local"` filter) was rectified by introducing the identity-typed `source` channel and removing the dead Line filter.

### The CRDT's origin slot belongs to the application

Kyneta is a translucent layer over the underlying CRDT, and the user-facing origin slot — `batch.origin` in Loro, `transaction.origin` in Yjs — is reserved for `options.origin` round-trip. Providers and ecosystem libraries (Yjs `UndoManager.addTrackedOrigin`, `y-websocket`, `y-indexeddb`) depend on that slot being app-controlled; a Kyneta sentinel there would force every app to fork those tools or accept Kyneta as opaque to its own ecosystem. So the substrate's "is this commit mine?" discriminator travels through the CRDT's own event machinery instead: Loro's pre-commit hook, Yjs's `transaction.meta`. Each is substrate-shaped and documented in its backend's TECHNICAL.md.

**The limit of commit-level discrimination.** Mixing raw CRDT mutations with Kyneta `batch()` calls inside one atomic unit — a Yjs `transact` body, or Loro pending ops before a Kyneta-issued commit — is unsupported: the raw mutations are absorbed into the own-commit skip and never bridged to the changefeed. Use separate transacts or commits. No origin-free approach can do better without op-level provenance, which neither CRDT exposes.

---

## Tree-observable changefeeds

Source: `packages/schema/src/changefeed.ts`, `src/interpreters/with-changefeed.ts`.

Every schema-issued changefeed implements `RecursiveChangefeedProtocol` — the schema-specific extension of `@kyneta/changefeed`'s universal `ChangefeedProtocol`. It adds `subscribeDescendants`, which delivers own-path + every descendant in one `Changeset<Op>` where each `Op = { path, change }` carries the relative path from the subscription point.

```
interface RecursiveChangefeedProtocol<S, C> extends ChangefeedProtocol<S, C> {
  current: Plain<S>
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
  subscribeDescendants(callback: (changeset: Changeset<Op<C>>) => void): () => void
}
```

Every node — leaf or composite — registers its deep subscribers at **its own path**, and delivery finds them by walking each changed path's ancestors (see [`planDelivery` → `deliverNotifications`](#plandelivery--delivernotifications)). A composite does not subscribe to its children; there is no aggregation step and no subscription graph. For a leaf, the deep channel carries exactly its own change at the empty relative path — a leaf is a tree of size 1.

`subscribe` (own-path only, `Changeset<C>` shape with no paths) is the lighter sibling. The two channels carry the same information for a leaf and different information for a composite (where own-path ⊊ tree).

Facade vs. protocol vocabulary inversion: facade `subscribe` is deep delivery (`Changeset<Op>`); the protocol-level `ChangefeedProtocol.subscribe` is own-path delivery (`Changeset<ChangeBase>`). The facade hides this; power users reaching directly into `ref[CHANGEFEED]` should know it.

> **Principle.** Facade-level entry points should hide protocol-method-set distinctions when the user's semantic is well-defined regardless of carrier kind. "Subscribe to changes under this ref" is well-defined for any reactive value; whether the value happens to have children is a structural concern, not an observation concern. The facade once threw on `subscribe(leaf)` because leaves lacked `subscribeDescendants`; lifting `subscribeDescendants` to every schema-issued changefeed retired that leak.

**The pure helper.** `liftToOps(cs, path): Changeset<Op<C>>` raises shape from `Changeset<C>` to `Changeset<Op<C>>` at a constant path. It is used for the tree's synthesized delete terminal, which is the one event not derived from an op. Ordinary delivery needs no shape transform beyond the one `deliverNotifications` performs when it rebases a change to a subscriber's relative path — computed once, at the point of delivery. (`prefixOps`, which prepended a prefix at each level as a change propagated up the subscription graph, is gone with the graph.)

`subscribe(ref, callback)` is the facade primitive that calls `subscribeDescendants` under the hood. `subscribeNode(ref, callback)` is the explicit shallow opt-in — fires only when the *specific node's* state changes, not its descendants.

### `planDelivery` → `deliverNotifications`

Two functions form the notification engine:

1. `planDelivery(ops, ownPathKeys, deepKeys)` → `DeliveryPlan` — the Functional Core. Walks a sealed batch's ops **once**, in dispatch order, and answers both channels.
2. `deliverNotifications(plan, listeners, descendants, options?)` → the Imperative Shell. Builds changesets and calls functions. All the deciding already happened.

**The two channels group differently, and the reason is structural.** A node's own path is a single key, so own-path changes can only come from one place. A node's *subtree* spans many paths, so a deep subscriber's changeset gathers ops from all of them. That gathering is the whole point: **one `batch()` reaches each subscriber as one `Changeset`.**

**The ancestor walk.** A change at `a.b.c` concerns a subscriber at `a.b.c`, at `a.b`, at `a`, and at the root. That set is just the path's ancestor chain, so it is computed from the path itself rather than maintained between flushes. The change is rebased to each subscriber's relative path, and rebasing is done only where a subscriber actually exists — a deep document with few subscribers pays for map lookups, not allocation.

The walk is **structural**: take the first N segments, then compute that path's key. A path key is its segments joined by a separator, so ancestor keys look like prefixes of the key string and cutting the string would be cheaper. It is also wrong. Joining is lossy, so a segment whose own text contains the separator makes the split invent a level that never existed, and a subscriber at that phantom path would receive changes from an unrelated subtree. `markPopulated` walks structurally for the same reason.

This is how a transaction that modifies `doc.items[0].title` and `doc.items[0].count` delivers one changeset to `subscribe(doc)` (two ops), one to `subscribe(doc.items)` (two ops), one to `subscribe(doc.items[0])` (two ops), and one each to `subscribe(doc.items[0].title)` / `subscribe(doc.items[0].count)` (one op each) — all synchronously, all deduplicated.

> That example described the intended contract for a long time while the implementation delivered one changeset per *changed path*, so `subscribe(doc)` really received two. `src/__tests__/delivery-conformance.test.ts` runs the example, so the claim is anchored to something executable rather than to prose that can drift again.

Delivery is a single pass because grouping destroys ordering. If an ancestor write lands between two writes to the same descendant, grouping by path floats the ancestor past both of them, and replaying the result reaches a different state than the writes produced. Walking the ops in order and appending as we go preserves dispatch order for free. The two channels also share work: at `i === path.length` the ancestor key *is* the op's own path key, so computing them separately would repeat a lookup.

The old `NotificationPlan.paths` is gone with the restructure. It existed only so the shell could recover a `Path` to walk from, holding nothing but key strings; a planner iterating the ops already has one in hand.

#### Ordering

Three guarantees, all pinned:

- **Dispatch order within a changeset.** A subscriber's `changes` are the ops it would have received individually, in the order they were dispatched. For a root subscriber that is exactly `batch()`'s return value, filtered to its subtree — which is what makes relaying through `applyChanges` sound.
- **Deepest-first across deep subscribers.** Chosen, not inherited: before the ancestor walk, cross-level delivery order was an artifact of the sequence in which subscribers happened to register, and reversing registration reversed delivery.
- **Every own-path callback before every deep callback.** This is the one ordering that is a *choice*. The channels used to interleave per changed path — own(P1), deep(P1→root), own(P2), deep(P2→root) — because delivery happened inside the walk. Planning before firing is what collapses a subscriber's several changesets into one, and this ordering is the price. It is a trade, not an oversight.

Ordering *across changed paths* used to be first-touch order and was never contractual. It is now subsumed: a subscriber above several paths receives one changeset, so there is no cross-path order left to observe.

#### Replay is where the fan-out is largest

The local-`batch()` framing hides the high-traffic case. An announcement bypasses `ctx.runBatch` but is sealed and delivered **once** for its whole payload (`announce`, `src/interpreters/writable.ts`), so one incoming sync merge is one flush over every op in it. An `offer` touching fifty paths once delivered **fifty** changesets to every doc-root subscriber; it delivers one. The factor is the number of distinct paths in a merge payload, which is unbounded in practice, and `@kyneta/exchange`, `@kyneta/react` and `@kyneta/devtools` all sit on that path.

Ordering has two halves here, and only one is universal. The engine preserves the relative order of the ops it is handed — that holds on every substrate and both entry points. That those ops arrive in *write* order is true only of a local batch: a merge carries a CRDT diff, so the event bridge reconstructs ops by enumerating what changed rather than replaying a write log. `deliveryConformance` pins the universal half for both drivers and the dispatch-order half for local writes. It runs against all four substrates: plain and ephemeral in this package, Loro and Yjs in theirs.

The context's delivery dispatcher (see [The batch lifecycle](#the-batch-lifecycle-capture-seal-release)) is what makes re-entrant `batch()` calls from inside a subscriber safe: each one seals its own batch, which queues behind the delivery in progress. See [Re-entrant `batch()` inside subscriber callbacks](#re-entrant-batch-inside-subscriber-callbacks-drain-to-quiescence).

Because the planner runs before any callback, a subscriber that writes during delivery cannot mutate a buffer mid-iteration. Delivery also comes after `afterBatch` and the native commit, so `version()` and `delta()` read from inside a callback reflect the finished batch.

### `expandMapOpsToLeaves`

A single `MapChange` (e.g. `replaceEntry("alice", {...})`) represents a structural operation on a `map` node. For subscribers on descendants of that map, the change has to be *expanded* into per-leaf `ReplaceChange` ops. `expandMapOpsToLeaves` does this pure expansion. It is **not** part of the notification engine: its only callers are the CRDT event bridges (`backends/loro/src/change-mapping.ts`, `backends/yjs/src/change-mapping.ts`), which run it before handing `announce` a finished op list. This is why the same logical write can reach subscribers as one map op on the plain substrate and as several per-key ops on Loro or Yjs — and why `deliveryConformance` asserts invariants rather than literal op lists.

### Why there are no dynamic-collection changefeed factories

Sequence, map, and tree used to share a pattern: an own-path listener plus a **per-key forwarder map** holding `child[CHANGEFEED].subscribeDescendants(...)` unsubscribes, plus **structural-change-driven wire/unwire** triggered from the own-path callback. Each kept its forwarders keyed by something stable — the sequence by address ID from `withAddressing`, the map by entry key, the tree by TreeID — and each rebuilt them as items came and went.

All of it is gone. Those three mechanisms existed to keep a *derived* structure aligned with a document whose shape changes at runtime, and the relation they encoded — "which subscribers care about this change" — is recomputable in O(depth) at delivery from the changed path alone. There is no longer a factory *per kind* at all: `createNodeChangefeed` serves every schema case except `tree`, and does nothing but register own-path subscribers in one registry and deep subscribers in the other. None of them touches a child ref.

The bug that forced the question was in `product`, which had **no** repair machinery because a struct's fields are fixed. That is true of the fields, and not of what sits behind them: `withChangefeed.sum()` is a pass-through, so a `.nullable()` field's `[CHANGEFEED]` resolves to *the live variant's* feed. A product that subscribed to its fields once captured the null variant's feed, and a later variant shift left it listening to nothing. Subscribing to a document before an optional field was populated meant never hearing about writes inside it, permanently — and because the Exchange wires its document subscription at creation time, that was every synced document.

The stability the sequence used to get from the address table it now gets for free: `AddressedPath.computeKey` emits `@${seg.id}` for index segments, so a path key already survives inserts and reorders. The changefeed layer no longer reads `ADDRESS_TABLE` at all.

### Terminal-on-delete

`createTreeChangefeed` synthesizes a **terminal event** when a node is deleted: subscribers at that node receive one final `Changeset<Op>` containing the delete instruction, and nothing after it.

This is the tree's one responsibility that is not routing, and the only event in the changefeed that is *synthesized* rather than derived from an op. That is precisely why it cannot ride on the ancestor walk: once a node is deleted, no op ever targets its path again, so there is nothing for the walk to find. The tree scans `TreeChange` delete instructions from its own-path listener and delivers directly.

Delivering directly means feeding **both** channels by hand — the facade `subscribe` is `subscribeDescendants`, so a per-node subscriber sits in the descendant map, while `.subscribe(cb)` on the node sits in the own-path map. It also means deliberately bypassing the notification plan: the terminal must reach the deleted node only, never its ancestors, because the tree already reported the deletion via its own-path change and an ancestor receiving both would see the same delete twice.

The payload is built by the pure `synthesizeTreeDeleteTerminal(id)` helper. Subscribers pattern-match on `cs.changes[0].change.type === "tree" && instructions[0].action === "delete"` to detect end-of-stream.

The scan that drives this is the one own-path registration not owned by a subscriber — see [One registration discipline for both channels](#one-registration-discipline-for-both-channels) for why it has to outlive them.

The asymmetry with sequence and map is justified by **identity semantics**: TreeIDs are CRDT-stable identifiers (minted at create-time, never reused, never re-anchored on shifts), and a subscriber at `d.tree.node(id)` holds a meaningful identity reference. Map keys are user-chosen strings that can come and go without identity meaning (re-adding the same key creates "the same" entry); sequence items are positional and shift under structural change. Only tree carries the identity invariant that warrants a lifecycle-end signal.

### Per-ref-instance carrier multiplication

Each call to the catamorphism's per-id child closure (sequence's `itemFn`, map's `itemFn`, tree's `nodeFn`) produces a fresh ref carrier. Each carrier's interpreter recursion calls `wireChangefeed` → `attachChangefeed` → its own `[CHANGEFEED]` protocol.

So multiple ref instances can exist at the same path key. Correct by construction, but not free: each is an object with its own protocol. Note that `withCaching` memoizes what it can — struct fields, and sequence/map entries reached through the address table — so `doc.items.at(0)` hands back the same carrier every time. `doc.tree.node(id)` is the case that reliably mints a new one.

Catamorphism-side memoization keyed by `(parentPath, id)` would collapse the count to one per id. Documented here to surface the property; not currently fixed.

**Registrations no longer multiply with carriers.** They used to, and that was the sharper half of this problem. Own-path listeners were registered when a carrier was *built*, by a fan-out shim that discarded the unsubscribe it was handed, so the shared set grew *monotonically* — one dead entry per discarded carrier, for the document's lifetime, each costing an iteration over an empty set per flush plus a retained closure. The workload named above as common was also the one that accumulated fastest: thirty `d.tree.node(id)` read-and-write cycles left sixty dead entries at one path key.

Registration now follows subscribers — established on the first, released on the last — so a carrier nobody subscribes to never enters the registry, and carrier multiplication costs only the carriers themselves. `src/__tests__/listener-registration.test.ts` pins this.

One thing carrier multiplication does *not* cost is changeset allocation. `deliverNotifications` builds one `Changeset` per key and shares it across every callback registered there.

### One registration discipline for both channels

Both channels now register the subscriber's real callback in a shared path-keyed registry and hand back a teardown that removes it. They use **the same function** to do it — `listenIn(registry, path, callback)`, generic over what a callback receives — so there is one registration discipline rather than two that happen to agree. The own-path channel used to differ: each node kept a *local* subscriber set and put a fan-out shim into the shared registry on its behalf, which is what made its registrations outlive its subscribers.

Two consequences worth knowing.

**The tree's delete scan is the one registration not tied to a subscription.** It has to see every changeset so a vanishing node can be told it is gone (see [Terminal-on-delete](#terminal-on-delete)), and that must happen whether or not anyone subscribed to the tree — so `createTreeChangefeed` registers it directly and never releases it. It is registered before any subscriber can be, and the registry iterates in insertion order, so a deleted node learns it is gone before the tree's own-path subscribers hear about the batch that removed it.

**Teardown guards on set membership**, which makes it idempotent and stops a stale teardown from evicting a later subscriber at the same path. The subtlety: a teardown closes over the set that existed when its subscriber registered, and emptying a key deletes it from the registry, so subscribing there again installs a *different* set. The old teardown cannot damage it, because a set is only ever orphaned at the moment it becomes empty and nothing can refill it afterwards — registration always looks the key up fresh. An orphaned set is empty forever, so the membership check short-circuits before the size check it would otherwise get wrong.

#### Delivery snapshots its subscriber sets

`deliverNotifications` copies each subscriber set before calling into it. The hazard is not the obvious one: under `Set` semantics a callback that unsubscribes *itself* is harmless, because it has already been visited.

What is not harmless is **adding**. A `Set` visits entries added during iteration, so a subscriber registered from inside a callback would receive the changeset already in flight — one planned, and committed to the substrate, before that subscriber existed. Someone subscribing at a *different* path in the same callback receives nothing, since `planDelivery` runs to completion before any callback fires. Snapshotting makes the same-path case agree.

It also settles the unsubscribe direction: a peer unsubscribed mid-delivery still receives the batch in flight, and the unsubscribe takes effect from the next one, rather than that peer being skipped depending on where the loop had got to.

---

## Position algebra

Source: `packages/schema/src/position.ts`.

A `Position` is a substrate-mediated stable reference to a location inside text or a sequence. Two operations:

```
interface Position {
  resolve(): number
  transform(change: Change): void
}
```

`resolve()` returns the current integer index. `transform(change)` updates the position to reflect the given change — critical for substrates that don't store positions as first-class citizens (plain, ephemeral) where the caller drives the update explicitly.

### `Side`: boundary bias

```
type Side = "left" | "right"
```

When an insertion occurs exactly at a position's resolved index, `Side` determines whether the position stays to the left (index unchanged, new content appears *after*) or moves right (index advances). Analogous to cursor affinity in text editors.

### Substrate-specific implementations

| Substrate | Implementation | Notes |
|-----------|----------------|-------|
| Plain | `PlainPosition` | Tracks an integer index. `transform(change)` adjusts via `transformIndex`. Serializable via `decodePlainPosition`. |
| Loro | Wraps `LoroText.getCursor()` / `LoroList.getCursor()` | `resolve` queries the CRDT state; `transform` is a no-op (resolution is stateless). |
| Yjs | Wraps `Y.RelativePosition` | Same pattern — CRDT-native cursor, stateless `transform`. |

### `HasPosition` and `POSITION`

`HasPosition` is the capability marker: a text or sequence ref carries `{ [POSITION]: PositionCapable }` when its substrate supports positions. `hasPosition(ref)` is the runtime type guard.

`PositionCapable` is the factory interface:

```
interface PositionCapable {
  create(index: number, side: Side): Position
  decode(serialized: string): Position
}
```

### `transformIndex` and `textInstructionsToPatches`

Source: `packages/schema/src/change.ts`.

Two pure helpers used by `PlainPosition` and by `@kyneta/react`'s `text-adapter`:

- `transformIndex(index, instructions, side)` → new index after applying a text or sequence instruction list.
- `textInstructionsToPatches(instructions)` → convert retain/insert/delete instructions into concrete `{ index, length, insert? }` patches.

### What a `Position` is NOT

- **Not a numeric index.** An index is a snapshot of "where"; a position is a stable reference that tracks "where" as the document evolves.
- **Not a character offset.** For text, positions are between graphemes; the underlying index is in code-point units but the `Position` interface does not expose that.
- **Not DOM-like.** There is no node reference, no selection range. Positions are pure algebra over text/sequence state.

---

## Tree-position algebra

Source: `packages/schema/src/tree-position.ts`.

Rich text editors (ProseMirror, CodeMirror, Slate, Lexical) address positions in a document tree using a single flat integer. The tree-position algebra bridges between these flat integers and kyneta's `(path, offset)` pairs in the schema tree — pure functions that require only a `Reader` and a `Schema`, no interpreter stack, no substrate-specific code.

### Counting convention

Follows ProseMirror's de facto standard:

| Schema kind | Position contribution |
|-------------|----------------------|
| `text` | 1 per character (no open/close boundaries) |
| `scalar`, `counter` | 1 (non-text leaf) |
| `product`, `sequence`, `movable`, `map` | 2 (open + close) + content size |
| `sum` | transparent — size of the active variant (resolved via `dispatchSum`) |
| `set`, `tree` | unsupported (throws) |

The root node does NOT count its own open/close — flat positions are relative to root content, matching ProseMirror's `doc.resolve(pos)` semantics.

### Core functions

```
function nodeSize(reader: Reader, schema: Schema, path: Path): number
function contentSize(reader: Reader, schema: Schema, path: Path): number
function isLeaf(schema: Schema): boolean
```

`nodeSize` computes the flat position size of a schema node at a path — the recursive building block. `contentSize` is `nodeSize` minus the open/close boundaries for composites (equals `nodeSize` for leaves). `isLeaf` identifies PM-leaf kinds: `text`, `scalar`, `counter`.

```
function resolveTreePosition(reader: Reader, schema: Schema, flatPos: number): ResolvedTreePosition | null
function flattenTreePosition(reader: Reader, schema: Schema, path: Path, offset: number): number
```

`resolveTreePosition` converts a flat integer to `{ path, offset, schema }` — the innermost node and the local offset within it. `flattenTreePosition` is the inverse: given a path and offset, compute the flat integer.

**Round-trip invariant:** `flattenTreePosition(r, s, ...resolveTreePosition(r, s, pos)) === pos` for all valid positions.

### Relationship to `Position`

Tree-position and `Position` operate at different layers:

1. **Tree-position** finds the structural location: "flat position 7 is at `items[1].content`, character offset 2."
2. **`Position`** creates a stable cursor: `ref[POSITION].createPosition(2, "right")` at the ref for `items[1].content`.

The caller composes: `resolveTreePosition` → navigate to the ref at the resolved path → `ref[POSITION].createPosition(offset, side)`. This separation preserves composability — tree-position needs only `Reader`, while `Position` needs the full interpreter stack.

### Ordering contracts

- **Product fields:** walked in `Object.keys(schema.fields)` insertion order. Deterministic because all peers construct schemas from the same source code.
- **Map entries:** walked in lexicographic key order (`keys.sort()`). Required because `reader.keys()` returns insertion order which may differ across peers.
- **Sequence/movable items:** walked in index order `0..length-1`.

### What tree-position is NOT

- **Not a DOM position.** No node references, no selection ranges. Pure algebra over `Reader` + `Schema`.
- **Not substrate-aware.** Works identically with plain, Loro, and Yjs substrates — any `Reader` implementation.
- **Not cached.** `nodeSize` is O(n) per call (walks the subtree). Caching can be added behind the same API if profiling shows a need.

---

## Sequence extension composition

Source: `packages/schema/src/change.ts` (types), `packages/schema/src/interpreters/sequence-helpers.ts` (write wiring).

The positional algebra (`Instruction`, `foldInstructions`, `transformIndex`, `advanceAddresses`) is shared across `text`, `sequence`, `movable`, and `richtext`. Extensions compose in two orthogonal patterns:

### Instruction-stream extensions (marks)

The extension adds new instruction variants to the sequence's instruction type. `format` interleaves with `retain`/`insert`/`delete` in one instruction stream. The changefeed delivers a single change type (`RichTextChange`) containing the extended instructions.

Positionally, `format(N)` ≡ `retain(N)` — the `Instruction` abstraction handles `format` by delegating to `onRetain` in `foldInstructions`. All position-tracking primitives (`transformIndex`, `advanceIndex`, `advanceAddresses`) work unchanged.

Why marks compose *within* the instruction stream: format is cursor-relative — it advances the cursor by N characters while annotating them. A `format` at position 5 references a cursor position established by preceding operations in the same stream. Splitting it into a separate change would lose this positional relationship.

### Change-union extensions (move)

The extension adds a new change type alongside the base sequence change. The changefeed's `C` parameter becomes a union: `SequenceChange<T> | MoveChange`. Move uses absolute indices (not cursor-relative), so it cannot be expressed as a cursor instruction.

Why move composes *alongside* the instruction stream: move is absolute-index-to-absolute-index — it cannot be expressed in the left-to-right cursor model that `foldInstructions` implements.

---

## `schemaHash` and compatibility

Source: `packages/schema/src/hash.ts` → `computeSchemaHash`, `HASH_ALGORITHM_VERSION`, `fnv1aHex`.

`computeSchemaHash(schema)` is a pure, content-addressed function:

1. Build a **canonical tuple** (`canonicalTuple`): a recursively-nested value of **arrays and strings only — never objects** (object key order is engine-defined; array order is positional and stable). Field names are alphabetized; the `JSON_BOUNDARY` marker (`.json()`) is emitted as a `["j", inner]` tag; scalar constraint values go through `serializeConstraintValue` (shared with `describe`/`validate`).
2. Serialize once with `JSON.stringify`. Because JSON escapes every user-controlled string (field names, constraint values, mark names), they cannot forge structural delimiters — canonicalization is **injective by construction** (distinct schemas ⟹ distinct bytes), not by a per-site escaping discipline.
3. Hash with single-pass FNV-1a-128 over UTF-8 bytes (`@sindresorhus/fnv1a` at `size: 128`).
4. Return a **34-character** lowercase string: `HASH_ALGORITHM_VERSION` (2 chars) + 32-char hex of the 128-bit hash.

`canonicalTuple` assumes a finite, eager, acyclic node tree — guaranteed by the grammar (see [What the grammar is NOT](#what-the-grammar-is-not)) — and guards the unsupported `as any`-forced-cycle case with a recursion depth cap that throws a clear error rather than overflowing the stack.

The hash is carried in every `present` message (the exchange's doc-announcement protocol). Receivers compare the incoming hash against their local `BoundSchema.schemaHash`:

- **Match** → structurally identical schemas; safe to sync.
- **Mismatch** → different schemas; receiver consults `supportedHashes` (from the `MigrationChain` walk) to see if a compatible ancestor exists.
- **No compatible version** → reject.

### `HASH_ALGORITHM_VERSION` — the prefix is part of the wire format

The 2-char prefix is a TLV-style algorithm-version tag. Bumping it signals a coordinated change to the hash bytes (algorithm swap, canonicalization change, or input-encoding shift). Current value is `"02"`. Retired versions:

- `"00"` — two-pass FNV-1a-64 with a shared prime over UTF-16 code units; overstated its effective entropy.
- `"01"` — single-pass FNV-1a-128 over UTF-8, but with an S-expression canonicalization that dispatched on `[KIND]` only: it was *boundary-blind* (`struct` ≡ `struct.json`) and *non-injective* (unescaped field names / constraint values could collide). Replaced by the injective JSON-tuple form.

Ecosystem code that asserts on the prefix (wire-format validators, store-migration tooling) should import `HASH_ALGORITHM_VERSION` rather than hardcoding the string.

### Why single-pass FNV-1a-128

- **Fast and deterministic** across JS runtimes (no `crypto.subtle`, no WASM). BigInt-native in the library.
- **128 bits** is wide enough to eliminate collision concern for the hundreds-to-millions of distinct schemas any real deployment will see.
- **Hex-encoded** for readability in logs, wire frames, and test assertions.
- **Standards-conformant** — `@sindresorhus/fnv1a` hashes UTF-8 bytes (the canonical FNV-1a interpretation). The previous in-house implementation hashed UTF-16 code units; standards-conformance was one motivation for the swap.

### What `schemaHash` is NOT

- **Not cryptographic.** FNV-1a is not collision-resistant against adversaries. It is collision-resistant against natural schema variation. Kyneta does not use the hash for authentication.
- **Not random.** Rebuilding a schema identically produces the same hash in every run. This is what makes the wire protocol deterministic across deployments.
- **Not a version number.** Two different schemas do not have "newer" / "older" hashes; they are different identities. Migration chains express evolution.

---

## Migration and identity

Source: `packages/schema/src/migration.ts`.

The migration system solves one problem: *how does a document keep its peer-to-peer identity when its schema evolves?*

The mechanism: every field in a `ProductSchema` has a content-addressed identity hash, derived from the migration chain. When a new schema replaces the old, the migration chain declares which old identity maps to which new identity. Peers running different schema versions can still sync — the substrate keys its CRDT containers by identity hashes, not field names.

### The 14 primitives, four tiers

Source: `packages/schema/src/migration.ts` → `Migration` namespace.

| Tier | Primitives | Semantics |
|------|------------|-----------|
| T0 (structural, identity-preserving) | `renameField` | Pure rename; identity unchanged. |
| T1 (non-destructive, identity-preserving) | `addField`, `setDefault`, `wrapField`, `unwrapField`, `promoteField`, `demoteField` | Shape changes that admit a canonical inverse; identity preserved. |
| T2 (destructive, identity-rederiving) | `dropField`, `extractField`, `mergeFields`, `splitField`, `transformField` | Shape changes that destroy or transform data; identity must be re-derived. Return a `Droppable<P>` requiring explicit `.drop()`. |
| T3 (epoch boundary) | `epoch`, `identity` | A hard break. New identity space; no sync with pre-epoch peers. |

`T2Primitive` and `NonT2Primitive` are type-level predicates. Constructor helpers on `Migration` return the appropriate discriminated union variants. `Droppable<P>` wraps T2 primitives so that drop semantics are explicit at the type level: `Migration.dropField("old").drop()` — forgetting `.drop()` is a compile-time error.

### The chain

A `MigrationChain` is an ordered sequence of `MigrationChainEntry` values. Each entry is either a `MigrationStep` (one or more primitives applied together) or an `EpochStep` (a hard identity break).

`validateChain(chain)` runs at `bind()` time (source: `src/bind.ts` → `bind` body). It checks:

- Primitives within one step are non-conflicting.
- T2 primitives have been `.drop()`-ed.
- Every step strictly advances identity (no cycles).

### Identity derivation

Source: `packages/schema/src/migration.ts` → `deriveIdentity`, `deriveManifest`, `deriveSchemaBinding`.

- `deriveIdentity(schema, chain)` → `NodeIdentity` — the content-addressed identity of every `ProductSchema` field, as a tree mirroring the schema shape.
- `deriveManifest(schema)` → `IdentityManifest` — the full identity tree for a schema, used in `bind()` to cache for `computeSchemaHash`.
- `deriveSchemaBinding(manifest)` → `{ forward: Map<string, NodeIdentity>, inverse: Map<NodeIdentity, string> }` — the runtime lookup used by substrates to key their CRDT containers.

The substrate consumes the `SchemaBinding` in its `factoryBuilder` context. Loro and Yjs backends use `forward` to determine container keys: a product field named `"title"` with identity hash `"abc123…"` is stored at `LoroMap.getMap("abc123…")`, not at `LoroMap.getMap("title")`. Renaming a field changes its display name, not its stored identity — the CRDT state survives the rename.

### Peer identity and when a substrate may claim it

Source: `packages/schema/src/substrate.ts` → `beginHydration`, `SubstrateFactory.createForHydration`.

A CRDT addresses each operation by `(peer, counter)`, and **the counter restarts at zero on a fresh document**. It only means anything relative to the history that document has loaded. So claiming a peer identity is not a free act — it decides which addresses the next writes will occupy.

That gives one rule, stated in terms of addressing rather than of any particular backend:

> A substrate may claim its stable identity at construction **only if** nothing it is about to import was authored by that same peer. Otherwise the identity must be claimed *after* the import.

Get it wrong and a peer writing before its own stored history arrives produces operations at addresses that history already occupies. Merge deduplicates by address — which is exactly what makes CRDT merge idempotent — so one of the two is discarded. Silently, with no way to tell which was the real one.

**Two construction paths express the rule.**

| Path | Claims identity | For |
|---|---|---|
| `create(schema)` | immediately | a document that imports nothing at construction |
| `beginHydration(factory, schema)` | on `adopt()` | a document about to load this peer's own history |

`beginHydration` returns `{ substrate, adopt }`. The obligation travels in the return value rather than sitting on the substrate as an optional capability, because a capability a caller must know to look for can only be discharged by a caller who already knew. `@kyneta/exchange`'s `Runtime` takes the second path whenever stores are configured and calls `adopt()` once hydration resolves — before telling anyone the document has loaded, and before registering it, so peers never see the transient identity.

**Plain uses the same hook for a different reason.** A plain document has no addressed operations, but its identity is its lineage, and authoring is what mints it. Its merge also does not commute with a local write: a stored whole-document entry, replayed after a write made during loading, overwrites it. So `plainSubstrateFactory.createForHydration` returns a substrate that refuses authored writes until `adopt()` — for plain, `adopt` grants the right to write. Merges during loading are announcements, not authored writes, and are unaffected.

Backends opt in by implementing `SubstrateFactory.createForHydration`; `beginHydration` supplies `create()` plus a no-op for those that do not. **Both identity-bearing backends need it.** Yjs and Loro fail differently, which is worth knowing because the difference is misleading:

- **Yjs** detects the collision — an update carrying operations from an id it claims but did not author — and defends by silently reassigning its own `clientID` to a random value. That saves the data when nothing has been written yet, at the cost of the peer's identity on *every* restart.
- **Loro** does not defend. Its `PeerID` stays stable across restarts, so identity looks healthy; the collision simply drops an operation.

Plain and ephemeral carry no identity and need nothing.

The residual, after the deferral: anything written before hydration lands under the document's transient identity, so that session contributes one version-vector entry that never grows. Bounded, non-compounding, and no data attached. Callers avoid it entirely by waiting for the document to settle before writing — which `@kyneta/exchange`'s readiness layer already asks of them for an independent reason.

### `supportedHashes`

Source: `packages/schema/src/migration.ts` → `computeSupportedHashes`.

A `BoundSchema` declares `supportedHashes`: all schema hashes at which the current peer can op-stream sync. Computed by `computeSupportedHashes(schema)`, which recursively walks **every** `MigrationChain` in the schema tree — the root chain plus chains on nested `ProductSchema` fields. The set is the **cartesian product** over independent chains: if the root chain reaches `N` ancestor shapes and a nested field's chain reaches `M`, the result contains `N × M` hashes.

**Per-chain halt** at the first of:

- **T2 step** — destroys identities; advertising T2 ancestors would overstate compatibility (the current path-keyed substrate has no identity-tombstone safety net). This aligns the single-set `supportedHashes` with the theory's `nativeSupports` semantics.
- **T3 epoch** — hard identity break; pre-epoch hashes are deliberately unreachable.
- **Un-invertible primitive** — anything not currently in `{add, rename, move}` at root level. The schema surgery for `addNullable` / `widenConstraint` / sub-product variant operations is bounded but not yet implemented; the walk halts conservatively rather than over-advertise.
- **`chain.entries` exhaustion** — the `chain.base` prune horizon; pre-base shapes are not recoverable from the chain alone.

The richer `readSupports` / `nativeSupports` split — allowing degraded entirety-only sync across T2/T3 boundaries — is deferred until degraded-sync infrastructure exists.

The exchange includes `supportedHashes` in every `present` message when it carries more info than the primary hash alone. Receivers with older schemas check whether one of their hashes is in the sender's `supportedHashes` to decide if sync can proceed.

### The two laws over `supportedHashes`

Source: `packages/schema/src/substrate.ts` → `supportsHash`, `mismatchForInterpretation`, `mismatchForSync`.

The set above gets asked two different questions, and they have different answers. Both are needed; neither substitutes for the other.

| Question | Law | Symmetry | Asked by |
|---|---|---|---|
| **Interpretation** — "can *my* schema read a document written at `h`?" | `h ∈ S_local` | directional | `exchange.get()` and everything that decides whether to interpret a document |
| **Sync** — "is there a shape we *both* speak?" | `S_local ∩ S_remote ≠ ∅` | symmetric | the sync program, when a `present` arrives for a document it already holds |

Membership implies intersection; the converse does not. Two peers on divergent migration branches from a common ancestor — `{H2a, H1}` and `{H2b, H1}` — share `H1`, so ops can flow between them; but neither can interpret a document written at the other's *current* shape, because neither has ever seen it. Answering one question with the other's law is a bug in whichever direction you make the mistake.

`hashesIntersect` is written in terms of `supportsHash` rather than as an independent set operation, so the relationship between the two laws lives in the code instead of only here.

**Which set is this, today?** `nativeSupports` — the T2 halt above exists precisely to keep it so. That makes `supportsHash` *conservative* when used for a read question: it can refuse a shape that entirety-only reading would in fact recover. Refusing is the safe direction, and it is what `resolveSchema` in `@kyneta/exchange` has always done. When the deferred `readSupports` / `nativeSupports` split arrives, **`supportsHash` moves to `readSupports` and `mismatchForSync` stays on `nativeSupports`** — at which point the two laws read different sets, not merely the same set two ways. That is the strongest reason not to collapse them into one function with a mode flag: the flag would eventually have to switch the data source, not just the operator.

### `DocMetadata` vs `ReadCapability`

`supportedHashes` describes a **reader**, never a document. A document has exactly one shape — the one its bytes were written at. A peer has a *set* — the shapes its schema can still reach. The type system now says so:

| Type | Is | Carries `supportedHashes` |
|---|---|---|
| `DocMetadata` | what a document *is*: `replicaType`, `syncMode`, `schemaHash` | no |
| `ReadCapability` | what a peer *can read*: a `DocMetadata` plus its reachable shapes | **yes, required** |

The required-ness is deliberate. A read capability is always derived locally from a `BoundSchema` (via `metadataOf`), whose own `supportedHashes` is a required set — it never arrives over the wire, so it is never absent. Because it is required, a bare `DocMetadata` cannot be passed where a `ReadCapability` is expected, which makes reversing `mismatchForInterpretation`'s arguments a compile error rather than a silent inversion of a directional law.

**Why both laws check all three axes**, despite the hash axis being the only one that differs:

- For **interpretation**, the three axes are the admission preconditions of a tier. "Interpret" here is the tier named alongside replicate and deferred, not the narrow act of decoding bytes. What a document must supply to enter it is `DocReadyInfo` in `@kyneta/exchange`, whose three compatibility-bearing fields are exactly these — one axis per precondition: construct a substrate (`replicaType`), register for sync (`syncMode`), bind a schema (`schemaHash`).
- For **sync**, the same three are simply the triple two peers must share to exchange ops at all.

`MetadataAxis` is deliberately *not* `@kyneta/exchange`'s `DiagnosticCode`. Schema names the axes; the exchange names the diagnostics it reports to users; the mapping between them is the layer boundary, and `@kyneta/devtools` depends on the diagnostic names independently.

### What migrations are NOT

- **Not SQL-style migrations.** No `up` / `down`, no runtime execution of migration code. The chain declares the identity map; the substrate reads identity-keyed data.
- **Not version numbers.** Two schemas with different migration histories may have the same shape but different identity spaces — and therefore cannot sync. The chain is part of the identity, not metadata about it.
- **Not bidirectional.** An epoch step is a one-way break. T0 / T1 primitives are reversible in principle, but Kyneta does not support "downgrading" a document — sync fails instead.

---

## Where types are lost, and why

Source: everywhere, which is the point of writing it down here.

A cast is a place where the type system was switched off. Most of them are not
statements about the code being hard — they are statements about a specific
limit, and a reader should be able to tell which limit, and whether it still
holds. This section records the limits. Every remaining cast in
`packages/schema` carries a comment naming which of them it sits on.

### The erasure frontier

**Augmenting a carrier typed as a type parameter.** Each interpreter layer
takes the value the layer below produced, adds members, and returns it as
`A & Has…`. Assigning to a property of a value typed `A` is a type error — `A`
might have that member at another type — so this used to be written `as any`,
which disabled checking for the whole case body.

It reads like a demand for higher-kinded types, and it is not. `Object.assign`
has the signature `<T, U>(target: T, source: U): T & U`, which is exactly "a
`T`, plus these members, still a `T`". The interpreter layers now use it, plus
assertion functions (`asserts x is T & …`) for members that must be attached
with `Object.defineProperty`. What the conversion actually needed was one
constraint: `withWritable<A extends object>`, because `Object.assign` will not
take an unconstrained type parameter.

**Phantom brands.** `HasNavigation`, `HasRead` and `HasCaching` each carry a
symbol that is declared but never assigned, marking a capability with no
runtime representation. Nothing structural can produce one, so `markNavigation`,
`markRead` and `markCaching` in `bottom.ts` are assertion functions **with
empty bodies** — the honest shape for a claim that is entirely type-level. They
are the reason those layers still end each case with an assertion, and the
assertion is now one named call rather than `as any` over the whole body.

The brands have a second consequence, which is where most of the remaining
narrowings come from. Because a brand says *that* a capability exists without
saying what it looks like, a layer cannot see the surface an inner layer
installed: the readable layer calls `.at`, but its carrier type does not carry
it. `NavigableCarrier<K>` names that dependency at each site instead of
reaching for `any`. Making the brands structural would remove those narrowings
and move the cost into every layer's return type, which is where the `TS2589`
budget would go.

**The `TS2589` depth ceiling.** "Type instantiation is excessively deep" is a
hard compiler limit, not a warning, and this codebase runs near it. The
interpreter's generic recursion is where it originates, and consumers inherit
the depth: `@kyneta/exchange` carries documented workarounds in `exchange.ts`
and `runtime.ts` — a deferred conditional to avoid tripping the `SchemaRef`
tree, a non-generic internal path, an `as never` bridge. `create-doc.ts` casts
the interpreter builder for the same reason, with the reason written next to
it. Anything that deepens instantiation must be checked against `@kyneta/
exchange` *first*, because it has the least headroom.

**The third-party boundary.** `loro-crdt` and `yjs` do not describe every value
they return. `resolveContainer` hands back `unknown` because what a path
resolves to depends on the schema there, and neither library exports a
discriminated union that answers "which container kind is this?". That gap is
now confined: `backends/loro/src/loro-guards.ts` holds one shape per container
kind, listing only the members this integration calls, plus `applyDiffGroup`,
`mapDiffUpdated` and `listDiffDeltas` for the places the published types are
narrower than the runtime. Adding a member there is the way to extend it;
casting at a call site is not.

**Structural interface parameters.** The substrate capability interfaces
declare callback parameters structurally (`path: { segments: readonly
unknown[] }`) so they do not depend on `Path`. The value really is a `Path`,
and both backends assert that back. This is a deliberate trade — substrate
independence bought with four assertions.

### The census

Counts, not a line-by-line inventory, which would go stale immediately.
What remains in `packages/schema` falls into four causes, and every surviving
cast carries a comment naming which one it sits on. The interpreter layers hold
none.

| Cause | Fixable? |
|---|---|
| Structural interface parameters | Deliberate — the price of substrate-agnostic capability interfaces |
| Third-party CRDT gaps | `configTextStyle`, `applyDelta`, and Yjs's internal `_item`; upstream could close all three |
| Runtime attachment before the slot exists | No — the property does not exist until the next statement |
| Documented `TS2589` workaround | Only by reducing generic depth |

The population was once far larger, and it did not shrink by one kind of fix:
symbol protocols became reachable by guard, union narrowings got guards of their
own, third-party shapes moved to a boundary module — and a substantial number
turned out to be inert the moment someone tried to write down what they
asserted. (Counting casts is easy to get wrong; see the note on `grep` below.)

### Guards are the general answer

Two patterns cover most of what used to be cast, and both were already in the
codebase before this work — they were simply not applied everywhere.

**Protocol guards** narrow over a symbol-keyed slot. `hasChangefeed`
(`packages/changefeed/src/changefeed.ts`) is the reference; `hasPosition`,
`hasTreeNodeAllocation`, `hasDevtoolsHistory`, `hasSubstrate`,
`hasBackingDoc`, `hasMigrationChain`, `hasPopulated` and `hasDeleted` all
follow it exactly. A new symbol protocol should ship its `Has…` interface and
`has…` guard beside the symbol, in the same shape.

**Union guards** narrow a discriminated union. `isMapChange` and siblings do it
for `ChangeBase` on `type`; `isProductSchema` and siblings now do it for
`Schema` on `[KIND]`. Note `sum` deliberately has no guard: three interfaces
carry `[KIND]: "sum"`, so the discriminant alone does not identify a type.

Where a guard's type parameter cannot be checked at runtime — `hasBackingDoc<Y.Doc>`
is the clearest case, since the whole point of the slot is that each substrate
stores something only it understands — the guard verifies the slot and the
caller asserts the type by naming it. `hasChangefeed` takes its parameters on
the same terms. That is still a large improvement on a bare cast: the assertion
is one named type in one place, rather than everything about the expression.

### How to test whether a cast is load-bearing

Reusable and non-obvious, so it is written down. The first sweep against this
codebase deleted 161 inert casts using it.

```
strip one cast -> tsc (that package)          -> individually clean?
apply all clean ones in a file -> tsc         -> cumulatively clean?
rebuild schema -> tsc every consumer          -> cross-package TS2589?
time tsc, best of three, vs baseline          -> depth cost without an error?
introduce a deliberate typo where it was      -> checking actually restored?
```

Three of those steps exist because of specific failures.

**Cumulative, not individual.** Removals that are each clean alone can fail
together. `with-addressing.ts` is the worked example: eight casts, each
individually removable, none removable as a set.

**Consumers, not just the package.** Strengthening an internal type can widen
an emitted `.d.ts` and cost depth downstream, where the error surfaces as
`TS2589` in a package you did not edit.

**The deliberate typo.** Compilation succeeding proves nothing about whether
checking came back. A guard declared `value is any` passes every runtime test
and every type-check, while restoring nothing. Put an error where the cast used
to be and confirm the compiler objects.

A note on counting them: `grep "as any"` also matches the prose "h*as any*".
Use a word boundary.

### The deferred piece

**Nothing in this category remains.** The installers were typed too — 17
`install…` helpers across `sequence-helpers.ts`, `keyed-helpers.ts`,
`set-helpers.ts` and `tree-helpers.ts` that used to take `result: any`. Those
that *add* members are assertion functions declaring what they attach
(`ListWriteOps`, `KeyedNavigation`, `TreeReadable` and so on), so a member
installed in one place is visible in the carrier's type at the call site.

Three still cannot assert: `installKeyedCaching`, `installSequenceCaching` and
`installAddressTable` (in `with-addressing.ts`) take the symbol they attach as
a *parameter*, so there is no member to name in a type. They take
`result: object` and narrow internally, which is honest about their being
dynamic by design.

`installAddressTable` is shared: sequences and maps had one installer each,
character-for-character identical, because every difference between them is
passed in as an argument. It lives in `with-addressing.ts`, its only caller.

One structural fact is worth knowing before touching this code. **Layers
describe each other with phantom brands, not structurally.** `installKeyedReadable`
calls `.at`, which the navigation layer installed further in — but
`HasNavigation` is a brand, so that surface is invisible in the type at the
readable layer. Each such helper names the single member it depends on rather
than reaching for `any`. Making the brands structural would remove those
narrowings and is the obvious next question; it would also mean every layer's
return type carrying its full installed surface, which is where the depth
budget would get spent.

---

## Key Types

Selection of the most-used types. Full list in the **Canonical symbols** line at the top of this document.

| Type | File | Role |
|------|------|------|
| `Schema` | `src/schema.ts` | The recursive schema union. |
| `ScalarSchema`, `ProductSchema`, `SequenceSchema`, `MapSchema`, `SumSchema`, `TextSchema`, `CounterSchema`, `SetSchema`, `TreeSchema`, `MovableSequenceSchema`, `RichTextSchema` | `src/schema.ts` | The eleven `[KIND]` variants. |
| `PlainSchema` | `src/schema.ts` | The CRDT-free subset. |
| `ExtractLaws<S>`, `RestrictLaws<S, L>` | `src/schema.ts` | Type-level composition-law extraction + constraint. |
| `BindingTarget<AllowedLaws, N>` | `src/bind.ts` | Fixed substrate target: `.bind(schema)`, `.replica()`. |
| `BoundSchema<S>`, `BoundReplica<V>` | `src/bind.ts` | Static binding types. |
| `EphemeralLaws` | `src/bind.ts` | `"lww" \| "lww-per-key" \| "lww-tag-replaced"` — the LWW-family law set. |
| `Interpret`, `Replicate`, `Defer`, `Reject` | `src/bind.ts` | Resolve-outcome variants. |
| `Interpreter<Ctx, A>`, `InterpreterLayer<Ctx, In, Out>` | `src/interpret.ts` | F-algebra + layer transformer. |
| `Ref<S>`, `RRef<S>`, `RWRef<S>`, `DocRef<S>` | `src/ref.ts` | Refs at each capability tier. |
| `Substrate<V>`, `Replica<V>`, `SubstrateFactory<V>`, `ReplicaFactory<V>` | `src/substrate.ts` | Interfaces. |
| `SubstratePayload` | `src/substrate.ts` | Opaque transfer shape. |
| `SyncMode`, `WriterModel`, `Delivery`, `Durability` | `src/substrate.ts` | Structured sync mode and its three axes. |
| `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL` | `src/substrate.ts` | The three built-in sync mode constants. |
| `Version` | `src/substrate.ts` | Abstract version base. |
| `Change`, `ChangeBase`, `TextChange`, `SequenceChange`, `MapChange`, `TreeChange`, `ReplaceChange`, `IncrementChange`, `RichTextChange` | `src/change.ts` | Change vocabulary. |
| `RichTextSchema`, `MarkConfig` | `src/schema.ts` | Rich text schema kind + mark configuration. |
| `RichTextDelta` | `src/change.ts` | Delta representation for rich text content. |
| `RichTextRef` | `src/ref.ts` | Ref specialization for `richtext` schema kind. |
| `Op` | `src/changefeed.ts` | `{ path, change }` — composed-feed notification. |
| `RecursiveChangefeedProtocol<S>`, `HasRecursiveChangefeed<S>` | `src/changefeed.ts` | Tree-observation surface carried by every schema-issued ref. |
| `Position`, `Side`, `HasPosition`, `PositionCapable`, `PlainPosition` | `src/position.ts` | Position algebra. |
| `MigrationChain`, `MigrationStep`, `EpochStep`, `MigrationPrimitive`, `Droppable`, `T2Primitive`, `NonT2Primitive` | `src/migration.ts` | Migration types. |
| `NodeIdentity`, `IdentityManifest`, `IdentityOrigin`, `SchemaBinding`, `TransformProof` | `src/migration.ts` | Identity types. |
| `NativeMap<S>`, `PlainNativeMap`, `UnknownNativeMap`, `HasNative` | `src/native.ts` | Type-level substrate-native mapping. |
| `CALL`, `NATIVE`, `SUBSTRATE`, `BACKING_DOC`, `KIND`, `LAWS`, `POSITION`, `MIGRATION_CHAIN`, `INVALIDATE`, `REMOVE`, `TRANSACT`, `ADDRESS_TABLE` | various | Symbol-keyed runtime protocol tags. |
| `Reader`, `PlainState` | `src/reader.ts` | Plain-state reader primitive. |
| `Path`, `Segment`, `Address`, `AddressTableRegistry` | `src/path.ts` | Path and address types. |
| `walkPath`, `PathWalk`, `foldPath`, `pathSchema`, `findOpaqueBoundary`, `OpaqueBoundaryHit`, `PathStepper`, `PathFoldResult`, `extendSchemaPathKey` | `src/fold-path.ts` | The one schema-guided traversal and its projections (the substrate-blind sibling of `Path.read(state)`), plus the shared binding-key accumulator. The single-step primitive `stepSchema` is package-internal by design — see [Why one traversal, not many](#why-one-traversal-not-many). |

---

## Build & Exports

### Subpath exports

The package exposes three subpath exports via `package.json` `"exports"`:

| Subpath | Import path | Entry | Role |
|---------|-------------|-------|------|
| `"."` | `@kyneta/schema` | `src/index.ts` | Public barrel — every public symbol. |
| `"./basic"` | `@kyneta/schema/basic` | `src/basic/index.ts` | Test-only helpers (re-exports of internal utilities for backend test suites). |
| `"./testing"` | `@kyneta/schema/testing` | `src/testing/index.ts` | Backend conformance suites: `positionConformance`, `deliveryConformance`, `projectionConformance`. |

The `"./testing"` subpath exists so that backend packages (`@kyneta/loro-schema`, `@kyneta/yjs-schema`) can import the conformance harnesses without depending on vitest at runtime. The tsdown config externalises vitest via `neverBundle: ["vitest"]`, so vitest internals are never bundled into the published `dist/`.

### Code splitting and stable chunk names

Rolldown (via tsdown) requires code splitting when multiple entry points share code — all three entries above share the core schema types. The default `[name]-[hash].js` chunk pattern produces filenames with content hashes that change on every build, breaking lockfile stability and making `dist/` diffs noisy.

The tsdown config overrides this with `chunkFileNames: "_shared/[name].js"`, producing deterministic chunk names under `dist/_shared/`. The build output looks like:

```
dist/
  index.js          # main entry
  index.d.ts
  basic/
    index.js        # ./basic entry
    index.d.ts
  testing/
    index.js        # ./testing entry
    index.d.ts
  _shared/
    *.js             # shared chunks, stable names, no hashes
```

### Module-internal exports

A symbol may be `export`ed from its own module and deliberately left out of the package barrel (`src/index.ts`). It is then reachable by tests inside the package and by nothing outside it — the module boundary carries it, the package boundary does not.

Mark such a symbol with:

```
@internal Not exported from the package barrel.
```

The marker asserts two things at once: this is package-internal despite the `export` keyword, and its absence from the barrel is a decision rather than an oversight. Without it a future reader has no way to tell which, and is as likely to promote the symbol as to delete it.

The worked example is `__getCacheHandlerCountAtPath` (`src/interpreters/with-caching.ts`), a backdoor for asserting that cache-invalidation handlers do not accrete across re-interpretations. It earns its place because that invariant's only symptom is memory and per-write work — there is no public-surface proxy, so a behavioural test would pass whether or not handlers accreted. Where the sole symptom is resource growth, inspecting the structure is the honest instrument; what was missing was the label.

---

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Public barrel — exports every public symbol. |
| `src/schema.ts` | The grammar: types + `Schema.*` constructors + `stepSchema` (the total single-step descent, package-internal) + `buildVariantMap` + `isNullableSum`. |
| `src/bind.ts` | `bind`, `BoundSchema`, `BoundReplica`, `BindingTarget`, `createBindingTarget`, `json`, `ephemeral`, resolve outcomes, `FactoryBuilder`. |
| `src/substrate.ts` | `Substrate<V>`, `Replica<V>`, factories, `BACKING_DOC`. Re-exports `computeSchemaHash` and `HASH_ALGORITHM_VERSION` from `src/hash.ts`. |
| `src/migration.ts` | 14 primitives, 4 tiers, identity derivation, chain validation, `MIGRATION_CHAIN`. |
| `src/change.ts` | Change vocabulary, constructors, guards, `transformIndex`, `textInstructionsToPatches`, `advanceAddresses`. |
| `src/interpret.ts` | `interpret`, `Interpreter`, `InterpretBuilder`, `InterpreterLayer`, `dispatchSum`, `RawPath`. |
| `src/interpreters/bottom.ts` | Bottom layer: `[CHANGEFEED]`, `[NATIVE]`, `[SUBSTRATE]`, `[CALL]`. |
| `src/interpreters/sequence-helpers.ts` | Shared indexed-coalgebra helpers: `at()`, `installTextWriteOps`, `installListWriteOps`, `installRichTextWriteOps`, `installSequenceReadable`, `installSequenceNavigation`, `installSequenceAddressing`, `installSequenceCaching`. |
| `src/interpreters/keyed-helpers.ts` | Shared keyed-coalgebra helpers: `installKeyedWriteOps`, `installKeyedReadable`, `installKeyedNavigation`, `installKeyedAddressing`, `installKeyedCaching`. |
| `src/interpreters/with-navigation.ts` | Structural descent. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/with-readable.ts` | `.current`, `()`, read-by-path. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/with-addressing.ts` | Address-table layer. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/with-caching.ts` | Identity-preserving memoization + `INVALIDATE`. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/writable.ts` | Mutation primitives + `REMOVE` + `TRANSACT` + the batch lifecycle (`buildWritableContext`, `SealedBatch`, `authoredSince`, `seal`) + `hasPreparePipeline`. Text/sequence/movable/map/set cases delegate to shared helpers. |
| `src/interpreters/with-changefeed.ts` | Observation layer + `planDelivery` + `deliverNotifications` + `listenIn` + `createNodeChangefeed` + `wireChangefeed`. All cases use `wireChangefeed` to unify changefeed boilerplate. The notification engine itself is internal — not exported. |
| `src/interpreters/validate.ts` | Validation interpreter. |
| `src/interpreters/plain.ts` | Plain-state interpreter (reader + canonical shape). |
| `src/interpreters/navigable.ts`, `readable.ts` | ~100 each | Type-interface modules. |
| `src/layers.ts` | Pre-built `navigation`, `readable`, `addressing`, `writable`, `observation` layer values. |
| `src/ref.ts` | `Ref<S>`, `RRef<S>`, `RWRef<S>`, `DocRef<S>`, `Wrap`, `RefMode`. |
| `src/position.ts` | `Position`, `Side`, `POSITION`, `HasPosition`, `PlainPosition`, `decodePlainPosition`. |
| `src/tree-position.ts` | Tree-position algebra: `nodeSize`, `contentSize`, `isLeaf`, `resolveTreePosition`, `flattenTreePosition`, `ResolvedTreePosition`. Pure functions over `Reader` + `Schema` for flat↔tree position mapping (ProseMirror convention). |
| `src/changefeed.ts` | `Op`, `RecursiveChangefeedProtocol`, `HasRecursiveChangefeed`, `expandMapOpsToLeaves`. |
| `src/facade/batch.ts` | `batch(ref, fn)`, `applyChanges`, `remove`, `CommitOptions`. |
| `src/facade/observe.ts` | `subscribe`, `subscribeNode`. |
| `src/step.ts` | State transitions: `step` (pure) and `stepInPlace` (its mutating dual), over one set of per-change-type cores. |
| `src/reader.ts` | `Reader`, `plainReader`, `writeByPath`, `applyChange`. |
| `src/unwrap.ts` | Typed escape hatch to `[NATIVE]`. |
| `src/version-vector.ts` | `versionVectorMeet`, `versionVectorCompare`. |
| `src/hash.ts` | FNV-1a-128. |
| `src/native.ts` | `NativeMap`, `NATIVE`, `SUBSTRATE`, `HasNative`. |
| `src/path.ts` | Path/segment/address types + constructors + `AddressedPath`. |
| `src/create-doc.ts` | `createDoc`, `createRef` — convenience factories. |
| `src/describe.ts` | ASCII schema tree printer. |
| `src/zero.ts` | `Zero`, `scalarDefault`. |
| `src/interpreters/materialize.ts` | Generic CRDT→PlainState materialization: `MaterializeResolver` interface, `createMaterializeInterpreter`. |
| `src/guards.ts` | `isNonNullObject`, `isPropertyHost`. |
| `src/base64.ts` | Platform-agnostic base64. |
| `src/substrates/plain.ts` | Plain substrate + factories. |
| `src/substrates/ephemeral.ts`, `substrates/state-tree.ts` | ~570 + ~770 | Ephemeral substrate: CvRDT field-level LWW and its state space. |
| `src/basic/index.ts` | — | Test-only helpers (re-exports). |
| `src/sync.ts` | `version`, `exportEntirety`, `exportSince`, `merge` — generic over `ref[SUBSTRATE]`. |
| `src/__tests__/` | ~56 files | Every test file is pure; no I/O, no timers. |

---

## Testing

Every test in this package is pure. Substrates-under-test are the plain substrate (for everything) and structured mocks. Interpreters are tested by constructing minimal refs and asserting on method results. Migrations are tested by deriving manifests for known schemas and asserting on the hash values. Validation is tested by running `validate` over synthetic inputs and asserting on the error tree.

The full suite serves as the specification of the `Substrate<V>` contract: `@kyneta/loro-schema` and `@kyneta/yjs-schema` run this same suite (adapted) against their substrates. Position conformance tests import `positionConformance` and `PositionTestEnv` from `@kyneta/schema/testing`; general substrate conformance helpers live in `@kyneta/schema/basic`.

**Run tests**: `cd packages/schema && pnpm exec vitest run`