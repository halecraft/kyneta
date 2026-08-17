refactor(schema): derive the container and boundary predicates from one storage classification

# Background

Every schema node has to be placed in one of three storage categories before it can be written to a substrate:

- **container** — it gets its own CRDT container in the parent (a product, a map, a text type).
- **opaque composite** — it _could_ be descended into, but the substrate stores the whole subtree as one plain value. Only two shapes qualify: a `sum` (which is what `.nullable()` expands to) and a `.json()` node.
- **leaf** — a scalar. Nothing to descend into in the first place.

That single decision is consulted from two directions, described in `packages/schema/TECHNICAL.md` §"Two semantic invariants live in `walkPath`, in one place":

- **Writing.** `needsContainer` (`materialize-value.ts`) decides whether `materializeValue` emits a container node or a plain value.
- **Walking.** `isOpaque` (`schema.ts`) decides whether `stepSchema` reports a `boundary` stop, which is how `walkPath` knows to hand the rest of a path over to value-level resolution.

That section states the constraint plainly: the two "answer the same question from opposite directions … so they have to agree." Today they agree by review.

Two further facts frame what follows.

**The eager policy.** `materializeValue` takes an `EagerPolicy` controlling how aggressively it pre-creates containers for schema-declared fields that are _absent_ from the value being written. `"leaf-containers"` (Yjs) creates only leaf containers — text and richtext — which need a stable container for later mutation. `"all-containers"` (Loro) is documented as creating those **and also** structural containers, because Loro requires a container to exist before a nested write can land on it.

**`richtext` is dual-natured.** `packages/schema/TECHNICAL.md` §"Interpreter duplication families" notes that "`text` and `richtext` straddle two families" — indexed for writing, leaf for reading, navigation and changefeed. That ambiguity is almost certainly how the defect below was introduced.

# Problem Statement

## 1. `needsContainer` gives the wrong answer for `richtext`

`needsContainer`'s own docstring defines it as _"whether a schema position is stored as its own CRDT container (vs. a plain value in the parent)."_ A `richtext` node **is** its own CRDT container — a Loro or Yjs text type carrying formatting marks. The function returns `false`, because `richtext` is missing from its `switch` and falls through to `default`.

The comment beside it excuses the omission:

> `richtext` is excluded here (it is not gated through this predicate)

That is not true. `shouldEager` gates `richtext` through `needsContainer` whenever the policy is `"all-containers"`. So the code carries a documented invariant that the code itself violates.

**The visible consequence is that `"all-containers"` is not a superset of `"leaf-containers"`**, contradicting both the names and the phrase "and also" in the policy's own documentation. Measured across all twelve schema shapes by materializing a struct whose fields are all declared-but-absent:

```
all-containers  → ["text"]
leaf-containers → ["text", "richtext"]
```

Every other divergence between the two policies runs the expected direction. `richtext` is the only shape present in the smaller policy and missing from the larger one.

The practical effect is that Loro does not pre-create a container for a declared-but-absent `richText` field. That turns out to be harmless — Loro creates the container lazily on first mutation, deterministically per path — but it is harmless by luck rather than by design, and it is invisible: nothing in the repository writes a `richText` field on a document, so no test could have caught it.

## 2. One storage decision is carved three different ways

The category above is re-derived in three places, in three shapes that must be compared by hand to check they agree:

| location | how it is expressed |
| --- | --- |
| `isOpaque` (`schema.ts`) | explicit disjunction: `.json()` **or** `sum` |
| `needsContainer` (`materialize-value.ts`) | a `.json()` short-circuit, then a `switch` whose `default` silently catches `sum` |
| `materializeValue` (`materialize-value.ts`) | a `.json()` short-circuit, then per-kind dispatch with `sum` routed to a plain node |

Nothing enforces that these three stay aligned. `packages/schema/TECHNICAL.md` §"Why one traversal, not many" records what happened the last time a rule in this area lived in prose rather than in code: three hand-rolled path walkers each learned a different half of the boundary rule, and each shipped a different bug from the same missing case. That section's conclusion is the relevant one here — **a stated invariant is not an enforced one.**

Defect 1 is what that looks like in practice. The `switch` in `needsContainer` and the disjunction in `isOpaque` disagree about `richtext`, and the disagreement survived because no single place had to state the classification once.

# Success Criteria

