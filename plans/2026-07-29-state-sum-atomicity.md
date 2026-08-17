fix(schema): store sum & json-boundary nodes as atomic LWW registers in the state substrate

<!-- PLAN-2026-07-29-state-sum-atomicity -->

# Background

The `state` binding target (`@kyneta/schema`) is a field-level LWW CvRDT. Every scalar leaf of a document is stored as a `StateTuple = [value, timestamp]` inside a `StateTree`, and peers converge by a schema-blind join: `mergeStateTree` recurses two trees and, at each leaf tuple, keeps the higher timestamp ("highest-T wins"). See `packages/schema/src/substrates/state-tree.ts` and `packages/schema/src/substrates/state.ts`.

This field-level merge is exactly why `state` is replacing `ephemeral` (whole-document LWW): concurrent writes to *different* fields both survive instead of one peer's whole snapshot clobbering the other's.

A key schema concept is the **atomic LWW register** — a subtree that must move as one indivisible value:

- **`sum` / discriminated union** (`Schema.discriminatedUnion`, `Schema.union`, and `.nullable()` sugar). Carries law `"lww-tag-replaced"`. Its variants are always `PlainSchema`, and per `packages/schema/TECHNICAL.md` (the `WritableDiscriminantProductRef` section) and `src/ref.ts:143-145`: a variant switch is a whole-value `.set()` at the sum node's path — the tag and its fields move together; individual variant-field mutation is structurally disallowed.
- **`.json()` boundary** (`struct.json`/`list.json`, marked with `JSON_BOUNDARY`, `schema.ts:51`). Collapses its whole subtree to law `"lww"` — an opaque JSON blob merged as one value.

Both laws (`"lww"`, `"lww-tag-replaced"`) are in `EphemeralLaws`, so `state.bind` accepts schemas containing sums and `.json()` blobs.

**Two existing pieces of infrastructure this fix reuses rather than reinventing:**

1. **`needsContainer(schema)`** (`materialize-value.ts:91`) — *"the single container-vs-leaf predicate,"* already shared by the Loro and Yjs backends. It returns `false` for `json-boundary`, `sum`, and `scalar` (the opaque plain values) and `true` for `product`/`map` (real containers). For the state substrate's reachable kinds — `product`, `map`, `scalar`, `sum`, `.json()` (everything else is compile-rejected by `EphemeralLaws`) — `!needsContainer(schema)` is exactly "store as one `[value, ts]` tuple." `MaterializedNode` even documents the bucket: `// scalar | sum | json-boundary | tree` are `"plain"`.
2. **`deepClonePreState`** (`inverse.ts:64`, re-exported from `index.ts:281`) — a `structuredClone`-based deep clone for plain JSON values, whose precondition ("plain JSON values round-trip faithfully under `structuredClone`") is exactly a register interior. `state.ts` already imports it (`state.ts:21`). This plan renames it to the shape-honest **`deepClonePlain`** (Phase 1) and reuses it as the aliasing barrier at the tree↔shadow boundary.

# Problem Statement

`state` stores an atomic register the same way it stores an ordinary product: **decomposed into one tuple per interior field.** The tree builders (`syncStateTreeToShadow`, `applyChangeToStateTree`, `insertStructuralZeros`, currently in `state.ts`) are schema-blind — they see a JS object and recurse, minting a `[value, ts]` tuple for each leaf they reach, whether that object is a product (correct) or the interior of a sum/json register (wrong).

Because the register's fields become independent tuples, the schema-blind `mergeStateTree` merges them independently. Concurrent writes then **blend fields across variants**:

> Peer A holds `{kind:"circle", radius:5}`; peer B concurrently switches to `{kind:"square", side:3}`. Merging their trees key-unions the interiors and yields `{kind:<LWW>, radius:5, side:3}` — a value that is neither a valid circle nor a valid square.

The identical failure hits `.json()` blobs: concurrent writes to the blob merge field-by-field instead of newest-blob-wins.

Whole-document LWW (`ephemeral`) never produced this — the newest whole snapshot won. `state` advertises `"lww-tag-replaced"` and `"lww"` but does not honor their atomicity. This is a correctness blocker for retiring `ephemeral`.

# Success Criteria

