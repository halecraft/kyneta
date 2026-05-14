# @kyneta/schema — Technical Reference

> **Package**: `@kyneta/schema`
> **Role**: The schema interpreter algebra — one recursive grammar for document structure, a reactive observation surface (`[CHANGEFEED]` on every ref, with tree-level composed changefeeds for composites), a substrate boundary that separates state management from replication, a migration system that derives stable identity from structure, and a position algebra for cursor-stable text and sequences.
> **Depends on**: `@kyneta/changefeed`
> **Depended on by**: `@kyneta/exchange`, `@kyneta/loro-schema`, `@kyneta/yjs-schema`, `@kyneta/index`, `@kyneta/react`, `@kyneta/compiler`, `@kyneta/cast`, `@kyneta/transport`
> **Canonical symbols**: `Schema`, `Schema.*` constructors, `KIND`, `LAWS`, `bind`, `BoundSchema`, `BoundReplica`, `BindingTarget`, `createBindingTarget`, `json`, `ephemeral`, `Interpret`, `Replicate`, `Defer`, `Reject`, `interpret`, `Interpreter`, `InterpreterLayer`, `createDoc`, `createRef`, `change`, `applyChanges`, `subscribe`, `subscribeNode`, `Substrate`, `SubstrateFactory`, `Replica`, `ReplicaFactory`, `SubstratePayload`, `Version`, `SyncProtocol`, `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`, `requiresBidirectionalSync`, `computeSchemaHash`, `BACKING_DOC`, `Op`, `TreeChangefeedProtocol`, `Change`, `ChangeBase`, `TextChange`, `SequenceChange`, `MapChange`, `TreeChange`, `ReplaceChange`, `IncrementChange`, `RichTextChange`, `transformIndex`, `textInstructionsToPatches`, `Migration`, `MIGRATION_CHAIN`, `deriveIdentity`, `deriveManifest`, `deriveSchemaBinding`, `deriveTier`, `validateChain`, `Position`, `POSITION`, `PlainPosition`, `hasPosition`, `decodePlainPosition`, `Side`, `NATIVE`, `SUBSTRATE`, `NativeMap`, `unwrap`, `versionVectorMeet`, `versionVectorCompare`, `Zero`, `validate`, `tryValidate`, `SchemaValidationError`
> **Key invariant(s)**: The schema grammar is one recursive type with eleven node kinds; substrates declare *closed* composition-law sets via phantom `[LAWS]` brands; `bind()` enforces law compatibility at compile time. Four named binding targets (`json`, `ephemeral`, `loro`, `yjs`) each bundle a substrate factory, a `SyncProtocol`, and a set of allowed laws. No runtime law dispatch; no open-world subtyping; no hidden backend coupling.

The algebraic core of every document in Kyneta. You write a schema once — a tree of structural composites and CRDT leaves — and hand it to a substrate (plain JS, Loro, Yjs). The substrate stores state; the interpreter stack gives you a typed, navigable, writable reference (`Ref<S>`) over that state, with reactive observation baked in — every ref carries a `[CHANGEFEED]` that emits one `Changeset<Op>` per transaction covering own-path + descendants via `subscribeTree`. Migration primitives derive a content-addressed identity from the schema tree so that documents can evolve across schema versions without losing peer-to-peer identity.

Imported by every other Kyneta package that touches documents: the CRDT backends to implement `Substrate<V>`, the exchange to sync `SubstratePayload` blobs, the index to build live views, react to bind refs into hooks, compiler/cast to detect reactive references at compile time.

---

## Questions this document answers

