refactor(schema)!: consolidate the ephemeral and state binding targets

# Background

`@kyneta/schema` ships five binding targets. Two of them — `ephemeral` and `state` — occupy the same slot. Both are `BindingTarget<EphemeralLaws, PlainNativeMap>`, both use `SYNC_EPHEMERAL` (concurrent writes, snapshot-only delivery, transient durability), and both accept exactly the same schemas. They differ only in how concurrent writes merge:

- **`ephemeral`** is a _whole-document_ LWW register. One timestamp for the entire document. The newest snapshot replaces everything. Implemented in `packages/schema/src/substrates/lww.ts` — the plain substrate parameterised with `timestampVersionStrategy`.
- **`state`** is a _field-level_ LWW CvRDT. A `StateTuple` per leaf, so two peers writing different fields both survive. Implemented in `packages/schema/src/substrates/state.ts` and `state-tree.ts`.

`state` was added to fix the anti-feature in `ephemeral`: a presence roster where every peer writes its own key was unusable, because whichever peer wrote last clobbered everyone else. Over `PLAN-2026-07-29-state-sum-atomicity`, `PLAN-2026-08-02-state-lattice-and-deletion` and `PLAN-2026-08-02-bind-time-validation`, `state` closed every remaining gap: sum/variant atomicity, record writes, delete convergence, a commutative merge, and a pinned bind-time contract (`src/__tests__/bind-constraints-state.test.ts`).

`state` is now a strict superset of what `ephemeral` was _for_. Nothing is in production and no backwards compatibility is required.

Two names for one concept is the problem. The internal vocabulary already resolved it in `ephemeral`'s favour: the law set is literally `type EphemeralLaws`, the sync mode is `SYNC_EPHEMERAL`, `Durability` is `"transient"`, and `validateDecayConstraints` describes decay as "ephemeral-only". `state` is the only identifier in that chain that does not say ephemeral — and it is actively misleading, because it is the one target whose data is never persisted and whose values can expire.

The name also has ecosystem precedent for exactly this migration. Loro replaced its `Awareness` API (whole-state sync per client) with `EphemeralStore` (per-key, timestamp-based LWW, with a timeout). That is the same move, and Loro named the destination _ephemeral_.

# Problem Statement

Ship 3.0 with **one** transient binding target, named `ephemeral`, backed by the field-level CvRDT.

Three things stand in the way, in order:

1. **A substrate-name string test in the synchronizer.** `#executeImportDocData` (`packages/exchange/src/synchronizer.ts`) chooses between replacing and merging a headless replica at a reset by comparing `runtime.replicaFactory.replicaType[0] !== "state"`. The compiler cannot see this string, so a rename would flip the comparison silently.

   The guard is unreachable (Phase 1 carries the proof), so removing it changes no behaviour. It goes first regardless: an unreachable name-string test is indistinguishable from a load-bearing one, so leaving it in place makes the later phases unverifiable by inspection.

2. **Deleting `ephemeral` is a behaviour change, not a rename.** Every current `ephemeral.bind()` call site moves from "one-wins" to "both-survive" merge semantics and loses timestamp-based stale rejection. `tests/conformance` declares that difference as a first-class axis (`fieldConcurrency`).

3. **The name `ephemeral` is occupied.** You cannot rename `state` to `ephemeral` while `export const ephemeral` exists. Deletion must come first.

# Success Criteria

- `@kyneta/schema` exports exactly four binding targets: `json`, `ephemeral`, `loro`, `yjs`. `ephemeral` is the field-level CvRDT.
- No production code decides behaviour by comparing a substrate _name_ string.
- The reason a transient CvRDT document never reaches the reset path is a **tested invariant**, not a defensive branch.
- `pnpm test` green at the end of every phase, not only at the end.
- These greps return **zero** matches across the whole repository, including `.md` files: `state.bind(`, `state.replica(`, `stateSubstrateFactory`, `stateReplicaFactory`, `` `state` `` as a binding-target reference, `lwwSubstrateFactory`, `lwwReplicaFactory`, `TimestampVersion`.
- Bare `state` still appears in quantity — `StateTree`, `StateTuple`, `PlainState`, "state management" — and is **not** swept.
- End-to-end, application call sites are byte-identical to their pre-Phase-2 form. `examples/bumper-cars/src/schema.ts` still reads `ephemeral.bind(PlayerInputSchema)`. Any call site that did _not_ return to its original text is a defect or a change that must be named explicitly.

