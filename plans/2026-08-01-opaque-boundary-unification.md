refactor(schema): unify path walking on one total traversal

# Background

Kyneta stores most of a document as nested CRDT containers, so a write can be applied exactly where its path points. Some subtrees are stored differently: the whole subtree becomes **one opaque plain value** sitting in the parent container, with no internal structure the substrate can address. Two schema shapes are stored this way, and `materializeValue` (`packages/schema/src/materialize-value.ts`) is where you can see it — both take its `needsContainer === false` path and come out as `{ kind: "plain", value }`:

- A `.json()` node — `struct.json` / `list.json` / `record.json`. Storing the subtree whole is the entire point of the modifier.
- A `sum` node — any union, including the `.nullable()` sugar that expands to `sum([null, inner])`. `.nullable()` is only ever offered on plain schemas (see `withPlainModifiers` in `packages/schema/src/schema.ts`), so a variant can never contain a CRDT type, which leaves the substrate nothing to build a container from.

A change aimed at or inside such a subtree cannot be applied where it points. It has to be **widened** into a whole-value write of the entire subtree. Widening is best understood as a _normalization_: it turns any change into a `replace`, which every substrate already handles.

`packages/schema/TECHNICAL.md` §"Why one fold, not many" records the intent behind the current design:

> After the consolidation, `advanceSchema` has exactly one production caller — `foldPath` itself — and the sum-boundary rule is structural, not exception-based.

That is no longer true. There are three production callers, each handling the sum case differently:

| caller | file | sum handling |
| --- | --- | --- |
| `foldPath` | `src/fold-path.ts` | explicit short-circuit — correct |
| `findJsonBoundary` | `src/fold-path.ts` | none — walks into the throw |
| `schemaAtPath` | `src/substrates/state-tree.ts` | `try/catch` → `undefined` |

The drift has a traceable origin. `findJsonBoundary` arrived with the `.json()` boundary work (see CHANGELOG, "struct.json / list.json / record.json now store their subtree as a single plain JSON value"). That work taught `foldPath` about json boundaries "symmetric with the existing sum boundary," but the second walker it introduced learned only the json half.

# Problem Statement

`advanceSchema` throws eleven ways, and they are not one category:

1. **Malformed path** — an index segment on a product, an unknown field, an entry segment on a sequence. The path contradicts the schema.
2. **Nothing below here** — `scalar`, `text`, `counter`, `richtext`. A path continuing past a leaf is also malformed.
3. **`sum`** — alone in its category. `optional.to` is a _legitimate_ path. It resolves on read and under `json.bind`. The schema simply cannot finish the walk, because which variant is present is a fact about the value.

Category 3 is a normal terminal condition that every walker must handle, filed next to ten genuine errors. Nothing in the type system says so; the rule lives in a doc comment. Two of three walkers got it wrong, producing two live bug classes.

**Bug class A — a write into an opaque subtree.** On `yjs.bind` and `loro.bind`, `findJsonBoundary` walks past a sum into `advanceSchema` and throws. Reported downstream against Yjs; Loro fails identically.

```ts
const Inner = Schema.struct({
  from: Schema.number(),
  to: Schema.number().nullable(),
});
const doc = createDoc(yjs.bind(Schema.struct({ optional: Inner.nullable() })));
doc.optional.set({ from: 1, to: null });
doc.optional.to.set(2);
// Error: advanceSchema: cannot advance through a sum
```

**Bug class B — a non-`replace` change at a sum.** Wider than what was reported, and the more damaging of the two, because collection mutation is the reason to reach for a nullable collection in the first place. Measured behaviour, with `json.bind` as the reference:

| operation | `json` | `yjs` / `loro` | `state` |
| --- | --- | --- | --- |
| `list(...).nullable()` + `push` | correct | **throws** | reads ok, **tree keeps `[1,2]`** |
| `list.json` + `push` | correct | correct | reads ok, **tree keeps `[]`** |
| `record(...).nullable()` + key write | correct | silent no-op | throws (see below) |
| `record.json` + key write | correct | correct | throws (see below) |

The Yjs failure is `applyChangeToYjs: SequenceChange target at path [ml] is not a Y.Array` — there is no `Y.Array`, because the whole list is one plain value.