- A `sum` node and a `.json()` node are each stored in the `StateTree` as **one** `StateTuple` whose value is the whole (deep-cloned) register value, stamped with a single timestamp.
- Concurrent variant switches (and concurrent `.json()` blob writes) converge to exactly one variant/blob (highest-T wins) on every peer. No field from the losing variant ever survives.
- `mergeStateTree` remains **schema-blind** — atomicity is carried by the tree's *shape* (register = tuple), decided at build/extract on schema-aware peers only. This preserves the invariant that headless replicas merge entirety payloads without schema (`state-tree.ts:12-14`; `stateReplicaFactory.fromEntirety`).
- The leaf-vs-container decision reuses **`needsContainer`** — no bespoke `state`-only predicate — so `state` agrees with the Loro/Yjs backends on what is a leaf.
- Register values are deep-cloned via **`deepClonePlain`** (the renamed shared helper) at the tree↔shadow boundary in both directions — no aliasing.
- The pure StateTree construction functions live in `state-tree.ts` (the functional core); `state.ts` is the imperative shell.
- Ordinary product/map fields still merge field-by-field (the core `state` property is untouched).
- Reading a sum through the interpreter (`doc.status.kind`, active-variant fields) still works.
- New unit + integration tests cover variant blending, `.json()` atomicity, nullable/positional sums, and a product-field-merge regression guard. All existing `state` tests and the conformance suite pass.

---

> **Each phase below is one commit in the jj stack, bottom → top.** The two pure refactors (Phases 1–2) bracket the single behavioral change (Phase 3) so its diff stays small; the cleanup (Phase 4) is separated because that code is only dead once Phase 3 lands; docs (Phase 5) are behavior-free. Every commit must build and pass tests on its own (bisectable).

# ✅ Phase 1 — `refactor(schema): rename deepClonePreState → deepClonePlain`

Behavior-preserving. The name should describe the mechanism (a plain-JSON `structuredClone`), not its first caller's intent (a pre-mutation σ snapshot), because a second subsystem (the `state` substrate) now depends on it.

- ✅ **Task 1.1 — Hard rename, no alias.** Rename the definition and internal uses in `inverse.ts` (:64 def; uses at :84, :162, :196, :206, :329), the re-export in `index.ts:281`, and the two substrate call sites (`plain.ts:301`, `state.ts:241`). Update the doc-comment to say it is the plain-JSON `structuredClone` used both for inverse σ-snapshots and (later) as the `state` aliasing barrier. At the σ call sites, carry the "pre-state" intent in a local variable name (`const pre = deepClonePlain(...)`), not the function name. Grep the whole repo for `deepClonePreState` to catch any external importer. Breaking the public export is acceptable.

# ✅ Phase 2 — `refactor(schema): move StateTree builders into state-tree.ts`

Behavior-preserving. Consolidates the functional core so Phase 3's diff is localized to one file and Phase 4's tests can hit pure functions.

- ✅ **Task 2.1 — Relocate the pure tree-construction functions.** Move `syncStateTreeToShadow` (`state.ts:527`), `applyChangeToStateTree` (`state.ts:427`), and `insertStructuralZeros` (`state.ts:669`) into `state-tree.ts`; export them; rewire the `state.ts` imports. `state-tree.ts` gains lower-level imports (`RawPath`/`Path`/`ChangeBase`/`replaceChange`/`applyChange` as needed); verify none of those modules import `state-tree.ts` (no cycle — it is the lower module).

# ✅ Phase 3 — `fix(schema): store sum & json nodes as atomic LWW registers in state`

The single behavioral change, shipped with its tests so the commit is self-proving.