- One function assigns every schema node its storage category. `needsContainer` and the opaque-boundary predicate are both thin derivations of it, with no independent logic.
- `richtext` classifies as a container, so `needsContainer`'s docstring becomes a true statement about its behaviour.
- `"leaf-containers"` is a strict subset of `"all-containers"` for every schema shape.
- A declared-but-absent `richText` field is writable and converges across peers on both CRDT backends, asserted by test rather than assumed.
- `npm run verify` passes with no test file modified except the ones this plan adds.

# Revision Stack

Three jj revisions, in order. Each builds and passes `npm run verify` on its own.

| # | revision | phase |
| --- | --- | --- |
| 1 | `fix(schema): classify richtext as a container` | Phase 1 |
| 2 | `refactor(schema): derive needsContainer and isOpaqueBoundary from one storage classification` | Phase 2 |
| 3 | `docs(schema): record the single storage classification` | Phase 3 |

Revision 1 is the only behavioural change and is deliberately alone, so revision 2 can be judged purely on whether it preserves behaviour — its correctness criterion is _no existing test is modified_. Revision 1 must precede revision 2: if the consolidation landed first it would have to encode `richtext` as a leaf to preserve behaviour, baking the falsehood into the abstraction meant to eliminate it.

This plan sits between two others. **PLAN-2026-08-02-retire-advance-schema** should land before it, because that plan only removes code and leaves a smaller `schema.ts` for this one to add to. **PLAN-2026-08-02-bind-time-validation** depends on this plan for `isOpaqueBoundary` and lands after.

# ✅ Phase 1 — Correct the `richtext` classification

Lands first and alone, because it is the one behavioural change in this plan. Isolating it means the consolidation that follows can be judged purely on whether it preserves behaviour.

**Amended during implementation: this is two fixes, not one.** Correcting the classification makes the eager path *fire* for `richtext`, and the node it then produces is one the backend realizers cannot build a container from. Both halves are needed, and the second only surfaced because the load-bearing test below was written first. Each was confirmed necessary by removing it and watching the same two tests fail.

- ✅ Add `richtext` to the `true` branch of `needsContainer`'s switch, joining `text`, `counter`, `movable`, `tree`, `set`, `product`, `map`, `sequence`.

- ✅ **Give `materializeValue`'s `richtext` branch a structural-zero default**, as its neighbours already have: `text` substitutes `""` for a missing value and `counter` substitutes `0`, while `richtext` passed `value` straight through. Once the eager path reaches it, an omitted field arrives as `undefined`, and the realizers guard on `typeof value === "string"` / `Array.isArray` — so neither branch fires, no diff is emitted, and the container is never created. The write that follows then panics inside Loro's WASM with `called Result::unwrap() on an Err value: Text([Replace ...])`. `value ?? []` matches `Zero.structural` for a rich-text node.

- ✅ Delete the "not gated through this predicate" sentence from `needsContainer`'s doc comment. It was never accurate, and leaving a corrected classification beside the excuse for the old one is worse than either alone.

- ✅ Replace it with the reason `richtext` is easy to get wrong: it is a container for _storage_ purposes while behaving as a leaf for reading and navigation. Cross-reference `packages/schema/TECHNICAL.md` §"Interpreter duplication families", which already documents that dual nature.

- ✅ Add the regression tests described under "Tests". The property that makes this change safe — that a declared-but-absent `richText` field works on both backends, eagerly created or not — is currently asserted nowhere.

# ✅ Phase 2 — One classification, two derived predicates

No behavioural change. Every existing test must pass untouched; that is the check that this phase is correct. **Confirmed: the revision touches two source files and no test file, with `npm run verify` green.**

- ✅ Add `storageClass(schema): StorageClass` to `packages/schema/src/schema.ts`, alongside the existing `isOpaque`. It belongs in the grammar module because the category is a property of the schema node, and the import direction already runs `materialize-value.ts` → `schema.ts`.

```ts
export type StorageClass = "container" | "opaque-composite" | "leaf";
```

The assignment, after Phase 1, has no ambiguous cell:

| class | kinds |
| --- | --- |
| `container` | product, map, sequence, set, tree, movable, text, richtext, counter |
| `opaque-composite` | any `.json()` node, sum |
| `leaf` | scalar |

