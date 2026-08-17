fix(schema): repair the state substrate's join, map writes, and delete convergence

# Background

The `state` binding target is a field-level LWW map, meant for decentralised presence — cursors, player positions, session rosters. Peers write to their own keys in a shared document and merge without clobbering each other. `packages/schema/TECHNICAL.md` §"`ephemeral` vs `state`" describes it, and §"Atomic registers in the StateTree" covers how sums and `.json()` blobs are stored.

Its state is a `StateTree`: the document shape, with every leaf replaced by a `StateTuple = [value, timestamp]`. Peers exchange whole trees (the target is `SYNC_EPHEMERAL` — snapshot-only, no op log, nothing persisted) and `mergeStateTree` folds them together. That merge is deliberately **schema-blind**, so a headless relay or store can merge raw payloads without knowing the schema.

Two design points matter for what follows.

**Wall-clock timestamps are intentional.** `Date.now()` under clock skew means an older write can beat a newer one. For realtime presence that is the accepted trade — it is the reason this substrate exists rather than a CRDT with causal metadata.

**`.decay()` is a read-time projection, not a mutation.** `tick(now)` re-projects the tree into the shadow, replacing any leaf older than its `decayMs` with `Zero.structural`. It runs with `projection: true` and `replay: true`: the tree is untouched, the version clock does not advance, nothing is broadcast. Decay removes nothing. It is the rule _"when reading, treat a leaf older than `decayMs` as its zero value"_, and it converges across peers with no communication because every peer applies the same age test to the same stored timestamp.

# Problem Statement

Three defects, in dependency order. The first invalidates anything built on the other two, so the order is forced.

## 1. The merge is not commutative

A CvRDT's join must be commutative, associative, and idempotent. Two of three hold. On a timestamp tie, `mergeStateTree` takes the remote value, commented as _"arbitrarily pick remote to be deterministic"_. Deterministic as a function is not the same as commutative, and commutativity is the property that matters. Measured:

```
A = { v: ["from-A", 1000] }      B = { v: ["from-B", 1000] }
A ⊔ B  →  { v: ["from-B", 1000] }
B ⊔ A  →  { v: ["from-A", 1000] }        converged: false
```

Two peers writing different values in the same millisecond **diverge permanently**. Idempotence and associativity do hold; this is the one law that fails. It is a live bug today, independent of everything below.

## 2. Every map write throws

`applyChangeToStateTree` reads a `MapChange` shape that the change vocabulary has never defined. The real one is:

```ts
export interface MapChange extends ChangeBase {
  readonly type: "map";
  readonly set?: Readonly<Record<string, unknown>>;
  readonly delete?: readonly string[];
}
```

The code reads `.entries`, expecting per-key objects tagged `{type: "set" | "delete"}`. Two sites — `state-tree.ts:399` (root) and `state-tree.ts:457` (nested) — so every map mutation on the substrate throws:

```ts
const doc = createDoc(
  state.bind(Schema.struct({ v: Schema.record(Schema.number()) })),
);
doc.v.set("a", 1);
// TypeError: Cannot convert undefined or null to object
```

`Schema.record` is unusable on `state`, which contradicts the substrate's own header ("containers are limited to structs and maps") and blocks the presence roster use case the target exists for. No test covers a record key write on `state`, which is why it survived.

## 3. Deletion cannot converge

`mergeStateTree` unions keys. A key absent from the remote is left alone, because absence is not representable: "never existed" and "was deleted" look identical. So a delete on one peer is resurrected the moment it merges a peer that still holds the key. Local deletes are visible locally (`syncStateTreeToShadow` prunes absent keys) and never converge.

Any `Schema.record` used as a roster where members leave — players, cursors, sessions — fails to converge removals.

# Success Criteria

- `mergeStateTree` satisfies commutativity, associativity and idempotence, pinned by property tests including the tie case that currently fails.
- `Schema.record` writes and deletes work on `state`, and a delete converges across peers.
- The merge stays **schema-blind**. A headless relay must still merge raw entirety payloads without the schema. This is the constraint that shapes the tombstone design.
- Deleting a key does not grow the tree. A key holds one tuple whether live or deleted, and repeated delete/re-add cycles do not accumulate.
- Registers are unaffected: a write at or inside a sum or `.json()` node is still widened to a whole-value register write, and `tests/conformance` stays green.

