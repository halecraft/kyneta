# Plan: Delta Provenance — Origin-Aware Reactive Deltas

## Background

Kinetic's delta region algebra maps CRDT deltas to surgical DOM mutations. Each region type — `textRegion`, `inputTextRegion`, `listRegion`, `conditionalRegion` — subscribes to a reactive ref, receives a `ReactiveDelta`, and applies the minimum DOM operation. This algebra is the core performance story: O(k) updates where k is the edit size, not the document size.

The algebra currently treats all deltas as **context-free**: a delta arrives, it gets mapped to a DOM operation. But `<input>` elements have **ephemeral local state** — the cursor position (selection range) — that is invisible in the delta. The correct DOM mutation depends on the **relationship** between this invisible state and the delta's origin.

### The Bug

Typing "Hello" into the kinetic-todo input field produces "olleH". The chain:

1. `beforeinput` → `editText` handler → `e.preventDefault()` (browser does NOT update input or cursor)
2. Handler reads `selectionStart = 0`, calls `ref.insert(0, "H")`
3. `commitIfAuto()` → subscription fires → `patchInputValue` → `setRangeText("H", 0, 0, "preserve")`
4. Per the HTML spec, `"preserve"` does NOT advance the cursor when `selectionStart === rangeStart` — cursor stays at 0
5. Next keystroke: `selectionStart` is still 0, so `ref.insert(0, "e")` → value becomes `"eH"`

Every character is inserted at position 0 because the cursor never advances.

### The Incorrect Assumption