- What is a `Schema` and how does it relate to TypeScript types? → [The grammar](#the-grammar)
- Why are `text`, `counter`, `set`, `tree`, `movable` first-class and not annotations? → [First-class CRDT types](#first-class-crdt-types)
- What does a `Substrate` do that a `Replica` does not? → [The substrate / replica split](#the-substrate--replica-split)
- What is `bind()` enforcing at compile time? → [Binding a schema to a substrate](#binding-a-schema-to-a-substrate)
- What is the six-layer interpreter stack? → [The interpreter stack](#the-interpreter-stack)
- How does `change(ref, fn)` end up as a wire `offer`? → [The write path](#the-write-path)
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
| `Substrate<V>` | State-management + transfer interface: `version()`, `exportEntirety()`, `exportSince(since?)`, `merge(payload, origin?)`, `context()`, plus `reader()`, `writable()`, `prepare()`. `V` is the substrate's version type (Lamport vector, Loro version, wall clock, …). | A database, a backend — this is an *interface* the backends implement |
| `Replica<V>` | The replication surface *alone* — `version`, `exportEntirety`, `exportSince`, `merge`. No schema knowledge. | `Substrate<V>`, which adds `reader`, `writable`, `prepare`, and schema awareness |
| `ReplicaFactory<V>` / `SubstrateFactory<V>` | Constructors for replicas / substrates. Every `SubstrateFactory` exposes a `replica` accessor yielding a `ReplicaFactory`. | A runtime singleton — factories are reusable and stateless |
| `BindingTarget<AllowedLaws, N>` | A fixed `(substrate factory, sync protocol, allowed laws)` bundle. Named targets: `json` (authoritative, all laws), `ephemeral` (LWW-family only), `loro` (CRDT laws), `yjs` (Yjs-supported laws). Each exposes `.bind(schema)` → `BoundSchema` and `.replica()` → `BoundReplica`. | `SubstrateFactory` — the target *wraps* a factory; it is not one |
| `BoundSchema<S>` | The triple `(schema, factory, syncProtocol)` captured at module scope via `target.bind(schema)`. The static declaration of a document type. | A runtime instance — `BoundSchema` is a value describing *how* to make one |
| `BoundReplica<V>` | `BoundSchema` minus the schema — used by replication conduits that persist state without reading it. | `BoundSchema` |
| `Interpret` / `Replicate` / `Defer` / `Reject` | The four variants of an exchange `resolve` callback outcome. Return values from application-level logic that decides how to handle an unknown doc. | Handlers, error types — these are discriminated-union constructors |
| `Interpreter<Ctx, A>` | The F-algebra: one method per `[KIND]` value, collapsing a schema tree into a value of type `A`. | A parser, a visitor, a validator alone |
| `InterpreterLayer` | A typed transformer from one interpreter to another (e.g. `withReadable` transforms `Interpreter<Ctx, R>` into `Interpreter<Ctx, R & Readable>`). | A middleware — layers compose statically via `.with()` |
| `Ref<S>` | The developer-facing handle: callable, navigable, readable, writable, observable. The result of `interpret(schema, ctx)...done()`. | A React ref, a DOM ref — this is a substrate-backed document reference |
| `Change` | The universal currency of change — discriminated union with `type` (`"text" \| "sequence" \| "map" \| "tree" \| "replace" \| "increment"` and extensible). Flows both inbound (intent) and outbound (notification). | A diff, a patch — `Change` is applied atomically by the substrate |
| `SubstratePayload` | `{ kind: "entirety" \| "since", encoding: "json" \| "binary", data: string \| Uint8Array }` — opaque state carrier. Produced by the substrate, carried by the exchange. | A `ChannelMsg` — payloads ride *inside* `offer` messages |

| `SyncProtocol` | Structured record decomposing sync semantics into three orthogonal axes: `WriterModel` (`"serialized"` / `"concurrent"`), `Delivery` (`"delta-capable"` / `"snapshot-only"`), `Durability` (`"persistent"` / `"transient"`). Three constants: `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`. `requiresBidirectionalSync(protocol)` is the helper predicate. | A string enum, a CRDT algorithm |
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

- **Change** (`src/change.ts`, `src/step.ts`, `src/facade/change.ts`) — the universal delta vocabulary and `change(ref, fn)` transaction facade.
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
- **Not symmetric across sync protocols.** A collaborative substrate (Loro, Yjs) has concurrent versions (`SYNC_COLLABORATIVE`); an authoritative substrate (json) has a total order (`SYNC_AUTHORITATIVE`); an ephemeral substrate has wall-clock-timestamped overwrite (`SYNC_EPHEMERAL`). The `SyncProtocol` — decomposed into `WriterModel`, `Delivery`, and `Durability` axes — tells the exchange which protocol shape to run. `requiresBidirectionalSync(protocol)` is the predicate the exchange uses to decide whether to establish a bidirectional causal exchange or a unidirectional push.

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
| `tree` | `tree(nodeData)` | CRDT | `() => Schema` | Hierarchical tree with move operations |
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

Each CRDT kind contributes to the `[LAWS]` phantom of every ancestor node. A `Schema.struct({ body: Schema.text() })` has `"positional-ot"` in its `[LAWS]` accumulator even though `struct` itself is structural. The tags are algebraic properties (`"lww"`, `"additive"`, `"positional-ot"`, `"positional-ot-move"`, `"tree-move"`, `"lww-per-key"`, `"lww-tag-replaced"`, `"add-wins-per-key"`), not kind names.

### `PlainSchema`: the no-CRDT subset

`PlainSchema` is `Schema` restricted to structural kinds. It appears in two places:

1. **`.json()` modifier.** `Schema.struct({...}).json()` marks a product as a plain-JSON merge boundary — the entire subtree is replaced atomically on write, not composed CRDT-style. Inside `.json()`, only `PlainSchema` is permitted.
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
| `loro` | `LoroLaws = "lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"` | Full CRDT law set minus `"add-wins-per-key"`. |
| `yjs` | `YjsLaws = "lww" \| "positional-ot" \| "lww-per-key" \| "lww-tag-replaced"` | Text and structural laws — no `"additive"`, `"positional-ot-move"`, `"tree-move"`, `"add-wins-per-key"`. |

`target.bind(schema)` applies `RestrictLaws<S, AllowedLaws>` at the type level. A schema with `"additive"` in its `[LAWS]` (from `Schema.counter()`) cannot be bound to the `yjs` target — the compiler refuses.

No runtime dispatch, no substrate-specific error messages. The type system is the enforcement mechanism.

### What the grammar is NOT

- **Not closed.** `sum` variants are open (you can add more) and `product` fields are open (you can nest arbitrary schemas). The eleven *kinds* are closed; user composition is not.
- **Not validated at construction.** `Schema.struct({})` with a circular reference via thunks is valid grammar. Cycles are detected only during specific interpretations (e.g. `canonicalizeSchema` for hashing).
- **Not self-describing at runtime.** `[KIND]` is the only tag. Fields, variants, etc. are discovered structurally. Never `Object.keys(schema)` to enumerate its kind — pattern-match on `[KIND]`.

---

## Binding a schema to a substrate

Source: `packages/schema/src/bind.ts`.

### The four binding targets

Rather than parameterizing a generic namespace with a merge strategy, each substrate is a named `BindingTarget` — a fixed bundle of `(factory, syncProtocol, allowedLaws)`:

| Target | Import | `SyncProtocol` | Allowed laws | Substrate |
|--------|--------|----------------|--------------|-----------|
| `json` | `@kyneta/schema` | `SYNC_AUTHORITATIVE` | all (`string`) | Plain JS objects, Lamport version |
| `ephemeral` | `@kyneta/schema` | `SYNC_EPHEMERAL` | `EphemeralLaws` (`"lww"`, `"lww-per-key"`, `"lww-tag-replaced"`) | LWW substrate, wall-clock version |
| `loro` | `@kyneta/loro-schema` | `SYNC_COLLABORATIVE` | `LoroLaws` (full CRDT set minus `"add-wins-per-key"`) | Loro CRDT doc |
| `yjs` | `@kyneta/yjs-schema` | `SYNC_COLLABORATIVE` | `YjsLaws` (text + structural laws) | Yjs doc |

Usage:

```
import { json, ephemeral, Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import { yjs } from "@kyneta/yjs-schema"

const Config = json.bind(Schema.struct({ theme: Schema.string() }))
const Cursor = ephemeral.bind(Schema.struct({ x: Schema.number(), y: Schema.number() }))
const Todo = loro.bind(Schema.struct({ title: Schema.text(), done: Schema.boolean() }))
const Note = yjs.bind(Schema.struct({ body: Schema.text() }))
```

No strategy parameter — the sync protocol is fixed per target.

### Low-level `bind()`

`bind({ schema, factory, syncProtocol })` returns a `BoundSchema<S>`. It captures three decisions at module scope:

1. **Which schema** — the recursive `Schema` value.
2. **Which factory builder** — `(context: { peerId, binding }) => SubstrateFactory<V>`. The builder receives the peer's identity and the schema binding; this is how a fresh factory instance is produced per exchange.
3. **Which sync protocol** — a `SyncProtocol` value (one of `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL`, or a custom record).

The result is a static value: `const Todo = loro.bind(schema)`. The exchange consumes it as `exchange.get(docId, Todo)`.

```
type BoundSchema<S extends Schema> = {
  schema: S
  factory: FactoryBuilder<V>
  syncProtocol: SyncProtocol
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
  syncProtocol: SyncProtocol
}): BindingTarget<AllowedLaws, N>
```

Custom substrate authors use `createBindingTarget` to build their own targets. The built-in `json`, `ephemeral`, `loro`, and `yjs` are all constructed this way.

### What `bind` is NOT

- **Not lazy.** Both `manifest` and `schemaHash` are computed on construction. Binding at module scope does the work once at import time.
- **Not runtime-variable.** The schema, factory, and sync protocol are all captured as values; `BoundSchema` has no runtime parameters.
- **Not magic.** `bind` validates the migration chain (if any) via `validateChain`, derives the binding, and stores the fields. No side effects on the schema or the factory.

### `BoundReplica<V>`: replication-only binding

A pure replication conduit (a routing server, a CDN edge, a store-only peer) does not need to interpret document state. It only needs to receive, persist, and re-emit payloads. `BoundReplica<V>` is `BoundSchema<S>` minus the schema — it carries the replica factory, sync protocol, and schema hash, but not the grammar itself.

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
  merge(payload: SubstratePayload, origin?: string): void
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
- `merge(payload, origin?)` → fold an incoming payload into local state. `origin` is propagated through the changefeed.

A `Substrate` adds interpretation:

- `reader()` → plain reads by path.
- `writable()` → mutation primitives (`replace`, `insert`, `delete`, `increment`, etc.).
- `prepare()` → the flush pipeline that turns accumulated mutations into a single `merge` call (plus notifications).
- `context()` → the `RefContext` the interpreter stack closes over.

### The `SubstratePrepare` pipeline

Mutations don't `merge` immediately. They accumulate in a prepare pipeline that:

1. Applies each instruction to the backing doc via substrate-native writes.
2. Records the resulting `Change` values (text, sequence, map, etc.) with their paths.
3. On commit, folds the accumulated changes into `Op[]` for the composed changefeed.
4. Calls `notify()` so subscribers receive a single `Changeset` per transaction, not one per primitive operation.

This is how `change(doc, d => { d.title("hi"); d.items.push(x); })` becomes one atomic changefeed emission, not two.

### Path resolution and sum boundaries

`resolveContainer` in substrate backends (e.g. `loro-resolve.ts`) handles sum boundaries by switching to plain JS property navigation for remaining path segments once a `sum` schema node is encountered. This is sound because sum variants are always `PlainSchema` — no Loro containers (or other CRDT containers) exist inside sums. The Yjs backend's `resolveYjsType` follows the same pattern. When `advanceSchema` reaches a sum, remaining segments are resolved via plain `obj[key]` access rather than substrate-specific container descent.

### Version vector algebra

Source: `packages/schema/src/version-vector.ts`.

For substrates whose `V` is a map of `PeerId → number` (Lamport-style vectors), two helpers are provided:

- `versionVectorMeet(a, b)` → the greatest lower bound. Component-wise minimum.
- `versionVectorCompare(a, b)` → `-1 | 0 | 1 | "concurrent"`. Determines whether one version strictly precedes the other, equals it, or is concurrent.

Both are pure. Loro and Yjs substrates use these directly for their Lamport vectors; substrates with different version shapes (wall clock, Loro's opaque version) implement their own comparison.

---

## `schemaHash` and compatibility

Source: `packages/schema/src/substrate.ts` → `computeSchemaHash`, `src/hash.ts` → `fnv1a128`.

`computeSchemaHash(manifest)` is a pure, content-addressed function:

1. Canonicalize the schema tree (stable field ordering, remove thunks, expand laziness).
2. Serialize to a deterministic byte representation.
3. Hash with FNV-1a-128 (`src/hash.ts`).
4. Return the 32-character lowercase hex digest.

The hash is carried in every `present` message (the exchange's doc-announcement protocol). Receivers compare the incoming hash against their local `BoundSchema.schemaHash`:

- **Match** → structurally identical schemas; safe to sync.
- **Mismatch** → different schemas; receiver consults `supportedHashes` (from the `MigrationChain`) to see if a compatible ancestor exists.
- **No compatible version** → reject.

### Why FNV-1a-128

- **Fast and deterministic** across JS runtimes (no `crypto.subtle`, no WASM).
- **128 bits** is wide enough to eliminate collision concern for the hundreds-to-millions of distinct schemas any real deployment will see.
- **Hex-encoded** for readability in logs, wire frames, and test assertions.

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
  tree: (ctx: Ctx, path: Path, schema: TreeSchema, nodeData: () => A) => A
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

**`WritableDiscriminantProductRef`** — the writable surface for discriminated unions. For a `DiscriminatedSumSchema<D, V>`, the writable ref exposes all fields (discriminant and non-discriminant) as `Plain<F[K]>` — that is, **read-only** values. Non-discriminant fields are callable (you can read them) but carry no `.set()`. The only mutation primitive is `.set()` on the union ref itself (via `ProductRef`) for whole-value replacement. This follows from sum interiors being opaque LWW values: variant fields are not independently addressable CRDT positions, and individual field mutation would violate the atomic replacement semantics of `lww-tag-replaced`.

Plus the orthogonal observation layer:

| Layer | Transformer | Adds |
|-------|-------------|------|
| Observation | `withChangefeed` | `subscribe`, `subscribeNode`, `TreeChangefeedProtocol<S>` |

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

### Interpreter composition combinators

Source: `packages/schema/src/combinators.ts`.

- `product(a, b)` — run two interpreters side-by-side, combine results pairwise.
- `overlay(base, fallback)` — run `base`; where it returns `undefined`, use `fallback`.
- `firstDefined(...interpreters)` — first interpreter to return a non-`undefined` wins.

Used internally to combine capability-specific interpreters into composed layers.

### What an `Interpreter` is NOT

- **Not a visitor pattern.** Interpreters return values; visitors mutate state. `interpret` is a catamorphism, not a traversal.
- **Not layered dynamically.** Layers compose at the type level. Once `.done()` is called, the stack is fixed.
- **Not framework-aware.** No React, no DOM. The `Ref<S>` the stack produces is a pure object with a `[CHANGEFEED]` surface; framework bindings (`@kyneta/react`, `@kyneta/cast`) adapt it.

### Interpreter duplication families

The 11 interpreter cases fall into four structural categories. The first three are **duplication families** — groups of cases that share identical logic across every transformer, captured by shared helper modules. The fourth has unique per-case logic.

| Family | Cases | Shared helpers | Shared algebra |
|--------|-------|---------------|----------------|
| **Indexed** (positional) | `text`, `sequence`, `movable`, `richtext` | `sequence-helpers.ts` — `at()`, `installTextWriteOps`, `installListWriteOps`, `installRichTextWriteOps`, `installSequenceReadable`, `installSequenceNavigation`, `installSequenceAddressing`, `installSequenceCaching` | `Instruction`, `foldInstructions`, `transformIndex`, `advanceAddresses` |
| **Keyed** (named) | `map`, `set` | `keyed-helpers.ts` — `installKeyedWriteOps`, `installKeyedReadable`, `installKeyedNavigation`, `installKeyedAddressing`, `installKeyedCaching` | `MapChange`, keyed addressing/tombstoning |
| **Leaf** (terminal) | `scalar`, `text`, `counter`, `richtext` | `wireChangefeed` in `with-changefeed.ts` unifies changefeed boilerplate across all leaf and composite cases | `createLeafChangefeed` |
| **Structural** (unique) | `product`, `sum`, `tree` | None — each has unique per-case logic | Product: schema-driven fields + discriminant. Sum: store-based variant dispatch. Tree: thin pass-through. |

**`text` and `richtext` straddle two families.** They are indexed for writable (share `at()` and the retain/insert/delete instruction stream with sequence/movable) but leaf for readable, navigation, and changefeed (return `string` / delta directly, not a fold over children). Characters are not independently addressable refs.

The `Interpreter` interface retains separate cases per kind — the sharing is internal to the built-in transformers. Substrate authors implement one case per kind; they never see the shared helpers.

**`attachNative` is intentionally skipped for sums in `interpretImpl`.** Sums are structurally transparent — the result carrier is the dispatched variant's carrier, which already has the correct `[NATIVE]` from its own interpreter case (product, scalar, etc.). Calling `attachNative` on the sum would double-define the property, crashing in substrates where the product resolves to a real container but the sum resolves to `undefined` (`configurable: false` + different value → `TypeError`).

### `NativeMap` and the escape hatch

`NativeMap<S>` is a type-level mapping from schema kinds to substrate-native types. `ref[NATIVE]` returns the underlying container — `LoroText` for a `text` on Loro, `Y.Map` for a `product` on Yjs, a plain object for the plain substrate. `unwrap(ref)` (`src/unwrap.ts`) is the typed escape hatch that returns `NativeMap<S>`.

Application code rarely touches `[NATIVE]`. Backends use it to dispatch to substrate-specific APIs. It is the only path through which substrate-specific behaviour leaks through the interpreter stack — and it is explicit at the call site.

---

## The write path

Source: `packages/schema/src/facade/change.ts`, `src/step.ts`, `src/interpreters/with-changefeed.ts`.

`change(ref, fn)` is the atomic transaction facade. End-to-end flow:

1. `change` calls `ref[SUBSTRATE].prepare()` → opens a `SubstratePrepare` context. The writable proxy handed to `fn` accumulates mutations.
2. `fn(doc)` runs — each `.field = value`, `.items.push(...)`, `.text("...").insert(...)` appends an instruction to the prepare pipeline. No backing-doc mutation yet.
3. Each instruction is applied via the substrate's writable context (substrate-native writes). As it runs, it records a `Change` value in the pipeline.
4. `prepare.commit()` runs when `fn` returns.
5. The accumulated `Change` values feed through `planNotifications(changes, ...)` → compute the minimal set of invalidations.
6. `deliverNotifications` emits one `Changeset` per subscribed node: composed refs receive all their descendants' changes in one batch; leaf refs receive only their own.

The substrate never sees the full transaction as a unit — it sees a sequence of native writes. The exchange sees the transaction as a single `merge` source: `origin` is `"local"` throughout, and after commit the substrate's `exportSince()` captures the entire delta.

### `applyChanges(ref, changes)`: declarative application

Source: `src/facade/change.ts`.

Sometimes changes arrive as data (from the network, from undo history, from tests). `applyChanges(ref, changes)` applies a `readonly Change[]` via the same substrate write path — no prepare facade, just direct substrate writes + notification planning.

### Pure step function

Source: `packages/schema/src/step.ts`.

For testing and reasoning, `step(state, change)` → `state` is the pure transition function. It handles every built-in change type (`stepText`, `stepSequence`, `stepMap`, `stepReplace`, `stepIncrement`, `stepFold`). The plain substrate uses `step` internally; tests use it to verify change semantics without constructing a substrate.

### What the write path is NOT

- **Not reactive under `fn`.** Reads inside `change(doc, fn)` return values as they were at transaction start. Writes accumulate; they are not visible to the next read within the same transaction (unless `fn` reads from the proxy, which reflects accumulated writes — that depends on substrate-specific optimism).
- **Not async.** `change()` is synchronous. The substrate's writes happen synchronously during `fn`. Notifications for the originating transaction fire synchronously at commit; re-entrant `change()` calls from inside a subscriber land in the per-context dispatcher's pending queue and produce a separate `Changeset` in a fresh sub-tick of the same outer call — still synchronous from the caller's perspective.
- **Not an effect system.** Side effects inside `fn` (network calls, DOM writes) run where they are called. Only the substrate-writable mutations are captured.

### Re-entrant `change()` inside subscriber callbacks (drain-to-quiescence)

Subscriber callbacks may mutate freely. `change()` invoked from inside `subscribe(doc, ...)` or `subscribeNode(doc.field, ...)` does *not* throw — `with-changefeed`'s per-context dispatcher (from `@kyneta/machine`'s `createDispatcher`) enqueues an `accumulate` Msg and the drain-to-quiescence loop processes it in a fresh sub-tick.

Substrate writes inside the re-entrant `change()` remain **synchronous** — subsequent reads see the new state. The sub-tick's mutations produce their own `Changeset` once the inner `change()` commits, delivered to subscribers after the originating Changeset.

When the host is an `Exchange`, every per-doc dispatcher shares the Exchange's `Lease` with the Synchronizer. Cross-doc A→B→A cascades, and tick-induced re-entry through the synchronizer, are bounded by one cooperating budget. A runaway oscillation throws `BudgetExhaustedError` whose history mixes `"synchronizer:*"` and `"changefeed"` label entries — the label set is the cascade topology.

See `@kyneta/machine`'s TECHNICAL.md §"Drain to quiescence and shared leases" for the primitive.

### Subscriber visibility of mid-batch re-entry

`deliverNotifications` iterates subscribers `[S1, S2, S3]`. If S1 calls `change(doc, ...)` synchronously, S1's substrate writes land *before* S2 fires. S2 receives the `Changeset` describing the originating transaction, but reads from a substrate that already includes S1's mutations.

Two guidances:

- The `Changeset` you receive describes the transaction that triggered your callback.
- The substrate state you read reflects everything up to now, including re-entrant writes from earlier subscribers in the same deliver batch.

To derive "pure pre-mutation state," consume the `Changeset` semantically; do not infer it by reading the substrate. This was always true in spirit — subscribers run after substrate commit — and the dispatcher refactor only changes whether re-entry from S1 succeeds (now) or throws (pre-1.6.0).

---

## Tree-observable changefeeds

Source: `packages/schema/src/changefeed.ts`, `src/interpreters/with-changefeed.ts`.

Every schema-issued changefeed implements `TreeChangefeedProtocol` — the schema-specific extension of `@kyneta/changefeed`'s universal `ChangefeedProtocol`. It adds `subscribeTree`, which delivers own-path + every descendant in one `Changeset<Op>` where each `Op = { path, change }` carries the relative path from the subscription point.

```
interface TreeChangefeedProtocol<S, C> extends ChangefeedProtocol<S, C> {
  current: Plain<S>
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
  subscribeTree(callback: (changeset: Changeset<Op<C>>) => void): () => void
}
```

For a composite ref, `subscribeTree` aggregates own-path changes with children's tree-streams (paths prefixed appropriately). For a leaf ref, `subscribeTree` is the trivial own-path lift: every change is delivered as a single `Op` whose `path` is the leaf's registry-aware root (empty relative path). A leaf is a tree of size 1.

`subscribe` (own-path only, `Changeset<C>` shape with no paths) is the lighter sibling. The two channels carry the same information for a leaf and different information for a composite (where own-path ⊊ tree).

Facade vs. protocol vocabulary inversion: facade `subscribe` is deep delivery (`Changeset<Op>`); the protocol-level `ChangefeedProtocol.subscribe` is own-path delivery (`Changeset<ChangeBase>`). The facade hides this; power users reaching directly into `ref[CHANGEFEED]` should know it.

> **Principle.** Facade-level entry points should hide protocol-method-set distinctions when the user's semantic is well-defined regardless of carrier kind. "Subscribe to changes under this ref" is well-defined for any reactive value; whether the value happens to have children is a structural concern, not an observation concern. Pre-1.6.0 the facade threw on `subscribe(leaf)` because leaves lacked `subscribeTree`; 1.6.0 retires that leak by lifting `subscribeTree` to every schema-issued changefeed.

**The pure helpers.** `liftToOps(cs, path): Changeset<Op<C>>` raises shape from `Changeset<C>` to `Changeset<Op<C>>` at a constant path; `prefixOps(cs, prefix): Changeset<Op<C>>` keeps shape and prepends a prefix to each event's existing path. Together they form the entire shape-grammar of the changefeed delivery pipeline: leaves' `subscribeTree`, composites' own-path → tree fan-out, and composites' child-tree propagation all decompose into one of these two transforms.

`subscribe(ref, callback)` is the facade primitive that calls `subscribeTree` under the hood. `subscribeNode(ref, callback)` is the explicit shallow opt-in — fires only when the *specific node's* state changes, not its descendants.

### `planNotifications` → `deliverNotifications`

Two pure functions form the notification engine:

1. `planNotifications(changes, addressTable)` → `NotificationPlan` — which refs need which changesets, deduplicated and ordered.
2. `deliverNotifications(plan, subscribers)` → fires each subscriber exactly once per transaction with the appropriate changeset.

This is how a transaction that modifies `doc.items[0].title` and `doc.items[0].count` delivers one changeset to `subscribe(doc)` (two ops), one to `subscribe(doc.items)` (two ops), one to `subscribe(doc.items[0])` (two ops), and one each to `subscribe(doc.items[0].title)` / `subscribe(doc.items[0].count)` (one op each) — all synchronously, all deduplicated.

The per-context dispatcher (`createDispatcher<ChangefeedMsg>` inside `ensurePrepareWiring`) is what makes re-entrant `change()` calls from inside a subscriber safe: each call dispatches an `accumulate` Msg that drains in a fresh sub-tick. See [Re-entrant `change()` inside subscriber callbacks](#re-entrant-change-inside-subscriber-callbacks-drain-to-quiescence).

### `expandMapOpsToLeaves`

A single `MapChange` (e.g. `replaceEntry("alice", {...})`) represents a structural operation on a `map` node. For subscribers on descendants of that map, the change has to be *expanded* into per-leaf `ReplaceChange` ops. `expandMapOpsToLeaves` does this pure expansion, used by `planNotifications`.

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

A `BoundSchema` declares `supportedHashes`: all schema hashes that can be interpreted by the current schema (the current hash plus every ancestor reachable through the migration chain without an epoch). The exchange includes this in every `present` message; receivers with older schemas check whether one of their hashes is in the sender's `supportedHashes` to decide if sync can proceed.

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

- **Inbound** (developer → substrate): the proxy in `change(doc, fn)` records changes describing *intent*.
- **Outbound** (substrate → subscribers): the substrate's changefeed emits changes describing *what happened*.

The shapes are identical. The substrate's `prepare` pipeline consumes the inbound changes, applies them, and re-emits (potentially transformed) outbound changes.

### Constructors, guards, and transforms

For every built-in change type:

- Constructor: `textChange(instructions)`, `sequenceChange(instructions)`, `mapChange(entries)`, etc.
- Type guard: `isTextChange(change)`, `isSequenceChange(change)`, etc.
- Pure transformer: `foldInstructions(instructions)`, `advanceIndex(index, instructions)`, `advanceAddresses(addresses, instructions)`.

These are the primitives `step`, `with-changefeed`, and `Position` build on.

---

## The plain substrate

Source: `packages/schema/src/substrates/plain.ts`.

The built-in substrate. Stores state as plain JS objects, tracks a Lamport version, and merges by total-order last-writer-wins. Used for:

- The default binding when no CRDT is needed (`Schema.string`, small configs, ephemeral UI state).
- The LWW variant (`src/substrates/lww.ts` + `src/substrates/timestamp-version.ts`) for wall-clock-ordered ephemeral broadcasts.
- Reference implementation for testing the `Substrate<V>` contract.

Key functions:

- `createPlainSubstrate(schema, context)` → `Substrate<PlainVersion>`.
- `createPlainReplica(context)` → `Replica<PlainVersion>`.
- `plainSubstrateFactory` / `plainReplicaFactory` — exported factory instances.
- `buildUpgrade(schema)` → function that re-derives internal structures after hydration.
- `objectToReplaceOps(obj)` → flatten a plain object into a sequence of `ReplaceChange` ops for migration.

### `PlainVersion`

```
type PlainVersion = Record<PeerId, number>
```

A Lamport vector. `versionVectorMeet` and `versionVectorCompare` operate on it directly. Every local write bumps the peer's component; `merge` increases each component to the max of local and incoming.

### `TimestampVersion`

For ephemeral substrates: a single wall-clock number plus the peer ID. `merge` accepts the incoming value iff `timestamp > local.timestamp || (equal && peerId > local.peerId)`. Stale writes are rejected silently.

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
- Sequence / map / set → empty.
- Sum → first variant's default.
- Text → empty text.
- Counter → `0`.
- Tree → single root node with `nodeData`'s default.
- Movable → empty.

`scalarDefault(kind)` is the scalar-only version. Used by `createDoc` when no initial state is supplied, by migrations' `setDefault` primitive, and by tests.

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
| `SyncProtocol`, `WriterModel`, `Delivery`, `Durability` | `src/substrate.ts` | Structured sync protocol and its three axes. |
| `SYNC_AUTHORITATIVE`, `SYNC_COLLABORATIVE`, `SYNC_EPHEMERAL` | `src/substrate.ts` | The three built-in sync protocol constants. |
| `Version` | `src/substrate.ts` | Abstract version base. |
| `Change`, `ChangeBase`, `TextChange`, `SequenceChange`, `MapChange`, `TreeChange`, `ReplaceChange`, `IncrementChange`, `RichTextChange` | `src/change.ts` | Change vocabulary. |
| `RichTextSchema`, `MarkConfig` | `src/schema.ts` | Rich text schema kind + mark configuration. |
| `RichTextDelta` | `src/change.ts` | Delta representation for rich text content. |
| `RichTextRef` | `src/ref.ts` | Ref specialization for `richtext` schema kind. |
| `Op` | `src/changefeed.ts` | `{ path, change }` — composed-feed notification. |
| `TreeChangefeedProtocol<S>`, `HasTreeChangefeed<S>` | `src/changefeed.ts` | Tree-observation surface carried by every schema-issued ref. |
| `Position`, `Side`, `HasPosition`, `PositionCapable`, `PlainPosition` | `src/position.ts` | Position algebra. |
| `MigrationChain`, `MigrationStep`, `EpochStep`, `MigrationPrimitive`, `Droppable`, `T2Primitive`, `NonT2Primitive` | `src/migration.ts` | Migration types. |
| `NodeIdentity`, `IdentityManifest`, `IdentityOrigin`, `SchemaBinding`, `TransformProof` | `src/migration.ts` | Identity types. |
| `NativeMap<S>`, `PlainNativeMap`, `UnknownNativeMap`, `HasNative` | `src/native.ts` | Type-level substrate-native mapping. |
| `CALL`, `NATIVE`, `SUBSTRATE`, `BACKING_DOC`, `KIND`, `LAWS`, `POSITION`, `MIGRATION_CHAIN`, `INVALIDATE`, `REMOVE`, `TRANSACT`, `ADDRESS_TABLE` | various | Symbol-keyed runtime protocol tags. |
| `Reader`, `PlainState` | `src/reader.ts` | Plain-state reader primitive. |
| `Path`, `Segment`, `Address`, `AddressTableRegistry` | `src/path.ts` | Path and address types. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | ~400 | Public barrel — exports every public symbol. |
| `src/schema.ts` | ~800 | The grammar: types + `Schema.*` constructors + `advanceSchema` + `buildVariantMap` + `isNullableSum`. |
| `src/bind.ts` | ~500 | `bind`, `BoundSchema`, `BoundReplica`, `BindingTarget`, `createBindingTarget`, `json`, `ephemeral`, resolve outcomes, `FactoryBuilder`. |
| `src/substrate.ts` | ~300 | `Substrate<V>`, `Replica<V>`, factories, `computeSchemaHash`, `BACKING_DOC`, `fnv1a128`. |
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
| `src/changefeed.ts` | ~150 | `Op`, `TreeChangefeedProtocol`, `HasTreeChangefeed`, `expandMapOpsToLeaves`. |
| `src/facade/change.ts` | ~250 | `change(ref, fn)`, `applyChanges`, `remove`, `CommitOptions`. |
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
| `src/combinators.ts` | ~100 | Interpreter composition: `product`, `overlay`, `firstDefined`. |
| `src/guards.ts` | ~30 | `isNonNullObject`, `isPropertyHost`. |
| `src/base64.ts` | ~30 | Platform-agnostic base64. |
| `src/substrates/plain.ts` | ~400 | Plain substrate + factories. |
| `src/substrates/lww.ts`, `substrates/timestamp-version.ts` | ~200 + ~100 | LWW / ephemeral substrate. |
| `src/basic/index.ts` | — | Test-only helpers (re-exports). |
| `src/sync.ts` | ~100 | `version`, `exportEntirety`, `exportSince`, `merge` — generic over `ref[SUBSTRATE]`. |
| `src/__tests__/` | ~56 files | Every test file is pure; no I/O, no timers. |

## Testing

Every test in this package is pure. Substrates-under-test are the plain substrate (for everything) and structured mocks. Interpreters are tested by constructing minimal refs and asserting on method results. Migrations are tested by deriving manifests for known schemas and asserting on the hash values. Validation is tested by running `validate` over synthetic inputs and asserting on the error tree.

The full suite serves as the specification of the `Substrate<V>` contract: `@kyneta/loro-schema` and `@kyneta/yjs-schema` run this same suite (adapted) against their substrates via the shared conformance harness in `src/basic/index.ts`.

**Tests**: 1,901 passed, 8 skipped across 59 files. Run with `cd packages/schema && pnpm exec vitest run`.