**Bug class C — register decomposition on `state`.** The `state` substrate never consults the boundary oracle at all. `schemaAtPath` swallows the `advanceSchema` throw and returns `undefined`, which callers read as "no schema opinion" and answer with decompose-everything. A write inside a register splits its atomic `[value, timestamp]` tuple and discards every sibling field the change did not mention — defeating the atomicity guarantee documented in `packages/schema/TECHNICAL.md` §"Atomic registers in the StateTree". Local reads stay correct because `prepare` updates the shadow directly, so only replicated state is damaged.

The `state` throws in the table above have a **different, unrelated cause** — a `MapChange` shape mismatch in `applyChangeToStateTree`. That defect and the silent dropping of sequence changes on `state` are out of scope here and are recorded separately; see "Out of scope" below.

# Success Criteria

- A walker cannot arrive at the sum throw by omission. There is one traversal, and reaching an opaque boundary is a case it reports rather than a state it crashes in.
- "Which schema shapes are opaque" has exactly one definition. No caller writes `[KIND] === "sum"` or `isJsonBoundary(...)` to decide where to stop.
- The boundary rule has no special cases: no terminating-vs-interior test, no sum-vs-json test, no change-type test.
- Bug classes A, B and C are fixed on every affected substrate, pinned by tests that fail without the change.
- `advanceSchema` keeps its signature, its throw sites, and its exact messages. It remains exported and working.
- `foldPath` keeps its signature and calls its `PathStepper` the same number of times, in the same order, with the same arguments. Both backends depend on this and no current test pins it.
- `packages/schema/TECHNICAL.md` states an invariant that is true, and names what enforces it.

# ✅ Phase 1 — Characterize before changing anything

Every defect here was invisible because the behaviour was untested. Pin the ground truth first, so the refactor that follows is provably behaviour-preserving and the fixes are visibly fixes.

- ✅ Add `packages/schema/src/__tests__/opaque-boundary.test.ts`. Build the matrix from the Problem Statement: `{list, record, struct} × {.nullable(), .json()} × {whole write, collection mutation, interior leaf write}`, run against `json.bind` as the reference. `json` is correct in every cell today, so these all pass immediately and become the oracle for the other substrates.
- ✅ Pin the currently-correct `.json()` behaviour on both CRDT backends before touching the boundary rule. `list.json` + `push` and `record.json` + key write work _only because_ the boundary is reported for a path that terminates on it. Losing that would break every `.json()` collection, so it needs a guard.
- ✅ Add failing tests for bug classes A and B on `yjs` and `loro`, and C on `state`. Mark them `.fails` so the suite stays green, and flip them to normal assertions in the phase that fixes each. A test that has never been red proves nothing.
- ✅ Pin `foldPath`'s stepper call sequence. `fold-path.test.ts` already has a recording stepper (`"sum-boundary terminates the CRDT-aware fold"` asserts `callCount === 1`). Extend it to assert the full recorded argument sequence on a sum-interior and a json-interior path. Nothing currently pins this, and Phase 3 could silently break both backends without it.

# ✅ Phase 2 — The total core

Add the traversal in `packages/schema/src/fold-path.ts`. Pure addition; no existing behaviour changes in this phase.

- ✅ Add the single-step function to `src/schema.ts`, beside `advanceSchema`. Total — it never throws.

  ```ts
  type SchemaStep =
    | { readonly kind: "descend"; readonly schema: Schema }
    | { readonly kind: "boundary"; readonly schema: Schema }
    | { readonly kind: "mismatch"; readonly reason: string };

  function stepSchema(schema: Schema, segment: Segment): SchemaStep;
  ```

  `boundary` means "the node you just reached is stored as one opaque value — stop; anything past this resolves against the value, not the schema." There is deliberately **no** tag distinguishing sum from json: nothing downstream needs to know which it is, and offering the distinction invites new special cases.

- ✅ Classify `boundary` by the **result** node, not the input. This is forced, not stylistic: `foldPath` calls its stepper for the segment that lands on the boundary and only then stops. Classifying the input would move that call and change what both backends resolve. See Transitive Effects.

- ✅ Return `mismatch` for the ten category-1 and category-2 failures, carrying today's message verbatim in `reason`. Also return `mismatch` for _stepping from_ a sum, which is what `advanceSchema` throws on today. Walkers that honour `boundary` never reach it, but the function stays total.

