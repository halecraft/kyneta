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

### The Missing Concept

The correct behavior depends on the edit's **origin**:

- **Local edit** (user typed at the cursor): cursor must advance past inserted text. `setRangeText("end")` or explicit `setSelectionRange` is needed.
- **Remote edit** (collaborator typed elsewhere): cursor should shift if edit is before it, stay if after. `setRangeText("preserve")` is correct.
- **Undo/redo**: Functionally like a remote edit — the delta comes from history, not the user's current cursor position.

The `ReactiveDelta` type has no concept of origin. Loro provides this information via the `by` field on `LoroEventBatch` (`"local"` or `"import"`), but `translateEventBatch` strips it. The information exists at the source and is discarded at the bridge layer.

### Loro's `by` Field Is Insufficient

A critical subtlety discovered in `hooks-core`: Loro's `by: "local"` fires for BOTH user input AND undo/redo operations. The `hooks-core` implementation explicitly documents this:

```
// We use isLocalChangeRef instead of event.by === "local" because:
// - isLocalChangeRef is only true during our beforeinput handler
// - event.by === "local" is true for BOTH user input AND undo/redo operations
// - We need to update the textarea for undo/redo, so we can't filter on event.by
```

Therefore, the provenance we add to `ReactiveDelta` should forward Loro's raw `by` value faithfully. The semantic distinction between "user input" and "undo triggered locally" is a higher-level concern that consumers (like `editText` + `inputTextRegion`) handle with their own flag, not something the delta algebra should opine on.

## Problem Statement

1. **Typing into `<input>` elements is backwards.** The cursor never advances because `setRangeText("preserve")` doesn't move the cursor when inserting at the cursor position.

2. **The delta algebra has no provenance dimension.** `ReactiveDelta` carries what changed but not who caused it. Consumers that need origin-aware behavior (input cursor management, animation hints, conflict visualization) have no way to distinguish local from remote edits.

3. **The reactive bridge discards available information.** Loro's `LoroEventBatch.by` field is present but stripped during translation in `translateEventBatch`.

## Success Criteria

- `ReactiveDelta` carries an optional `origin` field (`"local"` | `"import"` | undefined)
- `translateEventBatch` forwards the `by` field from `LoroEventBatch` as `origin`
- `inputTextRegion` uses `origin` to choose the correct `setRangeText` selectMode
- `editText` sets a local flag so `inputTextRegion` can distinguish "user is typing" from "local undo/redo"
- Typing "Hello" into the kinetic-todo input field produces "Hello" with cursor at position 5
- Remote edits to a text input preserve the local user's cursor position
- All existing text patching, list region, and conditional region tests continue to pass
- `textRegion` (Text nodes) is unaffected — it has no cursor concept

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| `ReactiveDelta` | No origin information | Optional `origin: "local" \| "import"` field |
| `translateEventBatch` | Strips `by` field | Forwards `by` as `origin` on each delta |
| `inputTextRegion` | Always uses `"preserve"` selectMode | Uses `"preserve"` normally; skips patching during active `editText` handler |
| `editText` | No DOM update, no cursor management | Sets a per-element flag during handler; manages cursor after CRDT mutation |
| `patchInputValue` | Single selectMode `"preserve"` | Accepts optional selectMode parameter |
| Unit tests | No round-trip cursor test | Tests for local typing, remote insert, undo cursor behavior |

## Phase 1: Add `origin` to `ReactiveDelta` 🔴

Extend the delta vocabulary with provenance metadata.

### Tasks