# ✅ Phase 1 — Remove the dead substrate-name guard from the reset path

## Why the guard is dead

The reset block in `#executeImportDocData` fires on `isLineageBoundary || isLegacyReset`. Both disjuncts are always false for a `SYNC_EPHEMERAL` document:

- `isLineageBoundaryOffer` (`synchronizer.ts:280-287`) requires **both** the local and remote lineage to differ from `DEFAULT_LINEAGE`. `StateVersion`, `LoroVersion` (`backends/loro/src/version.ts:48`) and `YjsVersion` (`backends/yjs/src/version.ts:171`) all return `DEFAULT_LINEAGE` unconditionally. Only `PlainVersion` mints a REAL lineage, on its first authored write.
- `isLegacyReset` (`synchronizer.ts:1456-1459`) requires `runtime.syncMode.durability !== "transient"`. `SYNC_EPHEMERAL` is transient.

So `replicaType[0] !== "state"` is never evaluated for a state document. The current behaviour is correct; the guard protects a path nothing can reach.

## Why the remaining branch must stay `fromEntirety`

The block serves **two triggers with different meanings**, and only one of them is what its name suggests:

| Trigger | Can fire for | Meaning | Correct operation |
| --- | --- | --- | --- |
| `isLineageBoundary` | `json` only | identity discontinuity — a serialized writer restarted with no store and minted a fresh lineage | adopt the new identity |
| `isLegacyReset` | `json`, `loro`, `yjs` | same-lineage history gap — the sender compacted past our version | **replace** |

The second is the one that matters here, and it is why `merge()` is wrong. Compaction on an oplog CRDT genuinely rewrites history: `LoroReplica.advance()` exports a `mode: "shallow-snapshot"` and rebuilds the doc via `LoroDoc.fromSnapshot`, and `YjsReplica.advance()` does the projection form of the same thing (`Y.encodeStateAsUpdate` into a fresh `Y.Doc`), because Yjs has no trim primitive at all. A receiver that merges such a snapshot keeps local ops whose causal anchors the incoming state no longer contains. That is exactly what the existing comment means by "ops whose causal anchors were trimmed", and it is correct.

**Constraint:** the replicate arm must not call `replica.resetFromEntirety(...)`. That method exists on `ReplicaLike` (`substrate.ts:399`) and three of its four implementations delegate to `merge`, scoped to the lineage trigger — which never fires for Loro or Yjs. Routing the compaction trigger through them reintroduces the dangling-anchor hazard on relays and stores. See Alternatives Considered.

## Tasks

- ✅ Delete the `if (runtime.replicaFactory.replicaType[0] !== "state")` wrapper and the `// state (replicate mode): fall through` comment. The replicate arm becomes unconditional: `fromEntirety`, dispatch `sync/doc-imported`, return.

- ✅ Replace the two inline trigger computations with one pure classifier, superseding the exported `isLineageBoundaryOffer` (which becomes an implementation detail of it):

  ```ts
  /** Which reset trigger, if any, an inbound offer represents. */
  export type ResetTrigger = "none" | "lineage" | "compaction";

  export function classifyResetTrigger(
    localLineage: string,
    remoteLineage: string,
    isEntirety: boolean,
    senderAlreadySynced: boolean,
    durability: Durability,
  ): ResetTrigger;
  ```

  One function rather than two booleans the shell recombines. This keeps the composition in production code, so a test asserts the outcome instead of re-deriving it; it names both triggers in the type, which is what the block comment needs to refer to; and it makes the unreachability testable without driving the private `#executeImportDocData`. `resolveInboundVersionGap` in the same file already establishes the pure-classifier pattern.