- ✅ Add the walk. Same parameter list as `foldPath`, with the stepper optional:

  ```ts
  type PathWalk =
    | {
        readonly stop: "complete";
        readonly schema: Schema;
        readonly consumed: number;
        readonly resolved: unknown;
      }
    | {
        readonly stop: "boundary";
        readonly schema: Schema;
        readonly consumed: number;
        readonly resolved: unknown;
      }
    | {
        readonly stop: "mismatch";
        readonly consumed: number;
        readonly segment: Segment;
        readonly reason: string;
      };

  function walkPath(
    root: unknown,
    rootSchema: Schema,
    path: Path,
    stepInto?: PathStepper,
    binding?: SchemaBinding,
  ): PathWalk;
  ```

  `consumed` is how many segments the schema walk got through. On `boundary` the boundary segment _is_ consumed, so it sits at `consumed - 1` and the segments needing value-level resolution start at `consumed`. State that plainly in the doc comment; it is the one piece of index arithmetic every caller depends on.

  `walkPath` returns `mismatch` rather than throwing. Each caller then picks its own policy, which is the functional-core / imperative-shell split: the core reports what happened, the shells decide what to do about it.

- ✅ Do **not** return a materialized `rest: Segment[]`. It would express the handoff more directly in the type, but `foldPath` is on the hot read path — both backend `TECHNICAL.md` files note resolution is not cached and "happens on every read" — and callers can iterate from `consumed` without allocating.

- ✅ Reduce `advanceSchema` to a wrapper: throw on `mismatch` with the reason verbatim, otherwise return `step.schema`. Note `boundary` returns the schema rather than throwing, which preserves two existing behaviours — descending _to_ a sum returns the sum as-is, and descending _into_ a `.json()` subtree keeps working.

- ✅ Export `walkPath` and `PathWalk` from `src/index.ts`. Keep `stepSchema` and `SchemaStep` module-private. Exporting the single step is what makes hand-rolling a fourth walker easy, and that is the habit this plan exists to break.

# ✅ Phase 3 — Move every walker onto the traversal

Behaviour-preserving. The full suite must stay green throughout, including the Phase 1 stepper-ordering pin.

- ✅ `foldPath` becomes a thin projection: `walkPath` with the stepper, then plain-property descent from `consumed` on `boundary`, then `throw new Error(reason)` on `mismatch`. Its two short-circuit blocks (sum, json) collapse into one, since both did the same thing. Signature unchanged.
- ✅ `pathSchema` becomes `walkPath` with no stepper, returning `.schema`.
- ✅ `findJsonBoundary` becomes `walkPath` with no stepper: `stop === "boundary"` gives a hit at `prefixLength: consumed - 1`. Keep the existing `JsonBoundaryHit` shape in this phase; renaming comes later so this diff stays reviewable.
- ✅ `schemaAtPath` (`src/substrates/state-tree.ts`) becomes `walkPath`, returning `.schema`, or `undefined` on `mismatch`. **Delete its `try/catch`.** It currently absorbs any error, including bugs inside `advanceSchema` itself; `mismatch` is narrow and deliberate where the catch was broad and accidental.
- ✅ Confirm `advanceSchema` has no remaining production callers. It stays exported for downstream users, but nothing inside the package should reach for it once the traversal exists.

**What actually happened.** This phase was planned as behaviour-preserving,
with Phase 4 adding the uniform boundary rule afterwards. It did not work out
that way, and the reason is worth recording: once `findJsonBoundary` became a
projection of `walkPath`, it inherited the `boundary` stop automatically, and
`stepSchema` already classifies a sum as a boundary. Bug classes A and B were
fixed the moment the walkers were consolidated — there was no separate
condition left to add.

That is the plan's thesis landing harder than expected. The uniform rule was
never a policy anyone needed to write down; it fell out of asking the question
in one place instead of three.

# ✅ Phase 4 — One boundary rule (subsumed by Phase 3)

The behaviour change for bug classes A and B. Small diff, resting on Phases 1–3.

- ✅ Report a `sum` boundary exactly as a `.json()` boundary is reported — one condition, no terminating check, no change-type check:

  ```ts
  if (isJsonBoundary(next) || next[KIND] === "sum") {
    /* boundary */
  }
  ```

- ✅ Flip the Phase 1 `.fails` tests for classes A and B to normal assertions on both CRDT backends.
- ✅ Confirm the previously-correct cases still hold: terminating `replace`, `set(null)`, two-peer replication, and `.json()` collection mutation.

Recorded here because it is easy to re-derive the wrong rule from first principles: a **terminating** boundary must still be reported. The instrumented write path shows boundary hits arriving with `change=sequence` and `change=map`, not only `change=replace`. Those are `d.jsonList.push(x)` and `d.jsonRecord.set(k, v)` — a `.json()` collection has no CRDT container behind it, so widening is the only way to express them. A rule that skipped terminating boundaries would break every `.json()` collection and permanently entrench bug class B for sums.

