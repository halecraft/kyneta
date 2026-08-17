refactor(schema): point the descent tests and error messages at `stepSchema`, and retire `advanceSchema`

# Background

`packages/schema/src/schema.ts` contains two ways to descend one path segment into a schema:

- **`stepSchema`** — total, never throws. Returns a tagged result: `descend` (an ordinary child), `boundary` (the child is stored as one opaque plain value, so the schema has nothing further to offer), or `mismatch` (the path does not fit, carrying a ready-to-use reason string). It is package-internal on purpose.
- **`advanceSchema`** — a public wrapper that returns the child schema or throws on a mismatch.

`walkPath` is the single schema-guided traversal in the package, and it is built on `stepSchema`. `foldPath`, `pathSchema`, `findOpaqueBoundary` and the `state` substrate's schema lookup are all projections of `walkPath`. `packages/schema/TECHNICAL.md` §"Why one traversal, not many" documents how this arrangement came about, including the fact that it came apart once before and had to be rebuilt structurally.

That section already records `advanceSchema`'s current status:

> `advanceSchema` survives as a public wrapper with no production callers.

Two deprecated aliases sit in the same vocabulary: `findJsonBoundary` and `JsonBoundaryHit` (`fold-path.ts`), kept as a soft landing when `findOpaqueBoundary` / `OpaqueBoundaryHit` replaced them.

# Problem Statement

## 1. The best descent tests are aimed at the one entry point nothing uses

`packages/schema/src/__tests__/advance-schema.test.ts` is 367 lines with 41 call sites. It is the most thorough test of per-kind descent in the package: field-vs-index-vs-entry segment handling for every container kind, the terminal cases for scalar / text / counter / richtext, the sum rule, and multi-step descent chains.

Every one of those assertions goes through `advanceSchema`. No production code calls `advanceSchema`. Every real traversal calls `stepSchema` via `walkPath`.

So the package's strongest coverage of its most bug-prone logic exercises a wrapper, while the function that actually runs is tested only indirectly through higher-level suites. `packages/schema/TECHNICAL.md` §"Why one traversal, not many" records that this exact area produced three separate shipped bugs from one missing case, which is a strong argument for testing the live path directly.

## 2. Twelve live error messages name a function that is not in the call path

`childSchema` returns failure as a string, and twelve of those strings are prefixed `advanceSchema:`:

```
advanceSchema: product has no field "x"
advanceSchema: cannot advance through a sum (sums resolve by value, not by path segment)
```

These are the reasons `stepSchema` reports on a `mismatch`, which `walkPath` surfaces and `foldPath` throws. **They reach users through traversals that never touch `advanceSchema`.** A developer who greps for the function named in the error finds a wrapper with no callers, which is a dead end.

This is wrong today, independently of anything else in this plan.

## 3. Dead public API, deliberately retained, and a major release is open

`advanceSchema`, `findJsonBoundary` and `JsonBoundaryHit` are all exported from `packages/schema/src/index.ts` and all have zero production callers. Removing a public export requires a major version. One is in progress; the next opportunity after it is the release after that.

**This was not an oversight, and the plan should not pretend otherwise.** `advance-schema.test.ts` states the prior decision plainly:

> It has no production callers left and **stays exported for downstream users**, so its behaviour must not drift.

Someone chose to keep the wrapper public after the last consolidation and wrote tests to hold it stable. Reversing that is a judgement call, argued in "Alternatives Considered" below rather than assumed here.

# Success Criteria

- Descent behaviour is tested directly against `stepSchema`, including the `descend` / `boundary` distinction that `advanceSchema` cannot express.
- No error message names a function that is not in the caller's path.
- `advanceSchema`, `findJsonBoundary` and `JsonBoundaryHit` are gone from the public surface.
- `stepSchema` stays package-internal. Nothing in this plan widens it.
- Documentation reflects the removal, and the §"Why one traversal, not many" post-mortem is **updated rather than trimmed** — it is the record of why this area is dangerous.
- `npm run verify` passes.

# Revision Stack

Four jj revisions, in order. Each builds and passes `npm run verify` on its own. The ordering is the point of the plan: **the deletion is trivial only if it comes last**, because the two revisions before it move everything of value out of the way first.

| # | revision | phase |
|---|---|---|
| 1 | `fix(schema): name stepSchema in its own descent error messages` | Phase 1 |
| 2 | `test(schema): test schema descent against stepSchema directly` | Phase 2 |
| 3 | `refactor(schema)!: remove advanceSchema and the deprecated json-boundary aliases` | Phase 3 |
| 4 | `docs(schema): record the advanceSchema retirement` | Phase 4 |

