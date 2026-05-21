# Schema migrations: design rationale and roadmap

This document explains *why* kyneta's migration system is shaped the way it is, and *where* it's heading. It is paired with [`migrations.md`](./migrations.md), the practical how-to. Read this when you want to understand the model or evaluate the framework; read the how-to when you have a schema change to ship today.

______________________________________________________________________

## 1. What migrations have to solve

A schema is a compile-time artifact that evolves. A deployed system contains peers with heterogeneous schema versions — some upgraded, some not, some partially upgraded through intermediate versions. The migration system's job is to make schema evolution behave correctly under those conditions, where "correctly" means:

1. **No silent data loss.** If a migration will destroy information, the developer is told, statically, which information and where.
1. **No silent semantic degradation.** If a migration will collapse CRDT merge semantics to last-writer-wins, the developer is told.
1. **No silent coordination requirements.** If a migration cannot proceed without coordination across peers, the developer is told.
1. **Maximum uncoordinated freedom.** Migrations that provably can be applied independently by each peer should proceed without any wire negotiation, consent step, or distributed protocol.
1. **Migrations are values, not scripts.** They compose, compare, and hash. They can be reasoned about statically.

Outside the migration system, the only existing answer is to refuse all schema mismatch. The migration system fills in the lattice of behaviors between "refuse all mismatch" and "allow anything."

______________________________________________________________________

## 2. The tier model

Each migration falls into one of four tiers. The tier determines what coordination, if any, is required between peers on either side of it.

| Tier | What changes | Identity | CRDT semantics | Coordination | |------|--------------|----------|----------------|--------------| | **T0** | Adds new structure (field, variant, constraint widening, nullable) | Preserved | Preserved | None | | **T1a** | Renames or moves existing structure | Preserved | Preserved | None | | **T2** | Removes structure (field, variant, constraint, nullable) | Destroys 1 identity per primitive | Preserved on surviving nodes | Developer consent (`.drop()`) | | **T3** | Changes a node's type (retype) or applies an arbitrary transform | Destroys + recreates at same path | Broken — old oplog meaningless under new schema | Epoch boundary; out-of-band reload |

### Tier composition

For a composite migration `m = m_n ∘ … ∘ m_1`:

```
tier(m) = max(tier(m_i))
```

The worst-case component dominates. Compose five T0 migrations with one T3 migration and the result is T3 — the system reports the worst case and requires epoch coordination. This is the law that makes tier composition safe and is what `deriveStepTier` implements.

### Why these specific tiers

