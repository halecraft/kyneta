test(conformance): pin sum atomicity as a cross-substrate invariant

# Background

`tests/conformance` is the repository's executable specification of the substrate abstraction. `PROFILES` (`tests/conformance/src/profiles.ts`) declares each substrate's axes as data — writer model, durability, merge granularity, compaction support — and `runSubstrateConformance` (`tests/conformance/src/harness.ts`) runs the same battery against every one of them through a real `Exchange` and `Bridge`. Universal invariants must hold everywhere; capability-gated ones run only where a profile declares support. A substrate whose behaviour drifts from its declared row fails here.

It exercises exactly one schema:

```ts
export const ConformanceSchema = Schema.struct({
  a: Schema.string(),
  b: Schema.string(),
});
```

Two scalars. No sums, no `.json()`, no containers.

That gap has now cost something concrete. `PLAN-2026-08-01-opaque-boundary-unification` fixed three separate bugs in sum handling, one per substrate, all live simultaneously:

- `yjs.bind` threw `advanceSchema: cannot advance through a sum` on a write inside a nullable struct.
- `loro.bind` accepted a nullable-record key write into its local shadow while the CRDT never received it, so it read back correctly and vanished on replication.
- `state` split a register's atomic `[value, timestamp]` tuple and discarded sibling fields, letting the schema-blind `mergeStateTree` blend fields across two peers' variants.

Every one was a cross-substrate divergence on the axis this suite exists to police, and none of them failed a single existing test. The fix was found and verified with a hand-built matrix in the schema package that compared each substrate against `json.bind` as the reference — a manual, package-local version of what conformance already does properly, across the real sync machinery.

# Problem Statement

**"A concurrent variant switch never blends fields across peers" is a universal invariant, and nothing asserts it.** Each substrate reaches it by a different mechanism — `json` and `ephemeral` via whole-document LWW, `state` via atomic registers, `loro` and `yjs` via opaque sum interiors — which is precisely the situation where a shared conformance assertion earns its keep. Four independent implementations of one guarantee, and no shared test.

Two things were measured while planning, and they shape the work:

**1. The variant-switch invariant holds today on all five.** A partition, a concurrent switch on each peer, then a heal, converges to one coherent variant everywhere. So this scenario is pure regression protection — it locks in what was just fixed rather than opening new work.

**2. A write _inside_ a sum does not trigger a sync, on any substrate.** This is a new bug, found while grounding this plan. Peer A writes a leaf inside a non-null `.nullable()` struct; peer A reads it back correctly; peer B never receives it, no matter how long the harness drains. Any subsequent unrelated write carries it across. It reproduces identically on `json`, which exonerates the substrates and places it above them, in the Exchange's decision about when to offer. Full measurements and where to look are recorded separately — see "Out of scope" below.

The second finding is the more valuable one for this suite to carry, because it is exactly the class of defect that stays invisible without a cross-substrate sync-level test.

# Success Criteria

- `ConformanceSchema` covers a sum, and every existing scenario still passes unchanged on all five profiles.
- A concurrent variant switch is asserted to converge to one _coherent_ variant — never a value carrying fields from both — on every substrate, gated by nothing.
- The sum-interior sync gap is asserted as the guarantee it should be, and left
  failing. The suite goes red, because it knows a guarantee is broken and saying
  so is its job. Green-with-a-known-bug is how the bugs that motivated this plan
  survived in the first place.
- The new scenarios read as specification, not as tests of an implementation detail. Someone adding a sixth substrate should be able to read them and know what their substrate has to do.

# ✅ Phase 1 — Separate orchestration from assertion

Done first because it makes every later phase shorter. `harness.ts` currently
braids two different things together in each scenario: the effectful dance of
spawning peers, partitioning, healing and draining, and the pure question of
what the resulting values must satisfy. Adding two scenarios by copy-paste would
take `new Bridge()` from four occurrences to six and the
`writerModel === "serialized"` fork from one to two.

- ✅ Extract `connectedPair(bound)` — spawn two peers already joined by a bridge,
  return both docs. Three existing scenarios open with this exact preamble.

- ✅ Extract `partitionedWrites(bound, writeA, writeB)` — spawn two peers with no
  transport, run each write, then heal with `addTransport` and drain. Carry the
  existing comment about the deliberate gap between the writes: same-millisecond
  timestamps compare "equal" and the synchronizer skips the sync, so the `drain(5)`
  between them is load-bearing rather than incidental.

- ✅ Move the existing three scenarios onto the helpers, changing no assertions.
  The suite must stay at eleven passing tests. This is the proof the extraction
  is faithful, and it has to happen before new scenarios land, or a later failure
  is ambiguous between "extraction broke it" and "new test found something".