- ✅ Redefine `isOpaque` as `storageClass(schema) === "opaque-composite"`, and export it under the name `isOpaqueBoundary` to match the surrounding vocabulary — `findOpaqueBoundary`, `OpaqueBoundaryHit`, and `walkPath`'s `boundary` stop all name the same idea. Keep it **package-internal**: exported from `schema.ts`, not re-exported from `index.ts`.

- ✅ Redefine `needsContainer` as `storageClass(schema) === "container"`. Keep it in `materialize-value.ts` and keep it exported from `index.ts`, so the public surface does not move.

- ✅ Leave `materializeValue`'s own per-kind dispatch alone. It does more than classify — it builds a differently-shaped node per kind — so collapsing it into `storageClass` would replace a readable switch with a switch plus a lookup. Add a comment noting that its `.json()` and `sum` branches must stay consistent with `storageClass`, and that `storageClass` is the definition if they ever appear to disagree.

- ✅ Record in a comment on `storageClass` why the subset relation matters: `"leaf-containers"` selects a subset of what `"all-containers"` selects, and that relation now holds because both are expressed against one classification rather than two switches that happened to line up.

# ✅ Phase 3 — Documentation

- ✅ `packages/schema/TECHNICAL.md` §"Value materialization — the write-side unfold" — this section describes `EagerPolicy` and says the two backends "genuinely differ." Add that `"leaf-containers"` is a strict subset of `"all-containers"`, and that both are now expressed against one classification so the relation holds structurally.

- ✅ `packages/schema/TECHNICAL.md` §"Two semantic invariants live in `walkPath`, in one place" — this section currently says the write-side and walk-side predicates "have to agree." Update it: they no longer _have to_ agree, because they are now the same function asked two different questions. This is the substantive doc change in the plan, and it is worth being explicit that the constraint was retired rather than restated.

- ✅ `packages/schema/TECHNICAL.md` §"Interpreter duplication families" — the "`text` and `richtext` straddle two families" note is the closest thing to an explanation of how the `richtext` defect arose. Add one line: for _storage_ classification they are both plainly containers, and the straddle applies to the interpreter families only.

- ✅ CHANGELOG entry under `@kyneta/schema`: a **fixed** entry for `needsContainer(richtext)`, describing the eager-creation consequence and noting that no user-visible behaviour changes, because Loro creates the container lazily and converges either way.

- ✅ No README change. `packages/schema/README.md` §"Schema types" already documents `Schema.richText({ bold: { expand: "after" } })` with its required marks argument, and `needsContainer` is not user-facing vocabulary.

**Comments.** Why, not what. Three carry weight:

- ✅ On `storageClass` — that it is the single definition, and which two predicates derive from it.
- ✅ On `richtext`'s classification — why a node that reads like a leaf is stored as a container.
- ✅ On `materializeValue`'s retained dispatch — that `storageClass` is authoritative if the two ever look inconsistent.

# Tests

Reuse `packages/schema/src/__tests__/materialize-value.test.ts` for the pure-IR assertions, and the two-peer pattern in `packages/schema/backends/loro/src/__tests__/discriminated-union.test.ts` (`loroSubstrateFactory.create` → `exportEntirety` → `merge`) for the convergence test.

Note that `Schema.richText(marks)` **requires** a `MarkConfig` argument. Calling it bare produces a schema whose `marks` is `undefined`, and `bind()` then fails with `Cannot convert undefined or null to object` — an unrelated failure that is easy to mistake for the behaviour under test.

- ✅ **Eager-policy subset property** — materialize a struct with one field of every schema kind, all declared-but-absent, under both policies. Assert that the `"leaf-containers"` result is a subset of the `"all-containers"` result. This is the property that failed, expressed directly rather than as a list of per-kind expectations, so it keeps holding as kinds are added.
- ✅ **`richtext` and `sum` classify correctly** — extend the existing case at `materialize-value.test.ts:187` (`"needsContainer follows structural kind, excludes json-boundary"`), which already covers struct, text, string and `.json()`. Add `richtext` → `true`, the change this phase makes. Add `sum` → `false` while the file is open: nothing currently asserts it, and it is load-bearing far beyond this plan — a `sum` answering `false` is what makes a register store as ONE tuple, which is what lets `mergeStateTree` stay schema-blind for headless relays.