Revisions 1 and 2 are independently valuable and would be worth landing even if `advanceSchema` were kept. Revision 3 is the only breaking one. Revision 4 is separated because it edits narrative documentation across three files, which reviews better on its own than buried under a deletion.

# ✅ Phase 1 — Name `stepSchema` in its own error messages

- ✅ Change the twelve `advanceSchema:` prefixes in `childSchema` (`packages/schema/src/schema.ts`) to `stepSchema:`. The messages describe what `stepSchema` reports; the prefix should say so.

- ✅ Leave the descriptive remainder of each message untouched. Only the prefix changes, which keeps the diff readable and keeps any downstream string matching on the descriptive half working.

- ✅ No test changes are needed. Verified: no test in the workspace asserts on the `advanceSchema:` prefix — the existing assertions match the descriptive tail.

# ✅ Phase 2 — Test descent against `stepSchema`

- ✅ Rename `packages/schema/src/__tests__/advance-schema.test.ts` to `step-schema.test.ts` and repoint every assertion at `stepSchema`. A test file should be named for what it tests.

- ✅ Translate the two assertion shapes. `stepSchema` is total, so a thrown-message assertion becomes a returned-value assertion:

```ts
// success — advanceSchema returned the child schema
expect(stepSchema(schema, segment)).toEqual({ kind: "descend", schema: child })

// failure — advanceSchema threw
expect(stepSchema(schema, segment)).toEqual({ kind: "mismatch", reason: "…" })
```

  Asserting on structured data rather than on exception text is the better test in its own right.

- ✅ Split the cases `advanceSchema` could not distinguish. It returned a schema for both an ordinary child and an opaque one; `stepSchema` reports `descend` versus `boundary`. Every case where the child is a `sum` or a `.json()` node should now assert `boundary` explicitly.

  This is the one place the port genuinely adds something, and it is worth being accurate about how much. Boundary behaviour is **already well covered one level up**: `src/__tests__/fold-path.test.ts` has dedicated sum-boundary and json-boundary sections, plus a stepper-call-sequence test asserting that the fold steps *to* the boundary before stopping rather than noticing it first. Nothing here is filling a hole. What it adds is coverage of the shared *primitive* that the well-covered traversal rests on — which matters because `stepSchema`'s boundary predicate is about to acquire a second consumer (see PLAN-2026-08-02-storage-classification), and a primitive with two consumers should be pinned on its own terms.

- ✅ Keep the distinction between *stepping into* a sum and *stepping from* one, which is easy to conflate. A segment whose child is a sum yields `boundary`. A segment applied to a sum yields `mismatch`, because a sum resolves by inspecting a value, not by reading the next path segment.

- ✅ Import `stepSchema` from `../schema.js`. It is package-internal and stays that way; an in-package test importing it directly is not a widening of its surface.

- ✅ **Port — do not drop — the two cases in the file's existing "advanceSchema as a wrapper over stepSchema" section.** The framing goes away, because there will be no wrapper to assert delegation for. The cases must not: they pin that **boundary-ness attaches to the child, not the parent**, which is the subtlest part of the rule and the easiest to get backwards.

  Descending *to* a sum yields `boundary`. Descending *within* a `.json()` node yields `descend`, because a json node is an ordinary product carrying a marker and its own fields are ordinary children. Reframed as `stepSchema` assertions these become the sharpest statement of the rule in the suite, and they are exactly the boundary cases the task above asks for. The section's own comment records that they were added deliberately after the last consolidation, as "the one case the refactor could plausibly have broken."

# ✅ Phase 3 — Remove the dead API

By this point `advanceSchema` has no callers, no tests, and no error messages bearing its name, so each removal is a deletion with nothing to relocate.

- ✅ Delete `advanceSchema` from `packages/schema/src/schema.ts` and from `packages/schema/src/index.ts`.

- ✅ Delete `findJsonBoundary` and `JsonBoundaryHit` from `packages/schema/src/fold-path.ts` and from `packages/schema/src/index.ts`.