# ✅ Phase 5 — Widen register writes on `state`

Bug class C. `state` reaches the same conclusion by a different route: its registers are `[value, timestamp]` tuples rather than CRDT containers, but the question "is this write aimed into an opaque subtree?" is identical.

- ✅ In `state.ts`'s `prepare`, ask the boundary oracle before applying to the tree. On a hit, re-aim the change at the register's own path as a whole-value `replace`, reading the post-change value from the shadow — `applyChange` has already updated it one line above.
- ✅ Skip the widening when no schema is available. A schemaless substrate cannot locate registers, so it keeps the historical decompose-everything behaviour; without a schema there is no `sum` or `.json()` to recognise anyway.
- ✅ Flip the Phase 1 `.fails` tests for class C.
- ✅ Note in the code comment that widening also happens to fix register-shaped `map` and `sequence` changes on `state`, because the widened change is a `replace`, which `applyChangeToStateTree` handles. Bare containers are _not_ fixed by this and remain broken — see "Out of scope".

# ✅ Phase 6 — Retire the misleading name

`findJsonBoundary` reports sum boundaries too, and after Phase 4 that is its main job.

- ✅ Rename to `findOpaqueBoundary`; rename `JsonBoundaryHit` to `OpaqueBoundaryHit`.
- ✅ Re-export both old names as `@deprecated` aliases. Both are exported from the package root, so removing them would be a breaking change in what is otherwise an internal correctness fix.
- ✅ Update the internal call sites: `src/substrates/state.ts` and the Loro and Yjs substrates.

# ✅ Phase 7 — Documentation and comments

- ✅ `packages/schema/TECHNICAL.md` §"Why one fold, not many". The claim "`advanceSchema` has exactly one production caller" is false and cannot be restored — several distinct walks are legitimate. Replace it with the invariant that now holds: every walk goes through `walkPath`, and the boundary rule is structural because the traversal reports it. Say plainly that the previous formulation drifted, and that an invariant living in a doc comment is not an enforced one. This is the most valuable paragraph in the change; the next person to add a walker will read it or repeat the bug.
- ✅ §"Two semantic invariants live in `foldPath`" — already stale, since `fold-path.ts` documents three. Correct the count and fold the two boundary invariants into one "opaque boundary" rule, which is what Phase 4 makes them.
- ✅ §"Path resolution and sum boundaries" — update: the traversal reports the boundary; `advanceSchema` no longer throws at it from inside a walk.
- ✅ §"Atomic registers in the StateTree" — add that a write aimed _inside_ a register is widened to the register itself, and why the shadow makes the failure invisible locally.
- ✅ Exports table and the canonical-symbols line at the top: add `walkPath`, `PathWalk`, `findOpaqueBoundary`, `OpaqueBoundaryHit`.
- ✅ Both backend `TECHNICAL.md` files: the `foldPath` / `PathStepper` rows (~line 35) say "the two semantic invariants"; and the write-path diagrams (`packages/schema/backends/yjs/TECHNICAL.md` ~line 255, `packages/schema/backends/loro/TECHNICAL.md` ~line 235) name `findJsonBoundary(path)` explicitly. Both need the rename and the corrected rule.
- ✅ `packages/schema/backends/loro/TECHNICAL.md` ~line 274 states that non-replace change types "cannot originate from sum-interior paths because sum variants are constrained to `PlainSchema`", and concludes the `advanceSchema` throw is unreachable. Bug class B disproves this — a `push` onto a `Schema.list(...).nullable()` is exactly such a change. Correct it.
- ✅ CHANGELOG entry under `@kyneta/schema`: two bug-class fixes, one new export, one deprecation, no breaking change.
- ✅ No README change. `walkPath` is a primitive for walker authors, not part of the document-authoring surface the README covers.

**Comments.** Why, not what; plain language; teach rather than assume. Four carry real weight:

- ✅ `stepSchema` — why `sum` is not an error while its ten siblings are: the path is valid, and it is the _oracle_ that is wrong, not the path.
- ✅ `walkPath` — why `boundary` is classified on the result node (stepper call ordering), and the `consumed - 1` index rule. A future reader will otherwise "simplify" the first and mis-derive the second.
- ✅ `state.ts`'s widening branch — that local reads come from the shadow and stay correct no matter what lands in the tree, so this branch cannot be tested by reading the document back. That single fact is why the bug survived.
- ✅ Phase 4's boundary condition — that a terminating boundary must be reported, with `push` on a `.json()` list as the concrete reason.