1. Add optional `origin` field to each named delta type in `packages/reactive/src/index.ts` 🔴

   The field is optional so that non-Loro reactive types (e.g., `LocalRef`) don't need to provide it. When absent, consumers treat the delta as origin-unknown and fall back to safe behavior (full replacement or `"preserve"`).

   ```typescript
   export type DeltaOrigin = "local" | "import"

   export type ReplaceDelta = { type: "replace"; origin?: DeltaOrigin }
   export type TextDelta = { type: "text"; ops: TextDeltaOp[]; origin?: DeltaOrigin }
   export type ListDelta = { type: "list"; ops: ListDeltaOp[]; origin?: DeltaOrigin }
   export type MapDelta = { type: "map"; ops: MapDeltaOp; origin?: DeltaOrigin }
   export type TreeDelta = { type: "tree"; ops: TreeDeltaOp[]; origin?: DeltaOrigin }
   ```

2. Export `DeltaOrigin` from `packages/reactive/src/index.ts` 🔴

3. Update `translateEventBatch` in `packages/change/src/reactive-bridge.ts` to forward the `by` field 🔴

   The function currently casts `eventBatch` as `{ events: Array<{ diff: unknown }> }`. Extend the cast to include `by?: string`. Pass it to `translateDiff` which attaches it to the returned delta.

4. Update `translateDiff` to accept and attach an optional origin parameter 🔴

5. Add tests for origin forwarding in `packages/change/src/reactive-bridge.test.ts` 🔴

   - `translateEventBatch` with `by: "local"` → each delta has `origin: "local"`
   - `translateEventBatch` with `by: "import"` → each delta has `origin: "import"`
   - `translateEventBatch` with no `by` field → each delta has `origin: undefined`

## Phase 2: Fix `inputTextRegion` + `editText` Round-Trip 🔴

The core cursor fix. Two coordinated changes make `inputTextRegion` origin-aware and give `editText` explicit cursor management.

### Tasks

1. Add a per-element "active edit" flag mechanism to `editText` in `packages/kinetic/src/loro/edit-text.ts` 🔴

   Use a module-scoped `WeakSet<Element>` to track which elements are currently inside an `editText` handler. The handler adds the element before calling the CRDT mutation and removes it in a `finally` block. This is analogous to `hooks-core`'s `isLocalChangeRef`, but scoped per-element rather than per-hook instance.

   ```typescript
   const activeEditElements = new WeakSet<Element>()

   export function isActiveEdit(el: Element): boolean {
     return activeEditElements.has(el)
   }
   ```