- ✅ Leave the `writerModel === "serialized"` fork inside each scenario rather
  than pushing it into a helper. What a serialized substrate does *instead* of
  racing differs per scenario — the existing one writes different fields, the
  variant-switch one writes the same field twice — so a helper would have to take
  both paths as parameters and would obscure more than it saved.

# ✅ Phase 2 — Extend the shared schema

- ✅ Add a discriminated union to `ConformanceSchema` with **disjoint fields per variant**, which is what makes blending detectable at all:

  ```ts
  export const Shape = Schema.discriminatedUnion("kind", [
    Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
    Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
  ]);
  ```

  A blend shows up as a value carrying both `radius` and `side`, or a `kind` that disagrees with its payload. Two variants sharing a field name would hide it.

- ✅ Add a `.nullable()` struct field for the interior-write scenario. A discriminated union cannot serve here: per the `WritableDiscriminantProductRef` contract, its variant fields are read-only and the only mutation is a whole-value `.set()` on the union. A `.nullable()` struct is the shape whose interior is writable at runtime.

- ✅ Confirm both fields bind on all five profiles. This is not a formality — the law system rejects `Schema.list(...).nullable()` on `state` and `ephemeral`, because a sequence carries `positional-ot` which is not in `EphemeralLaws`, while `Schema.list.json(...)` binds fine because `.json()` erases the inner laws. Struct- and record-shaped sums are unaffected, but the asymmetry is easy to trip over when extending this schema later.

- ✅ Verify the existing three scenarios still pass untouched. `read()` compares only `a` and `b`, and neither new field is written by them, so they should be neutral. Confirm rather than assume.

# ✅ Phase 3 — The variant-switch invariant

- ✅ Add a scenario asserting a concurrent variant switch converges to one coherent variant. Follow the existing partition pattern: spawn both peers with no transport, write on each, then heal with `addTransport` and drain. The brief gap between writes is load-bearing — same-millisecond timestamps compare "equal" and the synchronizer skips the sync, which the existing scenario already notes.

- ✅ Handle the serialized writer model the way the existing scenario does. For `json`, two peers racing one document is misuse, so drive it sequentially: A switches, sync, B switches, sync. The invariant is still asserted; only the concurrency is dropped.

- ✅ Assert coherence explicitly, not just equality. Two peers agreeing on a blended value would satisfy an equality check and still be wrong. Check that the surviving value carries the fields of its own variant and none from the other.

- ✅ Write the predicate by hand; `tryValidate` cannot stand in for it. Measured:
  it rejects a tag/payload mismatch (`{kind:"circle", side:3}` → `false`) but
  **accepts a blend** (`{kind:"circle", radius:5, side:3}` → `true`), because it
  does not reject excess properties. So the tag half comes free from the schema
  and the excess-field half is exactly what the hand-written check must cover.

- ✅ Gate on nothing, and say why in a comment: every substrate reaches this guarantee by a different mechanism, and that is exactly what makes it worth asserting in one shared place.

# ✅ Phase 4 — Leave the sum-interior sync gap failing

- ✅ Add a scenario: peer A materializes the nullable struct, syncs, then writes
  one leaf inside it. Assert on what the other peer reads — not on peer A, which
  reads its own write back correctly and would pass while the bug is live. That is
  the same trap that hid the substrate-level bugs: every substrate serves local
  reads from a shadow that `prepare` updates directly.

- ✅ **Assert the correct behaviour and let it fail.** Not `it.fails`, not pinned
  to the observed wrong value.

  This plan first proposed `it.fails`, then the pre-implementation review argued
  for pinning the wrong value instead, on the grounds that `it.fails` passes on
  any failure and so cannot tell "the peer is stale" from "the call now throws".
  That reasoning was sound as far as it went and still reached the wrong answer,
  because **both options report green**. A conformance suite that calls itself
  the executable specification of the substrate abstraction should not pass while
  it knows a guarantee is broken — and green-with-a-known-bug is precisely how
  the three sum bugs this plan exists to guard against survived. Every test
  passed the entire time they were live.

  So the scenario asserts `{ from: 1, to: 2 }`, fails on all five profiles, and
  the failure message says exactly what is wrong:
  `expected { from: 1, to: 7 } to deeply equal { from: 1, to: 2 }`.

- ✅ Name it for the guarantee, not the defect, so the red line reads as a missing
  capability rather than a broken test. The comment above it carries the
  diagnosis and points at the issue record.

- ✅ Do not attempt the fix here. It is above the substrate layer and wants its own
  diagnosis; this plan's job is to make it impossible to ignore.

**Consequence, accepted deliberately:** `npm test` and `npm run verify` are red
until the Exchange bug is fixed. There is no CI in this repository, so this is a
local signal rather than a broken pipeline, and the five failures are named and
explained. Anyone who needs a clean run in the meantime can scope it — verified:

```
SKIP_BROTLI=1 npx turbo verify --filter='!@kyneta/perspective' --filter='!@kyneta/test-conformance'
→ Tasks: 55 successful, 55 total
```

which is a visible, deliberate act rather than a silently green suite.

# ✅ Phase 5 — Documentation

- ✅ Update the `ConformanceSchema` doc comment. It currently explains only why two independent scalars are the crux of the field-concurrency invariant. Extend it to say what each new field is for and why the sum's variants have disjoint fields.

- ✅ Update `runSubstrateConformance`'s doc comment, which lists the universal invariants as "convergence, fresh-peer adoption". Add variant coherence.

- ✅ Update the header of `tests/conformance/src/conformance.test.ts` if its summary of what the battery covers no longer matches.

- ✅ `packages/schema/TECHNICAL.md` §"Atomic registers in the StateTree" notes that atomicity is what stops a concurrent variant switch blending fields. Add a sentence noting the property is now asserted across all substrates in `tests/conformance`, so the next person to touch register storage knows where the guard is.

- ✅ Add a pointer to `tests/conformance` in the root `TECHNICAL.md`. It is not
  mentioned there at all today, which means the document describing the
  architecture never names the suite that is supposed to be the executable
  specification of the substrate abstraction. One line, next to the existing
  substrate material.

- ✅ No `tests/conformance/TECHNICAL.md`. The suite is small and its doc comments
  carry the explanation; a separate file would duplicate them and drift.

- ✅ No CHANGELOG entry. This adds test coverage and changes no public behaviour. The bug it exposes gets its entry when it is fixed.

**Comments.** Why, not what. The three that carry weight here:

- ✅ Why the union's variants have _disjoint_ fields — blending is undetectable otherwise.
- ✅ Why the interior-write scenario asserts on the receiving peer — the writing peer's shadow makes the bug invisible.
- ✅ Why variant coherence is gated on nothing — four substrates, four mechanisms, one guarantee.

# Tests

This plan _is_ tests, so this section covers how to know they are worth having.

- ✅ **Every new scenario runs on all five profiles.** It is table-driven, so this is automatic — but confirm the count rises by five per scenario, rather than assuming.
- ✅ **The variant-switch scenario must be able to fail.** It passes on arrival, which proves nothing on its own. Verify by temporarily returning a blended value from the harness's read helper, or by asserting the negation once, and confirm it goes red on every profile. A test that has never been red is a guess.
- ✅ **The interior-write scenario must fail for the stated reason.** Confirm the
  failure is the stale value and not a throw, a timeout, or a bind error. Verified:
  `expected { from: 1, to: 7 } to deeply equal { from: 1, to: 2 }` on all five
  profiles — the message names the defect without anyone needing to open the file.
- ✅ **The existing eleven tests pass unchanged.** Any movement there means the schema extension was not neutral.
- ✅ **Full `npm run verify`.** Note the conformance package depends on built backend `dist` output, so `SKIP_BROTLI=1 npm run build` in `packages/schema` first if core changes are in flight.

# Transitive Effect Analysis [scratch]

**`ConformanceSchema` → all five profiles → `computeSchemaHash`.** Every profile binds the same schema object, so extending it changes the schema hash for all of them at once. Conformance documents are created fresh per test and never persisted, and both peers in every scenario use the same bound schema, so no compatibility surface is touched. Worth stating because "changing a shared schema" sounds riskier than it is here.

**New fields → substrate materialization at document creation.** Each substrate must materialize the sum at genesis, before any write. Both new fields are opaque plain values (`needsContainer === false`), so no container is created for them — the same path `PLAN-2026-08-01-opaque-boundary-unification` exercised. The `state` profile additionally runs them through `insertStructuralZeros` and the decay projection in `extractPlainState`; neither field sets `decayMs`, so that is a pass-through.

**`read()` helper → the convergence assertion.** It returns `{a, b}` only. Leaving it alone keeps the existing assertion exactly as it was, which is what makes the schema extension provably neutral. A later temptation to widen it into a whole-document compare would change what the existing scenarios assert; if that is ever wanted, it belongs in its own change with its own justification.

**The `ephemeral` profile.** `next.md` queues `ephemeral` for removal, and its capability matrix currently lists `state` as ❌ on sum atomicity — which `PLAN-2026-07-29-state-sum-atomicity` and `PLAN-2026-08-01-opaque-boundary-unification` have since made ✅, on `loro` and `yjs` too. Adding this scenario supplies the evidence that row should have been citing, so the matrix is worth correcting before it is used to justify that removal.

**Harness scenario count → suite runtime.** Each scenario spawns two `Exchange` instances and drains 60 rounds of micro/macro tasks, five times over. The suite runs in ~1.3s today; two more scenarios is a modest increase and no structural concern, but the drain loop is the dominant cost if it ever becomes one.