- ✅ Update the code comments that reference `advanceSchema` as a live thing. These are explanatory rather than load-bearing, and several are *historically* accurate in a way worth keeping — for example `state-tree.ts:schemaAtPath` explains why it no longer wraps `advanceSchema` in a `try/catch`, which is a real lesson. Rewrite those to name `stepSchema` or `walkPath` where they describe current behaviour, and leave the historical explanation intact where it teaches something. Sites: `src/migration.ts`, `src/changefeed.ts` (two), `src/substrates/state-tree.ts`, `backends/loro/src/change-mapping.ts`, `backends/yjs/src/change-mapping.ts`, and two test-file comments.

# ✅ Phase 4 — Documentation

- ✅ `packages/schema/TECHNICAL.md` §"Why one traversal, not many" — this section's closing sentence says `advanceSchema` "survives as a public wrapper with no production callers," which the removal makes false. **Update the outcome; do not trim the narrative.** The section is a post-mortem explaining how a consolidation decayed, and its central lesson — *"a stated invariant is not an enforced one"* — is the reason this plan exists. Record that the wrapper is now gone and that the descent tests point at the live path, which is what makes the invariant enforced rather than asserted.

- ✅ `packages/schema/TECHNICAL.md` §"Path resolution and sum boundaries" (~line 387) — describes the boundary rule in terms of `advanceSchema`'s throw. Restate it in terms of `stepSchema`'s `mismatch` reason. The throw itself is gone; the rule is not.

- ✅ `packages/schema/TECHNICAL.md` — the canonical-symbols list near the top, the module table entry for `src/schema.ts`, and the `fold-path.ts` row that reads "`findJsonBoundary` / `JsonBoundaryHit` remain as deprecated aliases." Three separate edits.

- ✅ `packages/schema/backends/loro/TECHNICAL.md` (~line 276) — references "the `advanceSchema` throw on sums" while explaining boundary-routed writes. Repoint at `stepSchema`.

- ✅ `packages/schema/theory/sql.md` (~line 769) — lists `advanceSchema()` under "Existing utilities." Repoint at `walkPath`, which is what a future implementer should reach for.

- ✅ CHANGELOG entry under `@kyneta/schema`. A **breaking** item for the three removed exports, naming `walkPath` as the supported replacement for `advanceSchema` and `findOpaqueBoundary` / `OpaqueBoundaryHit` for the aliases. A **fixed** item for the error-message prefix, since a developer grepping the old text will want to know why it changed.

- ✅ No README change. None of these symbols appear in either README.

**Comments.** Why, not what. Two carry weight:

- ✅ On the ported test file's header — why it tests `stepSchema` rather than a public entry point, and that the single-step boundary rule is the thing three walkers previously got wrong.
- ✅ On `childSchema`'s error strings — that they surface through `walkPath` and `foldPath`, so the prefix should name the function a reader can actually find in the call path.

# Tests

The test work is Phase 2 itself. Beyond it:

- ✅ **The ported suite covers everything the original did.** Compare case counts before and after. The port should lose nothing — including the two cases from the "wrapper over stepSchema" section, which are ported rather than dropped — and gain the `boundary` assertions.
- ✅ **Boundary is asserted at the single-step level** for both shapes that qualify — a `sum` (including the `.nullable()` form) and a `.json()` node. Assert the *direction* too: descending **to** an opaque node yields `boundary`, while descending **within** a `.json()` node yields `descend`, since boundary-ness attaches to the child rather than the parent. Traversal-level coverage of this already exists in `src/__tests__/fold-path.test.ts`; these pin the primitive it rests on.
- ✅ **`mismatch` reasons are asserted as data**, not through a thrown exception, with the new `stepSchema:` prefix.
- ✅ **No test references the removed exports** after Phase 3. A grep for all three names across the workspace should return only documentation and historical comments.
- ✅ **Full `npm run verify`.** Backends and the conformance suite resolve `@kyneta/schema` to `dist/`, so `SKIP_BROTLI=1 npm run build` must run first or they silently report the old behaviour.

# Transitive Effect Analysis [scratch]

**Error-message rename → downstream string matching.** The prefix is the only part that changes. No test in the workspace asserts on it — the existing assertions match the descriptive tail — so Phase 1 is invisible to the suite. A downstream consumer matching the full string would be affected, which is why the CHANGELOG gets a "fixed" entry rather than a silent change.

**Removal → other packages.** `advanceSchema`, `findJsonBoundary` and `JsonBoundaryHit` appear in no package outside `@kyneta/schema` except as words in comments and documentation. `@kyneta/exchange`, `@kyneta/index`, `@kyneta/reactive` and both CRDT backends import none of them.