The input-text-region plan (Learning #2) stated:

> `setRangeText("preserve")` eliminates cursor arithmetic — insert before cursor shifts it right

This is only true when the insertion range is **strictly before** the cursor (`selectionStart > end`). Per the HTML spec for `setRangeText` with `"preserve"`:

- If `selectionStart > end`: increment by delta ✅
- If `selectionStart > start`: snap to `start` (not an advance)
- If `selectionStart === start`: **no change**

The last case is exactly what happens during local typing — the insertion point IS the cursor position. `"preserve"` was designed for edits happening *elsewhere* in the text, not at the cursor.

### The Fix: Origin-Driven SelectMode Dispatch

The `setRangeText` API has two selectModes that are complementary:

- `"preserve"` — correct for **remote** edits (shifts cursor when edit is before it, leaves it when after)
- `"end"` — correct for **local** edits (places cursor at end of replacement range)

Verification of `"end"` for all local operation types:

| Operation | setRangeText call | Cursor result | Correct? |
|-----------|-------------------|---------------|----------|
| Insert "H" at pos 0 | `("H", 0, 0, "end")` | cursor → 1 (0 + 1) | ✅ |
| Insert "e" at pos 1 | `("e", 1, 1, "end")` | cursor → 2 (1 + 1) | ✅ |
| Backspace at pos 3 in "Hello" | `("", 2, 3, "end")` | cursor → 2 (2 + 0) | ✅ |
| Delete forward at pos 2 in "Hello" | `("", 2, 3, "end")` | cursor → 2 (2 + 0) | ✅ |
| Replace "llo" (2–5) with "y" | delete `("", 2, 5, "end")` then insert `("y", 2, 2, "end")` | cursor → 3 | ✅ |
| Paste "World" at pos 5 | `("World", 5, 5, "end")` | cursor → 10 | ✅ |

Verification of `"end"` for **local undo/redo** (Loro undo fires with `by: "local"`):

| Operation | Cursor result with `"end"` | UX |
|-----------|---------------------------|-----|
| Undo insertion (delta has delete) | Cursor goes to deletion point | ✅ User sees where text was removed |
| Undo deletion (delta has insert) | Cursor goes to end of re-inserted text | ✅ User sees where text was restored |

Verification of `"preserve"` for **remote** edits:

| Remote edit | Local cursor at 5 | Cursor result with `"preserve"` | Correct? |
|-------------|--------------------|---------------------------------|----------|
| Insert "XYZ" at pos 0 | `selectionStart (5) > end (0)` → `+3` | cursor → 8 | ✅ |
| Insert "XYZ" at pos 7 | `selectionStart (5) > end (7)`? No → no change | cursor → 5 | ✅ |
| Delete at pos 0–3 | `selectionStart (5) > end (3)` → `-3` | cursor → 2 | ✅ |

Both selectModes handle their respective cases correctly. The only information needed to choose between them is the delta's **origin** — which Loro already provides.

### Loro's `by` Field Is Sufficient

The earlier plan noted that `hooks-core` avoids using `event.by === "local"` because it conflates user input with undo/redo. However, that concern was specific to `hooks-core`'s approach of *skipping* the subscription for local edits (which would incorrectly skip undo). Our approach is different: we *always* apply the delta — we just choose a different `selectMode`. Both user input and local undo/redo want `"end"` selectMode (teleport cursor to the edit site), so `origin === "local"` is the correct discriminant.

## Problem Statement

1. **Typing into `<input>` elements is backwards.** The cursor never advances because `setRangeText("preserve")` doesn't move the cursor when inserting at the cursor position.

2. **The delta algebra has no provenance dimension.** `ReactiveDelta` carries what changed but not who caused it. Consumers that need origin-aware behavior (input cursor management, animation hints, conflict visualization) have no way to distinguish local from remote edits.

3. **The reactive bridge discards available information.** Loro's `LoroEventBatch.by` field is present but stripped during translation in `translateEventBatch`.

## Success Criteria

- `ReactiveDelta` carries an optional `origin` field (`"local"` | `"import"` | undefined)
- `translateEventBatch` forwards the `by` field from `LoroEventBatch` as `origin`
- `patchInputValue` accepts an optional `selectMode` parameter (default `"preserve"`)
- `inputTextRegion` passes `"end"` when `delta.origin === "local"`, `"preserve"` otherwise
- `editText` requires no changes — it remains a pure CRDT write function
- Typing "Hello" into the kinetic-todo input field produces "Hello" with cursor at position 5
- Remote edits to a text input preserve the local user's cursor position
- All existing text patching, list region, and conditional region tests continue to pass
- `textRegion` (Text nodes) is unaffected — it has no cursor concept

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| `ReactiveDelta` | No origin information | Optional `origin: "local" \| "import"` field |
| `translateEventBatch` | Strips `by` field | Forwards `by` as `origin` on each delta |
| `patchInputValue` | Hardcoded `"preserve"` selectMode | Accepts optional `selectMode` parameter (default `"preserve"`) |
| `inputTextRegion` | Always passes `"preserve"` | Dispatches on `delta.origin`: `"end"` for local, `"preserve"` otherwise |
| `editText` | No DOM update, no cursor management | **No change needed** — cursor managed by `setRangeText("end")` through the subscription |
| Unit tests | No round-trip cursor test | Tests for local typing, remote insert, undo cursor behavior |

## Phase 1: Add `origin` to `ReactiveDelta` ✅

Extend the delta vocabulary with provenance metadata.

### Tasks

1. Add optional `origin` field to each named delta type in `packages/reactive/src/index.ts` ✅

   The field is optional so that non-Loro reactive types (e.g., `LocalRef`) don't need to provide it. When absent, consumers treat the delta as origin-unknown and fall back to safe behavior (`"preserve"`).

   ```typescript
   export type DeltaOrigin = "local" | "import"

   export type ReplaceDelta = { type: "replace"; origin?: DeltaOrigin }
   export type TextDelta = { type: "text"; ops: TextDeltaOp[]; origin?: DeltaOrigin }
   export type ListDelta = { type: "list"; ops: ListDeltaOp[]; origin?: DeltaOrigin }
   export type MapDelta = { type: "map"; ops: MapDeltaOp; origin?: DeltaOrigin }
   export type TreeDelta = { type: "tree"; ops: TreeDeltaOp[]; origin?: DeltaOrigin }
   ```

2. Export `DeltaOrigin` from `packages/reactive/src/index.ts` ✅

3. Update `translateEventBatch` in `packages/change/src/reactive-bridge.ts` to forward the `by` field ✅

   The function currently casts `eventBatch` as `{ events: Array<{ diff: unknown }> }`. Extend the cast to include `by?: string`. Pass it to `translateDiff` which attaches it to the returned delta.

4. Update `translateDiff` to accept and attach an optional origin parameter ✅

   For the `REPLACE_DELTA` singleton optimization: return `origin ? { type: "replace", origin } : REPLACE_DELTA`. This preserves the singleton for the no-origin case (e.g., `LocalRef`) while correctly attaching origin when present.

5. Add tests for origin forwarding in `packages/change/src/reactive-bridge.test.ts` ✅

   - `translateEventBatch` with `by: "local"` → each delta has `origin: "local"`
   - `translateEventBatch` with `by: "import"` → each delta has `origin: "import"`
   - `translateEventBatch` with no `by` field → each delta has `origin: undefined`

## Phase 2: Origin-Driven SelectMode in `patchInputValue` + `inputTextRegion` ✅

The core cursor fix. `patchInputValue` gains a selectMode parameter; `inputTextRegion` dispatches on `delta.origin`.

### Tasks

1. Update `patchInputValue` in `packages/kinetic/src/runtime/text-patch.ts` to accept an optional `selectMode` parameter ✅

   Default to `"preserve"` for backward compatibility. The parameter is passed through to every `setRangeText` call.

   ```typescript
   export function patchInputValue(
     input: HTMLInputElement | HTMLTextAreaElement,
     ops: TextDeltaOp[],
     selectMode: "preserve" | "end" = "preserve",
   ): void
   ```

2. Update `inputTextRegion` in `packages/kinetic/src/runtime/text-patch.ts` to dispatch selectMode on `delta.origin` ✅

   ```typescript
   subscribe(ref, (delta: ReactiveDelta) => {
     if (delta.type === "text") {
       const mode = delta.origin === "local" ? "end" : "preserve"
       patchInputValue(input, delta.ops, mode)
     } else {
       input.value = typedRef.get()
     }
   }, scope)
   ```

   No changes to `editText` are needed. It remains a pure CRDT write function — the subscription's `setRangeText("end")` handles cursor positioning for local edits automatically.

## Phase 3: Tests ✅

### Tasks

1. Add round-trip cursor test to `packages/kinetic/src/loro/edit-text.test.ts` ✅

   Simulate typing "Hello" one character at a time through the full `editText` → CRDT → subscription → DOM cycle. After each keystroke, verify both `ref.toString()` and `input.selectionStart`. This is the test that would have caught the original bug. Requires wiring `inputTextRegion` to the same input element, with a real `Scope` and subscription.

2. Add remote edit cursor preservation test to `packages/kinetic/src/runtime/text-patch.test.ts` ✅

   Wire `inputTextRegion` on an input with cursor at position 5. Simulate a remote text delta (with `origin: "import"` or `origin: undefined`) inserting at position 0. Verify cursor shifted to position 8 (5 + inserted length). Verify `input.value` is correct.

3. Add origin-forwarding tests to `packages/change/src/reactive-bridge.test.ts` (covered in Phase 1 task 5) ✅

4. Verify existing `patchInputValue`, `textRegion`, `listRegion`, and `conditionalRegion` tests still pass ✅

## Phase 4: Documentation ✅

### Tasks

1. Update `packages/kinetic/TECHNICAL.md` — Input Text Region Architecture section ✅

2. Update `packages/kinetic/TECHNICAL.md` — Delta Region Algebra section ✅

3. Update `packages/change/TECHNICAL.md` — Reactive Bridge section ✅

4. Update `TECHNICAL.md` (root) — REACTIVE Callback Signature section ✅

5. Correct Learning #2 in `.plans/kinetic-input-text-region.md` ✅

6. Correct TECHNICAL.md files to reflect selectMode dispatch instead of active-edit flag mechanism ✅

   Corrected stale `setRangeText("preserve")` references in `packages/kinetic/TECHNICAL.md` (Loro Bindings Subpath), `examples/kinetic-todo/README.md` (What This Shows + How It Works), and `.changeset/input-text-region-edit-text.md`. Also created `.changeset/delta-provenance.md` for the reactive and change package changes.

## Tests

### Phase 1: `ReactiveDelta` origin

```
describe("translateEventBatch with origin", () => {
  it("forwards by:'local' as origin:'local' on each delta")
  it("forwards by:'import' as origin:'import' on each delta")
  it("handles missing by field — origin is undefined")
})

describe("translateDiff with origin", () => {
  it("attaches origin to text delta")
  it("attaches origin to list delta")
  it("attaches origin to replace delta")
  it("omits origin when undefined")
})
```

### Phase 2: Cursor behavior

```
describe("patchInputValue with selectMode", () => {
  it("uses 'preserve' by default (backward compatible)")
  it("uses 'end' when selectMode is 'end'")
  it("cursor advances past insert with 'end'")
  it("cursor stays at delete point with 'end'")
  it("cursor shifts for remote insert before cursor with 'preserve'")
  it("cursor unchanged for remote insert after cursor with 'preserve'")
})

describe("editText + inputTextRegion round-trip", () => {
  it("typing 'Hello' produces 'Hello' with cursor at position 5")
  it("backspace at position 3 in 'Hello' produces 'Helo' with cursor at 2")
  it("pasting 'World' at position 5 in 'Hello' produces 'HelloWorld' with cursor at 10")
})

describe("inputTextRegion remote edits", () => {
  it("remote insert before cursor shifts cursor right")
  it("remote insert after cursor leaves cursor unchanged")
  it("remote delete before cursor shifts cursor left")
})
```

### Phase 3: Regression

All existing tests in `text-patch.test.ts`, `edit-text.test.ts`, `integration.test.ts`, `reactive-bridge.test.ts` must continue to pass. The `patchInputValue` default parameter (`"preserve"`) ensures backward compatibility.

## Transitive Effect Analysis

### `ReactiveDelta` type change → all subscribers

Adding an optional `origin` field is non-breaking. Existing pattern matches on `delta.type` are unaffected. Consumers that destructure deltas (`{ type, ops }`) continue to work — `origin` is simply ignored. The `ReactiveDelta` union discriminant is still `type`.

**Risk: Low.** Optional field addition on an interface-like type.

### `translateEventBatch` signature unchanged → no downstream breakage

The function signature doesn't change. The callback still receives `ReactiveDelta`. The only difference is the deltas now carry `origin`. Consumers that ignore it are unaffected.

**Risk: None.**

### `translateDiff` signature change → internal only

`translateDiff` gains an optional `origin` parameter. It's only called from `translateEventBatch` (also internal). No external callers.

**Risk: None.** Both functions are in the same module.

### `REPLACE_DELTA` singleton → conditional allocation

The pre-allocated `REPLACE_DELTA` singleton (`{ type: "replace" }`) in `reactive-bridge.ts` cannot carry `origin`. When `origin` is defined, `translateDiff` returns a new object `{ type: "replace", origin }` instead of the singleton. When `origin` is undefined, the singleton is still used. This is a minor allocation increase for counter diffs with origin — negligible in practice.

**Risk: None.**

### `patchInputValue` signature change → default parameter preserves compatibility

The new `selectMode` parameter defaults to `"preserve"`. All existing callers (including direct calls in tests) are unaffected — they get the same behavior as before.

**Risk: None.**

### `inputTextRegion` behavior change → all input/textarea with TextRef value

The subscription callback now dispatches selectMode based on `delta.origin`:
- `origin === "local"` → `"end"` (cursor follows edit)
- anything else → `"preserve"` (cursor preserves position)

For inputs without `editText` (read-only display), all changes come from remote or programmatic mutations — `origin` is either `"import"` or `undefined`, both of which use `"preserve"`. Same behavior as before.

**Risk: Low.** The dispatch is a pure function of the delta — no side channels, no mutable state.

### `editText` — no changes needed

The handler remains a pure CRDT write function. It calls `e.preventDefault()`, mutates the ref, and returns. The subscription chain handles all DOM updates and cursor positioning via `setRangeText("end")`.

**Risk: None.**

### `@loro-extended/reactive` package version bump

Adding `DeltaOrigin` and the `origin` field to all delta types is a minor/patch change (additive, non-breaking). Consumers importing named delta types see the new optional field.

**Risk: None.** Additive type change.

### `hooks-core` — not affected

`hooks-core` subscribes to raw Loro containers directly (`loroRef.subscribe`), not through `[REACTIVE]`. The `ReactiveDelta` change doesn't affect it.

### Existing `textRegion` (Text nodes) — not affected

`textRegion` has no cursor concept. It receives deltas with `origin` and ignores it. `patchText` uses `insertData`/`deleteData` which have no selectMode.

### Existing `listRegion` / `conditionalRegion` — not affected

These regions don't interact with cursor state. The `origin` field is ignored.

### Loro-agnostic runtime boundary — preserved

The `inputTextRegion` function reads `delta.origin`, which is typed as `DeltaOrigin` from `@loro-extended/reactive`. This is not a Loro type — `reactive` is the Loro-agnostic foundation package. No imports from `@loro-extended/change` or Loro are introduced into `text-patch.ts`.

## Alternatives Considered

### Alternative: Skip subscription during local edits + active-edit flag

The original version of this plan proposed a `WeakSet<Element>`-based active-edit flag in `editText`, a pluggable `setActiveEditPredicate` to preserve the Loro-agnostic runtime boundary, and explicit cursor management via `setSelectionRange` in `editText`. During local edits, `inputTextRegion` would skip `patchInputValue` entirely.

Rejected because it is unnecessarily complex — 6 tasks, module-level mutable state, a registration pattern, and duplication of `calculateNewCursor` from `hooks-core`. The origin-driven selectMode dispatch achieves the same result with 2 tasks, no mutable state, no cursor arithmetic, and no cross-module coordination. The key insight: `setRangeText("end")` is correct for all local operations (insert, delete, replace, undo, redo), so dispatching on `delta.origin` alone is sufficient.

### Alternative: Post-correct cursor without changing selectMode (Response 3 from research)

Keep `inputTextRegion` unchanged, let it apply `setRangeText("preserve")`, then have `editText` override the cursor with `setSelectionRange` after the synchronous chain. Rejected because `editText` would need cursor arithmetic (`calculateNewCursor`), creating code duplication with `hooks-core`. Also less principled — it applies the wrong selectMode then immediately corrects the result, rather than applying the right selectMode in the first place.

### Alternative: `editText` handles DOM update directly, no subscription for local edits (Response 2 from research)

Have `editText` do `input.value = ref.toString()` + `setSelectionRange` after the CRDT mutation, and use an `isLocalChange` flag to suppress the subscription. Rejected because it means the read direction (`inputTextRegion`) and write direction (`editText`) are no longer independent — `editText` must replicate the DOM update logic. Also, `input.value = ...` is O(n) full replacement, losing the surgical benefit of `setRangeText`.

### Alternative: Add provenance to `ReactiveSubscribe` callback signature instead of delta

Change the callback from `(delta: D) => void` to `(delta: D, origin?: DeltaOrigin) => void`. Rejected because it breaks the existing callback contract. Every subscriber would need to be updated to accept two arguments. Putting `origin` on the delta object is additive and non-breaking.

## Resources for Implementation Context

### Files to Read

- `packages/reactive/src/index.ts` — `ReactiveDelta` union and all named delta types (modify)
- `packages/change/src/reactive-bridge.ts` — `translateEventBatch`, `translateDiff` (modify)
- `packages/change/src/reactive-bridge.test.ts` — existing batch translation tests (extend)
- `packages/kinetic/src/runtime/text-patch.ts` — `inputTextRegion`, `patchInputValue` (modify)
- `packages/kinetic/src/runtime/text-patch.test.ts` — existing input value patching tests (extend)
- `packages/kinetic/src/loro/edit-text.ts` — `editText` handler (no change, but understand the flow)
- `packages/kinetic/src/loro/edit-text.test.ts` — existing editText tests (extend with round-trip tests)
- `packages/kinetic/src/runtime/subscribe.ts` — `subscribe` function (no change, but understand callback flow)
- `packages/hooks-core/src/create-text-hooks/index.ts` L370-395 — `isLocalChangeRef` pattern and commentary on Loro's `by` field (reference, do not modify)

### Files to Modify

- `packages/reactive/src/index.ts` — add `DeltaOrigin`, add `origin?` to all named delta types
- `packages/change/src/reactive-bridge.ts` — forward `by` → `origin` in `translateEventBatch`/`translateDiff`
- `packages/change/src/reactive-bridge.test.ts` — add origin forwarding tests
- `packages/kinetic/src/runtime/text-patch.ts` — add `selectMode` param to `patchInputValue`, update `inputTextRegion`
- `packages/kinetic/src/runtime/text-patch.test.ts` — add selectMode and remote edit cursor tests
- `packages/kinetic/src/loro/edit-text.test.ts` — add round-trip cursor tests
- `packages/kinetic/TECHNICAL.md` — correct to describe selectMode dispatch (not active-edit flag)
- `packages/change/TECHNICAL.md` — already updated, verify accuracy
- `TECHNICAL.md` (root) — already updated, verify accuracy
- `.plans/kinetic-input-text-region.md` — correct Learning #2 to describe selectMode dispatch

### Key HTML Spec Reference

`setRangeText(replacement, start, end, selectMode)` cursor adjustment rules:

**`"preserve"` mode:**
```
let oldLength = end - start
let newLength = replacement.length
let delta = newLength - oldLength
let newEnd = start + newLength

// selectionStart adjustment:
if selectionStart > end:     selectionStart += delta
elif selectionStart > start: selectionStart = start     // SNAP, not shift
// else: NO CHANGE (this is the bug case for local edits)

// selectionEnd adjustment:
if selectionEnd > end:       selectionEnd += delta
elif selectionEnd > start:   selectionEnd = newEnd       // SNAP to newEnd
// else: NO CHANGE
```

When inserting at the cursor position (`start === end === selectionStart`), neither condition fires for `selectionStart`. The cursor stays put. This is why `"preserve"` is wrong for local edits.

**`"end"` mode:**
```
let newEnd = start + replacement.length
selectionStart = newEnd
selectionEnd = newEnd
```

The cursor always goes to the end of the replacement range. For inserts, this is past the inserted text. For deletes (`replacement = ""`), this is the deletion point (`start + 0 = start`). Both are correct for local edits.

## Learnings

1. **`setRangeText`'s two selectModes are complementary, not competitive.** `"preserve"` handles the "edit happened elsewhere" case (remote edits). `"end"` handles the "edit happened here" case (local edits). Together they cover all cursor scenarios without any manual cursor arithmetic. The original plan assumed `"preserve"` was universal — it's not. But the fix doesn't require abandoning `setRangeText`; it requires using the right mode for each origin.

2. **`"end"` is correct for local undo/redo, not just typing.** When undoing an insertion (delta contains delete), `"end"` places the cursor at the deletion point. When undoing a deletion (delta contains insert), `"end"` places the cursor at the end of the re-inserted text. Both are the expected UX for undo — the user should see where the change happened. This means `origin === "local"` (which Loro emits for both typing and undo) is the correct discriminant for choosing `"end"`.

3. **The `hooks-core` concern about `event.by === "local"` doesn't apply here.** `hooks-core` avoids `event.by` because it uses the flag to *skip* the subscription entirely — which would incorrectly skip undo. Our approach *always* applies the delta — it just chooses a different selectMode. The "local includes undo" fact is a feature, not a bug, because `"end"` is correct for both.

4. **Origin-driven selectMode dispatch preserves read/write independence.** `editText` remains a pure CRDT write function (no DOM manipulation, no cursor management). `inputTextRegion` remains the sole reader. The only coordination is through the delta's `origin` field — which flows through the existing subscription channel, not a side channel. This is the principled version of what the original plan tried to achieve with WeakSets and pluggable predicates.

5. **The `REPLACE_DELTA` singleton needs conditional handling.** Both `@loro-extended/reactive` (`LocalRef`) and `@loro-extended/change` (`reactive-bridge.ts`) have pre-allocated `REPLACE_DELTA` singletons. Adding `origin?` to the type is non-breaking, but `translateDiff` must create a new object when `origin` is defined rather than returning the singleton. Pattern: `origin ? { type: "replace", origin } : REPLACE_DELTA`.

6. **Loro's `LoroEventBatch.by` includes `"checkout"` — not just `"local"` and `"import"`.** The plan originally defined `DeltaOrigin = "local" | "import"`, but Loro's type definition is `by: "local" | "import" | "checkout"` (required, not optional). Checkout events represent wholesale state replacement (e.g., time travel) and must be filtered out in `translateEventBatch` rather than forwarded. The rest of the codebase (diff-overlay, functional-helpers, lens) already checks `event.by === "checkout"` and skips/throws. The reactive bridge was the only path that didn't filter checkouts — now it does. `DeltaOrigin` stays as `"local" | "import"` because `"checkout"` never reaches consumers.

7. **Cross-package type changes require rebuilding `dist/` before downstream tests see them.** Each package's `exports` field points to `dist/index.d.ts` and `dist/index.js`, not source. Vitest within a package transforms source directly, but cross-package imports resolve to built output. After adding `origin?` to `ReactiveDelta` in the reactive package and `translateEventBatch` changes in the change package, kinetic's round-trip tests still exhibited the backwards-typing bug until `pnpm -C packages/reactive build` and `pnpm -C packages/change build` were run. **If your tests pass in one package but fail in a downstream consumer, rebuild.** This is a monorepo hazard that's easy to miss when source transforms mask the stale `dist/`.

8. **JSDOM faithfully implements `setRangeText` selectMode per the HTML spec.** This was not assumed during planning — we expected to need a spec-faithful mock. Empirically verified: `setRangeText("end")` advances the cursor past the insertion (5→6 for a 1-char insert); `setRangeText("preserve")` shifts the cursor when the edit is strictly before it (5→6 for insert at 0) but does NOT advance when inserting at the cursor position (cursor stays at 0). This means round-trip tests can use JSDOM's native `setRangeText` directly rather than mocking, producing higher-fidelity cursor tests. The `"preserve" at cursor stays put` behavior is the exact bug case — JSDOM reproduces it faithfully.

9. **The `translateEventBatch` type cast should use `by?: string` (optional), not the Loro-required `by: string`.** Even though Loro's `LoroEventBatch.by` is required, `translateEventBatch` accepts `unknown` as its first parameter to avoid Loro type imports at the reactive boundary. Non-Loro callers (hypothetical future reactive sources) might not have a `by` field at all. The cast `{ by?: string; events: Array<{ diff: unknown }> }` correctly handles both cases: Loro events get forwarded, non-Loro events get `origin: undefined`. The explicit `batch.by === "local" || batch.by === "import"` guard narrows to `DeltaOrigin`, and anything else (including `undefined` or unexpected strings) falls through to `undefined`.

10. **Existing integration tests are implicit contracts on selectMode.** The compiler integration test `should apply surgical updates to input.value via inputTextRegion` captured `setRangeText` calls with their `mode` argument. It expected `"preserve"` for local Loro operations. After origin forwarding, local operations now produce `origin: "local"` → `selectMode: "end"`. This is correct behavior (it's the bug fix working), but it means **existing tests that spy on `setRangeText` mode arguments are effectively testing the cursor management policy**, not just the patching mechanics. When changing selectMode dispatch logic, search for `mode: "preserve"` and `mode: "end"` assertions across the test suite.

## Changeset

```
@loro-extended/reactive:
- Add `DeltaOrigin` type and optional `origin` field to all `ReactiveDelta` members

@loro-extended/change:
- Forward Loro `LoroEventBatch.by` as `origin` on translated deltas

@loro-extended/kinetic:
- Fix backwards text insertion in `<input>` elements
- `patchInputValue` accepts optional `selectMode` parameter (default "preserve")
- `inputTextRegion` dispatches selectMode based on `delta.origin`
```