- ✅ **A declared-but-absent `richText` field is writable on both backends.** Write a _sibling_ field without mentioning the richtext field, then insert into the richtext field and read it back. Run against Loro and Yjs. Both suites already have an `eager-write-coherence.test.ts`, which is the right home.

  **This test is the only evidence that Phase 1 is safe, and it must not be dropped as redundant.** A passing `npm run verify` proves nothing here: no test in the repository writes a `richText` field on a document, so the code path this phase changes is currently unexecuted by the suite.

  It earned that description immediately: writing it is what exposed the second half of the fix. With only the classification corrected, the test panics inside Loro's WASM, because the eager path now produces a rich-text node carrying `undefined` and the realizer cannot build a container from it. See Phase 1's amendment.

  Cover the nested-struct form specifically: `w.inner.set({ title: "x" })` on a struct that also declares `body: richText(...)`, then `w.inner.body.insert(0, "zz")`. That is the shape that actually fires the eager path, because a whole-value set of a _nested_ struct is where a declared field can be absent. A root-level `.set({...})` will not do — the CRDT backends reject replacing the root struct outright.

  **A nested leaf container is only writable once its parent struct exists.** Writing `inner.body` on a doc where `inner` was never written fails on Loro for `text` as well as `richtext`, so it is neither new nor specific to this change — but a test that omits the parent write will fail for that unrelated reason and look like a regression. Write the parent first.

- ✅ **…and converges across peers** — two peers from a shared base each insert into that field, then merge both directions and assert they agree. This is what makes lazy container creation safe, and it is the assumption Phase 1's change would otherwise rest on silently.
- ✅ **Every existing test passes unmodified through Phase 2.** That is the phase's correctness criterion, not an incidental check.
- ✅ **Full `npm run verify`.** Backends and the conformance suite resolve `@kyneta/schema` to `dist/`, so `SKIP_BROTLI=1 npm run build` must run first or they silently report the old behaviour.

# Transitive Effect Analysis [scratch]

**`needsContainer` → its call sites.** Three in the repository, all inside `packages/schema/src`: `shouldEager` (`materialize-value.ts`, module-private), and `isDecomposedContainer` plus the atomic-register guard in `substrates/state-tree.ts`. The `richtext` change can only reach the first: `state` rejects `richtext` at compile time, because `positional-ot` is not in `EphemeralLaws`, so neither `state-tree.ts` site can ever see one.

**`needsContainer` → the CRDT backends.** The backends import `materializeValue`, not `needsContainer`. They consume the IR it produces and never classify a schema themselves. So the blast radius of a classification change is the IR's shape, which the tests above cover directly.

**`richtext` eager creation → Loro.** With the fix, Loro pre-creates a container for a declared-but-absent `richText` field where it previously did not. Yjs is unaffected: it binds `"leaf-containers"`, which already creates richtext eagerly.

The full `npm run verify` passes with the change applied, including the Loro suite that the `EagerPolicy` doc comment warns is sensitive here ("a flip to a single policy fails the Loro suite"). **That is necessary but not sufficient, and it would be a mistake to treat it as the safety argument** — nothing in the repository writes a `richText` field on a document, so a green suite is consistent with the changed path never executing.

What was verified directly: writing a nested struct while omitting its `richText` field, then inserting into that field, produces `[{"text":"zz"}]` on Loro. The realizer's richtext branch guards on `typeof value === "string"` and `Array.isArray`, so an absent value falls through both and yields an empty container — which is exactly what eager creation is for. The test named above is what keeps that true.

Also verified unnecessary: two Loro peers concurrently inserting into such a field from a shared base already converge without eager creation. So this restores an invariant rather than fixing an outage.

**`needsContainer` → downstream consumers.** It is exported from `index.ts`, so its behaviour is public. A consumer branching on `needsContainer(richTextSchema)` would see the answer flip. This is a breaking change in principle and belongs in the CHANGELOG, though the correct answer was always `true`.

**Predicate rename → the traversal.** `isOpaque` has one caller, `stepSchema`. Renaming and re-pointing it at `storageClass` touches that call site only. `stepSchema` stays package-internal; nothing about the export policy that keeps it private changes.

`stepSchema` is now covered directly by `src/__tests__/step-schema.test.ts`, including five cases that assert the `boundary` outcome — which is precisely the branch `isOpaque` decides. Phase 2's correctness criterion ("every existing test passes untouched") is therefore a real check on this rename rather than an indirect one.