- ✅ **Task 3.1 — Adopt `needsContainer` as the leaf/container pivot.** Import `needsContainer` from `../materialize-value.js` into `state-tree.ts`. Build rule: for a child at `key` with schema `childSchema`, if `needsContainer(childSchema)` → recurse (product/map); else → store `tree[key] = [deepClonePlain(value), timestamp]` (scalar, sum, or json). This one branch subsumes the scalar-leaf case *and* the atomic-register case — no bespoke predicate. Add the "why" comment: *"a sum/json is opaque to the CRDT, exactly like a scalar — store the whole value under one timestamp, or concurrent merge corrupts the variant."*
- ✅ **Task 3.2 — `syncStateTreeToShadow` schema-aware.** Thread the subtree's schema through the recursion; resolve each child via `childSchemaForKey`; apply the Task 3.1 rule; recurse only into containers.
- ✅ **Task 3.3 — `applyChangeToStateTree` schema-aware.** Thread the substrate root `schema` in. Descend via `advanceSchema` (`schema.ts:1121`) per path segment — mirroring `findJsonBoundary` (`fold-path.ts:219`) — to the target node schema. In the `replace` branches (root + nested) and the `map` `set` branch, apply the Task 3.1 rule. Fall back to decompose if a path can't be resolved. Update `createStateSubstrate` (`state.ts:204`) to pass its `schema`.
- ✅ **Task 3.4 — `insertStructuralZeros` schema-aware.** Thread schema in; for a register field (`!needsContainer`), seed `t[key] = [Zero.structural(childSchema), 0]` (T=0 genesis; for a sum the first variant per `zero.ts:96-115`) instead of recursing. (Root is always a `ProductSchema` per `bind<P extends ProductSchema>`.)
- ✅ **Task 3.5 — Extract atomic registers whole (with clone).** In `extractInto` (`state-tree.ts:145`) a register is now a leaf tuple → the `isStateTuple` branch yields the whole object. Deep-clone object-valued leaves (`target[key] = deepClonePlain(child[0])` when `child[0]` is a non-null object) so the shadow does not alias the tree. Confirm register-boundary decay still fires via the parent's `childSchemaForKey` + `isExpired`.
- ✅ **Task 3.6 — Keep `mergeStateTree` schema-blind; comment why.** No functional change. Comment `mergeStateTree` (`state-tree.ts:62`) + the module header: a register is one tuple *by construction*, so highest-T merge is automatically atomic — which is why merge needs no schema (headless relays converge on raw payloads). Note the tuple-vs-object fallback (`state-tree.ts:75-82`) degrades a mixed old/new shape to whole-node LWW (non-corrupting).
- ✅ **Task 3.7 — Tests (ship with the fix).** Added `state-sum-atomicity.test.ts` (9 tests) exercising the now-pure builders + `mergeStateTree` (variant no-blend, commutativity, product-merge regression, deep-clone/no-alias, `.json()`, nullable) plus an end-to-end case through `stateSubstrateFactory.fromEntirety` + `substrate.merge`. **Conformance decision:** the cross-substrate suite shares a two-scalar `ConformanceSchema`; adding a sum there would perturb all five profiles and needs Exchange-level variant-write wiring. Per the plan's escape hatch, the assertion lives in the dedicated schema-package test instead. A *universal* sum-atomicity conformance invariant (all substrates keep a variant coherent under concurrent switches) is deferred — see `next.md`.

# ✅ Phase 4 — `refactor(schema): drop decomposition machinery obsoleted by atomic registers`

Pure cleanup, separated because this code is only dead once Phase 3 lands.

- ✅ **Task 4.1 — Reduce `childSchemaForKey`.** Removed the dead discriminant-based sum branch, leaving only `product` (`fields[key]`) and `map` (`item`); dropped the now-unused `target`/discriminant parameter and updated all six call sites (2 extract, 4 build) to the 2-arg form.
- ✅ **Task 4.2 — Delete the discriminant-first extraction ordering.** Removed; a sum is a leaf now, so `extractInto` never iterates a decomposed sum's fields.
- ✅ **Task 4.3 — Audit `facade/last-updated.ts`.** No code change needed. `getMaxTimestamp` reads a sum's single tuple timestamp (its switch time) — more correct than the old per-field max. `lastUpdated` returns that timestamp at the register node and `null` for an intra-register path (an atomic register has no per-field timestamp); no test relies on intra-register paths, and the "max of leaves" comment still holds for products/maps.

# ✅ Phase 5 — `docs(schema): document atomic LWW registers in the state substrate`

- ✅ **Task 5.1 — `packages/schema/TECHNICAL.md`.** Updated the `state` substrate row + the "`ephemeral` vs `state`" paragraph and added an "Atomic registers in the StateTree" subsection explaining the `needsContainer` reuse and that atomicity is structural (register = tuple) so merge stays schema-blind. Referenced `WritableDiscriminantProductRef` (by name — it is bold text, not a heading, so no anchor link).
- ✅ **Task 5.2 — `state-tree.ts` module header.** Added a paragraph: an atomic register is stored as one leaf tuple whose value is the whole object, so schema-blind merge treats it atomically.
- ✅ **Task 5.3 — README.** No change. `packages/schema/README.md` does not document `state` merge semantics, so there is nothing to correct.