# Tests

Reuse `packages/schema/src/__tests__/fold-path.test.ts` (recording-stepper helper), `state-sum-atomicity.test.ts` (tree-inspection helpers), and the two-peer sync helpers in the backend suites.

- ✅ **Matrix vs. the reference substrate** (Phase 1). The `{shape} × {wrapper} × {operation}` grid against `json.bind`. Runs on all five binding targets so any substrate that diverges from `json` is visible in one place.
- ✅ **Stepper call ordering** (Phase 1). Recorded argument sequence for sum-interior and json-interior paths. The only guard on the Phase 3 refactor not breaking both backends.
- ✅ **`walkPath` unit tests.** One per outcome: `complete` for a full path; `boundary` with correct `consumed` for sum and json, at the root and nested inside list and record containers; `mismatch` for wrong-role segments, unknown fields, and each leaf kind.
- ✅ **`advanceSchema` unchanged.** The existing ~15 `toThrow` cases in `advance-schema.test.ts` pass untouched. Add one asserting a `.json()` node still _descends_ rather than throwing — that behaviour is easy to lose when json becomes a `boundary` internally.
- ✅ **Bug class A** — leaf write through a non-null nullable struct, on `yjs` and `loro`, including two-peer replication.
- ✅ **Bug class B** — `push` on `Schema.list(...).nullable()`, key write on `Schema.record(...).nullable()`, on `yjs` and `loro`, including replication.
- ✅ **Bug class C** — register-interior writes on `state`, asserting on the **exported tree**, not on the document. A document-level assertion passes with the fix removed, because the shadow is updated independently.
- ✅ **`.json()` collections still work** — `list.json` + `push` and `record.json` + key write on both CRDT backends. The regression guard on Phase 4.
- ✅ **Changefeed path is unaffected.** Widening happens inside the substrate, after the changefeed layer has recorded the op, so a subscriber must still see the original leaf path. Untested today and easy to break.
- ✅ **Abort restores a widened write.** `batch(doc, ...)` containing a register-interior write, then throw. The recorded inverse is a `replace` at the leaf path, which widens the same way on replay; the register must come back whole.
- ✅ **Full `npm run verify`** — format, types, logic across all workspace tasks. Backends resolve `@kyneta/schema` to `dist/`, so `cd packages/schema && SKIP_BROTLI=1 npm run build` is required before backend suites reflect core changes. A stale `dist/` silently reports the old behaviour.

# Transitive Effect Analysis [scratch]

**`foldPath` → backends → every read.** `resolveContainer` (Loro) and `resolveYjsType` (Yjs) are thin wrappers over `foldPath`, and every substrate read plus most writes route through them. The hazard is stepper _call ordering_: `foldPath` steps into the boundary segment and only then short-circuits. Classifying the boundary on the input node instead would skip that final stepper call, so `resolveYjsType` would return the parent container rather than the boundary value. No current test would catch it. This single constraint determines `stepSchema`'s result-classification design, and is why Phase 1 adds an ordering pin before Phase 3 touches anything.

**`advanceSchema` is public API.** Exported from `src/index.ts` and present in the published type surface. Keeping it as a throwing wrapper avoids a breaking change. Its `boundary` branch must _return_ rather than throw, or descending into a `.json()` subtree breaks for external callers — that path never threw.

**`schemaAtPath` → `isDecomposedContainer` → tree shape → merge.** The chain is `state.ts:prepare` → `applyChangeToStateTree` → `schemaAtPath` → `isDecomposedContainer` → one tuple or many → what `mergeStateTree` can blend. `mergeStateTree` is deliberately schema-blind so headless relays and stores can merge without a schema, which leaves tree _shape_ as the only signal that a register is one value. Returning a register schema where `undefined` came back before changes `needsContainer`'s answer. After Phase 5, register-interior paths no longer reach `schemaAtPath` at all — but "should be unreachable" is exactly the assumption that produced bug class C, so it needs a test rather than an argument.

**`pathSchema` → changefeed classification.** `resolveSchemaKindAtPath` (`src/changefeed.ts`) wraps `pathSchema` in `try/catch` and maps `sum` to `"other"`. It sits two hops from the traversal and should need no edit. Confirm by test, not by reading.

**Widening → changefeed → subscribers → `@kyneta/exchange`.** The changefeed layer wraps `ctx.prepare` and records the op before the substrate sees it, so widening should be invisible to subscribers. If that were wrong, notification paths would shift from the leaf to the register, and `@kyneta/exchange`'s auto-subscribe filtering sits downstream of it.