# ✅ Phase 1 — Make the join a lattice

Ship alone, before anything else. It fixes a live divergence on its own, and everything below is unsound without it.

- ✅ Break timestamp ties on the value's serialisation: when timestamps are equal, the greater `JSON.stringify(value)` wins. Extract it as a named pure function so the rule is one testable thing rather than an inline comparison.

- ✅ Have the join **select the winning tuple and adopt it whole**, rather than patching `local[0]` and `local[1]` in place as it does today. This is the natural shape once the rule is a function that returns a winner, and it has a consequence Phase 3 depends on: a merge that copies fixed slots silently preserves any slot it does not know about. When the tuple grows a third element for tombstones, a _losing_ tombstone would keep its marker sitting on top of the winning value, and the key could never be re-added. Adopting wholesale makes the merge indifferent to how many slots a tuple has, so the tombstone work needs no merge change at all.

- ✅ Note in a comment why serialisation comparison is safe here, because it looks fragile and is not. Two peers may serialise an equal object with different key order, but both sides compare _the same pair of strings_, so they still agree. String comparison is a total order, so associativity holds across three or more tied peers. Values are JSON-safe by construction — the wire format is `JSON.stringify(tree)`.

- ✅ Note the semantic plainly: on a tie the greater value wins, not the later writer. A tie _is_ simultaneity; there is no later writer to prefer. Only the equal-timestamp path pays the `stringify`.

- ✅ ~~Leave the type-mismatch fallback (tuple merged against container) as it is.~~ **Changed during implementation.** It was still "remote always wins", which is the identical non-commutative defect this phase fixes for tuples, and Phase 3 briefly made the branch reachable from normal operation. It now compares on the newest timestamp anywhere in the subtree, which is commutative. It is deliberately NOT associative and is not claimed to be — the losing side's contents are discarded, so no later merge can recover them — and Phase 3's final design keeps well-formed peers out of it entirely.

# ✅ Phase 2 — Make map writes work

- ✅ Read `change.set` and `change.delete` per the real `MapChange` at both sites. Note `delete` is an array of keys, not instruction objects, so the loop shape changes.

- ✅ Fix the nested site's second defect: it currently replaces a register tuple with `{}` before writing entries. The register widening added in the opaque-boundary work means map changes at a register no longer reach here, but the line is still wrong and would fire again if that widening were ever bypassed.

- ✅ Implement `delete` as a plain local removal in this phase, and say in a comment that it does not yet converge. Records become usable without smuggling in the lattice change, and Phase 3 is then a clean substitution rather than a rewrite.

# ✅ Phase 3 — Converge deletion with tombstones

The design's whole point: **`mergeStateTree` does not change at all.** A tombstone is an ordinary register value, so it wins or loses by the Phase 1 rule like anything else. Merge needs no tombstone knowledge, which is what preserves the schema-blind headless-relay property.

That only holds because Phase 1 made the join adopt the winning tuple whole. A merge that patched fixed slots would carry a losing tombstone's marker forward onto the value that beat it — which is why that task sits in Phase 1 rather than here.

- ✅ Widen the tuple to `[value, timestamp, deleted?]`, where a third element marks a tombstone. The marker must be **out-of-band from the value domain**: `null` is a legitimate value under nullable schemas, and any in-band sentinel (a magic string, a marker object) collides with something a `.json()` blob could legitimately contain. A third slot cannot be mistaken for a value.

- ✅ Reduce `isStateTuple` to `Array.isArray(node) && typeof node[1] === "number"`, dropping the arity check rather than relaxing it to "2 or 3". The module header already states the real invariant: sequences are not a supported container on this substrate, so **any** array in a StateTree is a leaf. `length === 2` never encoded that. The `typeof` check already rules out arrays too short to hold a timestamp, so the arity clause contributes only an upper bound — on the one aspect of the shape that is changing. Keeping it as an arity test means editing this guard again for every future slot.