# Tests

Reuse helpers from `packages/schema/src/__tests__/state-decay.test.ts` (state substrate construction) and follow the discriminated-union patterns in `packages/schema/backends/loro/src/__tests__/discriminated-union.test.ts`. Keep boilerplate minimal. Phase 2 makes the builders pure exports, so unit cases need no substrate.

Schema under test (discriminated union inside a product, plus a plain field to prove independence):

```ts
const Shape = Schema.discriminatedUnion("kind", [
  Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
  Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
])
const Doc = Schema.struct({ shape: Shape, label: Schema.string() })
```

High-risk cases:

1. **Variant blending (the core bug).** Build two `state` trees from `{shape:{kind:"circle",radius:5}, label:"a"}` and `{shape:{kind:"square",side:3}, label:"b"}` with distinct timestamps. Merge both directions. Assert: `shape` is exactly one variant (higher-T), the losing variant's field (`radius` or `side`) is **absent**, `kind` matches that variant, and both merge orders converge identically (commutativity).
2. **Register stored as one tuple.** After a variant-switch write through `createStateSubstrate`, assert the `StateTree` node at `shape` satisfies `isStateTuple` (not a decomposed record) and its `[0]` is the whole variant object.
3. **Product field-merge regression.** Concurrent writes to `label` on one peer and `shape` on another both survive after merge (proves products did not become atomic).
4. **`.json()` atomicity.** A schema with a `Schema.struct.json({...})` field: concurrent whole-blob writes converge to the newest blob with no field blend.
5. **Nullable / positional sum.** `Schema.number().nullable()` (positional sum `[null, number]`): concurrent `set(null)` vs `set(7)` converge to the higher-T value; the register is a single tuple.
6. **Integration convergence.** Two substrates exchange entireties after concurrent variant switches; read `doc.shape.kind` and the active field on both and assert a coherent, identical single variant.
7. **Conformance.** Extend the `state` profile (`tests/conformance/src/profiles.ts`) so its concurrency assertions include a variant switch that must not blend. Do not perturb the `ephemeral`/`json` profiles — prefer a `state`-scoped assertion over changing the shared `ConformanceSchema` unless the schema addition is proven neutral for the other profiles.

# Transitive Effect Analysis [scratch]