**Widening → inverse recording → abort.** `substrate.prepare` records an inverse from the pre-change shadow at the _original_ path, before widening. On abort the inverse replays through `ctx.prepare` and widens identically. Consistent, but untested.

**Docs name the symbol.** `findJsonBoundary` appears in both backend write-path diagrams. The Phase 6 rename has to sweep prose, not just code.

# Resources for Implementation [scratch]

- `packages/schema/src/fold-path.ts` — the file header documents the three invariants; `foldPath`, `pathSchema`, `findJsonBoundary`.
- `packages/schema/src/schema.ts` — `advanceSchema` (~line 1121) and its eleven throw sites.
- `packages/schema/src/materialize-value.ts` — `needsContainer`, the existing container-vs-leaf predicate. The boundary set must agree with it; they answer the same question from opposite directions.
- `packages/schema/src/substrates/state-tree.ts` — `schemaAtPath`, `isDecomposedContainer`, `applyChangeToStateTree`.
- `packages/schema/src/substrates/state.ts` — `prepare` (~line 235), where widening goes and where the shadow is updated.
- `packages/schema/backends/{yjs,loro}/src/substrate.ts` — `prepare` and the boundary coalescing buffers.
- `packages/schema/TECHNICAL.md` §"`foldPath` — schema-guided path resolution" (line 1203 onward), especially §"Why one fold, not many" (line 1236) — the drifted invariant motivating this work. Also §"Path resolution and sum boundaries" (line 347) and §"Atomic registers in the StateTree" (line 205).
- `packages/schema/backends/{yjs,loro}/TECHNICAL.md` — `foldPath` / `PathStepper` rows (~line 35) and the write-path diagrams (~line 255 / ~line 235).
- `CHANGELOG.md` — the `.json()` boundary entry that introduced the second walker, and the `foldPath` consolidation entry that claimed "no drift surface".

# Out of scope

Two further `state` defects were found while characterizing this work. Both live in `packages/schema/src/substrates/state-tree.ts`, both affect only `state.bind`, and neither has anything to do with boundaries:

- `applyChangeToStateTree` reads a `MapChange` shape (`.entries`, with `{type:"set"|"delete"}` instructions) that the change vocabulary has never defined. Every map mutation on `state` throws, including on a plain `Schema.record`.
- `applyChangeToStateTree` has no case for sequence changes, so they are dropped silently while the shadow moves — the same invisible-locally signature as bug class C.

Phase 5 incidentally repairs both _for registers_, because widening normalizes any change into a `replace`. Bare containers stay broken. Fixing them properly first requires deciding what schemas `state` actually supports: its own header says "structs and maps," yet `state.bind` accepts `Schema.list`, `Schema.record` and `Schema.text` without complaint. That is a contract decision, not a walker one, and it is tracked separately.

# Alternatives Considered

**Fix `findJsonBoundary` in place and stop.** This is what a previous attempt did, and it is instructive that it produced a rule with an exception — "don't report a boundary the path terminates on" — justified by an argument that turned out to be false, and which would have broken every `.json()` collection and entrenched bug class B. Fixing the walker without naming the concept leaves the next author to re-derive it, with no more information than the last one had.

**Make the step total but keep three separate walks.** Catches bug class A by making the boundary case unignorable at the step level, and is a much smaller change. Rejected because it leaves three traversals free to diverge in every other respect, and the divergence is the actual defect. It also would not have surfaced bug class B, which needed the walkers compared against each other.

**Return a materialized `rest: Segment[]` from the traversal.** Expresses the schema-to-value handoff directly in the type, so a caller cannot receive it and forget. Rejected on cost: `foldPath` runs on every read and is explicitly uncached, and callers can iterate from `consumed` without allocating. This is the one place the plan takes the less pure shape, and it is a deliberate trade.

**Tag boundaries as `"sum" | "json"`.** Considered so callers could treat the two differently. Rejected once measurement showed no caller should: every difference anyone might key off that tag turned out to be a bug. Offering the distinction would invite the special cases this plan removes.

**Leave `advanceSchema` partial and rely on review.** Rejected. Both authors who introduced a divergent walker had the doc comment available. The sum throw reads like the ten genuine errors beside it, so the natural response is `try/catch` or nothing — which is what both of them did. The failure mode is omission, and review catches omissions only when the reviewer already knows to look.