- ✅ Rewrite the block comment to cover: both triggers and what each means, why `fromEntirety` is correct for both, and why a transient CvRDT document cannot arrive here — naming the two facts, since they live in separate files.

- ✅ Correct `packages/exchange/TECHNICAL.md` §"Compaction and lineage boundaries". It currently reads: replicate-mode substrates use `fromEntirety()` "except for `state` (CvRDT), which falls through to `merge()`". Replace with the two-trigger table and the unreachability argument — the section presently documents a special case that does not exist and omits the compaction trigger entirely.

# ✅ Phase 2 — Remove the whole-document LWW substrate

> The gate did its job. Repointing every call site onto `state` surfaced a
> convergence defect that no existing test drove: two peers writing within the
> same millisecond diverged permanently, because `classifyVersionGap` treats
> equal `StateVersion` timestamps as `no-gap` and skips the merge entirely.
> `ephemeral` never had this — `TimestampVersion` is a total order, so a later
> write dominates and heals divergence. Fixed below; the principled version is
> queued rather than rushed.

Delete `ephemeral` and everything only it used. Repoint every call site to `state`. This phase is where the "`state` is a true superset" claim stops being an argument and becomes a passing test run.

**Delete:**

- ✅ `packages/schema/src/substrates/lww.ts` (`timestampVersionStrategy`, `lwwReplicaFactory`, `lwwSubstrateFactory`)
- ✅ `packages/schema/src/substrates/timestamp-version.ts` (`TimestampVersion`)
- ✅ `packages/schema/src/__tests__/timestamp-version.test.ts`
- ✅ `export const ephemeral` and its imports in `packages/schema/src/bind.ts`
- ✅ `TimestampVersion` from the `@kyneta/schema` barrel (`src/index.ts`) and from the `@kyneta/exchange` re-export (`src/index.ts`)
- ✅ `test-ephemeral.ts` at the repository root. This is dead scratch code, not a migration site — it calls `Schema.object(...)` and `json.number()`, neither of which exists. It cannot compile today.
- ✅ The `"ephemeral (whole-doc LWW)"` profile in `tests/conformance/src/profiles.ts`. `conformance.test.ts` iterates `PROFILES` with no count assertion, so removal is safe.
- ✅ The `describe("ephemeral substrate")` block in `packages/schema/src/__tests__/opaque-boundary.test.ts`. **Delete, do not repoint.** Its stated purpose is to contrast a whole-document register against the per-field tree; repointed to `state` it becomes a duplicate of the block directly below it.
- ✅ `it("ephemeral.bind allows .decay()")` in `packages/schema/src/__tests__/state-decay.test.ts`. It pins a silent no-op: the plain substrate has no `tick()`, so decay bound cleanly and never fired.
- ✅ The `describe("ephemeral rejects non-LWW schemas at compile time")` block in `packages/schema/src/__tests__/bind.test.ts`. **Delete, do not repoint** — its six rejections and two acceptances are a strict subset of `bind-constraints-state.test.ts`, which additionally covers CRDT-in-a-record-item and `.nullable()` not erasing inner laws. Repointing would produce two suites asserting one contract, with the weaker one free to drift. `packages/schema/TECHNICAL.md` §"Composition-law enforcement" already names the `bind-constraints` suites as that contract's home. **Keep** `it("json.bind() accepts counter")` from inside the block — it exercises a different target.
- ✅ `buildUpgrade` from the `@kyneta/schema` barrel (`src/index.ts:519`). It was exported to be shared with `lww.ts`; afterwards its only caller is `plain.ts` itself, leaving a public export with no consumer anywhere in the repository. The function stays — only the barrel re-export goes.

**Repoint to `state`:**

- ✅ `examples/bumper-cars/src/schema.ts` (`PlayerInputDoc`) and the header comment naming the target, plus the comment in `src/client/bumper-cars-app.tsx`
- ✅ `packages/exchange/src/capabilities.ts` — drop `ephemeral.replica()` from `DEFAULT_REPLICAS` and rewrite the doc comment above it
- ✅ `packages/schema/src/__tests__/bind.test.ts` — the sites remaining after the deletion above (the assertion at `replica.factory === lwwReplicaFactory` becomes `stateReplicaFactory`)
- ✅ `packages/exchange/src/__tests__/`: `capabilities.test.ts`, `sync-invariants.test.ts`, `store-integration.test.ts`, `cohort.test.ts`, `integration.test.ts` (including its file-header comment)
- ✅ `tests/integration/src/exchange-websocket/e2e-sync.bun.test.ts`