# Resources for Implementation [scratch]

- `tests/conformance/src/profiles.ts` — `ConformanceSchema`, the `SubstrateProfile` type, and the five profile rows.
- `tests/conformance/src/harness.ts` — `runSubstrateConformance`, the `spawn` and `drain` helpers, the partition-and-heal pattern, and the `read` helper.
- `tests/conformance/src/conformance.test.ts` — the table-driven entry point.
- `packages/schema/src/__tests__/opaque-boundary.test.ts` — the package-local matrix this generalizes, including the `inner()` cast helper for reaching into a `.nullable()` ref and the note on why assertions target replicated state.
- `packages/schema/src/__tests__/state-sum-atomicity.test.ts` — the `circle`/`square` union used here, and the register-atomicity property being asserted end-to-end.
- `packages/schema/TECHNICAL.md` §"Atomic registers in the StateTree" and §"Why one traversal, not many".

# Out of scope

**The sum-interior sync gap itself.** Measured and recorded in the accompanying issue note (`sum-interior-write-sync-issue.md`): a write inside a sum applies locally, bumps the substrate version, and fires the changefeed, but does not cause the Exchange to offer. It reproduces on all five substrates including `json`, so it is not a substrate defect. Phase 3 pins it; diagnosing and fixing it is separate work at the Exchange layer.

**Collapsing the three `opaque-boundary.test.ts` files.**
`PLAN-2026-08-01-opaque-boundary-unification` left near-identical suites in the
schema package and both backends (251 / 236 / 239 lines, with eight
identically-named `it(...)` blocks shared between yjs and loro alone). This plan
adds a fourth expression of the same invariants at the Exchange level.

The repository already has the pattern to collapse them: `positionConformance`
(`packages/schema/src/testing/position-conformance.ts`, exported via the
`@kyneta/schema/testing` subpath so backends get it without a runtime vitest
dependency) lets a backend supply a small factory and inherit a whole battery.
`makeArmedFault` in `@kyneta/exchange/testing` is the same move applied to store
fault injection, and explicitly "replaced the per-backend hand-rolled wrappers".

A `sumConformance(factory)` alongside `positionConformance` would reduce both
backend files to a call site. Deliberately not folded in here: it is a refactor of
existing tests with its own risk, and doing it inside this plan would make the
plan about two things. Worth its own issue while the shape is fresh.

**The `state` substrate's `MapChange` and sequence-change defects**, recorded in `state-substrate-issues.md`. Both are `state`-only and unrelated to sums. They do not surface here because `ConformanceSchema` has no bare `Schema.record` or `Schema.list` — and extending it to cover containers should wait until those are fixed, or the suite goes red for reasons that have nothing to do with this work.

# Alternatives Considered

**Add a `sumAtomicity` axis to `SubstrateProfile`.** Consistent with how `fieldConcurrency` and `liveCompactable` are handled, and it would make the matrix explicit. Rejected because every substrate must satisfy this one — an axis whose every row reads the same is noise, and it invites a future substrate to declare itself exempt from a guarantee that is not optional. Universal invariants in this harness are asserted unconditionally; only genuinely capability-gated behaviour gets a profile field.

**Use `.nullable()` for the coherence scenario instead of a discriminated union.** Simpler schema, one field instead of two. Rejected because a nullable struct's two variants are `null` and the struct, so a "blend" has nothing to blend _with_ — the failure mode is invisible. Disjoint fields across two populated variants are what make the assertion meaningful. The nullable struct is still needed, for the interior-write scenario, where its runtime-writable interior is the point.

**Assert only convergence, not coherence.** Cheaper, and equality is what the existing scenarios check. Rejected: two peers can agree perfectly on a blended value. That is precisely the `state` bug that `PLAN-2026-07-29-state-sum-atomicity` fixed — both peers converged, on a shape carrying a tag from one variant and fields from both. Equality would have passed throughout.

**Mark the interior-write gap `it.fails`, or pin the observed wrong value.** Both
were proposed and both were adopted at some point during planning — `it.fails` in
the first draft, the pinned value after the pre-implementation review pointed out
that `it.fails` passes on *any* failure. Both were rejected in the end for the
same reason, which neither argument had noticed: **they report green.** The three
sum bugs this plan guards against were live for an unknown period with a fully
green suite. Adding a fourth known-broken guarantee to that green suite would
repeat the exact failure this work exists to prevent. A red test is the point.

**Leave the interior-write gap out until it is fixed.** Keeps this change purely green. Rejected because the gap is invisible by construction — it looks correct from the writing peer, and it was found only by driving two real peers through the Exchange. An unrecorded bug of that shape does not get rediscovered; it gets re-experienced by a user, which is how the work in `PLAN-2026-08-01-opaque-boundary-unification` started.