2. Update `editText` to manage cursor position after the synchronous CRDT mutation chain 🔴

   After the handler completes (which triggers `commitIfAuto` → subscription → `patchInputValue` synchronously), call `setSelectionRange(newCursor, newCursor)`. Import and adapt `calculateNewCursor` logic inline (it's ~10 lines — a local helper, not an import from `hooks-core`).

3. Update `inputTextRegion` in `packages/kinetic/src/runtime/text-patch.ts` to skip patching when the element is in an active edit 🔴

   Inside the subscription callback, check `isActiveEdit(input)`. If true, skip the `patchInputValue` call — `editText` handles the DOM update and cursor. If false (remote edit or undo), apply the patch with `"preserve"` selectMode as before. This avoids the need for `patchInputValue` to be selectMode-aware: local edits skip it entirely, remote edits use `"preserve"`.

   This introduces a runtime import from `../loro/edit-text.js` into `text-patch.ts`. To preserve the Loro-agnostic core runtime principle, import only the `isActiveEdit` predicate (which references no Loro types) and make it optional via a setter pattern (see task 4).

4. Preserve Loro-agnostic core runtime boundary 🔴

   `text-patch.ts` is in the Loro-agnostic `runtime/` directory. Rather than importing from `loro/edit-text.ts`, expose a pluggable predicate:

   ```typescript
   let isActiveEditFn: ((el: Element) => boolean) | null = null

   export function setActiveEditPredicate(fn: (el: Element) => boolean): void {
     isActiveEditFn = fn
   }
   ```

   The `editText` module calls `setActiveEditPredicate(isActiveEdit)` at import time. `inputTextRegion` checks `isActiveEditFn?.(input)`. If no predicate is registered (pure runtime without Loro bindings), all edits use `"preserve"` — the safe default.

5. Export `setActiveEditPredicate` from the runtime index and `isActiveEdit`/registration from the loro index 🔴

6. Wire up the registration in `packages/kinetic/src/loro/edit-text.ts` — call `setActiveEditPredicate` at module top level 🔴

## Phase 3: Tests 🔴

### Tasks

1. Add round-trip cursor test to `packages/kinetic/src/loro/edit-text.test.ts` 🔴

   Simulate typing "Hello" one character at a time through the full `editText` → CRDT → subscription → DOM cycle. After each keystroke, verify both `ref.toString()` and `input.selectionStart`. This is the test that would have caught the original bug. Requires wiring `inputTextRegion` to the same input element, with a real `Scope` and subscription.

2. Add remote edit cursor preservation test to `packages/kinetic/src/runtime/text-patch.test.ts` 🔴

   Wire `inputTextRegion` on an input with cursor at position 5. Simulate a remote text delta inserting at position 0. Verify cursor shifted to position 8 (5 + inserted length). Verify `input.value` is correct.

3. Add origin-forwarding tests to `packages/change/src/reactive-bridge.test.ts` (covered in Phase 1 task 5) 🔴

4. Verify existing `patchInputValue`, `textRegion`, `listRegion`, and `conditionalRegion` tests still pass 🔴

## Phase 4: Documentation 🔴

### Tasks

1. Update `packages/kinetic/TECHNICAL.md` — Input Text Region Architecture section 🔴

   Correct the `setRangeText("preserve")` description. Document the origin-aware dispatch: active-edit elements skip patching, remote edits use `"preserve"`. Document the `setActiveEditPredicate` pluggability pattern.

2. Update `packages/kinetic/TECHNICAL.md` — Delta Region Algebra section 🔴

   Add provenance as a dimension of the algebra. Update the pattern table to show that `inputTextRegion` has origin-dependent behavior.

3. Update `packages/change/TECHNICAL.md` — Reactive Bridge section 🔴

   Document that `translateEventBatch` now forwards the `by` field as `origin`. Update the "Key Design Decisions" list.

4. Update `TECHNICAL.md` (root) — REACTIVE Callback Signature section 🔴

   Document the `origin` field on `ReactiveDelta`. Note that it's optional and Loro-specific.

5. Correct Learning #2 in `.plans/kinetic-input-text-region.md` 🔴

   Add a correction note explaining the `setRangeText("preserve")` limitation and the origin-aware fix.

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

### Phase 2: Cursor round-trip

```
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

describe("isActiveEdit flag", () => {
  it("is true during editText handler execution")
  it("is false after handler completes")
  it("is false during remote subscription callback")
  it("is scoped per-element via WeakSet")
})
```

### Phase 3: Regression

All existing tests in `text-patch.test.ts`, `edit-text.test.ts`, `integration.test.ts`, `reactive-bridge.test.ts` must continue to pass unmodified (with the exception of tests that now need to account for `origin` in their delta assertions — these are updated in Phase 1).

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

### `inputTextRegion` behavior change → all input/textarea with TextRef value

The subscription callback now skips `patchInputValue` when `isActiveEditFn?.(input)` returns true. This means:

- **With `editText` wired**: local edits are handled by `editText` (cursor management + DOM update), remote edits by `inputTextRegion`. Correct.
- **Without `editText` (read-only display input)**: `isActiveEditFn` is never registered or always returns false. All edits use `"preserve"`. Same behavior as before. Correct.
- **With `editText` but remote-only changes**: `isActiveEditFn` returns false for remote. `"preserve"` is used. Correct.

**Risk: Low.** The flag is only true during the synchronous `editText` handler, which is a very narrow window.

### `editText` now manages cursor → behavioral change for kinetic-todo

The handler now calls `setSelectionRange` after the CRDT mutation. This is the fix. No breaking change — previously the cursor was wrong (always 0).

**Risk: Low.** This is the desired fix.

### `setActiveEditPredicate` registration pattern → module initialization order

The `editText` module registers the predicate at import time. If `inputTextRegion` runs before `editText` is imported, the predicate is null and `isActiveEditFn?.(input)` returns undefined (falsy) — all edits use `"preserve"`. This is the safe default. Once `editText` is imported (which happens when the user's component code imports it), the predicate is set.

**Risk: Low.** The worst case is reverting to the current (broken) behavior if `editText` isn't imported — and if it isn't imported, there's no `beforeinput` handler, so the input is read-only and `"preserve"` is correct.

### `@loro-extended/reactive` package version bump

Adding `DeltaOrigin` and the `origin` field to all delta types is a minor/patch change (additive, non-breaking). Consumers importing named delta types see the new optional field.

**Risk: None.** Additive type change.

### `hooks-core` — not affected

`hooks-core` subscribes to raw Loro containers directly (`loroRef.subscribe`), not through `[REACTIVE]`. The `ReactiveDelta` change doesn't affect it.

### Existing `textRegion` (Text nodes) — not affected

`textRegion` has no cursor concept. It receives deltas with `origin` and ignores it. `patchText` uses `insertData`/`deleteData` which have no selectMode.

### Existing `listRegion` / `conditionalRegion` — not affected

These regions don't interact with cursor state. The `origin` field is ignored.

## Alternatives Considered

### Alternative: `patchInputValue` accepts a `selectMode` parameter

Instead of skipping the patch for local edits, pass `"end"` as selectMode for local and `"preserve"` for remote. Rejected because `"end"` places the cursor at the end of the *replacement range*, which is wrong for delete operations (cursor should stay at the deletion point, not jump to end). Also, multiple patch ops in a single delta would each set the cursor — only the final position matters. Explicit `setSelectionRange` after all ops is simpler and correct.

### Alternative: Use Loro's `by` field directly for local/remote distinction in `inputTextRegion`

Check `delta.origin === "local"` to skip patching. Rejected because Loro's `"local"` includes undo/redo operations, which SHOULD update the input value and cursor. The `hooks-core` codebase explicitly documents this pitfall. A per-element flag set only during the `editText` handler is more precise.

### Alternative: `editText` handles DOM update directly, no subscription for local edits (Response 2 from research)

Have `editText` do `input.value = ref.toString()` + `setSelectionRange` after the CRDT mutation, and use an `isLocalChange` flag to suppress the subscription. Rejected because it means the read direction (`inputTextRegion`) and write direction (`editText`) are no longer independent — `editText` must replicate the DOM update logic. Also, `input.value = ...` is O(n) full replacement, losing the surgical benefit of `setRangeText`.

### Alternative: Post-correct cursor without skipping subscription (Response 3 from research)

Keep `inputTextRegion` unchanged, let it apply `setRangeText("preserve")`, then have `editText` override the cursor with `setSelectionRange` after the synchronous chain. This works because the chain is synchronous. Rejected because it does redundant work — `patchInputValue` runs and sets the wrong cursor, then `editText` immediately overrides it. More importantly, it's "accidentally correct" — it relies on synchronous execution rather than a principled design. If Loro ever batches or defers subscription callbacks, it breaks silently.

### Alternative: Add provenance to `ReactiveSubscribe` callback signature instead of delta

Change the callback from `(delta: D) => void` to `(delta: D, origin?: DeltaOrigin) => void`. Rejected because it breaks the existing callback contract. Every subscriber would need to be updated to accept two arguments. Putting `origin` on the delta object is additive and non-breaking.

## Resources for Implementation Context

### Files to Read

- `packages/reactive/src/index.ts` — `ReactiveDelta` union and all named delta types (modify)
- `packages/change/src/reactive-bridge.ts` — `translateEventBatch`, `translateDiff` (modify)
- `packages/change/src/reactive-bridge.test.ts` — existing batch translation tests (extend)
- `packages/kinetic/src/runtime/text-patch.ts` — `inputTextRegion`, `patchInputValue` (modify)
- `packages/kinetic/src/runtime/text-patch.test.ts` — existing input value patching tests (extend)
- `packages/kinetic/src/loro/edit-text.ts` — `editText` handler (modify)
- `packages/kinetic/src/loro/edit-text.test.ts` — existing editText tests (extend)
- `packages/kinetic/src/runtime/subscribe.ts` — `subscribe` function (no change, but understand callback flow)
- `packages/kinetic/src/runtime/index.ts` — runtime exports (add `setActiveEditPredicate`)
- `packages/kinetic/src/loro/index.ts` — loro binding exports (add `isActiveEdit`)
- `packages/hooks-core/src/create-text-hooks/index.ts` L370-395 — `isLocalChangeRef` pattern and commentary on Loro's `by` field (reference, do not modify)
- `packages/hooks-core/src/create-text-hooks/input-handlers.ts` L146-160 — `calculateNewCursor` logic (reference for cursor math, do not import)
- `packages/hooks-core/src/create-text-hooks/cursor-utils.ts` — `adjustCursorFromDelta` (reference for remote cursor adjustment, do not import)

### Files to Modify

- `packages/reactive/src/index.ts` — add `DeltaOrigin`, add `origin?` to all named delta types
- `packages/change/src/reactive-bridge.ts` — forward `by` → `origin` in `translateEventBatch`/`translateDiff`
- `packages/change/src/reactive-bridge.test.ts` — add origin forwarding tests
- `packages/kinetic/src/runtime/text-patch.ts` — add `setActiveEditPredicate`, update `inputTextRegion`
- `packages/kinetic/src/runtime/text-patch.test.ts` — add remote edit cursor tests
- `packages/kinetic/src/runtime/index.ts` — export `setActiveEditPredicate`
- `packages/kinetic/src/loro/edit-text.ts` — add `activeEditElements` WeakSet, cursor management, registration
- `packages/kinetic/src/loro/edit-text.test.ts` — add round-trip cursor tests
- `packages/kinetic/src/loro/index.ts` — export `isActiveEdit`
- `packages/kinetic/TECHNICAL.md` — correct Input Text Region and Delta Region Algebra sections
- `packages/change/TECHNICAL.md` — document origin forwarding in Reactive Bridge section
- `TECHNICAL.md` (root) — document `origin` field in REACTIVE Callback Signature section

### Key HTML Spec Reference

`setRangeText(replacement, start, end, "preserve")` cursor adjustment rules:

```
let oldLength = end - start
let newLength = replacement.length
let delta = newLength - oldLength
let newEnd = start + newLength

// selectionStart adjustment:
if selectionStart > end:     selectionStart += delta
elif selectionStart > start: selectionStart = start     // SNAP, not shift
// else: NO CHANGE (this is the bug case)

// selectionEnd adjustment:
if selectionEnd > end:       selectionEnd += delta
elif selectionEnd > start:   selectionEnd = newEnd       // SNAP to newEnd
// else: NO CHANGE
```

When inserting at the cursor position (`start === end === selectionStart`), neither condition fires for `selectionStart`. The cursor stays put.

### `calculateNewCursor` Logic (from hooks-core, adapt inline)

```
if inputType starts with "delete":
  if start !== end: newCursor = start          // deleted a selection
  else:             newCursor = max(0, start-1) // deleted one char backward
else:
  newCursor = start + (data?.length ?? 1)       // inserted text

return min(newCursor, maxLength)
```

## Changeset

```
@loro-extended/reactive:
- Add `DeltaOrigin` type and optional `origin` field to all `ReactiveDelta` members

@loro-extended/change:
- Forward Loro `LoroEventBatch.by` as `origin` on translated deltas

@loro-extended/kinetic:
- Fix backwards text insertion in `<input>` elements
- `editText` now manages cursor position after CRDT mutations
- `inputTextRegion` skips patching during active `editText` handler (local edits)
- Add `setActiveEditPredicate` for Loro-agnostic active-edit detection
```