**Unblock the gate:**

- ✅ `StateVersion.compare` now returns `"concurrent"` unconditionally and never
  `"equal"`. A wall clock describes the document's newest *write*, not its
  *content*, so it cannot answer "do we hold the same state?" — and answering
  it wrongly makes each peer discard the payload that would have reconciled
  them. Merging redundantly is idempotent; skipping wrongly is unrecoverable,
  so this refuses to guess. The cost is that no offer is ever skipped as
  redundant. Answering the question properly needs a digest of the tree, which
  is queued rather than rushed into a rename.
- ✅ `sync-invariants.test.ts` §3 rewritten: it asserted stale *rejection*,
  which `state` does not do. It now asserts convergence — both peers agree on
  every field once traffic settles — which is the invariant that actually
  matters and the one that caught this.
- ✅ `store-integration.test.ts` now asserts the transient contract (writes do
  not survive a restart) rather than the hydrate behaviour the whole-document
  substrate happened to provide.

**Gate:** `pnpm test` fully green before starting Phase 3. A failure here is information — it means `state` is not the superset this plan assumes.

# ✅ Phase 3 — Rename the field-level target to `ephemeral`

Purely mechanical once Phase 1 has removed the name dependency. The rule:

> **The package barrel is the boundary.** Everything exported from `src/index.ts` takes the `ephemeral` name — that is target-facing vocabulary. Everything internal to the substrate implementation keeps `State*` — there "state" means _state-based CRDT_, and it is correct.

