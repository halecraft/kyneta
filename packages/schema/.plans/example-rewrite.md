# Example Rewrite — Showcase the Full `@kyneta/schema` API Surface

## Background

`packages/schema/example/main.ts` is a 796-line self-contained example that demonstrates the `@kyneta/schema` package by building a thin facade (`createDoc`, `change`, `subscribe`) and then using it across 16 numbered sections. It was written before the apply-changes stack landed and before the library-level `change`, `applyChanges`, `subscribe`, and `subscribeTree` functions existed in `src/facade.ts`.

The example is well-structured and teaches effectively, but it now has three problems:

1. **The local facade is redundant.** The example defines its own `createDoc` (35 lines, complex generics, `toJSON` via `defineProperty`), `change` (returns doc for chaining), and `subscribe` (unwraps `Changeset` to individual `ChangeBase`). All three are superseded by library exports that are strictly better: the library `change` returns `PendingChange[]` (enabling round-trip), and the library `subscribe` preserves the `Changeset` protocol (enabling batch awareness and origin). The 115-line facade section is dead weight that makes the reader wonder "is this the real API?"

2. **Key capabilities are invisible.** The crown jewels of the apply-changes stack — `applyChanges`, `PendingChange[]` round-trip, `Changeset` batched delivery, `origin` provenance, `subscribeTree` as a library function — are entirely absent. Discriminated sums, nullable mutation, and the `step` pure-function primitives are also missing. The example showcases roughly 60% of the library's public surface.

3. **Stateful repetition.** `doc.settings` is mutated 17 times with 4 restore-to-clean-state cycles. Each section mutates, logs, then quietly restores for the next section. This is fragile (section order is load-bearing) and repetitive.

### Key library-level functions now available

| Function | Module | Purpose |
|---|---|---|
| `change(ref, fn)` → `PendingChange[]` | `src/facade.ts` | Imperative mutation capture |
| `applyChanges(ref, ops, opts?)` → `PendingChange[]` | `src/facade.ts` | Declarative change application |
| `subscribe(ref, cb)` → `() => void` | `src/facade.ts` | Node-level observation (preserves `Changeset`) |
| `subscribeTree(ref, cb)` → `() => void` | `src/facade.ts` | Tree-level observation (preserves `Changeset<TreeEvent>`) |

These four functions, combined with `interpret().with(readable).with(writable).with(changefeed).done()` and `createWritableContext`, constitute the complete high-level API. No local facade is needed.

## Problem Statement

The example is the primary onboarding artifact for `@kyneta/schema`. It should showcase the library's actual API surface — not a pre-library facade that hides the most impressive capabilities. A developer reading the example should come away understanding: schema definition, document creation, the five change types, the round-trip protocol, batched observation with origin, tree subscriptions, validation, and the composable layer architecture.

## Success Criteria

1. The local facade (`createDoc`, `change`, `subscribe`) is eliminated. Document creation uses inline `createWritableContext` + `interpret().with(...).done()`. Mutation capture uses the library-level `change`. Observation uses the library-level `subscribe` and `subscribeTree`.
2. The round-trip protocol is demonstrated: `change(docA, fn)` → ops → `applyChanges(docB, ops)` → assert equality. This is the sync story.
3. All five change types are visible in a single transaction: text, increment, sequence, replace, map.
4. `Changeset` batched delivery and `origin` provenance are demonstrated (not hidden behind unwrapping).
5. Discriminated sums are in the schema and demonstrated via variant dispatch + mutation.
6. Nullable mutation is demonstrated (set from `null` to a value and back).
7. `subscribeTree` is demonstrated via the library function (not raw `[CHANGEFEED]` symbol access).
8. Restore-to-clean-state cycles are eliminated by using fresh documents where section independence matters.
9. The example is shorter than today (~550–600 lines vs. 796), while covering more of the API surface.
10. The example runs cleanly: `npx tsx example/main.ts` produces well-formatted output.
11. `example/README.md` is updated to reflect the new structure.
12. TECHNICAL.md §Facade is updated to document `subscribe` and `subscribeTree`.
13. TECHNICAL.md File Map description for `example/main.ts` is updated.

## The Gap

### Missing capabilities