- ✅ Write a tombstone on `delete` instead of removing the key, and teach `extractPlainState` to project a tombstoned key as absent.

- ✅ State the semantics in a comment: concurrent add and remove resolve **by timestamp**, so a later add beats an earlier delete and vice versa. That is LWW-Element-Set behaviour, correct for a target advertising `lww-per-key`, and deliberately _not_ an observed-remove set where a concurrent add always wins. Someone reading "tombstone" will assume OR-Set semantics unless told otherwise. For presence this is the behaviour you want: a peer rejoining after removal reappears.

- ✅ Record the memory bound, and record that no collection mechanism is being built. Deleting replaces a tuple rather than adding one, and re-adding replaces it back — modelled over 500 alternating delete/add cycles, the tree holds one tuple. The tree is bounded by the set of keys ever written, which is the bound it had when nothing was ever deleted. The only cost is that a _currently deleted_ key stays present as a tombstone where it would otherwise be absent.

- ✅ Also record the constraint, so it is not rediscovered: if bounding this ever did matter, `.decay()` cannot be the mechanism. Decay never mutates the tree. Collection would need a real tree mutation with its own safety argument, and on a snapshot-only log-free CvRDT that means causal stability, which is not available. See Alternatives.

# ✅ Phase 4 — Documentation

- ✅ `packages/schema/TECHNICAL.md` §"`ephemeral` vs `state`" describes the merge as "Highest T wins" with no mention of ties. State the full rule: highest timestamp, then greater value rank. The tie case is the one a reader will hit in production and not in testing.

- ✅ Same section — document deletion. It currently describes writes only, and a reader has no way to learn that a delete on a record converges, or by what rule. Include the LWW-versus-OR-Set distinction.

- ✅ §"Atomic registers in the StateTree" — `StateTuple` is described as `[value, T]` throughout. Update for the third slot and say what it is for.

- ✅ Add a short subsection on what `.decay()` is, because it is easy to misread and this plan turned on getting it right: a read-time projection that removes nothing, converging without communication because every peer applies the same age test to the same timestamp. Say explicitly that it is not a deletion mechanism and does not interact with tombstones.

- ✅ CHANGELOG entry under `@kyneta/schema`: the divergence fix, records becoming usable, and converging deletes. The first is the one to lead with — it is a silent correctness bug that existed for any two peers writing in the same millisecond.

- ✅ No README change. `state` appears there as a binding target; none of this changes how it is bound or used.

**Comments.** Why, not what. Three carry real weight:

- ✅ The tie-break — why comparing serialisations is sound, since it reads like a hack and the failure it prevents is invisible.
- ✅ The tombstone marker — why it must sit outside the value domain, naming `null` and nullable schemas as the concrete reason.
- ✅ `mergeStateTree` — that it deliberately knows nothing about tombstones, and that this is what keeps headless relays working.

# Tests

Reuse `packages/schema/src/__tests__/state-sum-atomicity.test.ts` (tree-inspection helpers, `exportEntirety` access) and `state-decay.test.ts`.

- ✅ **Lattice laws as property tests** over `mergeStateTree`: commutativity, associativity, idempotence. Include the tie case explicitly — it is the one that fails today, and a generator that never produces equal timestamps would miss it entirely.
- ✅ **Record writes work** — set, overwrite, multiple keys, on a bare `Schema.record`. Currently throws.
- ✅ **Delete converges.** Peer A deletes, peer B has not seen it, merge both directions, both read the key as absent. Assert on the **exported tree** as well as the document: the substrate serves local reads from a shadow, so a document-level assertion can pass while replicated state is wrong. That trap is documented in §"Atomic registers in the StateTree" and has caught this substrate before.
- ✅ **Delete then re-add.** A deletes at t=10, B re-adds at t=11 → the key is live with B's value on both peers, and the tree holds one tuple. Then the reverse order → absent. This is the case that distinguishes LWW from OR-Set semantics, so it is worth pinning as a semantic decision rather than an accident.
- ✅ **Churn does not accumulate.** Many delete/add cycles on one key leave one tuple.
- ✅ **Registers still work** — `state-sum-atomicity.test.ts` passes unchanged, and `tests/conformance` stays green on all five profiles.
- ✅ **`lastUpdated` on a tombstoned key** returns the delete's timestamp rather than throwing or returning null. See Transitive Effects.
- ✅ **Full `npm run verify`.** Backends and the conformance suite resolve `@kyneta/schema` to `dist/`, so `SKIP_BROTLI=1 npm run build` must run first or they silently report the old behaviour.

