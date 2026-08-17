fix(schema): pin the state bind contract and reject `.decay()` below an opaque boundary

# Background

`bind()` is where a schema meets a substrate, and it is the only place a schema can be rejected for reasons the type system alone cannot express. Two mechanisms live there:

1. **Composition-law enforcement**, at the type level. Each binding target declares a closed law set, and `target.bind(schema)` applies `RestrictLaws<S, AllowedLaws>`. A schema carrying a law the target does not support resolves to `never`, so the call fails to compile. `packages/schema/TECHNICAL.md` §"Composition-law enforcement" has the table.

2. **`validateSyncModeConstraints`** (`packages/schema/src/bind.ts:555`), at runtime. It walks the whole schema graph and throws if `.decay()` appears under a durable or collaborative sync mode, because decay is a projection of the local shadow and cannot retroactively forget durable history.

Two facts about `.decay()` matter for what follows, both documented in `packages/schema/TECHNICAL.md` §"What `.decay()` is":

- It is a **read-time projection**, not a mutation. `tick(now)` re-projects the tree into the shadow, showing any leaf older than its `decayMs` as `Zero.structural`. The tree is untouched.
- It works **per leaf tuple**, by comparing that leaf's stored timestamp against `now`.

The second point is what interacts with opaque boundaries. A `sum` variant or a `.json()` blob is stored by the `state` substrate as **one** leaf tuple holding the whole value, so everything inside it shares a single timestamp. `packages/schema/TECHNICAL.md` §"Atomic registers in the StateTree" covers why.

# Problem Statement

## 1. `.decay()` below an opaque boundary is accepted and can never fire

A `decayMs` set on a field _inside_ a sum variant or a `.json()` blob has no timestamp of its own to age out — the enclosing register is one tuple. `validateSyncModeConstraints` walks straight into sum variants and `.json()` products and permits it silently. Verified against the current tree:

```
decay ON a sum (the register itself)   → accepted   (correct: whole variant decays)
decay INSIDE a sum variant             → accepted   (wrong: can never fire)
decay INSIDE a .json() blob            → accepted   (wrong: can never fire)
decay on a plain field                 → accepted   (correct)
```

The failure is silent and local-only in the worst way: nothing throws, nothing logs, and the field simply never decays. This is the same profile as the three sum defects fixed across the 2.3.x line — every test passed the entire time they were live.

## 2. `state`'s bind contract holds by accident

`state`'s type-level contract is correct and always has been. Verified by typechecking against the project config:

```
state.bind(… Schema.list(Schema.number()) …)              → rejected
state.bind(… Schema.text() …)                             → rejected
state.bind(… Schema.list(Schema.number()).nullable() …)   → rejected
state.bind(… Schema.record(Schema.number()) …)            → accepted
state.bind(… Schema.list.json(Schema.number()) …)         → accepted
```

That matches `state-tree.ts`'s header exactly — structs, maps, and opaque registers. **Nothing asserts it.** `packages/schema/backends/loro` and `packages/schema/backends/yjs` each have a `bind-constraints` test suite pinning their accepted and rejected shapes with `@ts-expect-error`; `state` has none.

The cost of that gap is already on the record. Project planning notes filed two `state` defects, one of which asserted that `state.bind` accepts a bare `Schema.list`. It does not. A fix direction was written for handling bare sequences on `state` — work that could never be needed, because a bare `Schema.list` cannot reach the substrate. The compiler had settled the question; nothing had written the answer down where a reader would find it.

# Success Criteria