**Removal → `stepSchema`'s privacy.** Deleting the public wrapper leaves `stepSchema` as the only descent primitive, and it stays package-internal. That is deliberate and is the arrangement `packages/schema/TECHNICAL.md` argues for: handing out a single step is what made a divergent walker easy to write. This plan does not widen it, and the new test file importing it in-package is not a widening.

**Test port → what stops being covered.** `advanceSchema`'s throwing behaviour disappears from the suite along with the function. Nothing else asserts that a mismatch throws, because nothing else should: `walkPath` reports mismatches as data and each projection decides its own policy. `foldPath`'s throw-on-mismatch policy is covered separately in `src/__tests__/fold-path.test.ts`.

**Phase ordering.** Phase 1 before Phase 2 so the ported assertions are written against the final message text and do not need touching twice. Phase 2 before Phase 3 so the deletion removes a function that already has no tests, rather than deleting a test suite and a function together and hoping the coverage moved.

# Resources for Implementation [scratch]

- `packages/schema/src/schema.ts` — `stepSchema` and its `SchemaStep` union, `advanceSchema`, `childSchema` and its twelve failure strings, and the comment explaining why `stepSchema` is package-internal.
- `packages/schema/src/__tests__/advance-schema.test.ts` — the suite being ported, including its existing "advanceSchema as a wrapper over stepSchema" section.
- `packages/schema/src/fold-path.ts` — `walkPath`, `PathWalk`, `findOpaqueBoundary`, and the two deprecated aliases.
- `packages/schema/src/__tests__/fold-path.test.ts` — existing traversal coverage, so the port does not duplicate it.
- `packages/schema/TECHNICAL.md` — §"Why one traversal, not many", §"Path resolution and sum boundaries", §"Two semantic invariants live in `walkPath`, in one place", the canonical-symbols list, and the module table.

# Out of scope

**Making `stepSchema` public.** The argument against is recorded in its own doc comment and in `packages/schema/TECHNICAL.md`: handing out a single traversal step is what made hand-rolling a divergent walker easy, and that is how the previous consolidation decayed. Removing the throwing wrapper does not change that reasoning.

**The storage-classification work.** `isOpaque` — the predicate `stepSchema` consults to decide `boundary` versus `descend` — is being consolidated separately, and that plan renames it to `isOpaqueBoundary`. The two changes touch different regions of `schema.ts` and are independent. This plan should land first, because it only removes code, leaving a smaller file for the other to add to.

# Alternatives Considered

**Keep `advanceSchema` exported, as a previous change deliberately decided to.** The retention was reasoned: it had lost its callers but was public, so it was kept for downstream users and pinned with tests so its behaviour could not drift. Rejected, because the condition that made retention look safe is the same condition `packages/schema/TECHNICAL.md` §"Why one traversal, not many" identifies as the hazard:

> the rule lived in a doc comment, and `advanceSchema` was exported, so hand-rolling a fourth walk was the path of least resistance.

An exported single-step descent is an invitation to write a fifth walker, and the section's own conclusion is that a stated invariant is not an enforced one. Keeping a public entry point *specifically so that outside code can descend a schema one segment at a time* is the shape of the problem, not a neutral courtesy. `walkPath` is the supported replacement and is already public; a downstream caller who needs one step needs a traversal.

The retention also had a cost the original decision did not price in: it anchored the package's most thorough descent suite to a function nothing calls, which is Problem 1 above.

**Delete `advanceSchema` and its test suite together.** The obvious reading of "remove dead code," and the reason this plan exists as four revisions instead of one. The suite is the package's most thorough coverage of per-kind descent, and the logic it covers still ships — it lives in `stepSchema`. Deleting the tests with the wrapper would quietly remove real coverage of live code under the banner of a cleanup.

**Keep `advanceSchema` because the test suite is pointed at it.** Rejected, and it inverts the actual problem. That the tests target a wrapper with no callers is an argument for moving the tests, not for preserving the wrapper. Once they are moved, nothing is left to justify keeping it.

**Rename the error strings as part of the removal.** Folding Phase 1 into Phase 3 would work, but it mixes a message correction that is right on its own merits into a breaking change. Keeping them separate means the fix lands even if the removal is deferred, and it means the ported tests in Phase 2 are written once against the final text.

**Leave the error strings alone.** They would then name a function that no longer exists at all, rather than one that merely has no callers. Since the strings are `stepSchema`'s output and always were, correcting them is the smaller and more accurate change either way.