# Transitive Effect Analysis [scratch]

**Tuple shape → `lastUpdated`.** `packages/schema/src/facade/last-updated.ts` walks the tree and reads `tuple[1]` via `isStateTuple`. A 3-element tuple still passes the guard once widened, and `tuple[1]` is still the timestamp, so it keeps working — but the _semantics_ deserve a decision rather than an accident. A tombstone's timestamp is a real "last updated" (the key was last changed when it was deleted), so returning it is right. Worth a test because it is the only consumer of the tuple shape outside `state-tree.ts` and `state.ts`.

**Tuple shape → the wire.** Trees are exchanged as `JSON.stringify(tree)`, and a 3-element array serialises and parses with no format change — so nothing on the transport needs touching. It is not *readable* by a 2.x peer: the old guard rejects a 3-tuple on arity, the merge then routes it into the type-mismatch fallback, and `extractPlainState` walks it as a container and projects `{0: value, 1: timestamp, 2: true}`.

This ships in **3.0.0**, where mixed-version `state` sync is out of contract, so no staged rollout or compatibility shim is required. Two supporting facts make that cheap rather than merely permitted: `state` is `SYNC_EPHEMERAL`, so nothing is persisted to be migrated, and mixed-version peers already cannot sync a `state` document across the `ephemeral`→`state` migration described in the project's planning notes. Belongs in the CHANGELOG's breaking-change list rather than being discovered.

**Merge → `@kyneta/exchange`.** `packages/exchange/src/__tests__/state-integration.test.ts` drives `state` through the real sync path. The tie-break changes which value wins in a race, so if that suite happens to construct same-millisecond writes its expectations may shift. Check it rather than assume; a test that passed by accident under "remote wins" is exactly what the fix invalidates.

**Merge → registers → `tests/conformance`.** The conformance suite asserts that a concurrent variant switch resolves to one coherent variant. A sum is stored as a single register, so the tie-break now decides which variant survives a same-millisecond switch. Coherence is preserved either way — a register is replaced whole — but the _winner_ may change, and the suite compares peers to each other rather than to a fixed value, so it should stay green. Confirm.

**Delete semantics → `syncStateTreeToShadow`.** It currently prunes keys absent from the plain value, which is how a local delete reflects locally today. Once deletes become tombstone writes, that pruning path and the tombstone path must agree, or a whole-value `.set()` that omits a key will silently disagree with an explicit delete of the same key.

**Not affected: sequences.** `applyChangeToStateTree` has no case for `SequenceChange`, so pushes onto a bare `Schema.list` are silently dropped. That is a separate defect, out of scope here — see below.

# Resources for Implementation [scratch]

- `packages/schema/src/substrates/state-tree.ts` — `mergeStateTree` (the tie-break), `applyChangeToStateTree` (both `MapChange` sites), `isStateTuple`, `extractPlainState` / `extractInto` / `isExpired` (the decay projection), `syncStateTreeToShadow`.
- `packages/schema/src/substrates/state.ts` — `prepare` (register widening), `tick` (the decay projection, and proof it never mutates the tree).
- `packages/schema/src/change.ts` — the real `MapChange`, and `mapChange()`.
- `packages/schema/src/facade/last-updated.ts` — the only tuple-shape consumer outside the substrate.
- `packages/schema/TECHNICAL.md` — §"`ephemeral` vs `state`" and §"Atomic registers in the StateTree", including the warning about asserting on the tree rather than the document.

# Out of scope