- **`mergeStateTree` must stay schema-blind (load-bearing).** `state-tree.ts:12-14` and `stateReplicaFactory.fromEntirety`/`createStateReplica` (`state.ts:566-620`) let headless relays/stores merge entirety payloads *without a schema*. Making merge schema-aware would break the headless replica contract. Mitigation: atomicity is encoded in tree *shape* (register = tuple) at build/extract only; merge is unchanged.
- **`deepClonePreState` rename blast radius (Phase 1).** Definition + internal uses in `inverse.ts` (:64, :84, :162, :196, :206, :329), re-export `index.ts:281`, call sites `plain.ts:301` and `state.ts:241`. A hard rename with no alias is a public-surface break — acceptable per direction. Grep the repo before finishing.
- **`needsContainer` coupling (Phase 3).** Reusing `materialize-value.ts:91` couples the state leaf/atomic decision to a predicate authored for CRDT-container detection. For state's *reachable* kinds the mapping is exact (product/map → container; scalar/sum/json → leaf); text/counter/set/tree/movable/richtext/sequence are compile-rejected by `EphemeralLaws` and never reach it. A shared unit test (one schema per kind) guards drift. The cross-substrate consistency win outweighs the coupling.
- **Relocation import direction (Phase 2).** `state-tree.ts` gains imports from `path.js`/`change.js`/`interpret.js`; none import `state-tree.ts`, so no cycle. `materialize-value.js` (for `needsContainer`) also does not import `state-tree.ts`.
- **Headless replica never decomposes.** The headless `Replica` builds trees only via `merge` (schema-blind) and `fromEntirety` (`JSON.parse` of a peer's tree); it never calls the build functions. It faithfully carries the atomic-tuple shape and merges by timestamp. No schema needed.
- **Shadow/tree aliasing.** Storing/reading an *object* register risks sharing a reference across tree and shadow. Mitigation: `deepClonePlain` at both boundaries (Tasks 3.1, 3.5). Scalars are immutable — no clone.
- **Decay interaction.** Decay at/above a register boundary still works; decay *inside* a variant becomes unreachable (`validateSyncModeConstraints` still permits it silently) — a separate deferred issue, not fixed here.
- **`facade/last-updated.ts`.** Consumes the tree via `isStateTuple`; a sum now yields one timestamp. Verify (Task 4.3).
- **Wire/replica compatibility.** `replicaType` stays `["state",1,0]`; the tree *shape* for sums changes (decomposed → atomic). Mixed old/new `state` peers see a shape mismatch at sum nodes → merge degrades to whole-node LWW (`state-tree.ts:75-82`) — coarser but non-corrupting. `state` is transient (nothing persisted); a mixed-deploy window self-heals. No major bump; document the transitional degrade.
- **No effect on `json`/`loro`/`yjs` substrates** beyond the shared `deepClonePlain` rename and reading (not changing) `needsContainer`.

# Resources for Implementation [scratch]

- `packages/schema/src/substrates/state.ts` — `createStateSubstrate` (:204), `prepare`/`afterBatch`/`tick` (:233/:266/:391), and (pre-relocation) `applyChangeToStateTree` (:427), `syncStateTreeToShadow` (:527), `insertStructuralZeros` (:669); headless factories (:566-667).
- `packages/schema/src/substrates/state-tree.ts` — `StateTuple`/`StateTree` (:28-35), `isStateTuple` (:45), `mergeStateTree` (:62), `extractPlainState`/`extractInto` (:120/:145), `childSchemaForKey` (:248), `deepClone` (:304).
- `packages/schema/src/materialize-value.ts` — `needsContainer` (:91) and the `MaterializedNode` "plain = scalar | sum | json-boundary | tree" precedent (:46-47, :164).
- `packages/schema/src/inverse.ts` — `deepClonePreState` (:64) → rename target `deepClonePlain`.
- `packages/schema/src/schema.ts` — `KIND` (:29), `JSON_BOUNDARY` + `isJsonBoundary` (:51-59), `advanceSchema` (:1121), `discriminatedSum`/`variantMap` (:718-734), `struct.json` (:814).
- `packages/schema/src/fold-path.ts` — `findJsonBoundary` (:219): the existing "walk path alongside schema via `advanceSchema`" discipline to mirror in Task 3.3.
- `packages/schema/src/zero.ts` — `Zero.structural` and the `sum` zero = first variant (:96-115).
- `packages/schema/TECHNICAL.md` — `WritableDiscriminantProductRef` (whole-value `.set()` invariant), "Sum variants", "Path resolution and sum boundaries", and the `state` substrate rows.
- Tests to mirror: `packages/schema/src/__tests__/state-decay.test.ts`, `oplog-raw-path.test.ts`, `packages/schema/backends/loro/src/__tests__/discriminated-union.test.ts`; conformance `tests/conformance/src/profiles.ts` (`state` profile at :71).

# Alternatives Considered

- **Chosen — structural atomic register (sum/json = single tuple); schema consulted only at build/extract; merge stays schema-blind.** Minimal merge change, preserves the headless "merge without schema" invariant, and the existing `[value, ts]` tuple already *is* an LWW register — no new tree shape.
- **Bespoke `isAtomicRegister` predicate.** Rejected in favor of reusing `needsContainer` (`materialize-value.ts:91`), which already classifies sum/json/scalar as leaves, unifies the scalar branch, and keeps `state` consistent with the Loro/Yjs backends. A new predicate would be a second source of truth for "what is a leaf."
- **New `cloneRegisterValue` helper.** Rejected in favor of renaming and reusing `deepClonePreState` → `deepClonePlain`. The function is already a plain-JSON `structuredClone`; a second clone helper would duplicate it. The rename fixes a name that only described its first caller's intent.
- **Schema-aware `mergeStateTree`.** Rejected: passing the schema into merge to collapse sums there breaks the load-bearing "relays/stores merge without schema" invariant — every relay would need the doc schema.
- **Drop `"lww-tag-replaced"`/`"lww"` from `state`'s `EphemeralLaws`.** Reject sums/json at compile time. Rejected: capitulates capability the migration needs and would leave `.json()` blobs either broken or banned.
- **Sentinel-wrapped atomic nodes** (`{__atomic:true, value, ts}`). Rejected: a bespoke shape complicates `isStateTuple`/`mergeStateTree`/the wire form for no benefit — the plain `[value, ts]` tuple is already the register.