- ✅ Rename the three barrel exports: `state` → `ephemeral`, `stateSubstrateFactory` → `ephemeralSubstrateFactory`, `stateReplicaFactory` → `ephemeralReplicaFactory`. This matches `loroSubstrateFactory` / `yjsSubstrateFactory`, a convention the old `ephemeral`-backed-by-`lww*` pairing broke.
- ✅ Rename `src/substrates/state.ts` → `src/substrates/ephemeral.ts`.
- ✅ **Keep** `src/substrates/state-tree.ts`, `StateTree`, `StateTuple`, `StateVersion`, `mergeStateTree`, `extractPlainState`. Add a short why-comment to the `state-tree.ts` header explaining that the name refers to the CvRDT state space, not to a binding target — otherwise the next reader will "fix" it for consistency.
- ✅ Change `replicaType` to `["ephemeral", 1, 0]`. A clean tag: there is no deployed `["state", 1, 0]` to be compatible with. Note the derived `ReplicaKey` in `packages/exchange/src/capabilities.ts` changes from `state:1:ephemeral` to `ephemeral:1:ephemeral`.
- ✅ Rename `src/__tests__/bind-constraints-state.test.ts` → `bind-constraints-ephemeral.test.ts` (it exercises the target's public API). **Keep** `state-decay`, `state-deletion`, `state-records`, `state-sum-atomicity`, `state-lattice` — those drive `ephemeralSubstrateFactory` and the `StateTree` internals, which keep their vocabulary.
- ✅ Update in-file comments as you go. `validateDecayConstraints` in `bind.ts` tells the caller to "Bind this schema via `state` or `ephemeral` instead" — Phase 2 makes that "`state`", Phase 3 makes it "`ephemeral`", and it ends correct without ever being a separate task.
- ✅ While in `packages/exchange/src/runtime.ts`, fix the stale comment on the `typeof substrate.tick === "function"` guard. It says the decay feature "_will_ implement it on the state substrate"; it has. Describe what the guard does now — skip substrates that legitimately have no clock.

**Out of scope, deliberately:** `VersionStrategy<V>` in `plain.ts` drops to a single inhabitant once `lww.ts` is gone, making its generic parameter dead weight. Collapsing it touches the _durable_ `json` substrate — the one place in this effort where a mistake reaches persisted data — so it does not belong in the same change. The now-vestigial `export` keywords on `buildPlainSubstrateFromEntirety` and `buildPlainReplicaFromEntirety` (called only from within `plain.ts` after Phase 2) ride along with that work.

# ✅ Phase 4 — Documentation sweep

Three distinct kinds of prose, worth separating because they need different work:

**(a) Naming the target `state`** — mechanical substitution.

- ✅ `packages/schema/TECHNICAL.md`: the `state` row in the composition-law table; the §"The five binding targets" table and heading (five → four); the §"`ephemeral` vs `state`" subsection, which collapses into a single description; the usage example (`MeshPresence`); every `state` reference under §"Deletion", §"What `.decay()` is", §"Atomic registers in the StateTree". Add `ephemeral` to the _Canonical symbols_ line if absent.
- ✅ `TECHNICAL.md`, `README.md`, `packages/exchange/README.md`, `packages/exchange/TECHNICAL.md`, `examples/bumper-cars/README.md`, `docs/migrations.md`, `docs/migrations-design.md`, `.plans/examples-roadmap.md`.

**(b) Describing the _old_ implementation's behaviour** — semantic rewrite, owed regardless of naming.

- ✅ `examples/bumper-cars/README.md`: "timestamp-based stale rejection at the receiver" is no longer true — `StateVersion.compare` never reports "behind". The tables describing the input doc as whole-document LWW also change.
- ✅ `packages/exchange/README.md` rows describing `ephemeral.bind(schema)` as "Plain substrate + ephemeral broadcast protocol".
- ✅ `ARCHITECTURE.md`: "Primary substrates: plain JS (authoritative, ephemeral)" — plain JS is authoritative only now.
- ✅ `packages/schema/TECHNICAL.md` §"What a `Substrate` is NOT": "an ephemeral substrate has wall-clock-timestamped overwrite" describes the deleted one.

**(c) Release notes for already-completed work** — easy to miss, highest visibility.

- ✅ `CHANGELOG.md`'s `# Unreleased` section already names `state` in five entries (the `StateTuple` third slot, map-delete convergence, `Schema.record` usability, the millisecond-tie fix, and the mixed-version note). 3.0 has not shipped, so these must be rewritten to `ephemeral` or the release documents a target that does not exist in it.
- ✅ Add a `## Breaking` entry for this change itself: one target replaces two; `ephemeral` now merges per field instead of replacing the whole document; `TimestampVersion` and the `buildUpgrade` barrel export are gone.

**Note in passing:** several docs already say "Four named binding targets (`json`, `ephemeral`, `loro`, `yjs`)". Those were written before `state` existed and are stale _today_; this work makes them true again. Verify rather than edit.

**Left alone this round:** `experimental/cast/TECHNICAL.md` and `experimental/perspective/theory/unified-engine.md` (one mention each; `perspective` is excluded from the test filter).

# Tests

Reuse the existing suites; only Phase 1 needs genuinely new coverage.

**Phase 1 — pin the invariant that replaces the branch.** Do not try to drive `#executeImportDocData`; it is a private method on the imperative shell. Test the extracted predicates instead — which is the reason for extracting `isCompactionResetOffer` in the first place.

- ✅ Repoint `packages/exchange/src/__tests__/epoch-boundary.test.ts` at `classifyResetTrigger`. Its five existing lineage-pair cases carry over as `"lineage"` / `"none"` expectations.
- ✅ Add the invariant row: a transient, snapshot-only document with `DEFAULT_LINEAGE` on both sides classifies as `"none"`. This is what replaces the guard, and it fails loudly if someone later gives `StateVersion` a real lineage or drops the transient exclusion.
- ✅ Cover the compaction axes: entirety + already-synced + persistent is the only combination yielding `"compaction"`.

**Phase 2 — existing suites are the gate.** `tests/conformance` is the substrate-unification matrix and already declares `fieldConcurrency` per profile; deleting the `ephemeral` row and watching the rest stay green is the superset proof. `packages/exchange/src/__tests__/integration.test.ts` and `tests/integration/.../e2e-sync.bun.test.ts` exercise real presence sync.

- ✅ No new tests. If a repointed site needs a _new_ assertion to pass, that is a genuine `state` gap and must be recorded rather than papered over.

**Phase 3 — the compiler is the test.** A file rename plus three export renames produce zero behavioural change; `tsc` finds every reference.

- ✅ Confirm the `bind-constraints-ephemeral` suite still fails the build if a `@ts-expect-error` stops suppressing — that suite's assertions _are_ `tsc`, so a silently-unused directive is the failure mode to watch.

**Every phase.** `pnpm test` green. Phase 2's run is a hard gate.

# Transitive Effect Analysis [scratch]

Chains that are not visible from the direct edit:

1. **The reset path serves two triggers, and only one is named.** The block is guarded by `isLineageBoundary || isLegacyReset`, but every comment in and around it discusses lineage, and `resetFromEntirety`'s docstring says "Called exclusively on the lineage-boundary path" — true of the interpret arm, false of the replicate arm. Compaction is the trigger that actually reaches Loro and Yjs, and it is the one the naming omits. Phase 1's comment rewrite is the mitigation, and is load-bearing rather than cosmetic.

2. **Four `resetFromEntirety` implementations are dead code.** `plain.ts:818`, `state.ts:484`, `loro/substrate.ts:774`, `yjs/substrate.ts:645`. The only production caller is the interpret arm at `synchronizer.ts:1546`. Leave them; they satisfy the `ReplicaLike` contract. They must not be reached by pointing the replicate arm at them — for Loro and Yjs that converts a correct replace into an unsafe merge.

3. **`TimestampVersion` → `@kyneta/exchange` → downstream.** It is re-exported from the exchange barrel, so deleting it in schema breaks the exchange's public surface too. Both barrels change together. `synchronizer.ts` mentions `timestampVersionStrategy.logOffset` in a comment only — that comment sits inside the `isLegacyReset` rationale and needs rewording, not deleting, since the transient exclusion it justifies survives.

4. **`DEFAULT_REPLICAS` → `ReplicaKey` space.** Dropping `ephemeral.replica()` removes the `plain:1:ephemeral` key. `plainReplicaFactory` and `lwwReplicaFactory` both declared `replicaType: ["plain", 1, 0]` and were distinguished _only_ by the sync-mode segment of the key. After removal, `plain:1:*` means authoritative alone. Any relay or store that relied on a `plain:1:ephemeral` entry loses the ability to replicate an old-format doc — intended, and nothing is deployed.

5. **`opaque-boundary.test.ts` → substrate coverage.** The `ephemeral` block there exercises the _plain_ substrate's boundary handling. Repointing it to `state` would silently change which code path is under test, because `state.ts:prepare` re-aims writes at opaque registers. Deleting the block preserves intent; `json` still covers the plain path.

6. **bumper-cars → merge semantics.** `PlayerInputDoc` changes from one-wins to both-survive, and loses stale rejection, so a peer now merges and re-broadcasts on every inbound offer at ~20fps. The example's 52 tests are logic/physics only and do not exercise multi-peer sync, so they will not catch a regression here. The integration suites are the real coverage.

7. **`replicaType` rename → persisted store records.** `StoreRecord` carries `replicaType`, so a stored doc under `["state", 1, 0]` would be unreadable. Not a concern: `SYNC_EPHEMERAL` is `durability: "transient"` and nothing is deployed. Recorded because it _would_ matter for a durable substrate.

8. **`SyncModeWireValue` is unaffected.** `packages/exchange/wire/PROTOCOL.md` encodes `0x02 ephemeral` for the _sync mode_, not the substrate name. `SYNC_EPHEMERAL` survives unchanged, so the wire encoding does not move.

9. **`EphemeralLaws` needs no change.** It is already correctly named and is already shared by both targets. Nothing about the law set is being deleted — the field-level target is still LWW, just per-field rather than per-document.

# Resources for Implementation [scratch]

- `packages/schema/TECHNICAL.md` §"Binding a schema to a substrate" — the five-target table, the `ephemeral` vs `state` contrast, and the full `.decay()` / atomic-register / deletion treatment. The single most important document for this work; most of Phase 4(a) is here.
- `packages/exchange/TECHNICAL.md` §"Compaction and lineage boundaries" — both triggers, `canReset` governance, and the cohort mechanism that prevents compacting past a critical peer. Read before touching Phase 1.
- `docs/migrations.md` §6 "T3 recipes — epoch boundaries" — why an oplog CRDT's history can become meaningless, and the fact that `.epoch()` is a marker with no cross-peer orchestration. Context for why compaction resets exist at all.
- `packages/schema/backends/loro/src/substrate.ts` → `LoroReplica.advance` and `packages/schema/backends/yjs/src/substrate.ts` → `YjsReplica.advance` — the shallow-snapshot and full-projection implementations. This is the concrete evidence that compaction rewrites history, which is the whole reason the replicate arm must replace rather than merge.
- `tests/conformance/src/profiles.ts` — the substrate-unification matrix as data. The `fieldConcurrency` axis is the machine-readable statement of what distinguishes the two targets.
- `packages/schema/src/substrates/state-tree.ts` header — explains why atomicity is encoded in tree _shape_ rather than merge logic, which is what keeps `mergeStateTree` schema-blind for headless relays.
- `packages/schema/src/bind.ts` — `createBindingTarget`, both targets, `validateDecayConstraints`.
- `CHANGELOG.md` `# Unreleased` — the five entries needing a rename, and the house style for a breaking-change entry (prose explaining the _why_, not a one-liner).

# Alternatives Considered

**Rename first, then delete.** Impossible: `export const ephemeral` occupies the name.

**One combined commit.** Cheaper — call sites are touched once instead of migrating to `state` and back. Rejected because it fuses a real behavioural change (whole-document → field-level merge on every presence document) with a mechanical rename. If bumper-cars or an integration suite regresses, a combined commit gives no way to bisect which half caused it. Phase 2's green run is also the only place the "superset" claim is actually verified; folding the rename in makes a failure there ambiguous. The double-touch is the price, and the end-to-end diff on call sites nets to zero, which is itself the check.

**Keep `state` and delete `ephemeral`.** Leaves the worse name. "State" is wrong on the axis that matters: it is the one target that is never persisted and whose fields can expire, while "state" is the word application authors use for data that survives. It also collides with the most overloaded identifier in frontend JavaScript, and its real justification — _state-based CRDT_ — is invisible at the call site.

**Other names (`presence`, `live`, `lww`, `transient`).** `presence` over- narrows: the flagship example uses this target for 20fps joystick input, which is not presence, and it names a use case in a namespace that otherwise names mechanisms. `lww` fails to distinguish, since the target being deleted was also LWW. `transient` reads as a warning label rather than a capability. `live` is serviceable but unprecedented, where `ephemeral` matches both this codebase's existing internal vocabulary and Loro's naming for the same design.

## Fixes for the Phase 1 guard

**Declare the answer as a property on `ReplicaFactoryLike`** — a required `lineageResetMode: "replace" | "merge"` that every factory states, replacing the name comparison with a field read. Rejected on two counts. It presumes the correct operation is a property of the _substrate_, when it is really a property of the _trigger_: the same Loro replica wants adopt-identity at a lineage boundary and replace at a compaction gap. And it would add a required field to a public interface — a real burden on third-party substrate authors — to encode a decision that, once the dead arm is removed, no longer needs to be made at all.

**Call `runtime.replica.resetFromEntirety(...)` from the replicate arm**, so it mirrors the interpret arm and the branch disappears entirely. Rejected because it is unsafe. Three of the four implementations delegate to `merge`, and their comments scope that to the lineage trigger — "a lineage boundary never arises for this substrate today — this exists to satisfy the `Substrate` contract". The replicate arm also carries the compaction trigger, which _does_ reach Loro and Yjs, and where merging a shallow snapshot leaves local ops pointing at trimmed history. The result passes every existing test and corrupts headless replicas on relays and stores.