**Sequence changes are dropped silently on `state`.** `applyChangeToStateTree` branches on `replace` and `map` only, so a push onto a bare `Schema.list` updates the shadow and never the tree — local reads stay correct while replicated state diverges. Untouched here because it is gated on a contract question this plan does not settle: `state-tree.ts`'s header says containers are "limited to structs and maps", yet `state.bind` accepts `Schema.list`, `Schema.record` **and** `Schema.text`. Whether sequences get real handling or a bind-time rejection changes what the fix is. Fixing map writes (Phase 2) moves the implementation _toward_ the stated contract, so this plan narrows the gap rather than widening it.

**Removing the `ephemeral` binding target.** Map/record behaviour is the gating item for that decision, and this plan closes it — but the removal itself is separate work with its own wire-compatibility questions.

# Alternatives Considered

**Break ties with a peer ID instead of the value.** The conventional LWW register uses `(timestamp, peerId)` lexicographic order. Rejected: `StateTuple` carries no peer ID, so this needs a fourth slot and a way to thread the writing peer's identity into every leaf. Value rank needs no new state and no plumbing, and gives the same total order. The peer-ID version is "an arbitrary peer wins"; value rank is "an arbitrary value wins". Neither is more principled, and one is much cheaper.

**Leave ties alone as "vanishingly rare".** Rejected on measurement: a tie is one `Date.now()` millisecond, and presence traffic is exactly the workload that produces bursts of same-millisecond writes from multiple peers. The failure is also silent and permanent — two peers simply hold different values forever, with no error and no convergence. That is the worst failure profile a CRDT can have.

**Represent a tombstone as a value, not a tuple slot.** A magic string, or a marker object like `{__tombstone: true}`. Rejected: `state` stores `.json()` blobs as opaque register values, so any in-band marker is something a user's blob could legitimately contain. `null` is worse — nullable schemas make it a real value. A third tuple slot is outside the value domain by construction.

**Garbage-collect tombstones, keyed on decay.** This was the original fix direction and it is a category error twice over. Decay is a read-time projection that never mutates the tree, so it cannot collect anything. And a refinement of the form "drop a tombstone once older than `decayMs`" is the same error dressed up — dropping _is_ a tree mutation.

More importantly, there is nothing to collect. Deleting replaces a tuple rather than adding one, so tombstones accumulate per _key_, not per operation, and the tree is bounded by the key space in use. The phrase "tombstone garbage collection" is imported from CRDTs where deletes really do accumulate unboundedly; here they do not.

**Observed-remove (OR-Set) semantics for deletion.** A concurrent add would always beat a remove regardless of clock. Rejected: `state` advertises `lww-per-key`, and OR-Set requires per-element causal metadata that a snapshot-only substrate does not carry. LWW is also the better fit for presence — if a peer is removed and rejoins, whichever happened later should win.


# Deviations from the plan [scratch]

Recorded so the next reader is not misled by a plan that reads as if it were followed exactly.

**Deleting a container-valued entry tombstones its leaves, rather than replacing the subtree with one tombstone tuple.** The plan did not distinguish the two. The single-tuple form was implemented first and broke associativity, caught by the tree-level lattice tests: a leaf beating a container discards the container's contents, so `(L ⊔ B) ⊔ C` and `L ⊔ (B ⊔ C)` disagree. Tombstoning leaf-by-leaf keeps every node's shape stable, which confines the join to leaf-against-leaf where it is provably a lattice. This is why the type-mismatch fallback above changed too.

**Projection needed a third piece of state.** `extractInto` now reports whether a subtree should appear at all, tracking "has a live leaf" separately from "has a tombstone". Without the distinction a legitimately EMPTY record would project as absent rather than as `{}`, because both have no live leaves.

**The `lastUpdated` test asserts something narrower than planned.** The plan called for `lastUpdated` on a tombstoned key to return the delete's timestamp. That case is unreachable: `doc.peers.at("alice")` resolves against the projected shadow, where a deleted key is absent, so it returns `undefined` and there is no ref to pass. This is not a regression — the key was equally unreachable under the old local-removal behaviour. What is tested instead is the reachable question: a container reports the delete as its last update, and a live key still reads correctly through the widened tuple.

**A guard was added that the plan did not ask for.** A map change aimed at an atomic register now throws instead of silently decomposing it, keyed off the schema so it also catches a register not yet written. Phase 2 called only for fixing the `{}`-clobbering line.
