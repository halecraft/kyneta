# Learnings: Decoupling @kyneta/cast from @loro-extended

Technical findings from migrating `@kyneta/cast`'s reactive protocol from the
two-symbol `REACTIVE`+`SNAPSHOT` design (`@loro-extended/reactive`) to the
single-symbol `CHANGEFEED` coalgebra (`@kyneta/schema`).

## Facts

### The dependency was completely dead

`@loro-extended/reactive` and `@loro-extended/change` do not exist in this
monorepo. They are not in any `package.json`, not in `node_modules`, and every
import from them was a dead reference. Before the migration, **13 of 24 test
files** failed at the module-loading stage — not at assertion time. The code
hadn't been runnable since the packages were removed.

`@kyneta/schema` was listed as a `workspace:^` dependency in `package.json`
but had zero imports in any core source file. It was a phantom dependency.

### Schema needed to be built before core tests could import it

`@kyneta/schema`'s `package.json` points `main` at `./dist/index.js`, but the
`dist/` directory didn't exist. Vitest resolves workspace dependencies through
the `exports` map, so you must run `npx tsdown` in the schema package before
core's tests can import from `@kyneta/schema`. This is easy to forget and
produces a confusing Vite error: `Failed to resolve entry for package`.

### DOM comment markers are not IR vocabulary

The IR `DeltaKind` type uses vocabulary like `"sequence"` (formerly `"list"`).
But the SSR hydration system emits DOM comment markers like
`<!--kyneta:list:1-->` via `RegionMarkerType = "list" | "if"` in
`html-constants.ts`. These are **different namespaces**: one is an internal IR
discriminant, the other is a user-facing HTML convention parsed by the
hydration system. Renaming the IR vocabulary does not require renaming the DOM
markers. We kept `"list"` for markers because it's clearer in HTML output, and
changing it would ripple into `hydrate.ts`, `html.ts` codegen, and all
template tests that assert on marker content.

### `getDeltaKind` needed a legacy mapping, not just an allowlist update

When Phase 1 changed `DeltaKind` from `"list"` to `"sequence"`, the compiler's
`getDeltaKind()` function (which extracts the delta kind from TypeScript types
at compile time) still encountered `"list"` from existing type stubs that
hadn't been rewritten yet. Simply adding `"sequence"` to the allowlist was
insufficient — we also needed `if (value === "list") return "sequence"` to
bridge the gap until Phase 4 rewrites the type stubs. Without this mapping,
`"list"` would have fallen through to `"replace"`, silently disabling all list
region optimizations.

**Lesson:** When renaming a discriminant that flows through a type-extraction
pipeline, you need a compatibility mapping at the extraction point, not just at
the definition point.

### `SequenceInstruction.insert` carries items, not a count

The old `ListDeltaOp.insert` was a `number` (count of inserted items). The new
`SequenceInstruction.insert` is `readonly T[]` (the actual items). The DOM
runtime doesn't use these items — it reads `.insert.length` as the count and
looks up refs from the live ref tree via `listRef.at(index)`. This is the
"two-layer model":

- **Change layer** carries plain values (for `step()` / pure computation)
- **Ref layer** carries reactive handles (for DOM handlers)

`planDeltaOps` bridges the two: it reads the count from the change, then
fetches refs from the live ref tree. The plain values in the change are
discarded by the DOM runtime.

### `.get()` vs `.at()` — a semantic distinction that matters

Schema's `ReadableSequenceRef` has both `.at(index)` (returns child **ref**)
and `.get(index)` (returns plain **value**). The old `ListRefLike<T>` used
`.get()` to mean "give me a ref", which is the opposite of schema's
convention. We renamed to `.at()` to prevent a subtle semantic mismatch. Core
owns a minimal `ListRefLike<T>` interface:

```typescript
interface ListRefLike<T> {
  readonly length: number
  at(index: number): T | undefined
}
```

Schema's `ReadableSequenceRef` structurally satisfies this (duck typing) — no
nominal import needed. The coupling is at the protocol level, not the
interpreter level.

### `subscribeWithValue`'s `getValue` closure is NOT `CHANGEFEED.current`

`subscribeWithValue(ref, getValue, onValue, scope)` takes a caller-provided
`getValue` closure. It's tempting to replace this with `ref[CHANGEFEED].current`,
but that would be wrong. The `getValue` closure evaluates the **user's compiled
expression** (e.g. `() => doc.count.get().toString()`), which may transform the
ref's raw value. `CHANGEFEED.current` returns the ref's own value without
transformation. The two serve different purposes. The plan correctly identified
this and we preserved the closure pattern.

### `origin` on `ChangeBase` is a one-line schema change with outsized impact

`inputTextRegion` dispatches `setRangeText` selectMode based on
`change.origin === "local"` (cursor follows edit) vs everything else (cursor
preserves position). Without the `origin` field on `ChangeBase`, all edits
would use `"preserve"` mode, causing the cursor to stay at position 0 during
local typing — a showstopper UX bug. Adding `origin?: string` to `ChangeBase`
was a one-line, backward-compatible change in schema, but it was load-bearing
for the entire input text region feature.

