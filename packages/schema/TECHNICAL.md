# @kyneta/schema — Technical Reference

> **Package**: `@kyneta/schema`
> **Role**: The schema interpreter algebra — one recursive grammar for document structure, a reactive observation surface (`[CHANGEFEED]` on every ref, with tree-level composed changefeeds for composites), a substrate boundary that separates state management from replication, a migration system that derives stable identity from structure, and a position algebra for cursor-stable text and sequences.
> **Depends on**: `@kyneta/changefeed`
> **Depended on by**: `@kyneta/exchange`, `@kyneta/loro-schema`, `@kyneta/yjs-schema`, `@kyneta/index`, `@kyneta/react`, `@kyneta/compiler`, `@kyneta/cast`, `@kyneta/transport`
> **Canonical symbols**: `Schema`, `Schema.*` constructors, `KIND`, `LAWS`, `bind`, `BoundSchema`, `BoundReplica`, `BindingTarget`, `createBindingTarget`, `json`, `ephemeral`, `Interpret`, `Replicate`, `Defer`, `Reject`, `interpret`, `Interpreter`, `InterpreterLayer`, `createDoc`, `createRef`, `change`, `applyChanges`, `subscribe`, `subscribeNode`, `Substrate`, `SubstrateFactory`, `SubstrateCapabilities`, `Replica`, `ReplicaFactory`, `SubstratePayload`, `Version`, `SyncMode`, `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`, `requiresBidirectionalSync`, `computeSchemaHash`, `BACKING_DOC`, `Op`, `RecursiveChangefeedProtocol`, `Change`, `ChangeBase`, `TextChange`, `SequenceChange`, `MapChange`, `TreeChange`, `ReplaceChange`, `IncrementChange`, `RichTextChange`, `transformIndex`, `textInstructionsToPatches`, `Migration`, `MIGRATION_CHAIN`, `deriveIdentity`, `deriveManifest`, `deriveSchemaBinding`, `deriveTier`, `validateChain`, `Position`, `POSITION`, `PlainPosition`, `hasPosition`, `decodePlainPosition`, `Side`, `NATIVE`, `SUBSTRATE`, `NativeMap`, `unwrap`, `versionVectorMeet`, `versionVectorCompare`, `Zero`, `validate`, `tryValidate`, `SchemaValidationError`, `foldPath`, `pathSchema`, `PathStepper`, `PathFoldResult`, `extendSchemaPathKey`, `withTracking`, `tracking`, `withReadScope`, `reportRead`, `withoutTracking`, `currentScope`, `dependencyKey`, `Dependency`, `Aspect`
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
- What is the `CHANGEFEED` surface over a composite ref? → [Composed changefeeds](#composed-changefeeds)

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
| `Change` | The universal currency of change — discriminated union with `type` (`"text" \| "sequence" \| "map" \| "tree" \| "replace" \| "increment"` and extensible). Flows both inbound (intent) and outbound (notification). | A diff, a patch — `Change` is applied atomically by the substrate |
| `SubstratePayload` | `{ kind: "entirety" \| "since", encoding: "json" \| "binary", data: string \| Uint8Array }` — opaque state carrier. Produced by the substrate, carried by the exchange. | A `ChannelMsg` — payloads ride *inside* `offer` messages |

| `SyncMode` | Structured record decomposing sync semantics into three orthogonal axes: `WriterModel` (`"serialized"` / `"concurrent"`), `Delivery` (`"delta-capable"` / `"snapshot-only"`), `Durability` (`"persistent"` / `"transient"`). Three constants: `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`. `requiresBidirectionalSync(mode)` is the helper predicate. | A string enum, a CRDT algorithm |
| `NativeMap<S>` | Type-level functor mapping each schema kind to its substrate-native type (e.g. Loro's `LoroText`, Yjs's `Y.Text`, plain JS `string`). | A runtime `Map<K,V>` |
| `NATIVE` / `SUBSTRATE` / `BACKING_DOC` | Symbol-keyed accessors for the underlying native container, the substrate instance, and the backing document object. | User-facing APIs — these are escape hatches |
| `Position` | Substrate-mediated stable reference to a location within text or a sequence. Survives concurrent edits. | A numeric index, a character position |
| `POSITION` | Capability symbol: `hasPosition(ref)` returns true when the substrate supports positions for this ref. | The `Position` interface |
| `Migration` | The namespace of 14 migration primitives (`renameField`, `dropField`, `extractField`, `mergeFields`, `splitField`, `transformField`, `setDefault`, `addField`, `wrapField`, `unwrapField`, `promoteField`, `demoteField`, `epoch`, `identity`) organized into four tiers. | A database migration — this is a pure algebraic operation on schema + data |
| `MIGRATION_CHAIN` | Symbol-keyed slot on a `ProductSchema` carrying its `MigrationChain` (sequence of migration steps + epochs). Invisible to `JSON.stringify` / `Object.keys`. | The chain's content — the symbol is just the slot |
| `SchemaBinding` | `{ forward: Map<string, Hash>, backward: Map<Hash, string> }` — the identity map from human-facing field names to content-addressed identity hashes for one schema snapshot. | Schema validation rules |
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
- **Not symmetric across sync modes.** A collaborative substrate (Loro, Yjs) has concurrent versions (`SYNC_COLLABORATIVE`); an authoritative substrate (json) has a total order (`SYNC_AUTHORITATIVE`); an ephemeral substrate has wall-clock-timestamped overwrite (`SYNC_EPHEMERAL`). The `SyncMode` — decomposed into `WriterModel`, `Delivery`, and `Durability` axes — tells the exchange which mode shape to run. `requiresBidirectionalSync(mode)` is the predicate the exchange uses to decide whether to establish a bidirectional causal exchange or a unidirectional push.
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
- **Change vocabulary is `SetChange { add, remove }`** — value-addressed, not key-addressed. Distinct from `MapChange { set, delete }`. On overlap (an item appears in both `add` and `remove`), **remove-wins** (mirrors `stepMap`'s asymmetric set-wins-on-set-then-delete).
- **`stepSet` is total over arbitrary input** and produces normalized output: no duplicates (via `isSameSetMember`), stable order (existing members retain relative position; new adds appended in `add[]` order). The `setOpChange(add?, remove?)` constructor is a thin passthrough — the invariant lives at the operation boundary, not the constructor.
- **`SetRef` is leaf-shaped at the ref layer.** The interface is `.has(value)`, `.add(value)`, `.delete(value)`, `.clear()`, `.size`, `[Symbol.iterator]` over plain values, and a callable returning `T[]`. **No `.at(value)` and no per-member child refs** — sets have no addressable positions, and writing through a member ref would silently violate the set's uniqueness invariant.
- **Membership is content-equal** (via `isSameSetMember` in `guards.ts`) — single source of truth shared by `stepSet`, `validate`, and `SetRef.has(value)`. `Schema.set(Schema.struct({...}))` correctly recognises structurally-equal object members as duplicates; native JS `Set` (which uses identity equality for objects) is *not* used because it can't fulfil this contract.
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
| `ephemeral` | `EphemeralLaws = "lww" \| "lww-per-key" \| "lww-tag-replaced"` | LWW-family only — no concurrent merge needed. |
| `state` | `EphemeralLaws = "lww" \| "lww-per-key" \| "lww-tag-replaced"` | Field-level LWW Map (CvRDT) — concurrent merges for presence state. |
| `loro` | `LoroLaws = "lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"` | Full CRDT law set minus `"add-wins-per-key"`. |
| `yjs` | `YjsLaws = "lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` | Text and structural laws — no `"additive"`, `"positional-ot-move"`, `"tree-move"`, `"add-wins-per-key"`. |

`target.bind(schema)` applies `RestrictLaws<S, AllowedLaws>` at the type level. A schema with `"additive"` in its `[LAWS]` (from `Schema.counter()`) cannot be bound to the `yjs` target — the compiler refuses.

No runtime dispatch, no substrate-specific error messages. The type system is the enforcement mechanism.

### What the grammar is NOT

- **Not closed.** `sum` variants are open (you can add more) and `product` fields are open (you can nest arbitrary schemas). The eleven *kinds* are closed; user composition is not.
- **Not validated at construction**, but **finite, eager, and acyclic by typing.** Product fields are eager `Schema` values — there is no lazy/thunk field variant and no `lazy`/`recursive` constructor — so a cyclic schema *graph* cannot be built through the typed API (`struct({ next: () => self })` does not typecheck). Recursive/hierarchical *data* is modeled via `Schema.tree(item)`, whose schema is finite. `canonicalizeSchema` relies on this precondition; an `as any`-forced cycle is the only way to violate it, and it is caught by a depth cap that throws a clear error (not an opaque stack overflow).
- **Not self-describing at runtime.** `[KIND]` is the only tag. Fields, variants, etc. are discovered structurally. Never `Object.keys(schema)` to enumerate its kind — pattern-match on `[KIND]`.

---

## Binding a schema to a substrate

Source: `packages/schema/src/bind.ts`.

### The five binding targets

Kyneta exports five pre-configured binding targets:

| Target | Package | `syncMode` | Allowed Laws | Mechanism |
|--------|--------|----------------|--------------|-----------|
| `json` | `@kyneta/schema` | `SYNC_AUTHORITATIVE` | all (`string`) | Plain JS objects, Lamport version |
| `ephemeral` | `@kyneta/schema` | `SYNC_EPHEMERAL` | `EphemeralLaws` (`"lww"`, `"lww-per-key"`, `"lww-tag-replaced"`) | LWW substrate, wall-clock version, full document overwrite |
| `state` | `@kyneta/schema` | `SYNC_EPHEMERAL` | `EphemeralLaws` (`"lww"`, `"lww-per-key"`, `"lww-tag-replaced"`) | State CvRDT, wall-clock version, field-level overwrite |
| `loro` | `@kyneta/loro-schema` | `SYNC_COLLABORATIVE` | `LoroLaws` (full CRDT set minus `"add-wins-per-key"`) | Loro CRDT doc |
| `yjs` | `@kyneta/yjs-schema` | `SYNC_COLLABORATIVE` | `YjsLaws` (text + structural laws) | Yjs doc |

#### `ephemeral` vs `state`
Both targets implement snapshot-only transient delivery via `SYNC_EPHEMERAL`, but they have radically different semantics:
- `ephemeral`: A **Global LWW Register**. A write to any field bumps the global document timestamp. When peers sync, the peer with the newest timestamp overwrites the *entire* document. Useful when you explicitly want total state replacement.
- `state`: A **Field-level LWW Map (CvRDT)**. The substrate maintains a `[Value, Timestamp]` tuple for every scalar leaf. When peers sync, the payloads merge concurrently field-by-field (`Highest T wins`). Useful for decentralized presence where multiple peers write to their own keys in a shared document without clobbering each other, without generating any op-log history bloat.

Usage:

```
import { json, ephemeral, state, Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import { yjs } from "@kyneta/yjs-schema"

const Config = json.bind(Schema.struct({ theme: Schema.string() }))
const Cursor = ephemeral.bind(Schema.struct({ x: Schema.number(), y: Schema.number() }))
const MeshPresence = state.bind(Schema.struct({ alice: Schema.string(), bob: Schema.string() }))
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
  merge(payload: SubstratePayload, options?: BatchOptions): void
}

interface Replica<V> extends ReplicaLike {
  version(): V
  baseVersion(): V
  // exportSince, advance, merge inherited from ReplicaLike
}

interface Substrate<V> extends Replica<V> {
  reader(): Reader
  writable(): WritableContext
  prepare(): SubstratePrepare
  context(): RefContext
}
```

**`ReplicaLike`** is the minimal replication contract — what the synchronizer needs. All version-typed positions use the base `Version` type so the synchronizer can hold heterogeneous replicas in a single `Map` without variance escapes. Named after the TypeScript `-Like` convention (`PromiseLike`, `ArrayLike`): a structural interface that the full `Replica<V>` satisfies.

**`Replica<V>`** extends `ReplicaLike` with concrete version types. External consumers (binding targets, factories) use this for compile-time version-type safety on return values (`version(): V`, `baseVersion(): V`). Input methods (`exportSince`, `advance`) inherit the wider `Version` parameter type from `ReplicaLike`.

**`ReplicaFactoryLike`** / **`ReplicaFactory<V>`** follow the same pattern: a variance-safe structural interface and a narrow extension with concrete return types.

The split exists because TypeScript treats generics as invariant: `Replica<LoroVersion>` is NOT assignable to `Replica<Version>`, even though `LoroVersion extends Version`. The `-Like` interfaces solve this by using `Version` in all positions, making them assignable from any concrete `Replica<V>`.

Every replica exposes six methods:

- `version()` → the current state's version.
- `baseVersion()` → the earliest version retained (trimmed history starts here).
- `exportEntirety()` → full state as an opaque payload.
- `exportSince(since)` → delta relative to the given version, or `null` if not possible.
- `advance(to)` → trim history up to the given version.
- `merge(payload, options?)` → fold an incoming payload into local state. `options.origin` propagates through the changefeed as an app-level label; the substrate forces `replay: true` on the resulting `Changeset` so layered consumers (e.g. the exchange's echo filter) can discriminate the merge from a local write.

A `Substrate` adds interpretation:

- `reader()` → plain reads by path.
- `writable()` → mutation primitives (`replace`, `insert`, `delete`, `increment`, etc.).
- `prepare()` → the flush pipeline that turns accumulated mutations into a single `merge` call (plus notifications).
- `context()` → the `RefContext` the interpreter stack closes over.

### The `SubstratePrepare` pipeline

Mutations apply eagerly per the σ-eager design (jj:kqnkxrkl). For each `prepare(path, change)`:

1. Capture `pre = path.read(σ)` (deep-cloned) before the change applies.
2. Compute `inverse = invert(pre, change)` — the reverse arrow in the change groupoid.
3. Push `{ path, inverse }` on the active runBatch frame's inverse stack via the `RECORD_INVERSE` callback threaded through options.
4. Advance σ via `applyChange(shadow, path, change)`.
5. Advance λ via the substrate-native path (Loro: applyDiff or coalescing buffer; Yjs: applyChangeToYjs inside the ambient transact).

The inverse stack belongs to the bracket primitive (`WritableContext.runBatch`'s wrapper). On the bracket's depth-0 success release, the frame's inverse range is discarded and `ctx.flush(opts)` fires. On a throw, the catch path replays the frame's inverses LIFO through `ctx.prepare(path, inverse, { compensating: true })` (the substrate skips inverse recording under the undo-replay handler), then flushes with `aborted: true`, then rethrows. The bracket's commit contains forward + inverse ops with net-zero delta when the outermost throws.

This is how `batch(doc, d => { d.title.insert(0, "hi"); d.items.push(x); })` becomes one atomic changefeed emission with read-your-writes inside the block, and how a throwing block becomes one batched native event with net-zero delta plus one `Changeset` with `aborted: true`.

### Path resolution and sum boundaries

`resolveContainer` in substrate backends (e.g. `loro-resolve.ts`) handles sum boundaries by switching to plain JS property navigation for remaining path segments once a `sum` schema node is encountered. This is sound because sum variants are always `PlainSchema` — no Loro containers (or other CRDT containers) exist inside sums. The Yjs backend's `resolveYjsType` follows the same pattern. When `advanceSchema` reaches a sum, remaining segments are resolved via plain `obj[key]` access rather than substrate-specific container descent.

### Version vector algebra

Source: `packages/schema/src/version-vector.ts`.

For substrates whose `V` is a map of `PeerId → number` (Lamport-style vectors), two helpers are provided:

- `versionVectorMeet(a, b)` → the greatest lower bound. Component-wise minimum.
- `versionVectorCompare(a, b)` → `-1 | 0 | 1 | "concurrent"`. Determines whether one version strictly precedes the other, equals it, or is concurrent.

Both are pure. Loro and Yjs substrates use these directly for their Lamport vectors; substrates with different version shapes (wall clock, Loro's opaque version) implement their own comparison.

`PlainVersion` (the plain substrate's version, below) **is** a version vector — a single authored *lineage* entry `{lineage: value}`, with genesis (`DEFAULT_LINEAGE`) projecting to the **empty** vector ⊥. Its `compare`/`meet` delegate to `versionVectorCompare`/`versionVectorMeet` over that projection (`PlainVersion.#toVector`) — the same lattice Loro/Yjs use, with no Plain-specific case matrix. `Version.lineage` is the version-vector *lineage key* (the writer/identity coordinate), not a scalar bolted on beside the counter. A serialized writer holds at most one authored lineage at a time (prune-on-reset), so the vector is single-entry. Context: jj:kxswmuzx.

`Version.lineage` (renamed from `Version.epoch` — jj:pwymxzwq) is the identity coordinate on every `Version`: for `PlainVersion` a REAL lineage minted on the first authored write (genesis ⊥ before that); for Loro/Yjs/TimestampVersion/StateVersion a constant `DEFAULT_LINEAGE` (their identity lives in their own native vectors). The lattice operations never branch on the raw string — `PlainVersion` projects it to a vector and `versionVectorCompare` does the rest; genuine cross-lineage divergence surfaces as `"concurrent"`. **The word `epoch` is now reserved for the deliberate T3 _migration_ boundary** (`.epoch()` / `EpochStep` / `MigrationTier` T3 — see [Migration and identity](#migration-and-identity)): *lineage* (writer identity, per-VV-key, minted automatically) and *epoch* (migration generation, global, developer-declared) are now distinct axes with distinct names.

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

- `"00"` — two-pass FNV-1a-64 with a shared prime over UTF-16 code units; overstated its effective entropy (`jj:snrmsznm`).
- `"01"` — single-pass FNV-1a-128 over UTF-8, but with an S-expression canonicalization that dispatched on `[KIND]` only: it was *boundary-blind* (`struct` ≡ `struct.json`) and *non-injective* (unescaped field names / constraint values could collide). Replaced by the injective JSON-tuple form (`jj:qnmtvtwn`).

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
| Observation | `withChangefeed` | `subscribe`, `subscribeNode`, `RecursiveChangefeedProtocol<S>` |

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

### What an `Interpreter` is NOT

- **Not a visitor pattern.** Interpreters return values; visitors mutate state. `interpret` is a catamorphism, not a traversal.
- **Not layered dynamically.** Layers compose at the type level. Once `.done()` is called, the stack is fixed.
- **Not framework-aware.** No React, no DOM. The `Ref<S>` the stack produces is a pure object with a `[CHANGEFEED]` surface; framework bindings (`@kyneta/react`, `@kyneta/cast`) adapt it.

### Interpreter duplication families

The 11 interpreter cases fall into four structural categories. The first three are **duplication families** — groups of cases that share identical logic across every transformer, captured by shared helper modules. The fourth has unique per-case logic.

| Family | Cases | Shared helpers | Shared algebra |
|--------|-------|---------------|----------------|
| **Indexed** (positional) | `text`, `sequence`, `movable`, `richtext` | `sequence-helpers.ts` — `at()`, `installTextWriteOps`, `installListWriteOps`, `installRichTextWriteOps`, `installSequenceReadable`, `installSequenceNavigation`, `installSequenceAddressing`, `installSequenceCaching` | `Instruction`, `foldInstructions`, `transformIndex`, `advanceAddresses` |
| **Keyed** (named) | `map` | `keyed-helpers.ts` — `installKeyedWriteOps`, `installKeyedReadable`, `installKeyedNavigation`, `installKeyedAddressing`, `installKeyedCaching` | `MapChange`, keyed addressing/tombstoning |
| **Leaf** (terminal) | `scalar`, `text`, `counter`, `richtext`, **`set`** | `wireChangefeed` in `with-changefeed.ts` unifies changefeed boilerplate; `set-helpers.ts` provides `installSetReadable` and `installSetWriteOps` for the value-addressed set surface | `createLeafChangefeed`, `SetChange`, `isSameSetMember` |
| **Structural** (unique) | `product`, `sum`, `tree` | None — each has unique per-case logic | Product: schema-driven fields + discriminant. Sum: store-based variant dispatch. Tree: thin pass-through. |

**`text` and `richtext` straddle two families.** They are indexed for writable (share `at()` and the retain/insert/delete instruction stream with sequence/movable) but leaf for readable, navigation, and changefeed (return `string` / delta directly, not a fold over children). Characters are not independently addressable refs.

**`set` is leaf-shaped at the ref layer.** Although the catamorphism dispatches set children by string key (mirroring `map`), there are no per-member child refs at the user-facing API. The surface is `.has(value)`, `.add(value)`, `.delete(value)`, `.clear()`, `.size`, `[Symbol.iterator]`, callable returning `Plain<I>[]` — narrower than `map`'s, and value-addressed (no `.at(value)`). Invalidation is whole-carrier on any `SetChange` (same pattern as text/counter). See [§Set: value-addressed leaf](#set-value-addressed-leaf).

The `Interpreter` interface retains separate cases per kind — the sharing is internal to the built-in transformers. Substrate authors implement one case per kind; they never see the shared helpers.

The materialize interpreter is another duplication family — all CRDT backends share the same 11-case structure, varying only in resolution. The `MaterializeResolver` abstraction captures this by decomposing resolution into leaf resolvers (value, text, counter, richtext) and container shape resolvers (length, keys) that mirror the indexed/keyed duplication families.

**`attachNative` is intentionally skipped for sums in `interpretImpl`.** Sums are structurally transparent — the result carrier is the dispatched variant's carrier, which already has the correct `[NATIVE]` from its own interpreter case (product, scalar, etc.). Calling `attachNative` on the sum would double-define the property, crashing in substrates where the product resolves to a real container but the sum resolves to `undefined` (`configurable: false` + different value → `TypeError`).

### `NativeMap` and the escape hatch

`NativeMap<S>` is a type-level mapping from schema kinds to substrate-native types. `ref[NATIVE]` returns the underlying container — `LoroText` for a `text` on Loro, `Y.Map` for a `product` on Yjs, a plain object for the plain substrate. `unwrap(ref)` (`src/unwrap.ts`) is the typed escape hatch that returns `NativeMap<S>`.

Application code rarely touches `[NATIVE]`. Backends use it to dispatch to substrate-specific APIs. It is the only path through which substrate-specific behaviour leaks through the interpreter stack — and it is explicit at the call site.

### Read tracking — `withTracking` + the tracking context

Source: `src/interpreters/with-tracking.ts` (the layer) + `src/tracking.ts` (the pure context). Consumed by `@kyneta/reactive` (jj:kpywvkpr) for fine-grained auto-tracked reactivity (`useSelector`/`useValue` ultimately rest on it).

`withTracking` is the **outermost** layer in the canonical `createRef` stack (`.with(readable).with(writable).with(observation).with(tracking)`). When a *tracking scope* is active, every user-facing read reports a `Dependency` (a stable handle + an `Aspect`); when no scope is active, every wrapped accessor is a one-guard passthrough (the full suite is byte-identical — confirmed by 2171 passing tests). Subscription *policy* (aspect → changefeed primitive) lives in the runtime, not here.

**The pure context (`tracking.ts`)** is the functional core: a save/restore scope discipline (`withReadScope(fn) → { value, deps }`), a single mutation point (`reportRead`, a no-op when no scope is active), and `withoutTracking` (suppresses reports while a composite `()` folds its snapshot). FC/IS exemplars: `@kyneta/index`'s `integrate` and `@kyneta/machine`'s `Program`/runtime.

**Aspect inference** (read-method × node-kind):

| Read | Node kind | Aspect |
|------|-----------|--------|
| `()` | leaf (scalar/text/counter/richtext/**set**) | `value` |
| `()` | composite (product/sequence/map/tree) | `deep` (fold suppressed — the dep subsumes the subtree) |
| `.at` / `.length` / iteration / `.keys` / `.has` / `.size` / `.entries` / `.values` | sequence/movable/map | `structure` |

Products report nothing on field navigation (fixed fields); the child carrier reports its own reads. **`identity` is folded into `structure` for v1**: navigating a dynamic container reports `structure`, which soundly catches moves/deletes — so the runtime needs only `subscribeNode`/`subscribeDescendants`, no `address.listeners` wiring. Completeness (no missed reads) is verified against the helpers: every accessor that touches the substrate is wrapped, or delegates to one that is (`.get`/iteration route through `.at`; map `.has`/`.keys`/`.size`/`.entries`/`.values` read `reader.keys`/`hasKey` directly, so all are wrapped).

**Stable keys without addressing internals.** Dependency keys are derived from the carrier's *object identity* (a `WeakMap<carrier, id>`), which is already **cursor-stable** — `.at(i)` is backed by the address table keyed on `Address.id` (`sequence-helpers.ts:329`), so the same logical element yields the same carrier object across structural change. A dep key is therefore invariant under inserts/deletes (an insert before a tracked element does not change its key) while keying transitively on `Address.id` — no addressing-internals integration needed.

The aspect vocabulary harmonizes with `@kyneta/compiler`'s `DependencyClassification` (`experimental/compiler/src/classify.ts` — `structural`/`item`/`external`): `structural` is shared; `value`/`identity` refine the compiler's `item`; the compiler's `external` (reading another reactive source) is the runtime's plain-`HasChangefeed` `.subscribe` branch, not a schema-ref read. One classification model — the compiler is its AOT face, `withTracking` its JIT face.

---

## The write path

Source: `packages/schema/src/facade/batch.ts`, `src/step.ts`, `src/inverse.ts`, `src/interpreters/with-changefeed.ts`, `src/interpreters/writable.ts`.

`batch(doc, fn)` is the atomic mutation facade. Under the three-primitive substrate contract (jj:ryquprut), it is implemented as a thin `runWriter` / `execWriter` wrapper around `ctx.runBatch`:

```ts
batch(doc, fn) = ctx.runBatch(() => {
  const marker = ctx[FORWARD_OPS_MARKER]()
  fn(doc)
  return ctx[FORWARD_OPS_SINCE](marker)
}, opts)
```

**Convention.** A single mutation needs no `batch()` — a bare helper call (`doc.x.set(v)`) opens an implicit single-op `runBatch` and auto-commits (jj:kqnkxrkl). Reach for `batch()` only to (a) group ≥2 writes into one atomic commit + one `Changeset`, (b) capture the returned `Op[]`, or (c) attach `origin`/`source` provenance. The name leads with batching; the atomic-abort guarantee (a throwing block compensates LIFO and emits one `Changeset` with `aborted: true`) is the contract that makes a multi-write batch safe — it is still a *transaction in the algebraic sense*, just not a DB-style transaction with isolation/durability.

End-to-end flow:

1. `change` resolves `ref[TRANSACT]` → the `WritableContext`.
2. `ctx.runBatch(work, opts)` opens a frame (push on `frameStarts`/`inverseStack`). At depth-0 entry it invokes the substrate's `runBatch` bracket (Loro `doc.commit()`, Yjs `Y.transact`) wrapping the whole body.
3. `fn(doc)` runs. Inside `fn`, each helper (`.set`, `.push`, `.insert`, …) routes through `ctx.dispatch(path, change)` — the depth-aware combinator. Inside a frame, dispatch is just `ctx.prepare`; outside any frame it opens an implicit single-op runBatch (auto-commit).
4. `ctx.prepare` writes to the writer log (for `batch()`'s return value), calls `substrate.prepare`. The substrate captures σ at the change's target path, computes the inverse via `invert(pre, change)` and records it on the active frame, then advances σ and λ in lockstep.
5. After `fn` returns, the bracket's depth-0 release calls `ctx.flush(opts)` exactly once → `wrappedFlush` → `planNotifications` → `deliverNotifications`. One `Changeset` per affected subscriber path.
6. If `fn` throws, the catch path replays this frame's recorded inverses LIFO through `ctx.prepare(path, inverse, { compensating: true })`, then flushes with `aborted: true`, then rethrows. External observers see one batched native event whose ops net to zero.

The substrate's `runBatch` bracket invocation is gated on `frameStarts.length === 0`: substrate.runBatch is invoked at most once per outermost block, regardless of how deeply `dispatch` nests. The exchange sees the transaction as a single `merge` source: after commit the substrate's `exportSince()` captures the entire delta.

### `applyChanges(ref, changes)`: declarative application

Source: `src/facade/batch.ts`.

Sometimes changes arrive as data (from the network, from undo history, from tests). `applyChanges(ref, changes)` applies a `readonly Change[]` via the same substrate write path — no prepare facade, just direct substrate writes + notification planning.

### `remove(ref)`: ergonomic self-removal

Source: `src/facade/batch.ts`.

A container's child ref carries `[REMOVE]()` (a symbol method — see `Removable<T> = T & HasRemove` in `src/ref.ts`), symbol-keyed for collision safety: a child can be any schema kind, including a struct with a user field literally named `remove`, so a plain `.remove()` method would shadow it. `remove(ref)` is the free-function facade over that symbol — the same collision-safe symbol-protocol + free-function-facade pattern as `unwrap` (`[NATIVE]`), `changefeed` (`[CHANGEFEED]`), and `batch` (`[TRANSACT]`). Prefer `remove(ref)` at call sites; reach for `ref[REMOVE]()` only when you already hold the symbol. Like any single mutation, a lone `remove()` auto-commits (no `batch()` needed). It throws on a dead ref, and its `HasRemove` parameter type rejects non-removable refs (product fields, top-level docs) at compile time.

### Pure step function

Source: `packages/schema/src/step.ts`.

For testing and reasoning, `step(state, change)` → `state` is the pure transition function. It handles every built-in change type (`stepText`, `stepSequence`, `stepMap`, `stepReplace`, `stepIncrement`, `stepFold`). The plain substrate uses `step` internally; tests use it to verify change semantics without constructing a substrate.

### What the write path is NOT

- **Read-your-writes inside `fn`** (post-jj:ryquprut). σ advances eagerly on every prepare, so reads inside `batch(doc, fn)` reflect prior writes within the same block. `d.todos.push("a"); d.todos.push("b")` appends in order. Pre-refactor this silently reordered because length-derived helpers read a stale σ.
- **Not async.** `batch()` is synchronous. The substrate's writes happen synchronously during `fn`. Notifications for the originating transaction fire synchronously at commit; re-entrant `batch()` calls from inside a subscriber land in the per-context dispatcher's pending queue and produce a separate `Changeset` in a fresh sub-tick of the same outer call — still synchronous from the caller's perspective.
- **Not an effect system.** Side effects inside `fn` (network calls, DOM writes) run where they are called. Only the substrate-writable mutations are captured.

### Re-entrant `batch()` inside subscriber callbacks (drain-to-quiescence)

Subscriber callbacks may mutate freely. `batch()` invoked from inside `subscribe(doc, ...)` or `subscribeNode(doc.field, ...)` does *not* throw — `with-changefeed`'s per-context dispatcher (from `@kyneta/machine`'s `createDispatcher`) enqueues an `accumulate` Msg and the drain-to-quiescence loop processes it in a fresh sub-tick.

Substrate writes inside the re-entrant `batch()` remain **synchronous** — subsequent reads see the new state. The sub-tick's mutations produce their own `Changeset` once the inner `batch()` commits, delivered to subscribers after the originating Changeset.

When the host is an `Exchange`, every per-doc dispatcher shares the Exchange's `Lease` with the Synchronizer. Cross-doc A→B→A cascades, and tick-induced re-entry through the synchronizer, are bounded by one cooperating budget. A runaway oscillation throws `BudgetExhaustedError` whose message names the cascade's entry-point frame, a top-N message-type histogram, and a recent-event tail — the label histogram is the cascade *topology* and the count distribution names the *hot path*, so users can locate the responsible subscriber without ad-hoc instrumentation (`jj:tozwpvuu`).

See `@kyneta/machine`'s TECHNICAL.md §"Drain to quiescence and shared leases" for the primitive.

### Subscriber visibility of mid-batch re-entry

`deliverNotifications` iterates subscribers `[S1, S2, S3]`. If S1 calls `batch(doc, ...)` synchronously, S1's substrate writes land *before* S2 fires. S2 receives the `Changeset` describing the originating transaction, but reads from — and may write through — a substrate that already includes S1's mutations.

This invariant is uniform across all substrates — plain, Loro, Yjs — because every substrate now advances **both** of its state stores in lockstep at prepare-time:

- σ (the shadow, the reader's view) advances eagerly via `applyChange(shadow, path, change)`.
- λ (the native container tree, the change-mapping's view) advances eagerly too: PlainSubstrate has λ ≡ σ; CRDT substrates run their native mutation primitive immediately during `prepare` (Loro coalesces plain MapDiff writes and applies structural inserts on the spot; Yjs invokes `applyChangeToYjs` against the live `Y.Doc` inside the ambient transact opened by `runBatch`).

Concretely, the projection law `σ ≡ Π(λ)` (the naturality condition of the materialisation catamorphism) holds at every prepare boundary. A re-entrant subscriber may either read through σ (via the Reader / the ref `[CALL]`) or write through λ (via re-entrant `batch()`, which itself walks λ through `changeToDiff`/`applyChangeToYjs`) — both views are coherent.

When the outer batch is a **replay** batch from a substrate event bridge (e.g. an incoming sync merge), S1's local re-entrant write inside the replay-batch delivery is *not* a replay (the user code constructs a normal `batch(doc, ...)` with no `replay` flag), so the substrate's `prepare`/`afterBatch` apply it natively. Pre-fix this case was the source of a hidden invariant hole on CRDT substrates: an `inEventHandler`/`inOurTransaction` global flag wrapped the entire event-bridge call and caused the substrate to silently drop S1's write. Resolved by threading `BatchOptions.replay` as a typed parameter; see [§Origin vs replay](#origin-vs-replay).

Two guidances:

- The `Changeset` you receive describes the transaction that triggered your callback.
- The substrate state you read (and can safely write through) reflects everything up to now, including re-entrant writes from earlier subscribers in the same deliver batch.

To derive "pure pre-mutation state," consume the `Changeset` semantically; do not infer it by reading the substrate. This was always true in spirit — subscribers run after substrate commit — and the dispatcher refactor only changes whether re-entry from S1 succeeds (now) or throws (pre-1.6.0).

### `Changeset.aborted`

A Changeset with `aborted: true` is the bracket's signal that the outermost `batch(doc, fn)` block threw and was wholly compensated via inverse replay. The op list contains forward + inverse pairs that net to identity at every path. Inner `batch()`s that threw and were caught by an outer `batch()`'s try/catch produce a NON-aborted outermost Changeset; the absorbed forward + inverse pair sits in the op list alongside surviving outer ops. Consumers needing to identify absorbed inner aborts pair the ops semantically (the framework doesn't surface a separate flag for this).

The `aborted` flag is tightened: `true` iff the outermost block threw. Auto-commit blocks and successful outermost blocks have `aborted: undefined` (== falsy). Replay batches have `aborted: undefined`.

### `runBatch` — one bracket, three handlers

Under the three-primitive substrate contract (jj:ryquprut), `ctx.runBatch` is **one bracket primitive with three handlers**, not three concentric brackets. Inside the bracket, `prepare` is the single effect; the three handlers all key off the same `frameStarts.length` depth:

1. **Substrate handler** — invoked only at the depth-0 entry. Loro: `doc.commit()` at the wrap-end. Yjs: `Y.transact(doc, work, KYNETA_ORIGIN)`. PlainSubstrate omits this method; the ctx-level wrapper invokes the body directly. The Loro per-substrate depth counter is no longer needed — ctx-level outermost detection subsumes it.

2. **Changefeed-flush handler** — fires exactly once at the depth 1→0 transition. Success path: `ctx.flush(opts)`. Catch path: `ctx.flush({ ...opts, aborted: true })`. Inner frames push/pop without flushing — the depth-0 release is the single delivery point per outermost block.

3. **Inverse-stack handler** — every successful `prepare` pushes an `InverseEntry` (path + reverse arrow). On throw, the frame's range is replayed LIFO through `ctx.prepare(path, inverse, { compensating: true })`. Substrates skip inverse recording under the undo-replay handler (the `compensating` flag signals "this prepare is replaying an inverse, not applying a new forward change"). External observers see one batched native event whose ops net to zero.

The three handlers are co-extensive — they all open and close at the same boundary. `executeBatch` invokes `ctx.runBatch` for local-write batches; replay batches bypass it (the substrate's native state already absorbed those ops at the event-bridge call site, so there's no need for a bracket).

Substrate.runBatch is invoked at most once per outermost `batch(doc, fn)` — re-entrant subscriber writes open their own outermost runBatch (frameStarts goes to 0 between outer flush and subscriber re-entry), each block is its own atomic abort unit and gets its own commit.

**Gotcha: Compensation masking with buffered substrates.** If a substrate (like Loro) buffers changes (e.g., `coalesceBuffer`) or throws synchronously during `prepare`, Kyneta's eager inverse recording causes the compensation loop to apply inverses for changes that were never actually committed to the substrate. This can cause the compensation loop itself to crash (e.g., throwing "Index out of bound" when attempting to revert an uncommitted insert). A `try/catch` in the compensation loop ensures the original error is chained via `Error.cause`, but the architectural mismatch between eager inverse recording and buffered substrate application remains a known limitation.

**Future Direction:** This will eventually be resolved by a deeper architectural shift, such as a "two-phase prepare" (recording inverses only after successful substrate application) or by pushing transaction boundaries and rollback responsibilities down to the substrate.

### Batch metadata: origin / replay / source / aborted

`BatchOptions` extends `BatchMetadata` (defined in `@kyneta/changefeed`) with one upstream-only field `compensating`. Four channels ride on every batch through `executeBatch → ctx.prepare → ctx.flush → substrate.prepare → substrate.onFlush`, all surfacing on the delivered `Changeset` via `BatchMetadata`:

- **`origin`** — opaque application-level label. Propagates to `Changeset.origin` so subscribers can categorize batches (`"sync"`, `"undo"`, `"migration"` — or anything else). The schema layer and the exchange **never branch on origin's value**. It is *free vocabulary* for app code.

- **`replay`** — kyneta-internal structural directive. `true` iff the batch represents state authored elsewhere: substrate event bridge replaying `doc.import`, a `merge` payload, or version travel. Substrates with external mutation paths (Loro, Yjs) skip native-side work in `prepare`/`onFlush` when `replay: true` (the native state already absorbed the change); the changefeed layer still delivers `Changeset` notifications, and surfaces `replay: true` to subscribers. The plain substrate ignores `replay` in `prepare` because it has no out-of-band mutation path. **User-facing APIs (`change`, `applyChanges`) never construct `replay: true`** — only substrate event bridges and `merge` paths do.

- **`source`** — identity-typed echo-suppression token. Compared with `===` by subscribers that issued the change. Unlike `origin` (app vocabulary) and `replay` (kyneta-internal structural directive), `source` is a kyneta-managed handshake between writer and reader: the originating `batch()` caller mints a token (`Symbol("...")` or `{}`), passes it via `options.source`, and the same token round-trips to `Changeset.source` so the caller's subscriber can identify and skip its own writes. The schema layer NEVER branches on `source`'s identity — it threads it through the pipeline unchanged, the same way it threads `origin`. **Substrate replay paths explicitly drop `source`** — `source` never survives a CRDT round-trip; any value reaching a subscriber is therefore from a local `batch()` on this peer.

- **`aborted`** — kyneta-internal outcome directive. See §"`Changeset.aborted`" above.

These four fields are *orthogonal* — they form a two-axis classification (app-set / subscriber-set / kyneta-set × provenance / outcome). See `BatchMetadata` in `@kyneta/changefeed`'s TECHNICAL.md for the full table.

Layered consumers that need to discriminate "echo from sync" from "local write" — notably `@kyneta/exchange`'s auto-subscribe filter — read `Changeset.replay` rather than parsing the `origin` string. This closes a fragile string-collision surface where `batch(doc, fn, { origin: "sync" })` was accidentally suppressed and `doc.import(payload, "from-some-other-pubsub")` would echo to peers. Context: jj:qpultxsw.

The "schema layer and exchange never branch on origin's value" invariant is again **structurally true** after jj:wpvtoxmw — the conflation that had crept into `text-adapter` (`origin === "local"` for echo suppression) and `Line` (a dead `origin === "local"` filter) was rectified by introducing the identity-typed `source` channel and removing the dead Line filter.

### Origin-free discriminator

Kyneta is a translucent layer over the underlying CRDT. The user-facing origin slot (`batch.origin` in Loro, `transaction.origin` in Yjs) is reserved for `options.origin` round-trip — providers and ecosystem libraries (Yjs UndoManager, y-websocket, etc.) depend on this slot being app-controlled. The substrate's "is this event mine?" discriminator must travel via the CRDT's own event-machinery channels, not via the origin slot.

#### Why this matters (translucency as a kyneta value)
Kyneta's "bring your own doc" position is that the underlying CRDT remains fully usable by raw consumers and ecosystem tooling. The Yjs ecosystem in particular routes provider identity (`y-websocket`, `y-indexeddb`, `y-webrtc`) and orchestration filters (`UndoManager.addTrackedOrigin`) through `transaction.origin` — colonizing that slot with a kyneta sentinel forces every kyneta-using app to either fork those tools or accept that kyneta is opaque to the rest of its ecosystem. The same logic applies to Loro's `batch.origin` as its provider ecosystem matures. Translucency isn't a stylistic choice — it's load-bearing for interop. Any future "let me just put a small flag on `transaction.origin`" proposal must answer: how does this not break the provider ecosystem?

#### Loro implementation
`subscribePreCommit` hook captures per-commit identity `(peer, counter+length-1)` synchronously inside `doc.commit()`; subscribe handler matches via `batch.to` entries.

#### Yjs implementation
`transaction.meta.set(MARK, true)` inscribed from inside the `Y.transact` body; observeDeep checks `transaction.meta.get(MARK)`. Survives Yjs's nested-transact collapse.

#### Why the two implementations aren't identical
Loro models commits as a discrete API call (`doc.commit()` is separate from the pending mutations); Yjs models transactions as a body callback (`Y.transact(body)` runs work inside an opened transaction object). The pre-commit hook is Loro's analog of "code that runs inside the transaction"; `transaction.meta` is Yjs's analog of "intrinsic per-commit identity that travels with the event." Same principle (origin-free, CRDT-native machinery), substrate-shaped expression.

#### Known limitation (both substrates)
Mixing raw CRDT mutations with kyneta `batch()` calls inside the same atomic unit (Yjs `transact` body, or Loro pending ops accumulated before a kyneta-issued commit) is unsupported. The raw mutations will be silently absorbed into kyneta's own-commit skip and not bridged to the changefeed. Use separate transacts/commits for raw mutations. This is a fundamental limit of commit-level discrimination — no origin-free approach can address it without op-level provenance, which neither CRDT exposes.

Context: jj:uvykupvx.

### Substrate algebra vocabulary

The substrate is a functor `Π : ChangeGroupoid → NativeStateCategory`. Three names show up across `prepare`, `afterBatch`, `runBatch`, the inverse stack, and the materialisation interpreter:

- **σ** — the **shadow**, a plain JS object materialized from the native CRDT tree. The Reader closes over σ; all `ref[CALL]` reads bottom out here.
- **λ** — the **native CRDT container tree**. For Loro: `LoroDoc` + its `LoroMap` / `LoroList` / `LoroText` / `LoroTree` children. For Yjs: `Y.Doc` + `Y.Map` / `Y.Array` / `Y.Text`. For PlainSubstrate: λ ≡ σ.
- **Π** — the **materialisation catamorphism**: `materializeLoroShadow`, `materializeYjsShadow`. Produces σ from λ in one pass.

The **projection law** `σ ≡ Π(λ)` is the naturality of `Π` between the abstract state and the CRDT-native state. It holds at every prepare boundary. Stated as two naturality conditions over the change groupoid:

- Forward: `Π ∘ step_λ(c) = step_σ(c) ∘ Π`
- Inverse: `Π ∘ step_λ(invert(c)) = step_σ(invert(c)) ∘ Π`

Both must hold. Naturality over `invert` is what makes the abort path correct: when the bracket replays inverses inside the same commit, the σ-side compensation matches the λ-side compensation step-for-step, so external observers see one batched event with net-zero delta simultaneously on σ AND λ. A backend whose `applyChange` is not natural over `invert` would fail abort silently (σ revert, λ partial — or vice versa).

Substrate-implementation contract: **any backend whose `applyChange` is a natural transformation over the change groupoid (forward AND inverse arrows) automatically gets correct abort for free.** PlainSubstrate is the degenerate case (σ ≡ λ, Π = id; both naturality squares hold trivially). Loro and Yjs satisfy naturality by design.

Replay can't use incremental σ-step: CRDT merge is a lattice join with no sequential decomposition. The correct response is `syncShadow(materialize(λ))` in `afterBatch` on replay — re-materialise σ from λ in one Π pass.

### Inverse algebra

Source: `packages/schema/src/inverse.ts`.

The change algebra `⟨State, Change, step⟩` is extended into a groupoid by `invert(pre, change)`: a reverse arrow such that `step(step(pre, change), invert(pre, change)) = pre`. This is the groupoid identity law `c ∘ c⁻¹ = id` written in coordinates; the per-type test table pins it for every `ChangeBase` constructor.

| Type | Inverse shape |
|------|---------------|
| `replace` | swap value (`replaceChange(pre)`) |
| `increment` | negate amount |
| `text` | OT inverse: retain → retain, insert → delete, delete → insert (text from pre at preCursor) |
| `sequence` | OT inverse with deep-cloned items |
| `map` | restore prior entries; new keys → delete; overwritten keys → set to prior value |
| `set` | swap add/remove (set membership equality, not order) |
| `richtext` | OT inverse with mark restoration |
| `tree` | per-instruction inverse with pre-state topology lookup; reversed instruction order for LIFO undo |

Substrates capture `pre = path.read(σ)` (deep-cloned via `deepClonePreState`) before applying the forward change, compute the inverse, push it onto the active runBatch frame's stack via the `RECORD_INVERSE` callback threaded through prepare options. On throw, the bracket's catch path replays inverses LIFO inside the same commit — observers see one batched event with net-zero delta.

### Depth-aware `dispatch`

`WritableContext.dispatch` is a depth-aware combinator. The 5 ref-helper files (`scalar.set`, `sequence.push`, etc.) and the addressing layer's `REMOVE` handler all route through it. Its polymorphism shifted under jj:ryquprut:

- Pre-refactor: `dispatch = inTransaction ? buffer : applyImmediately`. Buffered changes accumulated in `pending`; commit flushed them.
- Post-refactor: `dispatch = frameStarts.length === 0 ? implicitSingleOpRunBatch : justPrepare`. In-block dispatch is just a prepare (the outer frame owns the flush boundary); out-of-block dispatch opens an auto-commit single-op runBatch.

Both shapes are polymorphic combinators with a local condition; the new role is structurally simpler. Keeping the combinator avoids 5+1 files of mechanical helper conversion and eliminates per-helper substrate-bracket re-entry overhead — in-block helpers collapse into one substrate commit + one Changeset.

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

For a composite ref, `subscribeDescendants` aggregates own-path changes with children's tree-streams (paths prefixed appropriately). For a leaf ref, `subscribeDescendants` is the trivial own-path lift: every change is delivered as a single `Op` whose `path` is the leaf's registry-aware root (empty relative path). A leaf is a tree of size 1.

`subscribe` (own-path only, `Changeset<C>` shape with no paths) is the lighter sibling. The two channels carry the same information for a leaf and different information for a composite (where own-path ⊊ tree).

Facade vs. protocol vocabulary inversion: facade `subscribe` is deep delivery (`Changeset<Op>`); the protocol-level `ChangefeedProtocol.subscribe` is own-path delivery (`Changeset<ChangeBase>`). The facade hides this; power users reaching directly into `ref[CHANGEFEED]` should know it.

> **Principle.** Facade-level entry points should hide protocol-method-set distinctions when the user's semantic is well-defined regardless of carrier kind. "Subscribe to changes under this ref" is well-defined for any reactive value; whether the value happens to have children is a structural concern, not an observation concern. Pre-1.6.0 the facade threw on `subscribe(leaf)` because leaves lacked `subscribeDescendants`; 1.6.0 retires that leak by lifting `subscribeDescendants` to every schema-issued changefeed.

**The pure helpers.** `liftToOps(cs, path): Changeset<Op<C>>` raises shape from `Changeset<C>` to `Changeset<Op<C>>` at a constant path; `prefixOps(cs, prefix): Changeset<Op<C>>` keeps shape and prepends a prefix to each event's existing path. Together they form the entire shape-grammar of the changefeed delivery pipeline: leaves' `subscribeDescendants`, composites' own-path → tree fan-out, and composites' child-tree propagation all decompose into one of these two transforms.

`subscribe(ref, callback)` is the facade primitive that calls `subscribeDescendants` under the hood. `subscribeNode(ref, callback)` is the explicit shallow opt-in — fires only when the *specific node's* state changes, not its descendants.

### `planNotifications` → `deliverNotifications`

Two pure functions form the notification engine:

1. `planNotifications(changes, addressTable)` → `NotificationPlan` — which refs need which changesets, deduplicated and ordered.
2. `deliverNotifications(plan, subscribers)` → fires each subscriber exactly once per transaction with the appropriate changeset.

This is how a transaction that modifies `doc.items[0].title` and `doc.items[0].count` delivers one changeset to `subscribe(doc)` (two ops), one to `subscribe(doc.items)` (two ops), one to `subscribe(doc.items[0])` (two ops), and one each to `subscribe(doc.items[0].title)` / `subscribe(doc.items[0].count)` (one op each) — all synchronously, all deduplicated.

The per-context dispatcher (`createDispatcher<ChangefeedMsg>` inside `ensurePrepareWiring`) is what makes re-entrant `batch()` calls from inside a subscriber safe: each call dispatches an `accumulate` Msg that drains in a fresh sub-tick. See [Re-entrant `batch()` inside subscriber callbacks](#re-entrant-batch-inside-subscriber-callbacks-drain-to-quiescence).

### `expandMapOpsToLeaves`

A single `MapChange` (e.g. `replaceEntry("alice", {...})`) represents a structural operation on a `map` node. For subscribers on descendants of that map, the change has to be *expanded* into per-leaf `ReplaceChange` ops. `expandMapOpsToLeaves` does this pure expansion, used by `planNotifications`.

### Dynamic-collection changefeed factories

`createSequenceChangefeed`, `createMapChangefeed`, and `createTreeChangefeed` are three instances of one pattern: an **own-path listener** registered via `listenAtPath` + a **per-key forwarder map** holding `child[CHANGEFEED].subscribeDescendants(propagateUp)` unsubs + **structural-change-driven wire/unwire** triggered from the own-path callback.

The three differ only in:

| Factory | Key type | Key-stability source | Structural-change-instruction source |
|---------|----------|----------------------|--------------------------------------|
| `createSequenceChangefeed` | numeric index | `ADDRESS_TABLE` from `withAddressing` (stable address IDs) | `SequenceChange` instructions + `ReplaceChange` |
| `createMapChangefeed` | string key | the key itself (LWW per key) | `MapChange.set` / `MapChange.delete` |
| `createTreeChangefeed` | `TreeID` | the TreeID itself (CRDT-stable identifier) | `TreeChange.instructions` (`create` / `delete`; `move` preserves identity) |

The dynamic-lookup property of `deliverNotifications` is what makes same-batch wiring correct in all three: when a parent's own-path callback fires `subscribeToChild(newKey)`, the new child's `listenAtPath` registration lands in the listener map mid-iteration; the next path the loop reaches finds the freshly-registered listener and fires it. This is the same invariant for sequence (`subscribeToItem`), map (`subscribeToEntry`), and tree (`subscribeToNode`).

Tree is the cleanest instance of the pattern: TreeIDs are identity-bearing from the start (no address-table dance), and `TreeChange.instructions` is an explicit create/delete stream (no diff inference from `MapChange.delete` keys). Tree's structural-change handler is a two-line compose of the pure `planTreeMembershipUpdate` (the diff calc) + the impure wire/unwire loop — see `with-changefeed.ts:createTreeChangefeed`.

### Terminal-on-delete

`createTreeChangefeed` is the one dynamic-collection factory that synthesizes a **terminal event** before tearing down a per-node forwarder on deletion. When a `TreeChange.delete` removes a node, the per-node `treeSubs` receive one final `Changeset<Op>` containing the delete instruction at the node-relative path. After that delivery, the forwarder is torn down and the subscriber receives nothing further.

The terminal payload is built by the pure `synthesizeTreeDeleteTerminal(prefix, id)` helper — pinned as a first-class artifact rather than inline-synthesized. Subscribers pattern-match on `cs.changes[0].change.type === "tree" && instructions[0].action === "delete"` to detect end-of-stream.

The asymmetry with sequence and map is justified by **identity semantics**: TreeIDs are CRDT-stable identifiers (minted at create-time, never reused, never re-anchored on shifts), and a subscriber at `d.tree.node(id)` holds a meaningful identity reference. Map keys are user-chosen strings that can come and go without identity meaning (re-adding the same key creates "the same" entry); sequence items are positional and shift under structural change. Only tree carries the identity invariant that warrants a lifecycle-end signal.

**Last-subscriber teardown is distinct from terminal-on-delete.** When `subscribeDescendants`'s unsub fires `treeSubs.size === 0`, the factory uses a private `tearDownForwarder` helper that bypasses `synthesizeTreeDeleteTerminal`. Conflating teardown-because-empty with terminal-because-deleted would emit phantom delete events to a (just-cleared) subscriber set on resubscribe scenarios — a correctness leak avoided by routing the two paths through different helpers.

### Per-ref-instance listener multiplication

Each call to the catamorphism's per-id child closure (sequence's `itemFn`, map's `itemFn`, tree's `nodeFn`) produces a fresh ref carrier. Each carrier's interpreter recursion calls `wireChangefeed` → `attachChangefeed` → its own `[CHANGEFEED]` protocol; each protocol's own-path listener registers a callback in the shared listener-Map entry at the same path key.

So multiple ref instances at the same path → multiple callbacks → multiple fan-outs per flush. The listener-Map keyed by `path.key` is *shared* (via `listenAtPath`), but each ref instance is independent. Correct by construction — `Changeset` delivery to N callbacks at the same path key is exactly N invocations — but not free.

Profiling memory or callback counts on tree-heavy docs (where re-accessing `d.tree.node(id)` in subscriber callbacks is common) may surface this as a future optimization target: catamorphism-side memoization keyed by `(parentPath, id)` would collapse the ref-instance count to one per id. Documented here to surface the property; not currently fixed.

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
- `deriveSchemaBinding(manifest)` → `{ forward: Map<string, Hash>, backward: Map<Hash, string> }` — the runtime lookup used by substrates to key their CRDT containers.

The substrate consumes the `SchemaBinding` in its `factoryBuilder` context. Loro and Yjs backends use `forward` to determine container keys: a product field named `"title"` with identity hash `"abc123…"` is stored at `LoroMap.getMap("abc123…")`, not at `LoroMap.getMap("title")`. Renaming a field changes its display name, not its stored identity — the CRDT state survives the rename.

### `supportedHashes`

Source: `packages/schema/src/migration.ts` → `computeSupportedHashes`.

A `BoundSchema` declares `supportedHashes`: all schema hashes at which the current peer can op-stream sync. Computed by `computeSupportedHashes(schema)`, which recursively walks **every** `MigrationChain` in the schema tree — the root chain plus chains on nested `ProductSchema` fields. The set is the **cartesian product** over independent chains: if the root chain reaches `N` ancestor shapes and a nested field's chain reaches `M`, the result contains `N × M` hashes.

**Per-chain halt** at the first of:

- **T2 step** — destroys identities; advertising T2 ancestors would overstate compatibility (the current path-keyed substrate has no identity-tombstone safety net). This aligns the single-set `supportedHashes` with the theory's `nativeSupports` semantics (`.jj-plan/migrations.md` §8).
- **T3 epoch** — hard identity break; pre-epoch hashes are deliberately unreachable.
- **Un-invertible primitive** — anything not currently in `{add, rename, move}` at root level. The schema surgery for `addNullable` / `widenConstraint` / sub-product variant operations is bounded but not yet implemented; the walk halts conservatively rather than over-advertise.
- **`chain.entries` exhaustion** — the `chain.base` prune horizon; pre-base shapes are not recoverable from the chain alone.

The richer `readSupports` / `nativeSupports` split (allowing degraded entirety-only sync across T2/T3 boundaries — see `.jj-plan/migrations.md` §8.1) is deferred until degraded-sync infrastructure exists.

The exchange includes `supportedHashes` in every `present` message when it carries more info than the primary hash alone. Receivers with older schemas check whether one of their hashes is in the sender's `supportedHashes` to decide if sync can proceed.

### What migrations are NOT

- **Not SQL-style migrations.** No `up` / `down`, no runtime execution of migration code. The chain declares the identity map; the substrate reads identity-keyed data.
- **Not version numbers.** Two schemas with different migration histories may have the same shape but different identity spaces — and therefore cannot sync. The chain is part of the identity, not metadata about it.
- **Not bidirectional.** An epoch step is a one-way break. T0 / T1 primitives are reversible in principle, but Kyneta does not support "downgrading" a document — sync fails instead.

---

## Change vocabulary

Source: `packages/schema/src/change.ts`.

Every mutation flows through a `Change` — a discriminated union identified by `type`. The built-in types:

| `type` | Shape | Composition law | Used by |
|--------|-------|-----------------|---------|
| `"text"` | `{ instructions: TextInstruction[] }` — retain / insert / delete over characters | `positional-ot` | Text CRDTs |
| `"sequence"` | `{ instructions: SequenceInstruction[] }` — retain / insert / delete over items | `positional-ot` | Lists, movable lists |
| `"map"` | `{ entries: MapInstruction[] }` — set / delete over keys | `lww-per-key` | Maps, sets |
| `"tree"` | `{ instructions: TreeInstruction[] }` — create / move / delete nodes | `tree-move` | Trees |
| `"replace"` | `{ value: unknown }` — overwrite this node | `lww` | Scalars, plain JSON sub-trees |
| `"increment"` | `{ delta: number }` — counter increment | `additive` | Counters |
| `"richtext"` | `{ instructions: RichTextInstruction[] }` — retain / insert / delete / format over characters | `positional-ot` | Rich text CRDTs |

Note: `TextChange` and `SequenceChange` are parameterizations of the same positional algebra, unified by the `Instruction` type. Both use `retain`/`insert`/`delete` cursor instructions; the only difference is the content type (`string` vs `T[]`). The shared algebra is captured by `foldInstructions`, `transformIndex`, and `advanceAddresses`, which operate on `Instruction` generically.

`ChangeBase` is re-exported from `@kyneta/changefeed` — the open protocol base. Third-party backends may extend with additional `type` values; the exchange and interpreters treat unknown types as opaque, passing them through.

### `Change` flows both ways

- **Inbound** (developer → substrate): the proxy in `batch(doc, fn)` records changes describing *intent*.
- **Outbound** (substrate → subscribers): the substrate's changefeed emits changes describing *what happened*.

The shapes are identical. The substrate's `prepare` pipeline consumes the inbound changes, applies them, and re-emits (potentially transformed) outbound changes.

### Constructors, guards, and transforms

For every built-in change type:

- Constructor: `textChange(instructions)`, `sequenceChange(instructions)`, `mapChange(entries)`, etc.
- Type guard: `isTextChange(change)`, `isSequenceChange(change)`, etc.
- Pure transformer: `foldInstructions(instructions)`, `advanceIndex(index, instructions)`, `advanceAddresses(addresses, instructions)`.

`applyTextInstructions(target, instructions)` replays a `TextInstruction[]` delta onto a live `TextRef`. It is the **imperative shell over `textInstructionsToPatches`** — it converts the cursor-based instructions to absolute-offset patches, then dispatches each to `TextRef.insert`/`.delete` (the `TextRef` counterpart to applying those patches to a DOM `Text` node via `insertData`/`deleteData`; see [Position algebra](#transformindex-and-textinstructionstopatches)). It is *not* built on `foldInstructions`: that is a dual source/target cursor fold for diffs, whose `insert` case carries only a length, not content — the wrong sibling for single-cursor, content-carrying replay.

These are the primitives `step`, `with-changefeed`, and `Position` build on.

---

## The plain substrate

Source: `packages/schema/src/substrates/plain.ts`.

The built-in substrate. Stores state as plain JS objects, tracks a monotonic integer version scoped to an lineage (see `PlainVersion` below), and merges by total-order last-writer-wins within an lineage. Used for:

- The default binding when no CRDT is needed (`Schema.string`, small configs, ephemeral UI state).
- The LWW variant (`src/substrates/lww.ts` + `src/substrates/timestamp-version.ts`) for wall-clock-ordered ephemeral broadcasts.
- Reference implementation for testing the `Substrate<V>` contract.

All substrates now share the same read semantics: reads go through `plainReader` backed by a `PlainState` object. For the plain substrate this is trivially the substrate's own state. For CRDT substrates (Loro, Yjs), the `PlainState` is a shadow that is kept in sync — eagerly on local writes, re-materialized from the CRDT doc on replay. See [§The functional shadow](#the-functional-shadow).

Key functions:

- `createPlainSubstrate(schema, context)` → `Substrate<PlainVersion>`.
- `createPlainReplica(context)` → `Replica<PlainVersion>`.
- `plainSubstrateFactory` / `plainReplicaFactory` — exported factory instances.
- `buildUpgrade(schema)` → function that re-derives internal structures after hydration.
- `objectToReplaceOps(obj)` → flatten a plain object into a sequence of `ReplaceChange` ops for migration.

### `PlainVersion`

```
class PlainVersion {
  constructor(value: number, lineage: string)
  readonly value: number
  readonly lineage: string
}
```

A **single-entry version vector**: at most one authored *lineage* `{lineage: value}`, with genesis (`DEFAULT_LINEAGE`) as the empty vector ⊥ (see [§Version vector algebra](#version-vector-algebra)). `serialize()` produces `"lineage:value"` (genesis serializes as `"kyneta.genesis:0"`); `parseVersion` also accepts legacy bare-integer strings (e.g. `"5"`), which parse as belonging to `LEGACY_EPOCH`. Context: jj:kxswmuzx.

`lineage` is the version-vector *lineage key* — the identity coordinate, universal to every `Version` (see [§Version vector algebra](#version-vector-algebra)). Plain is the substrate where the lineage changes during normal operation (a fresh REAL lineage is minted on the first authored write, or on a writer restart with no persisted store); CRDT substrates (Loro, Yjs) and `state` hold a constant `DEFAULT_LINEAGE`, their identity living in their own native vectors.

`compare()`/`meet()` delegate to `versionVectorCompare`/`versionVectorMeet` over `#toVector()` (`DEFAULT_LINEAGE` → empty map; REAL → `{lineage: value}`) — **no** Plain-specific case matrix:
- Two genesis versions → `equal` (both ⊥); genesis vs a REAL lineage → `behind`/`ahead` (⊥ is a subset).
- Same REAL lineage → total order on `value`.
- Two different REAL lineages → `concurrent` (disjoint keys); their `meet` is the empty vector → genesis (a valid compaction floor).

**Op-free genesis.** A freshly created doc is the empty vector: `buildUpgrade` applies structural defaults directly to the doc *without* flushing them into the log (structure is schema-derived and reconstructed by every interpreter), so `version()` starts at `DEFAULT_LINEAGE:0`. Identity is minted lazily by `createPlainSubstrate.afterBatch` on the first **local, non-`replay`** authored flush (via `adoptEpoch(randomHex(8))`) — never in `strategy.current()` (a pure projection now), and never on a merge/replica that merely *absorbs* a peer's ops, so absorbed content never causes a peer to invent an identity.

`merge()` adopts an incoming lineage (via the `adoptEpoch` closure) only while the current lineage is still `DEFAULT_LINEAGE` — accepting the substrate's first real lineage. Genuine lineage-boundary resets (a REAL lineage transitioning to a *different* REAL lineage) are handled by `resetFromEntirety` (see `Substrate.resetFromEntirety` and `@kyneta/exchange`'s [Compaction and lineage boundaries](../exchange/TECHNICAL.md#compaction-and-lineage-boundaries)), which the Synchronizer invokes on an explicit mismatch — `merge()` never adopts across two REAL lineages. `SubstratePayload.lineage` is the preferred source for the incoming lineage; `parsePlainPayload`'s legacy `{ i, s|b }` envelope extraction is the fallback for peers that pre-date lineage support.

### `TimestampVersion`

For ephemeral substrates: a single wall-clock number plus the peer ID. `merge` accepts the incoming value iff `timestamp > local.timestamp || (equal && peerId > local.peerId)`. Stale writes are rejected silently.

### Wire-codec opacity

The plain substrate's `serializeOps` / `deserializeOps` embed `Op.change` by reference — the change is JSON-stringified as-is and passed through `WireOfferMsg.d` (an opaque `string | Uint8Array` payload). The exchange wire codec never inspects schema-level change types; it carries them as JSON inside the substrate payload. Adding a new `ChangeBase` variant (e.g. `SetChange { type: "set-op" }`) is purely additive — no exchange codec change required. The only caveat is for out-of-monorepo consumers parsing the plain JSON wire format with a strict change-type whitelist: those need to extend their whitelist when new change variants land.

The lineage now travels as an explicit field, `SubstratePayload.lineage`, set by every substrate's `exportEntirety`/`exportSince` (Plain sets it to the current lineage; Loro/Yjs/`state` set it to `DEFAULT_LINEAGE`). Plain's own `data` payload is simply `JSON.stringify(materialize())` for entirety and `JSON.stringify(serializedBatches)` for since — no inner envelope. This is a simplification from an earlier design where Plain's JSON payload wrapped state/ops in an inline envelope (`{ i: string, s: PlainState }` / `{ i: string, b: SerializedOp[][] }`); that inline lineage field duplicated information already available via the parsed `Version` (which encodes as `"${lineage}:${value}"`) and via the new `SubstratePayload.lineage` field, creating a desync hazard between the wire-level version and the body-embedded lineage.

`parsePlainPayload` still parses the legacy `{ i, s|b }` envelope for backward compatibility with peers/payloads that pre-date `SubstratePayload.lineage` — `SubstratePayload.lineage` is the preferred source when present; `parsePlainPayload`'s extracted `i` field is the fallback. Bare state objects / bare op-batch arrays (no `i` field, no `SubstratePayload.lineage`) still parse correctly via the same helper, one level further back in the compatibility chain.

### The op-log holds immutable `RawPath` (authoring-time freeze)

**Invariant: the op-log is history — immutable values, never references into the live addressing registry.** A logged `Op` is a fact about the past; a since-deleted key is still the correct thing that op did. `AddressedPath` segments are memoized, *mutable* `Address` objects (an entry delete sets `dead = true`; a sequence edit advances `index` — both in place, see [§The interpreter stack](#the-interpreter-stack) addressing and `change.ts` `advanceAddresses`). If the log stored the live path, a later mutation would corrupt a historical op: `exportSince` → `serializeOps` would throw `"Ref access on deleted map entry"` on a tombstoned entry segment, or silently serialize a *drifted* index. Context: jj:mlurlzqt.

The fix is a one-token change at the authoring seam: `PlainSubstrate.prepare` (and the `state` substrate's) pushes `{ path: path.toRaw(), change }`, not `{ path, change }`. `Path.toRaw()` (`path.ts`) is a pure projection — `RawPath.toRaw()` returns `this`; `AddressedPath.toRaw()` reads each segment's **`coord()`** (never `resolve()`, so it succeeds even for a dead address). It is the named inverse of `resolveToAddressed`. Two consequences worth internalizing:

- **Freeze at *push*, not flush.** Index addresses advance in place *within* a batch, before `log.push([...pendingOps])` runs, so freezing later would capture the post-advance index. Push-time captures the coordinate as-authored. (The addressing prepare-handler fires *before* `substrate.prepare` for the same change, but an op's own path coordinate is stable under its own change — structural effects live in the change *payload* at the container path, not in the op's path segments; `index`/`entry` segments appear only on *nested* writes, which don't advance the address they sit on.)
- **The log is now byte-shape-homogeneous.** Local-write ops and merge ops (which were already `RawPath` via `deserializeOps`) are the same value type, replayed by the same `applyChange`. `serializeOps` needs no special case: its `seg.resolve()` runs only on total `RawSegment`s and never throws — the defect was the *input*, not the code.

### `resolve()` vs `coord()` — liveness assertion vs coordinate projection

A path segment (`RawSegment` | `Address`, `path.ts`) exposes two coordinate accessors, and the distinction is load-bearing:

- **`coord()`** — total, pure, never throws (even for a dead `Address`). The coordinate is an *invariant* of the segment (`readonly key` / `index`). Use it for **history, diagnostics, identity, and reads**: serialization, `format()`, the `\0`-joined `key`, schema/position walks (`fold-path.ts`, `doc-position.ts`, `schema.ts` — a deleted *instance* keeps its static *schema*), and `AbstractPath.read`.
- **`resolve()`** — projects the coordinate but *asserts liveness*, throwing on a dead `Address`. This is the loud-failure backstop for a **stale ref that tries to navigate or write**. It survives only at the genuine guard sites: the `Address` factories themselves, `writeByPath` (writing through a deleted path must fail), and the live ref-navigation surface.

Two totality rules follow (both fixed as part of jj:mlurlzqt):

- **Diagnostics never throw.** `format()`/`key` route through `coord()`. Previously they used `resolve()`, so formatting a path with a dead segment threw *while building an error message* (e.g. `withAddressing`'s `onRefCreated` throw), masking the original error.
- **Reads are total; a deleted key is absent.** `path.read(store)` of a deleted key returns `undefined` (via the natural `store[key]` miss), **not** a throw. Deletion remains observable via `deleted(ref)`; **writes** still throw (that guard belongs on the write path, not the read). This is the intended contract — see the `with-addressing` "delete → read undefined, write throws, deleted is true" tests.

## The functional shadow

CRDT substrates (Loro, Yjs) maintain a **shadow**: a `PlainState` object that serves as the canonical read surface for all interpreter-stack reads. The architecture separates four surfaces:

| Surface | Backing | Purpose |
|---------|---------|---------|
| **Read surface** | `PlainState` + `plainReader` | All `ref.field()` reads, subscriber reads, interpreter-stack caching |
| **Sync surface** | CRDT doc (`LoroDoc` / `Y.Doc`) | `exportSince`, `merge`, `import` — replication and conflict resolution |
| **Position surface** | CRDT doc | `positionResolver` — cursor / relative-position operations that require CRDT structure |
| **Native escape hatch** | CRDT doc | `nativeResolver` — direct access to the underlying CRDT container for advanced use |

**On local writes**, `prepare` calls `applyChange(shadow, path, change)` — the same pure `step` function used by the plain substrate — making the write immediately visible to reads. CRDT diffs are buffered and applied to the CRDT doc in `onFlush`. This two-phase design means the read surface is always ahead of (or equal to) the sync surface during a transaction.

**On replay (merge)**, the CRDT doc absorbs the remote state first (via `doc.import` or `Y.applyUpdate`). `onFlush` then re-materializes the shadow from the CRDT doc, ensuring `ctx.reader` reflects the merged state for subscriber callbacks.

**Initialization.** The shadow is created at substrate construction time via `materializeLoroShadow` (Loro) or `materializeYjsShadow` (Yjs). These functions now delegate to `createMaterializeInterpreter` with a backend-specific `MaterializeResolver`, rather than defining bespoke 370-line interpreters. The resolver closes over the CRDT doc and binding; the generic materializer walks the schema and calls resolver methods to produce a plain JS object matching the schema's shape. The shadow is also re-materialized on upgrade and after any replay flush.

**`Reader` vs `MaterializeResolver`.** `Reader` (4 methods) is the runtime read interface backed by the `PlainState` shadow — schema-blind, live. `MaterializeResolver` (6 methods) is the materialization interface backed by the CRDT — schema-aware via catamorphism dispatch, one-shot. They share a conceptual lineage — the resolver is what a CRDT Reader would look like if it were schema-aware and didn't need liveness.

This design makes the read-your-writes invariant true by construction for all substrates: reads always go through `plainReader(shadow)`, and local writes always land in the shadow eagerly. No coordination, no flags, no special-casing per substrate.

---

## `foldPath` — schema-guided path resolution

Source: `packages/schema/src/fold-path.ts`.

`foldPath` is the schema-guided sibling of `Path.read(state)`. Where `Path.read` walks a plain JS object by segment-resolved keys, `foldPath` walks a substrate-native container tree by composing `advanceSchema` (pure schema descent) with a backend-supplied `PathStepper` (per-step substrate dispatch). Backends carry only the `PathStepper`; the fold skeleton lives once in core.

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

### Two semantic invariants live in `foldPath`, in one place

1. **Identity-keying at product-field boundaries only.** When `seg.role === "field"`, the absolute schema path is extended via `extendSchemaPathKey(prev, segment)` and used to look up `binding.forward.get(key)`. `entry` (map/set/tree) and `index` (sequence/movable) segments pass through with the raw key — they are not identity-keyed. The writer side of this contract — `deriveBindingRecursive` in `migration.ts` — uses the same `extendSchemaPathKey` accumulator, so the writer/reader key construction is byte-identical by construction.

2. **Sum-boundary short-circuit.** When the fold lands on a schema with `[KIND] === "sum"`, all remaining segments resolve via plain JS property access on the returned value. Sum variants are PlainSchema by construction — no CRDT containers exist inside them — so the substrate has nothing to navigate past the sum boundary.

### `pathSchema` — the schema-only specialization

`pathSchema(rootSchema, path, binding?)` is `foldPath` with a no-op stepper, returning only `.schema`. Used by callers that need the schema at a path but not the substrate value: changefeed kind classification (`changefeed.ts:resolveSchemaKindAtPath`), change-mapping target resolution (Loro `changeToDiff` / `batchToOps`, Yjs `applySequenceChange` / `applyMapChange` / `applyReplaceChange` / `eventToChange`). The sum-boundary rule applies uniformly — on a sum-interior path, `pathSchema` returns the sum schema (the variant cannot be determined without a value at parse time).

### Why one fold, not many

Before this primitive, both Loro's `resolveContainer` and Yjs's `resolveYjsType` re-implemented the same left-fold over `Path.segments`, and four schema-only walks (one in `changefeed.ts`, one in `yjs/change-mapping.ts`, two inline in `loro/change-mapping.ts`) re-implemented the schema-only variant with subtly different sum-boundary handling (three explicit short-circuits, one try/catch). After the consolidation, `advanceSchema` has exactly one production caller — `foldPath` itself — and the sum-boundary rule is structural, not exception-based.

---

## Validation

Source: `packages/schema/src/interpreters/validate.ts`.

A separate interpreter — not required by the stack, not automatic. `validate(schema, value)` returns `ValidationResult` collecting every error in the tree; `tryValidate` throws on the first. `SchemaValidationError` carries a structured `path` and a human-readable `message`.

Validation is an *interpretation* of the schema. The same `Schema` value that builds a ref also validates untrusted input. Errors format via `formatPath(path)` for human-readable output.

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

The materializer is the canonical consumer of zeros for CRDT substrates — the `zeroInterpreter` is the single source of truth, and zeros are no longer eagerly written during CRDT initialization. CRDT initialization routines (`ensureRootContainer`, `ensureContainers`) now only create structural containers.

---

## Describe

Source: `packages/schema/src/describe.ts`.

`describe(schema)` returns a human-readable ASCII tree of the schema structure. Used in tests, logs, and documentation. Not used at runtime by any interpreter.

---

## Key Types

Selection of the most-used types. Full list in [Canonical symbols](#canonical-symbols) at the top of this document.

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
| `foldPath`, `pathSchema`, `PathStepper`, `PathFoldResult`, `extendSchemaPathKey` | `src/fold-path.ts` | Schema-guided path-fold primitive (the substrate-blind sibling of `Path.read(state)`) and shared binding-key accumulator. |

## Build & Exports

### Subpath exports

The package exposes three subpath exports via `package.json` `"exports"`:

| Subpath | Import path | Entry | Role |
|---------|-------------|-------|------|
| `"."` | `@kyneta/schema` | `src/index.ts` | Public barrel — every public symbol. |
| `"./basic"` | `@kyneta/schema/basic` | `src/basic/index.ts` | Test-only helpers (re-exports of internal utilities for backend test suites). |
| `"./testing"` | `@kyneta/schema/testing` | `src/testing/index.ts` | Backend conformance testing: `positionConformance` and `PositionTestEnv`. |

The `"./testing"` subpath exists so that backend packages (`@kyneta/loro-schema`, `@kyneta/yjs-schema`) can import the position conformance harness without depending on vitest at runtime. The tsdown config externalises vitest via `neverBundle: ["vitest"]`, so vitest internals are never bundled into the published `dist/`.

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

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | ~400 | Public barrel — exports every public symbol. |
| `src/schema.ts` | ~800 | The grammar: types + `Schema.*` constructors + `advanceSchema` + `buildVariantMap` + `isNullableSum`. |
| `src/bind.ts` | ~500 | `bind`, `BoundSchema`, `BoundReplica`, `BindingTarget`, `createBindingTarget`, `json`, `ephemeral`, resolve outcomes, `FactoryBuilder`. |
| `src/substrate.ts` | ~300 | `Substrate<V>`, `Replica<V>`, factories, `BACKING_DOC`. Re-exports `computeSchemaHash` and `HASH_ALGORITHM_VERSION` from `src/hash.ts`. |
| `src/migration.ts` | ~1000 | 14 primitives, 4 tiers, identity derivation, chain validation, `MIGRATION_CHAIN`. |
| `src/change.ts` | ~600 | Change vocabulary, constructors, guards, `transformIndex`, `textInstructionsToPatches`, `advanceAddresses`. |
| `src/interpret.ts` | ~400 | `interpret`, `Interpreter`, `InterpretBuilder`, `InterpreterLayer`, `dispatchSum`, `RawPath`. |
| `src/interpreters/bottom.ts` | ~200 | Bottom layer: `[CHANGEFEED]`, `[NATIVE]`, `[SUBSTRATE]`, `[CALL]`. |
| `src/interpreters/sequence-helpers.ts` | ~280 | Shared indexed-coalgebra helpers: `at()`, `installTextWriteOps`, `installListWriteOps`, `installRichTextWriteOps`, `installSequenceReadable`, `installSequenceNavigation`, `installSequenceAddressing`, `installSequenceCaching`. |
| `src/interpreters/keyed-helpers.ts` | ~235 | Shared keyed-coalgebra helpers: `installKeyedWriteOps`, `installKeyedReadable`, `installKeyedNavigation`, `installKeyedAddressing`, `installKeyedCaching`. |
| `src/interpreters/with-navigation.ts` | ~235 | Structural descent. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/with-readable.ts` | ~225 | `.current`, `()`, read-by-path. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/with-addressing.ts` | ~500 | Address-table layer. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/with-caching.ts` | ~380 | Identity-preserving memoization + `INVALIDATE`. Sequence/movable and map/set cases delegate to shared helpers. |
| `src/interpreters/writable.ts` | ~700 | Mutation primitives + `REMOVE` + `TRANSACT` + `executeBatch`. Text/sequence/movable/map/set cases delegate to shared helpers. |
| `src/interpreters/with-changefeed.ts` | ~1300 | Observation layer + `planNotifications` + `deliverNotifications` + `wireChangefeed`. All cases use `wireChangefeed` to unify changefeed boilerplate. |
| `src/interpreters/validate.ts` | ~200 | Validation interpreter. |
| `src/interpreters/plain.ts` | ~100 | Plain-state interpreter (reader + canonical shape). |
| `src/interpreters/navigable.ts`, `readable.ts` | ~100 each | Type-interface modules. |
| `src/layers.ts` | ~100 | Pre-built `navigation`, `readable`, `addressing`, `writable`, `observation` layer values. |
| `src/ref.ts` | ~150 | `Ref<S>`, `RRef<S>`, `RWRef<S>`, `DocRef<S>`, `Wrap`, `RefMode`. |
| `src/position.ts` | ~300 | `Position`, `Side`, `POSITION`, `HasPosition`, `PlainPosition`, `decodePlainPosition`. |
| `src/tree-position.ts` | ~620 | Tree-position algebra: `nodeSize`, `contentSize`, `isLeaf`, `resolveTreePosition`, `flattenTreePosition`, `ResolvedTreePosition`. Pure functions over `Reader` + `Schema` for flat↔tree position mapping (ProseMirror convention). |
| `src/changefeed.ts` | ~150 | `Op`, `RecursiveChangefeedProtocol`, `HasRecursiveChangefeed`, `expandMapOpsToLeaves`. |
| `src/facade/batch.ts` | ~250 | `batch(ref, fn)`, `applyChanges`, `remove`, `CommitOptions`. |
| `src/facade/observe.ts` | ~100 | `subscribe`, `subscribeNode`. |
| `src/step.ts` | ~300 | Pure state transitions: `step`, per-change-type step functions. |
| `src/reader.ts` | ~150 | `Reader`, `plainReader`, `writeByPath`, `applyChange`. |
| `src/unwrap.ts` | ~50 | Typed escape hatch to `[NATIVE]`. |
| `src/version-vector.ts` | ~90 | `versionVectorMeet`, `versionVectorCompare`. |
| `src/hash.ts` | ~50 | FNV-1a-128. |
| `src/native.ts` | ~100 | `NativeMap`, `NATIVE`, `SUBSTRATE`, `HasNative`. |
| `src/path.ts` | ~200 | Path/segment/address types + constructors + `AddressedPath`. |
| `src/create-doc.ts` | ~100 | `createDoc`, `createRef` — convenience factories. |
| `src/describe.ts` | ~150 | ASCII schema tree printer. |
| `src/zero.ts` | ~150 | `Zero`, `scalarDefault`. |
| `src/interpreters/materialize.ts` | ~70 | Generic CRDT→PlainState materialization: `MaterializeResolver` interface, `createMaterializeInterpreter`. |
| `src/guards.ts` | ~30 | `isNonNullObject`, `isPropertyHost`. |
| `src/base64.ts` | ~30 | Platform-agnostic base64. |
| `src/substrates/plain.ts` | ~400 | Plain substrate + factories. |
| `src/substrates/lww.ts`, `substrates/timestamp-version.ts` | ~200 + ~100 | LWW / ephemeral substrate. |
| `src/basic/index.ts` | — | Test-only helpers (re-exports). |
| `src/sync.ts` | ~100 | `version`, `exportEntirety`, `exportSince`, `merge` — generic over `ref[SUBSTRATE]`. |
| `src/__tests__/` | ~56 files | Every test file is pure; no I/O, no timers. |

## Testing

Every test in this package is pure. Substrates-under-test are the plain substrate (for everything) and structured mocks. Interpreters are tested by constructing minimal refs and asserting on method results. Migrations are tested by deriving manifests for known schemas and asserting on the hash values. Validation is tested by running `validate` over synthetic inputs and asserting on the error tree.

The full suite serves as the specification of the `Substrate<V>` contract: `@kyneta/loro-schema` and `@kyneta/yjs-schema` run this same suite (adapted) against their substrates. Position conformance tests import `positionConformance` and `PositionTestEnv` from `@kyneta/schema/testing`; general substrate conformance helpers live in `@kyneta/schema/basic`.

**Tests**:

| Package | Passed | Skipped |
|---------|--------|---------|
| `@kyneta/schema` | 1,949 | 8 |
| `@kyneta/loro-schema` | 208 | 4 |
| `@kyneta/yjs-schema` | 218 | 4 |

Run with `cd packages/schema && pnpm exec vitest run`.