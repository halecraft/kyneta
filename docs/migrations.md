# Schema migrations

A practical guide for evolving a kyneta schema after you have users with data
in production. This is the developer-facing how-to. The mathematical theory
lives in [`.jj-plan/migrations.md`](../.jj-plan/migrations.md) and is not
required reading.

> **Status, in one line.** Schema-side migrations (declaration, identity
> binding, sync-compat negotiation) are production-quality for T0 and T1a.
> Anything that touches existing record values at runtime is partially
> implemented or not implemented. Read [§9 Known gaps](#9-known-gaps) before
> you commit to a strategy.

---

## 1. Cheatsheet

The "I want to…" table. Find your row, follow the link.

| I want to…                                  | Use                                     | Tier | Safe across mixed-version peers? | Section |
|---------------------------------------------|-----------------------------------------|------|----------------------------------|---------|
| Add a field                                 | `Migration.add("path")`                 | T0   | Yes                              | [§4.1](#41-add-a-field) |
| Add a variant to a discriminated union      | `Migration.addVariant("path", "tag")`   | T0   | Yes                              | [§4.2](#42-add-a-variant) |
| Widen a scalar constraint                   | `Migration.widenConstraint("path", […])`| T0   | Yes                              | [§4.3](#43-widen-a-constraint) |
| Make a field nullable                       | `Migration.addNullable("path")`         | T0   | Yes                              | [§4.4](#44-make-a-field-nullable) |
| Rename a field                              | `Migration.rename("old", "new")`        | T1a  | Yes                              | [§4.5](#45-rename-a-field) |
| Move a field to a new location              | `Migration.move("from", "to")`          | T1a  | Yes                              | [§4.6](#46-move-a-field) |
| Rename a variant tag                        | `Migration.renameVariant(…)`            | T1a  | Yes                              | [§4.7](#47-rename-a-variant-tag-or-discriminant-key) |
| Rename a discriminant key                   | `Migration.renameDiscriminant(…)`       | T1a  | Yes                              | [§4.7](#47-rename-a-variant-tag-or-discriminant-key) |
| Remove a field                              | `Migration.remove(…).drop()`            | T2   | No (one-way)                     | [§5.1](#51-remove-a-field) |
| Remove a variant                            | `Migration.removeVariant(…).drop()`     | T2   | No (one-way)                     | [§5.2](#52-remove-a-variant) |
| Narrow a constraint                         | `Migration.narrowConstraint(…).drop()`  | T2   | No (one-way)                     | [§5.3](#53-narrow-a-constraint) |
| Drop nullability                            | `Migration.dropNullable(…).drop()`      | T2   | No (one-way)                     | [§5.4](#54-drop-nullability) |
| Change a field's type                       | `.epoch(Migration.retype(…))`           | T3   | No (hard break)                  | [§6.1](#61-change-a-fields-type-retype) |
| Apply a custom data transformation          | `.epoch(Migration.transform(…))`        | T3   | No (hard break)                  | [§6.2](#62-custom-transforms) |

### Maturity matrix

| Tier | Schema declaration | Identity preservation | Sync compatibility | Runtime data transform |
|------|--------------------|------------------------|---------------------|------------------------|
| T0   | ✅ shipped          | ✅ shipped              | ✅ shipped           | ✅ no transform needed  |
| T1a  | ✅ shipped          | ✅ shipped              | ✅ shipped           | ✅ no transform needed  |
| T2   | ✅ shipped          | n/a (destroys identity) | ⚠️ peers behind T2 reject sync | ❌ you implement the scrub |
| T3   | ✅ shipped          | n/a (epoch reset)       | ⚠️ peers behind T3 reject sync | ❌ you implement the reload |

T1b (structural bijection on CRDT nodes, e.g. splitting a `Schema.text()`)
is not currently a distinct tier — anything CRDT-touching that isn't a pure
rename is T3.

---

## 2. Mental model

Three ideas, in order:

**A migration is a value, attached to your schema.** You build a schema with
`Schema.struct(...)`, then chain `.migrated(Migration.add("foo"))` and
`.epoch(Migration.retype("bar"))` on it. The result is a new schema that
carries a *migration chain* — an immutable list of all the changes you've
declared since v1. Schemas are recomputed at each step; nothing mutates.

**Identity makes safe migrations cheap.** Every product-field gets an opaque
128-bit identity derived from its *origin* path and *generation*. When you
`.rename("a", "b")`, the field's identity does not change — its origin is
still `a`. The schema-path-to-identity map gets updated; the underlying
storage key is untouched. Two peers on different schema versions can write
to the same node because they compute the same identity for it.

**Tiers describe coordination cost, not just structural difference.**

- **T0 — additive.** Add a field, variant, constraint relaxation. Old peers
  don't see it; new peers see it with a default. No coordination.
- **T1a — identity-preserving rename.** Renames and moves. Identity is
  preserved; native storage doesn't budge. No coordination.
- **T2 — lossy projection.** Removing something. Old peers can still write
  to the removed node; migrated peers silently shed those writes. No
  *distributed* coordination, but you must acknowledge data loss with
  `.drop()` and (currently) implement any actual data scrubbing yourself.
- **T3 — epoch boundary.** Type changes or arbitrary transforms. The CRDT
  history becomes meaningless under the new schema; you must reload
  documents from a snapshot. No automated orchestration is provided.

`bind()` validates the entire chain at module load. A malformed chain
throws — there is no production/dev distinction.

---

## 3. The smallest end-to-end example

```ts
import { bind, json, Migration, Schema } from "@kyneta/schema"

// v2 of your document. Note: this is what the schema looks like NOW —
// the chain describes what changed to get here.
const PlayerDoc = Schema.struct({
  displayName: Schema.string(),  // formerly `name`
  score:       Schema.number(),
  joinedAt:    Schema.number(),  // added in v2
})
  .migrated(Migration.rename("name", "displayName"))
  .migrated(Migration.add("joinedAt"))

export const Player = json.bind(PlayerDoc)
```

A v1 client (running the schema with `name` and `score`, no `joinedAt`) and
a v2 client (running the schema above) can sync the same document. Writes
to `displayName` from v2 reach v1 as writes to `name` (same identity).
Writes to `joinedAt` from v2 are invisible to v1; writes to anything else
sync normally.

---

## 4. T0 and T1a recipes (the safe ones)

### 4.1. Add a field

```ts
const Doc = Schema.struct({
  title:  Schema.string(),
  body:   Schema.string(),
  pinned: Schema.boolean(),       // newly added
})
  .migrated(Migration.add("pinned"))
```

- **Existing payloads:** the field is absent; readers see the schema's
  default for the kind (`false` for boolean, `""` for string, `0` for
  number, `[]` for sequence, etc.) until something writes to it.
- **Old peers:** never see ops addressed to the new field. Migrated peers
  writing `pinned` produce ops that old peers silently ignore.
- **Sync compatibility:** preserved. The pre-`add` schema's hash remains in
  `bound.supportedHashes`.

### 4.2. Add a variant

```ts
const Block = Schema.sum("kind", {
  text:  Schema.struct({ value: Schema.string() }),
  image: Schema.struct({ url: Schema.string() }),
  code:  Schema.struct({ language: Schema.string(), source: Schema.string() }),
})

const Doc = Schema.struct({ blocks: Schema.sequence(Block) })
  .migrated(Migration.addVariant("blocks", "code"))
```

- The new variant's struct is part of the *current* schema literal; the
  `addVariant(...)` step in the chain marks when it was introduced.
- Old peers can't construct `code` blocks but can pass through documents
  that contain them in fields they don't reach.

### 4.3. Widen a constraint

```ts
const Doc = Schema.struct({
  role: Schema.string("admin", "user", "guest"),  // was: "admin" | "user"
})
  .migrated(Migration.widenConstraint("role", ["admin", "user", "guest"]))
```

- Strictly relaxes the accepted value set. Old peers will reject `"guest"`;
  migrated peers accept all three. The protocol-level mismatch is described
  in [§7](#7-cross-version-sync-between-peers).

### 4.4. Make a field nullable

```ts
const Doc = Schema.struct({
  avatarUrl: Schema.nullable(Schema.string()),
})
  .migrated(Migration.addNullable("avatarUrl"))
```

### 4.5. Rename a field

```ts
const Doc = Schema.struct({
  displayName: Schema.string(),
})
  .migrated(Migration.rename("name", "displayName"))
```

- **Identity:** preserved. `bound.identityBinding.forward.get("displayName")`
  is `deriveIdentity("name", 1)` — the original origin path.
- **Old peers:** continue writing to `"name"`. Their ops resolve to the same
  identity as `"displayName"` on a migrated peer. Convergence is automatic.
- **Substrate storage:** untouched. The CRDT container that backs the field
  is keyed by identity, not by path.

> **Gotcha — chain order matters.** `.migrated(Migration.rename("a", "b"))`
> only works if the *previous* schema had `"a"` as a field. If you renamed
> `a → b` and then `b → c`, that's two separate `.migrated(...)` calls in
> order, not one. `validateChain` catches misordered renames at `bind()`.

### 4.6. Move a field

```ts
const Doc = Schema.struct({
  profile: Schema.struct({ avatarUrl: Schema.string() }),
})
  .migrated(Migration.move("avatarUrl", "profile.avatarUrl"))
```

- Semantically a rename across nesting; identity is preserved the same way.

> **Current limit — nested moves halt the backward sync-compat walk.** The
> walk that computes `supportedHashes` only inverts root-level `add`,
> `rename`, `move`. Nested-path renames work *forward* (identity binding
> tracks them) but the pre-move schema hash will not be in
> `bound.supportedHashes`, so peers running the pre-move schema will be
> rejected at sync handshake time. Workaround: if you must support
> pre-move peers, hold the move until they've upgraded.

### 4.7. Rename a variant tag or discriminant key

```ts
const Doc = Schema.struct({
  blocks: Schema.sequence(
    Schema.sum("kind", {
      text:  Schema.struct({ value: Schema.string() }),
      image: Schema.struct({ url: Schema.string() }),    // was "img"
    }),
  ),
})
  .migrated(Migration.renameVariant("blocks", "img", "image"))

// And to rename the discriminant key itself ("type" → "kind"):
.migrated(Migration.renameDiscriminant("blocks", "kind"))
```

---

## 5. T2 recipes — lossy migrations (you must implement the data scrub)

T2 primitives are returned wrapped in a `Droppable<T>` and **must** be
unwrapped with `.drop()` before passing to `.migrated()`. This is a
compile-time gate: forgetting `.drop()` is a type error.

> **The big caveat.** kyneta does not currently:
> 1. Enumerate which records will be affected before the migration runs.
> 2. Scrub data from existing payloads. After a `Migration.remove("legacy")`,
>    the field is absent from the new schema, but any pre-existing CRDT
>    state under that identity remains in the substrate.
> 3. Reject incoming ops from old peers writing to the removed node — they
>    are silently shed when their identity has no schema-path mapping.
>
> `.drop()` is an acknowledgment that you understand these things. It is
> not a data-deletion call.

### 5.1. Remove a field

```ts
const Doc = Schema.struct({
  title: Schema.string(),
  // legacyFlag removed
})
  .migrated(Migration.remove("legacyFlag", Schema.boolean()).drop())
//                                          ^^^^^^^^^^^^^^^^^
//                          You must pass the OLD field's schema so kyneta
//                          knows its kind for inversion / inspection.
```

If you need any of (a) confirming what `legacyFlag` actually held in live
documents, (b) physically reclaiming that storage, or (c) producing a
report for users of how many records had truthy values — implement those
yourself, separately, before deploying the migration.

### 5.2. Remove a variant

```ts
const BlockSchema = Schema.sum("kind", {
  text: Schema.struct({ value: Schema.string() }),
  // "image" variant removed
})

const Doc = Schema.struct({ blocks: Schema.sequence(BlockSchema) })
  .migrated(Migration.removeVariant("blocks", "image", BlockSchema).drop())
```

Documents that still contain `image`-variant entries become invalid under
the new schema. There is no automated coercion.

### 5.3. Narrow a constraint

```ts
const Doc = Schema.struct({
  role: Schema.string("admin", "user"),   // was: "admin" | "user" | "guest"
})
  .migrated(Migration.narrowConstraint("role", ["admin", "user"]).drop())
```

### 5.4. Drop nullability

```ts
const Doc = Schema.struct({
  avatarUrl: Schema.string(),    // was: nullable(string)
})
  .migrated(Migration.dropNullable("avatarUrl").drop())
```

> **Gotcha — T2 closes the backward sync compat walk.** Once any T2 step
> appears in the chain, the supportedHashes walk halts at that step. Peers
> running schemas from before the T2 step cannot sync. This is intentional
> — under the current substrate-keying model, advertising a pre-T2 hash
> would mean accepting writes to identities the new schema has dropped.

---

## 6. T3 recipes — epoch boundaries (you must implement the reload)

T3 is the explicit "the old CRDT history doesn't make sense under the new
schema" signal. It uses `.epoch(...)` (not `.migrated(...)`) and resets
identity for every surviving node — generations bump, fresh hashes.

> **The bigger caveat.** kyneta does not currently:
> 1. Coordinate the epoch boundary across peers. You can't issue `.epoch()`
>    and expect connected peers to reload — there's no protocol for it.
> 2. Apply the `coerce` / `transform` function to existing payload data
>    automatically. The function is recorded in the chain but is not yet
>    executed by any built-in code path.
>
> The current shape of a T3 deployment is operational, not in-band:
> 1. Quiesce writes on the affected documents.
> 2. Snapshot the documents' plain state via `unwrap(ref)`.
> 3. Apply your transform offline.
> 4. Create fresh substrates from the transformed payloads via the
>    `fromEntirety` factory primitive.
> 5. Reload all clients.

### 6.1. Change a field's type (retype)

```ts
const Doc = Schema.struct({
  count: Schema.counter(),    // was: Schema.number()
})
  .epoch(
    Migration.retype("count", v => (typeof v === "number" ? v : 0)),
  )
```

The `coerce` argument is for *your* offline pipeline — it is not invoked
inside the schema runtime today.

### 6.2. Custom transforms

```ts
const Doc = Schema.struct({
  fullName: Schema.string(),     // was: { firstName, lastName }
})
  .epoch(
    Migration.transform(
      "fullName",
      v => `${(v as any).firstName} ${(v as any).lastName}`,
      v => {
        const [first, ...rest] = (v as string).split(" ")
        return { firstName: first, lastName: rest.join(" ") }
      },
    ),
  )
```

**Proof-promoted transforms.** If your transform is genuinely a CRDT
homomorphism, idempotent, and bijective on a plain (non-CRDT) node, you
can pass a `proof` object and it will be classified as T1a instead of T3:

```ts
Migration.transform("rgb", encode, decode, {
  idempotent:       true,
  crdtHomomorphism: true,
  bijective:        true,
})
```

The system **does not verify** these proofs. They are a developer
attestation and should be code-reviewed accordingly.

---

## 7. Cross-version sync between peers

Every `BoundSchema` carries a `supportedHashes: ReadonlySet<string>` —
the set of schema hashes this peer can talk over the wire. Peers exchange
their sets when they meet a document, and the exchange syncs only if
their sets intersect.

### How the set is built

Starting from the current schema's hash, walk backwards through the
migration chain inverting each step. Add each ancestor hash to the set.
Halt when you hit any of:

- A **T2 step** (would expose dropped identities).
- A **T3 epoch boundary** (hard break by construction).
- A primitive that's **not currently invertible at root level** —
  presently only `add`, `rename`, and `move` are inverted. Anything else
  halts the walk.
- The **`migrationBase` horizon** (chain has been pruned past this point).

### What you see when peers can't talk

The exchange emits a warning effect of the form:

```
[exchange] schema hash mismatch for doc 'docId': local '<localHash>' vs remote '<remoteHash>' — skipping sync
```

…and skips sync for that document. The peers remain connected; only this
document is shed.

### Practical implications

- Two peers on **any combination of T0/T1a versions** sync correctly, as
  long as one of them carries the other's hash in `supportedHashes`.
- After a **T2 deployment**, peers still on the pre-T2 schema are cut off
  from sync until they upgrade.
- After a **T3 deployment**, every peer is cut off until they upgrade *and*
  receive a fresh document via your `fromEntirety` reload pipeline.

> **Limit — current backward-walk only inverts root-level `add` /
> `rename` / `move`.** Other invertible primitives (e.g. `addNullable`,
> `widenConstraint`) currently halt the walk. The forward state is
> correct; sync compat with pre-`addNullable` peers is conservatively
> rejected. If you need that compat, hold the migration until peers
> upgrade.

---

## 8. Pruning history with `.migrationBase()`

A chain grows monotonically. After a long-lived project accumulates
dozens of `.migrated(...)` calls, you can collapse the historical prefix
into a single base manifest.

### When it is safe

- Every live document has been bound at least once under code containing
  the steps you're about to prune (so its identity layer is realized).
- Every live peer is on a schema whose `supportedHashes` no longer needs
  the pruned ancestors.

There is no enforcement of this — it is operational discipline, the same
shape as pruning database migrations.

### How

1. From a one-off script in your repo, capture the current manifest:

   ```ts
   import { snapshotManifest } from "@kyneta/schema"
   import { CurrentDoc } from "./schema"

   console.log(JSON.stringify(snapshotManifest(CurrentDoc), null, 2))
   ```

2. Paste the output as a literal into your schema file, replacing the
   pruned `.migrated(...)` calls:

   ```ts
   const Doc = Schema.struct({ /* current shape */ })
     .migrationBase({
       title:  { originPath: "title",  generation: 1 },
       body:   { originPath: "body",   generation: 1 },
       pinned: { originPath: "pinned", generation: 1 },
       // …etc
     })
     // Keep the post-prune steps:
     .migrated(Migration.add("priority"))
   ```

3. `.migrationBase(...)` **must come before any `.migrated()` or
   `.epoch()`** in the chain — runtime check, throws otherwise.

After pruning, the pre-prune ancestor hashes drop out of
`supportedHashes`. Peers still on those versions cannot sync until they
upgrade.

---

## 9. Known gaps

These are the rough edges. None are blockers for T0/T1a use, but you
should know about each before relying on T2 or T3.

1. **No runtime data transformation.**
   The migration chain *declares* what changed; nothing currently rewrites
   existing payload values. T0 and T1a are correct by construction (no
   transform needed). T2 and T3 leave the data side to you.

2. **No `DataLossReport`.**
   `.drop()` is an acknowledgment, not an enumeration. If you want a list
   of which records would be affected by a `Migration.remove(...)`, scan
   them yourself before deploying.

3. **No persistent node registry.**
   Identities are recomputed at every `bind()` from the migration chain in
   code. Two consequences: (a) deterministic — two peers running the same
   code compute the same identities, no shared state needed — and (b)
   fragile under unilateral code pruning. If you `.migrated(Migration.rename(...))`
   on one peer and then delete that migration from the source without
   substituting a `.migrationBase(...)`, the identity link breaks.

4. **No T3 cross-peer orchestration.**
   `.epoch()` is a marker; document reload across peers is your problem.
   The exchange has no quiesce / snapshot / migrate / resume primitive.

5. **Wire ops are still path-keyed.**
   At the substrate level, native storage is keyed by identity at
   product-field boundaries. The wire format itself still carries paths;
   correct cross-version behavior relies on each peer's `bind()` mapping
   paths to identities at the resolve step. This is functionally adequate
   for T0/T1a but is not the clean identity-keyed wire format described in
   the theory document.

6. **T1b is collapsed into T3.**
   The theory distinguishes structural bijection on plain nodes (T1b) from
   the same thing on CRDT nodes (T3). In code, anything that isn't a pure
   rename and touches a CRDT-kind node is T3. There is no `split` /
   `merge` primitive.

7. **Backward-walk inverts a narrow primitive set.**
   The walk that builds `supportedHashes` only inverts root-level `add`,
   `rename`, `move`. Other invertible primitives halt the walk — forward
   state is correct, cross-version sync compat is conservatively dropped.
   Nested-path `add`/`rename`/`move` also halt (root-level only).

---

## 10. Reference

### 10.1. The `Migration` namespace

Constructors for every primitive. All are pure data — they return
`MigrationPrimitive` values you pass to `.migrated()` or `.epoch()`.

```ts
import { Migration } from "@kyneta/schema"

// T0 — additive
Migration.add(path)
Migration.addVariant(path, tag)
Migration.widenConstraint(path, values)
Migration.addNullable(path)

// T1a — identity-preserving rename
Migration.rename(from, to)
Migration.move(from, to)
Migration.renameVariant(sumPath, fromTag, toTag)
Migration.renameDiscriminant(sumPath, newKey)

// T2 — lossy (returns Droppable<P>; call .drop() to unwrap)
Migration.remove(path, schema).drop()
Migration.removeVariant(sumPath, tag, schema).drop()
Migration.narrowConstraint(path, values).drop()
Migration.dropNullable(path).drop()

// T3 — epoch
Migration.retype(path, coerce?)
Migration.transform(path, fn, inv?, proof?)
```

### 10.2. Schema methods

| Method                          | Where                       | What it does |
|---------------------------------|-----------------------------|--------------|
| `.migrated(...inputs)`          | `ProductSchema`             | Append one migration step (≥1 primitives, max-tier composed). Throws on empty. |
| `.epoch(...primitives)`         | `ProductSchema`             | Append an epoch boundary. Resets identity generations for all surviving nodes. |
| `.migrationBase(manifest)`      | `ProductSchema`             | Seed the chain from a pre-collapsed manifest. Must precede any `.migrated()` / `.epoch()`. |

All three return a new schema; the original is untouched.

### 10.3. Functions

| Function                              | Returns                       | Use when |
|---------------------------------------|-------------------------------|----------|
| `bind({ schema, factory, syncProtocol })` | `BoundSchema`             | Create the runtime binding. Validates the chain; throws if malformed. |
| `getMigrationChain(schema)`           | `MigrationChain \| null`      | Read the chain from a schema (introspection / tooling). |
| `snapshotManifest(schema)`            | `IdentityManifest`            | Collapse the full chain to a manifest for pruning. |
| `deriveTier(primitive)`               | `MigrationTier`               | Classify a single primitive (rarely needed directly). |
| `deriveStepTier(primitives)`          | `MigrationTier`               | Classify a list (used internally by `.migrated`). |
| `validateChain(schema)`               | `{ valid, errors }`           | Check for ordering / collision errors before binding. Called by `bind()` automatically. |
| `computeSupportedHashes(schema)`      | `ReadonlySet<string>`         | Inspect the cross-version compat set (used internally by `bind()`). |

### 10.4. Types

```ts
type MigrationTier = "T0" | "T1a" | "T2" | "T3"

type IdentityOrigin = {
  readonly originPath: string
  readonly generation: number    // 1-based, increments on destroy+recreate
}

type IdentityManifest = Readonly<Record<string, IdentityOrigin>>

type MigrationChain = {
  readonly base: IdentityManifest | null
  readonly entries: readonly MigrationChainEntry[]
}

type BoundSchema = {
  readonly schema:           ProductSchema
  readonly schemaHash:       string             // canonical 34-char hash
  readonly identityBinding:  SchemaBinding      // path↔identity maps
  readonly migrationChain:   MigrationChain | null
  readonly supportedHashes:  ReadonlySet<string>
  // …factory, syncProtocol
}
```

---

## 11. Where to go from here

- The theory and the lattice algebra: [`.jj-plan/migrations.md`](../.jj-plan/migrations.md).
- The implementation source: [`packages/schema/src/migration.ts`](../packages/schema/src/migration.ts).
- The test suite, useful as worked examples:
  [`packages/schema/src/__tests__/migration.test.ts`](../packages/schema/src/__tests__/migration.test.ts).
- Schema basics (if you haven't already): [`packages/schema/TECHNICAL.md`](../packages/schema/TECHNICAL.md).