The tiers are not arbitrary buckets. They are the equivalence classes produced by intersecting three orthogonal properties of a migration: whether identity is preserved, whether CRDT merge semantics survive, and whether data is destroyed. T0 preserves all three; T1a preserves the latter two; T2 destroys data but preserves CRDT semantics on what remains; T3 breaks CRDT semantics entirely. There is in principle a fifth tier — T1b — for migrations that are structurally bijective on plain values but not CRDT homomorphisms; in the current implementation T1b is collapsed into T3 (see [§7 Roadmap](#7-roadmap)).

______________________________________________________________________

## 3. Why identity is the foundation

The first thing to understand about safe migration is that renames cannot be done at the storage layer. If a rename is implemented as "delete the old key, write the new key," two peers that apply the rename concurrently produce divergent CRDT state, and an old peer still writing under the old key has its writes lost.

The solution is an *identity layer* between schema paths and native storage. Every product-field has an opaque 128-bit identity. The substrate stores state keyed by identity; the schema layer maintains a `schema-path → identity` map (the binding). A rename is purely a binding update — native storage is untouched. Peers at different schema versions end up computing the same identity for the same conceptual node, and their ops converge.

### The git analogy

The scheme is structurally analogous to git:

| Git | kyneta migrations | |---|---| | Blob addressed by content hash | Node addressed by opaque identity | | Working tree maps paths → blobs | Schema binding maps paths → identities | | Commit history records rename | Migration chain records rename | | `git gc` prunes unreachable commits | `.migrationBase(...)` prunes pre-base history | | Two developers reach the same blob hash | Two peers reach the same identity |

The working tree's current-path view is ephemeral and recomputed. The underlying content is stable and durable. The schema binding plays the same role for live state.

### Identity derivation today

In the current implementation, identity is derived purely from `(originPath, generation)` — no substrate-level registry, no persisted anchor. Two peers running the same migration chain in code compute the same identity for the same node without exchanging anything. This is deterministic and free, but it makes unilateral code pruning fragile (see the persisted-registry roadmap item in §7).

______________________________________________________________________

## 4. Background: why lens laws and CRDT commutativity matter

Two algebraic ideas explain why some migrations are easy and others are not. They're worth knowing if you want to predict which category a new migration kind falls into.

### Lens laws

A migration with both an `up` and a `down` function (going forward and backward through the schema versions) is a lens. A lens is *retract* if `down ∘ up = id` — roundtripping a value at the source preserves it. It is a *section* if `up ∘ down = id` — roundtripping at the target preserves it. A lens with both laws is a bijection.

| Has retract | Has section | Class | |---|---|---| | ✅ | ✅ | Isomorphism (fully reversible) | | ✅ | ❌ | Source-faithful (target may add information not in source) | | ❌ | ✅ | Target-faithful (source has information lost going forward — T2) | | ❌ | ❌ | Lossy in both directions |

T0 is the natural shape of a source-faithful migration: the target schema strictly extends the source, and the forward direction is an embedding. T1a is an isomorphism. T2 is target-faithful with explicit acknowledgment.

### CRDT commutativity

Plain-value reversibility is not enough for CRDT substrates. An operation on a state is combined with other operations via the substrate's merge function. For a migration's `up` to be safely applied to streaming ops on the wire, it must commute with merge:

```
up(merge(x, y)) = merge(up(x), up(y))
```

This is the property of being a *CRDT homomorphism*. Renames are CRDT homomorphisms trivially because the merge happens at the substrate level under the stable identity. But a "split this text field into two text fields" transform is not — concurrent edits to the source CRDT cannot be reconciled by applying the split to wire ops. This is the property that forces such migrations into T3.

______________________________________________________________________

## 5. Code pruning

The migration chain grows monotonically. After a project accumulates dozens of steps, you can collapse the historical prefix into a single base manifest via `.migrationBase(...)`. The how-to covers the mechanics; the design question is *when it is safe*.

A migration step can be pruned once:

1. Every live document has been bound at least once under code containing the step. After binding, its identity layer is realized — the step's identity-delta has been applied in deriving the document's binding.
1. Every live peer is on a schema whose `supportedHashes` no longer needs the pre-prune ancestors.

The system cannot verify either condition globally. Pruning too early breaks documents that haven't been bound under the newer code. This is the same operational discipline as pruning database migrations in any production system — kyneta does not invent a new failure mode here, it just inherits the standard one.

______________________________________________________________________

## 6. Non-goals

Things the migration system is deliberately not trying to solve:

1. **Distributed schema-code distribution.** Migrations remain compile-time artifacts. Peers running old code cannot dynamically learn new migrations from peers running new code. Schema deployment is a deploy-time concern, not a runtime protocol.
1. **Verification of user-provided transform proofs.** When a developer passes `{ idempotent: true, crdtHomomorphism: true, bijective: true }` on a `Migration.transform(...)`, the system trusts the attestation. It does not property-test the function.
1. **Cross-substrate migration.** A migration transforms `S₁ → S₂` within one substrate kind. Moving a document from Loro to plain JSON is an unrelated operation handled via `fromEntirety`.
1. **Migration-graph forks.** If development forks produce two chains with no common descendant, peers on the two branches cannot sync. No unification protocol is provided. Monorepo discipline is assumed.

______________________________________________________________________

## 7. Roadmap

The migration system has a working algebra and identity layer but does not yet implement runtime data transformation, full wire-protocol negotiation, or the T1b tier. These are the load-bearing items on the roadmap. They are not commitments to a delivery date — they are the design's intended direction.

### Data-transformation runtime

**`up` / `down` lens functions on migrations.** Each migration would carry pure functions `Plain<S₁> → Plain<S₂>` and an optional inverse, with composition `up = m₂.up ∘ m₁.up`. Today migration primitives are descriptors of intent; the chain records *what changed* but cannot transform a value\* from the old shape to the new. Adding lenses turns migrations into composable values that operate on data.

**`applyMigration(payload, m)`.** A pure function that runs a migration against a persisted payload at hydration time, with no distributed protocol. This is what closes today's biggest gap: T2 and proof-promoted transform cases currently leave data scrubbing to the developer. With `applyMigration` plus lens functions, removing a field actually scrubs the payload, narrowing a constraint actually rejects invalid values, and a proof-promoted transform actually rewrites stored data.

**`DataLossReport` with `StaticLoss` and `RuntimeLoss`.** Structured enumeration of what a T2 migration destroys. *Static loss* is derivable from the migration value alone (which field, which variant). *Runtime loss* requires scanning live documents (which actual records violate a narrowed constraint, which rows have non-null values that will be lost when nullability is dropped). Today `.drop()` is the only loss surface; this would turn acknowledgment into visibility.

**T3 epoch coordination.** An exchange-level primitive that quiesces ops on a document, snapshots its state, applies the migration to the snapshot, and resumes ops under the new schema. The `fromEntirety` substrate primitive already provides the building block; what's missing is the cross-peer orchestration. Today T3 is operational — you reload all clients out-of-band. With coordination it becomes in-band.

### Tier expansion

**T1b as a distinct tier.** Structural bijection on plain-only subtrees (no CRDT-kind descendants) is T1a-equivalent for coordination; on CRDT- kind nodes it degrades to T3. The dispatch is per-affected-node, not per-migration. This lets the system promote, e.g., a "split one plain string field into two plain string fields" to T1a-class behavior automatically while keeping the equivalent on a `Schema.text()` node at T3. Currently anything beyond a pure rename is T3 regardless of node kind.

**`split` and `merge` primitives.** Atomic structural bijections — split one field into N, merge N fields into one. Both would be T1b on plain nodes, T3 on CRDT nodes (per the dispatch above). These cover a refactor pattern that today forces an epoch boundary.

**Backward-walk extension to all invertible primitives.** The walk that builds `supportedHashes` currently inverts only root-level `add`, `rename`, and `move`. Other primitives that are structurally invertible (`addNullable`, `widenConstraint`, `addVariant`, nested-path `add` / `rename` / `move`) halt the walk today. Extending coverage stops the system from conservatively dropping cross-version sync compat that should be supported.

### Wire format and capability negotiation

**Two-layer capability: `readSupports` + `nativeSupports`.** Today a peer advertises a single set of supported schema hashes. The richer model splits the set into two: hashes the peer can *read* (any reachable schema via any direction of any migration in its chain) and hashes it can natively hold\* live CRDT state for (only identity-preserving reachable schemas). The invariant is `nativeSupports ⊆ readSupports`. The distinction matters for the degraded-sync mode below.

**Degraded sync — "honest LWW".** When two peers have no `nativeSupports` intersection but do share `readSupports`, fall back to entirety-payload exchange. No op stream, no CRDT merge semantics, explicit warning. Today the same condition produces "skip sync." Degraded mode would keep documents flowing at lower, explicitly-acknowledged fidelity rather than silently severing the connection.

**"Superior peer adapts" wire translation.** When peer P natively supports a strict superset of peer Q's hashes, P translates outgoing ops down to a hash in the negotiated intersection and up-translates incoming ops before applying locally. This is sound exactly when the migrations bridging the versions are CRDT homomorphisms in both directions (T0, T1a, plain-only T1b). The "adapt" responsibility falls on the superior peer so older peers can remain pinned. Today there is no wire translation — peers must agree on a hash in the meet to talk at all.

______________________________________________________________________

## 8. Where to look next

- **How-to:** [`migrations.md`](./migrations.md) — recipes, gotchas, and reference.
- **Source:** [`packages/schema/src/migration.ts`](../packages/schema/src/migration.ts) — the algebra implementation.
- **Tests:** [`packages/schema/src/__tests__/migration.test.ts`](../packages/schema/src/__tests__/migration.test.ts) — worked examples for every primitive.
- **Schema basics:** [`packages/schema/TECHNICAL.md`](../packages/schema/TECHNICAL.md).