| Capability | Current status | After rewrite |
|---|---|---|
| Library-level `change()` → `PendingChange[]` | Not used (local `change` returns doc) | Primary mutation API |
| `applyChanges(ref, ops, {origin})` | Absent | Demonstrated with round-trip |
| `Changeset` protocol (batched delivery) | Hidden by local `subscribe` that unwraps | Shown directly |
| `origin` provenance on `Changeset` | Absent | Demonstrated via `applyChanges` with `{ origin: "sync" }` |
| Library-level `subscribe(ref, cb)` | Not used (local version) | Primary observation API |
| Library-level `subscribeTree(ref, cb)` | Not used (raw `[CHANGEFEED]` access) | Primary tree observation API |
| Discriminated sums | Absent from schema | In schema, demonstrated |
| Nullable mutation | `bio` in schema but never mutated | Demonstrated |
| `step` pure functions | Absent | Brief demonstration |
| `PendingChange` type constructors | Absent | Shown in `applyChanges` section |

### Structural issues to fix

- **115-line local facade** → eliminated (use library functions directly)
- **17 settings mutations, 4 restore cycles** → use fresh documents
- **Echo pattern bloat** (code written twice: once executable, once as log string) → reduce by making sections shorter and more focused
- **§9 (Referential Identity)** is 25 lines of `hasChangefeed`/`hasTransact` introspection → fold into other sections as brief asides
- **§14 (toPrimitive)** is a full section for a niche feature → shrink to a brief aside
- **§15 (Composition Algebra)** is pure prose → shorten since layers are already demonstrated

## Phases

### Phase 1: Rewrite `example/main.ts` 🔴

The new structure follows a narrative arc: **define → create → mutate → observe → round-trip → validate → compose**. Each section is self-contained where possible (fresh documents, no restore cycles).