### `getOrCreateChangefeed` is the right caching pattern for `LocalRef`

`LocalRef`'s `[CHANGEFEED]` getter uses `getOrCreateChangefeed(this, factory)`
from `@kyneta/schema`, which provides WeakMap-based caching. This ensures
`ref[CHANGEFEED] === ref[CHANGEFEED]` (referential identity) without
per-instance allocation at construction time. The changefeed object is created
lazily on first access and cached for the lifetime of the ref. This is the
same pattern schema's own interpreters use.

The `this` capture inside the factory closure requires a `const self = this`
assignment because the changefeed object outlives the getter call.

## New Findings and Insights

### Phase ordering has hidden type-system dependencies

Phase 1 (IR vocabulary) seemed like a "pure data-level change", but it
actually required touching `getDeltaKind` in the compiler detection module
(nominally a Phase 4 concern) because the return type is `DeltaKind`.
After removing `"list"` from the union, TypeScript would reject any code path
that returns `"list"`. The plan's phase boundaries were conceptually clean but
the type system enforced a tighter coupling.

**Lesson:** In TypeScript, changing a union type's members is not a localized
change — every function that returns or accepts that type is affected.

### Five test files were recovered as side effects

Rewriting `subscribe.ts` to use `CHANGEFEED` also unblocked `hydrate.test.ts`
and `mount.test.ts`, which depend on `subscribe.ts` transitively. These files
had no `@loro-extended` imports of their own — they failed only because
`subscribe.ts` failed to load. We went from 13 → 8 failing test files in one
phase. Always check transitive dependencies when assessing blast radius.

### Test stub narrowness is critical for compiler detection

The compiler's `getDeltaKind` extracts a string literal type from the
TypeScript type system. If a test stub declares
`[CHANGEFEED]: Changefeed<unknown, ChangeBase>`, the `type` property resolves
to `string` (not a string literal), `isStringLiteral()` returns false, and
delta kind silently falls back to `"replace"`. Every ref type stub **must**
declare a specific change type:

```typescript
// ✅ Correct: getDeltaKind extracts "text"
[CHANGEFEED]: Changefeed<string, TextChange>

// ❌ Wrong: getDeltaKind falls back to "replace"
[CHANGEFEED]: Changefeed<string, ChangeBase>
```

This is not a new finding (it was documented in the plan and TECHNICAL.md for
the old `REACTIVE` protocol), but it's the kind of thing that bites you on
every new test you write if you forget.

### Mock infrastructure for CHANGEFEED is simpler than REACTIVE

The old mock required constructing an object with two symbol-keyed functions
(`[REACTIVE]` taking `(self, callback)` and `[SNAPSHOT]` taking `(self)`).
The new mock is a plain object with a `[CHANGEFEED]` property containing
`{ current, subscribe }` — no `self` parameter gymnastics, just a standard
coalgebra:

```typescript
const ref = {
  [CHANGEFEED]: {
    get current() { return value },
    subscribe(cb) { listener = cb; return () => { listener = null } },
  },
}
```

This is meaningfully less error-prone in test code.

## Corrections to Previous Assumptions

### Phase 2 → Phase 3 dependency is softer than the plan states

The plan positioned Phase 2 (LocalRef) as a hard prerequisite for Phase 3
(runtime rewiring) because "runtime and compiler tests depend on having a local
reactive primitive." In practice, Phase 3's tests only need any object that
implements `[CHANGEFEED]` — bare mock objects work fine. `LocalRef` is the
*cleanest* fixture but not the *only* option. If you needed to parallelize,
Phase 3's test mocks could be written as inline objects without Phase 2.

### The plan's codegen task 2 ("update `"list"` in codegen dispatch sites") found nothing to change

The plan said to update `"list"` string literals in `dom.ts` and `html.ts`
codegen. Investigation revealed that `dom.ts` has **no** `"list"` delta kind
literals — it dispatches on `isTextRegionContent(node)` which checks
`deltaKind === "text"` internally. `html.ts` has `"list"` only as a DOM marker
type string (see the marker discussion above), not a delta kind. The task was
correctly marked complete with a note that no changes were needed.

### The remaining 8 test failures split cleanly into two categories

After Phase 3, the remaining failures are:

**Phase 4 targets** (compiler detection — need type stub rewiring):
- `integration.test.ts` — imports `@loro-extended/change` at top level
- `transform.test.ts` — `@loro-extended/change` module resolution in source strings
- `plugin.test.ts` — hardcoded `@kyneta/cast/runtime` import path assertion

**Phase 5 targets** (Loro removal — entire files to delete or gut):
- `binding.test.ts` — uses `loro()` unwrapper
- `edit-text.test.ts` — uses `TextRef` from `@loro-extended/change`
- `serialize.test.ts` — uses `LoroDoc` from `loro-crdt`
- `ssr.test.ts` — uses `createTypedDoc` from `@loro-extended/change`
- `todo.test.ts` — uses `createTypedDoc` and `PlainValueRef`

None of these require runtime changes — they are all either compiler pipeline
rewiring or dead Loro code removal.