**Phase ordering.** Phase 1 must precede Phase 2. If the consolidation landed first it would have to encode `richtext` as a leaf to preserve behaviour, which bakes the falsehood into the very abstraction meant to eliminate it — and then Phase 1 becomes a change to the new classification rather than a correction of an old mistake.

# Resources for Implementation [scratch]

- `packages/schema/src/materialize-value.ts` — `needsContainer` and its doc comment, `shouldEager`, the `EagerPolicy` type and its rationale, and `materializeValue`'s per-kind dispatch.
- `packages/schema/src/schema.ts` — `isOpaque` (module-private, around line 1162), `stepSchema` and the comment explaining why it stays package-internal, `isJsonBoundary`.
- `packages/schema/src/fold-path.ts` — `findOpaqueBoundary` and `OpaqueBoundaryHit`.
- `packages/schema/src/index.ts` — the export list, which carries `needsContainer` and `isJsonBoundary` but deliberately not `stepSchema`.
- `packages/schema/src/__tests__/materialize-value.test.ts` — the existing `needsContainer` case to extend, rather than a new file.
- `packages/schema/src/__tests__/step-schema.test.ts` — the direct coverage of `stepSchema`'s `descend` / `boundary` split, which guards the Phase 2 rename.
- `packages/schema/backends/loro/src/__tests__/discriminated-union.test.ts` — the two-peer merge pattern (`interpretSubstrate` helper, `exportEntirety`, `merge`).
- `packages/schema/TECHNICAL.md` — §"Value materialization — the write-side unfold", §"Two semantic invariants live in `walkPath`, in one place", §"Why one traversal, not many", §"Interpreter duplication families".

# Out of scope

**Collapsing `materializeValue`'s dispatch into `storageClass`.** It builds a different node shape per kind, so it needs the kind, not just the category. Routing it through the classification would add an indirection without removing a decision.

**Unifying the two eager policies.** The `EagerPolicy` doc comment records that the backends genuinely differ and that a flip to a single policy fails the Loro suite. This plan makes the two policies nest correctly; whether Loro still needs the broader one is a separate question about Loro's container semantics.

**End-to-end `richText` coverage.** The tests here cover the specific property this change depends on. Nothing in the repository exercises a `richText` field on a document more broadly, and `src/__tests__/richtext.test.ts` covers only the instruction algebra. Closing that gap is worthwhile and much larger than this plan.

# Alternatives Considered

**Preserve `needsContainer(richtext) === false` and consolidate around it.** This was the initial recommendation, on the ordinary principle that a refactor should not change behaviour. Rejected once the behaviour was examined rather than assumed. The point of a single classification is that it states the storage model honestly; classifying `richtext` as a leaf to preserve the current answer would bake a false statement into the new abstraction. That trades "two definitions that must agree" for "one definition with a memorised exception," which is a rename, not a consolidation. Behaviour preservation is the right default when the behaviour is correct; here it encodes an error.

**Fix `shouldEager` instead of `needsContainer`.** Special-case `richtext` in the `"all-containers"` branch so the subset property holds, and leave the classification alone. Rejected: it repairs the symptom at one call site while leaving the wrong answer in the shared predicate, where the next consumer will find it. It also adds a second place where `richtext` is handled specially, which is the shape of the original defect.

**Put `storageClass` in `materialize-value.ts` beside `needsContainer`.** Rejected: `schema.ts` already hosts `isOpaque` and is the grammar module, and the storage category is a property of the schema node rather than of the materializer. The import direction already runs `materialize-value.ts` → `schema.ts`, so the reverse placement would need the dependency inverted.

**Remove the dead opaque-boundary API here.** An earlier draft carried it as a phase, on the reasoning that `advanceSchema`, `findJsonBoundary` and `JsonBoundaryHit` share this plan's vocabulary and that removing public API needs a major release. Rejected once the removal was sized: `advanceSchema` had a dedicated 367-line test suite and twelve error strings bearing its name, making it a four-revision change in its own right. That work is done — see PLAN-2026-08-02-retire-advance-schema, which landed before this plan and left a smaller `schema.ts` to add to. Folding it in here would also have destroyed this plan's sharpest correctness signal: that Phase 2 modifies no existing test.