- Task: Remove the local facade section (`createDoc`, `change`, `subscribe`). 🔴
- Task: Update imports to use library-level `change`, `applyChanges`, `subscribe`, `subscribeTree` from `src/index.js`. 🔴
- Task: Keep the `section()` and `log()` helpers (they're useful for formatted output). 🔴
- Task: Write the new sections as described below. 🔴
- Task: Verify `npx tsx example/main.ts` runs cleanly with well-formatted output. 🔴

#### New section structure

**§1 — Define a Schema** (~30 lines)

Same schema as today but add a discriminated sum field:

```ts
content: Schema.discriminatedUnion("type", [
  Schema.struct({ type: Schema.string("text"), body: LoroSchema.text() }),
  Schema.struct({ type: Schema.string("image"), url: LoroSchema.plain.string(), caption: LoroSchema.text() }),
])
```

Keep: `name` (text), `stars` (counter), `tasks` (list of struct), `settings` (plain struct), `bio` (nullable string), `labels` (record). Drop: `description` (redundant with `name` for demo purposes). Show `describe(schema)` output.

**§2 — Create a Document** (~20 lines)

Inline the wiring — no `createDoc` wrapper:

```ts
const store = Zero.overlay(seed, Zero.structural(ProjectSchema), ProjectSchema) as Store
const ctx = createWritableContext(store)
const doc = interpret(ProjectSchema, ctx)
  .with(readable).with(writable).with(changefeed).done()
```

Show `doc()` snapshot. Point out: 6 lines of setup, fully typed, no wrapper class.

**§3 — Mutations: Five Change Types** (~40 lines)

Demonstrate all five change types with auto-commit (one mutation each, brief):

- Text: `doc.name.insert(...)` — surgical character patch
- Counter: `doc.stars.increment(...)` — delta operation
- Sequence: `doc.tasks.push(...)` — O(k) list op
- Replace: `doc.settings.darkMode.set(...)` — whole-value swap
- Map: `doc.labels.set("bug", "red")` — key-level operation

Also demonstrate product `.set()` for bulk struct replacement. Show the contrast: leaf `.set()` for surgical, product `.set()` for bulk.

**§4 — Working with Collections** (~40 lines)

Demonstrate list and record navigation + mutation:

- List: `.at(i)`, `.get(i)`, `.length`, iteration via `for..of`, `.insert()`, `.delete()`
- Record: `.at(key)`, `.get(key)`, `.set()`, `.delete()`, `.has()`, `.keys()`, `.size`

**§5 — Sums and Nullables** (~25 lines)

Demonstrate discriminated union dispatch and nullable mutation:

- Read `doc.content.body()` (dispatches to "text" variant based on store discriminant)
- Nullable: `doc.bio` is `null` by default → set to a string → read → set back to `null`

**§6 — Transactions with `change()`** (~25 lines)

Use the library-level `change()`. Demonstrate it returns `PendingChange[]`:

```ts
const ops = change(doc, d => {
  d.name.insert(0, "✨ ")
  d.stars.increment(10)
  d.tasks.push({ title: "Ship it!", done: false, priority: 3 })
  d.settings.set({ darkMode: true, fontSize: 18 })
  d.labels.set("priority", "high")
})
```

Log `ops.length` and show each op's `change.type` — all five types in one transaction.

**§7 — Observing Changes** (~35 lines)

Use library-level `subscribe` and `subscribeTree`:

- `subscribe(doc.stars, cb)` — leaf subscription, show `Changeset` with `.changes` and `.origin`
- `subscribeTree(doc.settings, cb)` — tree subscription, show `TreeEvent` with relative `.path`
- Unsubscribe demonstration
- Contrast: `subscribe` is node-level, `subscribeTree` sees descendants

**§8 — The Round-Trip: `change` → `applyChanges`** (~30 lines)

The crown jewel. Two fresh documents from the same seed:

```ts
const ops = change(docA, d => {
  d.name.insert(5, " World")
  d.stars.increment(100)
  d.tasks.push({ title: "Review", done: false, priority: 1 })
})
applyChanges(docB, ops, { origin: "sync" })
```

Assert `docA()` deep-equals `docB()`. Show that `origin: "sync"` flows through to subscribers on docB. This is the sync/collaboration story in 10 lines.

**§9 — Batched Notification and Origin** (~25 lines)

Demonstrate that `applyChanges` delivers exactly one `Changeset` per affected path (not one per change), and that subscribers see fully-applied state when notified. Show `changeset.origin` carrying provenance.

**§10 — Portable Refs** (~20 lines)

Keep the best parts of the old §8: `tag(ref, label)` and `ensureMinimum(counter, min)`. Drop `resetSettings` (redundant). The point: refs are closures that carry their context — pass them to functions that know nothing about the document.

**§11 — Validation** (~30 lines)

Same as today but trimmed: `validate()` happy path, `tryValidate()` error collection, `SchemaValidationError` throw. Use the updated schema (with discriminated sum and nullable).

**§12 — The Composition Algebra** (~30 lines)

Demonstrate read-only documents by dropping layers:

```ts
const readOnly = interpret(schema, { store }).with(readable).done()
```

Show the fluent builder vs. manual composition. Brief mention of `toPrimitive` coercion (as an aside, not a full section). Mention the four symbol-keyed hooks.

**§13 — Pure State Transitions with `step`** (~15 lines)

Brief demonstration of `step` / `stepText` — apply a change to a plain value without any interpreter machinery:

```ts
stepText("Hello", textChange([{ retain: 5 }, { insert: " World" }]))
// → "Hello World"
```

The point: the change vocabulary works independently of the reactive document system.

**§14 — Final Snapshot** (~5 lines)

Show the final `doc()` output.

### Phase 2: Update `example/README.md` 🔴

- Task: Rewrite README to reflect the new section structure and the elimination of the local facade. 🔴
- Task: Update the "Key Concepts" section to feature `change`/`applyChanges`/`subscribe`/`subscribeTree` as library imports, not local functions. 🔴
- Task: Update the "Structure" section — the example no longer has a "Facade" half. 🔴
- Task: Update the section listing to match the new 14-section structure. 🔴

### Phase 3: Update TECHNICAL.md 🔴

- Task: Update §Facade to document `subscribe` and `subscribeTree` alongside `change` and `applyChanges`. 🔴
- Task: Update File Map description for `example/main.ts` — no longer "self-contained mini-app with createDoc, change, subscribe". 🔴
- Task: Update Verified Properties with subscribe/subscribeTree invariants if not already present. 🔴

### Phase 4: Update plan status 🔴

- Task: Mark subscribe-facade.md phases as complete (the subscribe/subscribeTree functions already exist in `src/facade.ts` and are exported from `src/index.ts`). 🔴

## Tests

No new tests are needed. The example is a runnable demonstration, not a test suite. The library functions it uses (`change`, `applyChanges`, `subscribe`, `subscribeTree`) are already exhaustively tested in `facade.test.ts` (39 tests including 5 re-entrancy tests) and `changefeed.test.ts`.

**Validation:** Run `npx tsx example/main.ts` and verify clean output. This is a manual check, not an automated test.

## Transitive Effect Analysis

| Change | Affected | Impact |
|---|---|---|
| Rewrite `example/main.ts` | `example/README.md` | Must be updated to match new structure — handled in Phase 2 |
| Rewrite `example/main.ts` | `TECHNICAL.md` File Map | Description references "createDoc, change, subscribe" — updated in Phase 3 |
| Rewrite `example/main.ts` | `@kyneta/core` | No impact — core has its own runtime subscribe |
| Rewrite `example/main.ts` | `src/facade.ts` | No changes needed — functions already exist and are exported |
| Rewrite `example/main.ts` | `src/index.ts` | No changes needed — `subscribe` and `subscribeTree` are already exported |
| Rewrite `example/main.ts` | `.plans/subscribe-facade.md` | Phase status update — the functions exist but the plan may show them as 🔴 |
| Rewrite `example/main.ts` | Test suite | No impact — tests don't import from `example/` |
| TECHNICAL.md §Facade update | Downstream readers | Additive — documents existing but undocumented functions |

## Resources for Implementation Context

- `packages/schema/example/main.ts` — the file being rewritten. Read for current structure and output format.
- `packages/schema/example/README.md` — documentation for the example. Must be updated.
- `packages/schema/src/facade.ts` — library-level `change`, `applyChanges`, `subscribe`, `subscribeTree`. Read for exact signatures and JSDoc.
- `packages/schema/src/index.ts` — barrel exports. Verify `subscribe`, `subscribeTree`, `step`, `stepText` etc. are exported.
- `packages/schema/src/step.ts` — pure state transition functions. Read for `stepText` signature.
- `packages/schema/src/zero.ts` — `Zero.structural`, `Zero.overlay`. Read for usage pattern.
- `packages/schema/src/change.ts` — `textChange`, `sequenceChange`, `replaceChange`, `incrementChange`, `mapChange` constructors. Needed for `applyChanges` section.
- `packages/schema/src/changefeed.ts` — `Changeset`, `TreeEvent`, `CHANGEFEED`. Types used in observation sections.
- `packages/schema/src/describe.ts` — `describe(schema)` for schema tree view.
- `packages/schema/src/interpret.ts` — `interpret()` fluent builder API.
- `packages/schema/src/layers.ts` — `readable`, `writable`, `changefeed` layer instances.
- `packages/schema/src/interpreters/writable.ts` — `createWritableContext`, `PendingChange`.
- `packages/schema/src/interpreters/validate.ts` — `validate`, `tryValidate`, `SchemaValidationError`, `formatPath`.
- `packages/schema/TECHNICAL.md` — architectural documentation. §Facade needs update.
- `packages/schema/.plans/subscribe-facade.md` — plan for subscribe/subscribeTree (already implemented).
- `packages/schema/src/__tests__/facade.test.ts` — test fixtures (`createChatDoc`, `chatDocSchema`) for reference on schema + document creation patterns.

## Alternatives Considered

### Keep the local facade and just add new sections

This would add round-trip and `applyChanges` demonstrations without removing the local `createDoc`/`change`/`subscribe`. Rejected because it makes the example longer (not shorter), leaves the reader confused about which API is real, and the local `change` (returning doc) actively contradicts the library `change` (returning `PendingChange[]`). The local `subscribe` (unwrapping `Changeset`) hides the batch protocol. Keeping both would require explaining "this is the example's version, the library version is different" — the opposite of clarity.

### Split into multiple example files

One file per section theme (mutations.ts, subscriptions.ts, round-trip.ts, etc.). Rejected because the narrative arc is the point — the reader follows a single document from schema definition through to final snapshot, seeing capabilities build on each other. Multiple files lose this continuity and force the reader to context-switch between files. A single file that runs top-to-bottom is the right format for a "here's what this library can do" showcase.

### Use a test-like assertion framework instead of `console.log`

Replace `log()` calls with `assert()` or `expect()` to make the example a runnable test. Rejected because the example is a teaching artifact, not a test. `console.log` output is essential — the developer runs `npx tsx example/main.ts` and reads the output. The test suite (`facade.test.ts`, `changefeed.test.ts`, etc.) already provides exhaustive correctness verification. The example's job is to impress and teach, not to verify.

### Keep `createDoc` as a thin convenience

Reduce `createDoc` to the 6-line wiring inline but wrap it in a named function for reuse within the example. Rejected because the example benefits from showing the raw wiring at least once — it proves there's no magic. For sections that need fresh documents (e.g. the round-trip), a small local helper function that creates a document from the schema + seed is fine, but it should be ~4 lines, not a generic typed facade.

## Changeset

This change is a **documentation/example rewrite** — no library source code is modified (aside from TECHNICAL.md). The changeset touches:

- `packages/schema/example/main.ts` — full rewrite
- `packages/schema/example/README.md` — rewrite to match
- `packages/schema/TECHNICAL.md` — §Facade update, File Map update
- `packages/schema/.plans/subscribe-facade.md` — status updates