- `.decay()` below an opaque boundary throws at `bind()` time, with a message naming the fix.
- `.decay()` **at** a boundary (on the sum or `.json()` node itself) still binds and still works — the whole register decays to its structural zero.
- The predicate for "is this node an opaque boundary" has **one** definition in the package, shared by the path traversal and the new validation. No second copy. (Already satisfied by PLAN-2026-08-02-storage-classification, which collapsed three separate carvings of that decision into `storageClass`. When this plan was written the criterion was aspirational; the prerequisite is what made it true, which is why it lands first. This plan's job is to become the second consumer without adding a fourth carving.)
- `state`'s accepted and rejected schema shapes are pinned by a `bind-constraints` suite in the same style as the Loro and Yjs suites.
- No existing schema in the repository is newly rejected.

# Revision Stack

Three jj revisions, in order. Each builds and passes `npm run verify` on its own.

| # | revision | phase |
|---|---|---|
| 1 | `test(schema): pin the state bind contract` | Phase 1 |
| 2 | `fix(schema): reject .decay() below an opaque boundary` | Phase 2 |
| 3 | `docs(schema): document decay placement and the state bind contract` | Phase 3 |

Revision 1 characterises behaviour that is already correct, so it is green on arrival, and revision 2 then adds its cases to an existing suite. Landing them in the other order would mean writing the suite against a contract that had just moved, and the diff would no longer show which line of the contract the fix changed.

**PLAN-2026-08-02-storage-classification** must land first: Phase 2 consumes the `isOpaqueBoundary` predicate that plan creates, and its success criterion — one definition of "is this an opaque boundary" in the package — is only true once that consolidation has happened.

# ✅ Phase 1 — Pin `state`'s bind contract

Lands first and alone. It characterises behaviour that is already correct, so it is green on arrival, and it gives Phase 2 a place to add its cases rather than inventing a suite alongside a behaviour change.

- ✅ Add `packages/schema/src/__tests__/bind-constraints-state.test.ts`. It lives in the core package rather than under `backends/`, because `state` is a core substrate — but it mirrors the structure of `packages/schema/backends/loro/src/__tests__/bind-constraints.test.ts`: a section for accepted shapes, a section for rejected shapes.

- ✅ Cover the accepted shapes: scalars, nested structs, `Schema.record`, a discriminated union, a `.nullable()` struct, and `.json()`-wrapped collections (`Schema.list.json`, `Schema.struct.json`).

- ✅ Cover the rejected shapes with `@ts-expect-error`: bare `Schema.list`, `Schema.text`, `Schema.counter`, `Schema.set`, `Schema.tree`, `Schema.movableList`, and a `.nullable()` list. The last one is worth its line: `.nullable()` does **not** erase inner laws, so wrapping a sequence in it does not smuggle it past the law check — only `.json()` does that, by collapsing the subtree to an inert blob.

- ✅ Note in the file header that `@ts-expect-error` means **`tsc` is the assertion**, not vitest. A `@ts-expect-error` that stops being an error becomes a compile failure. Someone reading a test body that just calls `bind()` and asserts nothing will otherwise assume it is dead weight.

- ✅ Cover `state` only. `ephemeral` is declared as `BindingTarget<EphemeralLaws, PlainNativeMap>` and so is `state` (`bind.ts:503` and `bind.ts:522`) — the _same_ type. What each accepts at compile time is decided by identical type parameters, so a suite comparing them would assert that TypeScript answers one question the same way twice. That tests the compiler, not this package.

# ✅ Phase 2 — Reject `.decay()` below an opaque boundary

## The rule

`decayMs` is legal **at or above** an opaque boundary and illegal **strictly below** one.

- On the sum or `.json()` node itself: legal. The register is one tuple with one timestamp, so the whole variant decays to its structural zero coherently.
- On anything beneath it: illegal. There is no independent timestamp for the projection to test, so the decay can never fire.

## Tasks

- ✅ ~~Export the existing opaque-boundary predicate as `isOpaqueBoundary`.~~ **Already done**, by PLAN-2026-08-02-storage-classification. It lives at `schema.ts:1207` as a one-line derivation of `storageClass` (`schema.ts:1180`), which is now the single definition of how a node is stored. Nothing to create here — import it.

- ✅ ~~Keep it package-internal.~~ **Already done**: exported from `schema.ts`, absent from `index.ts`.

- ✅ Record in a comment why exporting this predicate does not reopen the hazard that keeps `stepSchema` private. **This one is still outstanding.** The existing comment on `isOpaqueBoundary` explains that it is shared "rather than rewriting the disjunction" and that it stays off the public surface — but it never draws the distinction that makes it safe: a *predicate* carries no policy and admits one correct answer, while handing out a single traversal *step* is what makes a divergent walker easy to write. See "Alternatives Considered" for the full argument; the comment should carry the short form.

- ✅ Thread a `belowBoundary` flag through the existing walk in `validateSyncModeConstraints`. It is set when the walk descends _through_ a node that `isOpaqueBoundary` accepts, and it makes `decayMs` an error regardless of sync mode. No second traversal: the function already walks the whole graph with a depth cap.

  Verified against the walk's actual shape before planning: a node's own `decayMs` is checked before the flag is raised for its children, so decay **on** a sum or `.json()` node stays legal while decay on anything beneath it is rejected. The nested case — `decayMs` on a record's item inside a `.json()` blob — falls out of the recursion without a special branch, because the flag propagates through both levels. That is the case the Tests section says to assert rather than assume.

- ✅ **Check the durable rule first, and only reach the boundary check when the sync mode permits decay at all.** A schema can violate both at once, and the two are independent — fixing either still leaves the other — so the tie-break comes from which misunderstanding is larger. Someone binding decay to `json` has misread what `.decay()` is; someone binding it inside a variant on `state` has merely misplaced it. Leading with the smaller correction makes them move the annotation, rebuild, and only then learn the whole binding choice was wrong.

  Nesting the checks also says something true about the rules: "where may decay legally sit" is a refinement that only has meaning on a substrate where decay is legal somewhere. A compound condition (`!isEphemeral || belowBoundary`) flattens two rules that are not peers, and then needs one blended message to serve both.

```ts
const decayMs = (node as { decayMs?: number }).decayMs
if (decayMs !== undefined) {
  if (!isEphemeral) throw new Error(durableMessage) // existing rule, wins
  if (belowBoundary) throw new Error(boundaryMessage)
}
```

- ✅ Give the error a message that names the fix, not just the prohibition. Two sentences of cause, one of remedy — the cause matters because the placement looks reasonable until you know how registers are stored:

  > `.decay()` cannot be set inside a sum variant or a `.json()` blob. The whole value is stored as one register with a single timestamp, so a field inside it has nothing of its own to age out. Move `.decay()` onto the sum or `.json()` node itself if the whole value should decay together.

- ✅ Rename `validateSyncModeConstraints` → `validateDecayConstraints`. It will enforce two rules, both about `.decay()`, and only one of them is a sync-mode constraint. The function is exported from `bind.ts` but **not** from `index.ts`, and has a single production call site (`bind.ts:317`), so the rename costs nothing. Update the section banner comment above it and the depth-cap error string, both of which name the old function.

- ✅ Update the existing doc comment to state both rules. The current one explains only the durable-substrate rule, and explains it well — keep that reasoning and add the boundary rule beside it.

# ✅ Phase 3 — Documentation

- ✅ `packages/schema/TECHNICAL.md` §"What `.decay()` is" — add the placement rule. It currently explains what decay is and that it does not interact with tombstones, but says nothing about where it may be attached. State that decay is per leaf tuple, that a register is one tuple, and that this is why the boundary is the lowest legal position.

- ✅ `packages/schema/TECHNICAL.md` §"Two semantic invariants live in `walkPath`, in one place" — note that the opaque-boundary predicate now has a second consumer outside the traversal. That section already argues the two boundary shapes are one rule because they describe one storage decision; the validator is now a third place that must agree, and the point of exporting the predicate is that it agrees by construction rather than by review.

- ✅ `packages/schema/TECHNICAL.md` §"Composition-law enforcement" — the table lists what each target accepts by law. Add a pointer to the new `state` suite as the executable form of the `state` row.

- ✅ CHANGELOG entry under `@kyneta/schema`, as a breaking change: a schema that previously bound will now throw. Frame it as a bug fix — the binding was accepted and the decay silently never fired — and give the migration in one line: move `.decay()` to the boundary node.

- ✅ No README change. `.decay()` does not appear there, and neither does the bind-time validation surface.

**Comments.** Why, not what. Two carry real weight:

- ✅ On `isOpaqueBoundary`'s export — why a _predicate_ is safe to share when the single-step traversal beside it is deliberately not. One or two sentences; the long form lives in this plan and in TECHNICAL.md.
- ✅ On the `belowBoundary` flag — why a register cannot host a per-field decay, in terms of the one-tuple-one-timestamp storage decision rather than in terms of the rule being enforced.

# Tests

Reuse `packages/schema/backends/loro/src/__tests__/bind-constraints.test.ts` as the structural model, and `packages/schema/src/__tests__/state-decay.test.ts` for the existing decay assertions.

- ✅ **Accepted and rejected shapes for `state`** — Phase 1's suite, as listed above.
- ✅ **Decay at a boundary still binds** — on a `.nullable()` struct and on a `.json()` node. `state-decay.test.ts:53` already builds `Schema.string().nullable().decay(1000)`; that assertion must keep passing unchanged.
- ✅ **Decay below a boundary throws** — inside a sum variant, and inside a `.json()` blob. Assert on the message, not just that it throws, since the message is the deliverable for a user who hits this.
- ✅ **Decay below a boundary throws when nested further** — a `Schema.record` inside a `.json()` blob, with `decayMs` on the record's item. This should fall out of the recursion for free rather than needing its own branch, and the test is what confirms that rather than assuming it.
- ✅ **Decay on a plain field still works end to end** — `state-decay.test.ts` already covers this; confirm it passes unchanged rather than adding a duplicate.
- ✅ **Nothing in the repository is newly rejected** — the only `.decay()` in a schema outside tests is `state-decay.test.ts:53`, which sits _on_ a sum and stays legal. A full `npm run verify` is the check.
- ✅ **Full `npm run verify`.** Backends and the conformance suite resolve `@kyneta/schema` to `dist/`, so `SKIP_BROTLI=1 npm run build` must run first or they silently report the old behaviour.

# Transitive Effect Analysis [scratch]

**Predicate → the traversal.** `isOpaqueBoundary` has one caller today, `stepSchema`. This plan makes `bind.ts` the second. No code moves; the risk is drift of a different kind — a definition consulted from two places is load-bearing in both, so a future change to `storageClass` now has two behaviours riding on it rather than one. That is the intended trade, and `packages/schema/TECHNICAL.md` §"Two semantic invariants" already records it after the prerequisite plan rewrote that section.

**Predicate → `needsContainer`.** Both now derive from `storageClass`, which makes `!needsContainer(node)` look like a usable stand-in for `isOpaqueBoundary(node)`. It is not: `needsContainer` is also false for **scalars**, which are leaves rather than boundaries. For the decay walk the two happen to agree, but only because a scalar has no children to descend into — correct by accident, and wrong the moment anything else consults it. `isOpaqueBoundary` asks the precise question and is what Phase 2 uses.

**Validator rename → callers.** `validateSyncModeConstraints` is exported from `bind.ts` and imported nowhere else in the workspace; the single production call site is `bind.ts:317`. One test comment references it by name (`state-decay.test.ts:124`) and needs updating. It is not in `packages/schema/TECHNICAL.md`'s canonical-symbols list, and not re-exported from `index.ts`, so no public surface moves.

**New rejection → the examples and conformance.** A grep for `.decay(` across `packages`, `examples` and `tests` finds no schema-level usage outside `state-decay.test.ts`. The `bumper-cars` example uses `ephemeral` for player input but does not set `decayMs`. The conformance profiles do not use decay. So the blast radius inside the repository is zero, and the breaking-change note in Phase 3 is for downstream consumers only.

**New rejection → `ephemeral`.** The rule is written against sync-mode-independent storage facts, so it fires for `ephemeral` bindings as well as `state`. That is harmless and consistent: `ephemeral` stores a whole document as one value, so a per-field decay below a boundary is at least as meaningless there. See "Out of scope" for the larger `ephemeral` decay problem this deliberately does not address.

**Phase ordering.** Phase 1 must land before Phase 2. If Phase 2 landed first, Phase 1's suite would be written against a contract that had just moved, and the diff would no longer show which line of the contract the fix changed.

# Resources for Implementation [scratch]

- `packages/schema/src/bind.ts` — `validateSyncModeConstraints` (`:555`), its call site (`:317`), the section banner (`:530`), the depth cap (`:538`), and the `ephemeral` / `state` target declarations (`:503`, `:522`).
- `packages/schema/src/schema.ts` — `storageClass` (`:1180`) and its derivation `isOpaqueBoundary` (`:1207`), which is the predicate to import; `stepSchema` and its "package-internal on purpose" comment (`:1145`), which is the contrast the outstanding comment task has to draw; `isJsonBoundary` (`:55`), the half-boundary predicate that is public and therefore the thing a fourth carving would be written from.
- `packages/schema/src/substrates/state-tree.ts` — the module header's statement of which containers `state` supports, and `isDecomposedContainer` for how `needsContainer` is used on the storage side.
- `packages/schema/backends/loro/src/__tests__/bind-constraints.test.ts` — the structural model for Phase 1, including the `@ts-expect-error` idiom.
- `packages/schema/src/__tests__/state-decay.test.ts` — existing decay coverage; `:53` is the at-a-boundary case that must keep passing.
- `packages/schema/TECHNICAL.md` — §"Composition-law enforcement", §"What `.decay()` is", §"Atomic registers in the StateTree", and §"Two semantic invariants live in `walkPath`, in one place".

# Out of scope

**`.decay()` on `ephemeral` is a silent no-op everywhere, not just below a boundary.** The `ephemeral` substrate has no `tick()` at all, so decay never fires on it at any position — and `state-decay.test.ts` currently asserts that `ephemeral.bind` _allows_ `.decay()`. That is the same bug class this plan fixes: `bind()` accepting something that cannot work. It is left alone because `ephemeral` is slated for removal in favour of `state`, so the fix would be deleted along with the target. Leaving it unremarked would make the new rejection look arbitrary, which is why it is named here.

**Runtime enforcement of the law set.** Phase 1 pins `state`'s contract at the type level, which is where it is enforced. `state.bind` will still accept a bare `Schema.list` from untyped JavaScript, exactly as every other target does. Adding runtime law checks is a separate decision affecting all five targets.

# Alternatives Considered

**Document the restriction instead of rejecting it.** Rejected. The current behaviour is that the binding succeeds and the field silently never decays. A documented restriction leaves that intact and asks every future reader to have read the right paragraph. There is also no legitimate reading of "decay this field inside a register": the only coherent meaning would be action-at-a-distance on the whole enclosing register, which should be written on the register.

**Write the predicate inline in `bind.ts`.** Rejected, and it is the option worth arguing against explicitly, because it is one line and looks obviously correct:

```
isJsonBoundary(node) || node[KIND] === "sum"
```

Both `isJsonBoundary` and `KIND` are public, so this line is always available to write — which is exactly why `isOpaqueBoundary` is exported package-internally: a consumer that needs the notion and cannot reach the shared one will write its own. `packages/schema/TECHNICAL.md` §"Why one traversal, not many" records what happened the last time this rule was duplicated: `findJsonBoundary` learned only the json half, `schemaAtPath` reached for `try/catch`, and each shipped a different bug from the same missing case. The section's own conclusion is that **a stated invariant is not an enforced one**. Writing the disjunction in `bind.ts` would be the same mistake with the same shape, and it would go stale the day a third opaque kind is added — the more so now that `storageClass` exists and a hand-written copy would silently diverge from it.

**Export `stepSchema` and let `bind.ts` walk with it.** Rejected, and the distinction is the reason `isOpaqueBoundary` is safe to export while `stepSchema` is not. `stepSchema` returns a tagged union — `descend` / `boundary` / `mismatch` — and every tag demands a _policy_ decision from the caller: stop or continue at a boundary, throw or return `undefined` on a mismatch, what to accumulate across the loop. Handing that out is what makes hand-rolling a divergent walker easy, which is precisely how the traversal consolidation came apart. `isOpaqueBoundary` returns a `boolean`. There is no tag to interpret, nothing to accumulate, and exactly one correct answer, so no divergent policy can be built from it. It is a shared _fact_, not a shared _traversal_.

**Fold the boundary rule into a separate validator function.** Rejected. It would mean a second full walk of the schema graph at every `bind()`, to enforce a rule about the same feature the first walk already checks. Threading one boolean through the existing walk is smaller and keeps the two `.decay()` rules adjacent, where a reader will find both.

**Cover `ephemeral` alongside `state` in the Phase 1 suite.** Rejected. The two targets are declared with the identical type (`BindingTarget<EphemeralLaws, PlainNativeMap>`), so what they accept at compile time is decided by the same type parameters. A suite comparing them would be asserting that TypeScript gives one question the same answer twice.
