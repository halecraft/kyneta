# Plan: hooks-core Collaborative Text Input Fixes

## Background

The `hooks-core` package provides framework-agnostic hooks for collaborative text editing via `useCollaborativeText`. During the Kinetic framework's implementation of `editText` — a parallel but architecturally distinct approach to the same problem — we identified several bugs and design shortcomings in `hooks-core`'s `create-text-hooks` module that affect production users of `@loro-extended/react` and `@loro-extended/hono`.

The Kinetic implementation solved the same problems differently (surgical `setRangeText` patching, origin-driven selectMode dispatch, no manual cursor math). Some of those solutions don't transfer directly because `hooks-core` has a fundamentally different architecture: it uses `e.preventDefault()` + manual `input.value` replacement + `setSelectionRange()` rather than a subscription-driven `inputTextRegion`. However, the bugs identified are real and can be fixed within `hooks-core`'s existing architecture.

Key architectural difference: in hooks-core, the `beforeinput` handler calls `e.preventDefault()`, mutates the CRDT, reads the CRDT value back, sets `input.value` directly, and calls `setSelectionRange()` with a computed cursor. There is no `inputTextRegion` subscription for local edits — the subscription only fires for remote/undo events (and is skipped during local changes via `isLocalChangeRef`). This means the "DOM restore before `ref.update()`" trick from Kinetic is **not needed** — hooks-core doesn't have a subscription that would double-apply deltas during local changes.

## Problem Statement

Five issues were identified by comparing Kinetic's `editText` with hooks-core's `useCollaborativeText`:

### Issue A: Word/Line Delete Silent Failure

`handleDeleteByRange` silently does nothing when `getTargetRanges()` returns `[]` and the cursor is collapsed. Since `e.preventDefault()` was already called unconditionally, the keystroke is eaten. Affects Option+Delete, Cmd+Delete (Mac), Ctrl+Backspace (Windows/Linux), and their forward equivalents — six `inputType` values.

### Issue B: `handleDeleteForward` Bounds Check Uses `input.value.length`

`handleDeleteForward` checks `start < input.value.length` to decide whether a forward delete is valid. Since `e.preventDefault()` has been called, `input.value` hasn't been updated — so this is the *pre-edit* length. In most cases this matches CRDT length, but diverges when placeholder text is rendered as actual content or when remote edits have changed the CRDT since the last DOM sync. The correct source of truth is the CRDT length (`getRawTextValue(textRef).length` or `textRef.length`).

### Issue C: `calculateNewCursor` Is Wrong for Word/Line Deletes and Forward Deletes

`calculateNewCursor` uses `inputType.startsWith("delete")` to handle all delete types identically: `start !== end ? start : Math.max(0, start - 1)`. This is wrong for:

- **`deleteContentForward`** (Delete key): cursor should stay at `start`, not move to `start - 1`
- **`deleteWordBackward`**: cursor should be at the start of the deleted range (which may be many characters back), not `start - 1`
- **`deleteWordForward`**: cursor should stay at `start`, not `start - 1`
- **`deleteSoftLineBackward`** / **`deleteHardLineBackward`**: cursor should be at position 0 (or line start), not `start - 1`

The existing test suite asserts the wrong expected values (e.g., `expect(result).toBe(4)` for `deleteWordBackward` at position 5 — the cursor would not be at 4 if a multi-character word was deleted).

### Issue D: Missing `insertFromComposition` in Handler Map

The `inputHandlers` map does not include `insertFromComposition`. When the browser fires a `beforeinput` event with `inputType: "insertFromComposition"` (the canonical composition commit event in Chrome), it falls through to the `console.warn` branch. Meanwhile, `e.preventDefault()` has already been called, suppressing the browser's insertion. The `compositionend` handler eventually reconciles via `textRef.update(currentValue)`, but by then the input value may be stale since the browser's own insertion was prevented.

### Issue E: No Test Coverage for the Actual Bug Cases

The test suite tests `handleDeleteByRange` with valid `getTargetRanges` and with empty `getTargetRanges` + non-collapsed selection, but has no test for empty `getTargetRanges` + collapsed cursor (the actual bug). The `calculateNewCursor` tests assert incorrect expected values for word/line delete cursor positions. There are no tests for `handleDeleteForward` bounds-checking against CRDT length vs. `input.value.length`.

## Success Criteria

- Option+Delete, Cmd+Delete, Ctrl+Backspace, and equivalents work correctly in `<input>` and `<textarea>` elements managed by `useCollaborativeText`
- `deleteContentForward` leaves cursor at `start` (not `start - 1`)
- Word/line deletions place cursor at the CRDT-computed position after deletion
- `handleDeleteForward` uses CRDT length for bounds check
- `insertFromComposition` is handled in the `beforeinput` path
- All existing tests continue to pass (with corrected expectations where the old expectations were wrong)
- New tests cover the previously-untested bug cases

## The Gap

| Aspect | Current | Target |
|---|---|---|
| `e.preventDefault()` | Called unconditionally for all recognized `inputType`s | Deferred for word/line deletes when `getTargetRanges()` fails and cursor is collapsed |
| Fallback when `getTargetRanges()` returns `[]` and cursor is collapsed | Silent no-op (keystroke eaten) | Browser performs native delete; CRDT reconciled from DOM via one-shot `input` listener |
| `handleDeleteByRange` return value | `void` | `boolean` — signals whether the handler performed the mutation |
| `InputHandler` signature | `(ctx: InputContext) => void` | `(ctx: InputContext) => boolean` |
| `handleDeleteForward` bounds check | `input.value.length` | `textRef.length` (CRDT ground truth) |
| `calculateNewCursor` for `deleteContentForward` | `start - 1` | `start` |
| `calculateNewCursor` for word/line deletes | `start - 1` | Reads cursor from CRDT result (post-mutation length difference) or delegates to the reconciliation path |
| `insertFromComposition` handling | Missing from handler map; `console.warn` | In handler map, processed as text insertion |
| `isLocalChangeRef` during reconciliation | N/A | Must be set `true` around `textRef.update()` in the one-shot `input` listener to prevent the subscription from clobbering |

## Phase 1: Fix `handleDeleteForward` Bounds Check and Add `insertFromComposition` 🔴

These are small, low-risk fixes that don't change the handler contract.

### Tasks

1. Change `handleDeleteForward` to use `textRef.length` instead of `input.value.length` 🔴

   The `InputContext` already includes `textRef`. Replace `input.value.length` with `textRef.length`. The `input` field can be removed from this handler's destructuring — it was only used for the bounds check.

2. Add `insertFromComposition` to the `inputHandlers` map 🔴

   Map `insertFromComposition` to `handleInsertText`. The data and selection semantics are identical to `insertText`. This mirrors Kinetic's handler map.

3. Add test for `handleDeleteForward` bounds check 🔴

   Create a scenario where `input.value.length` and CRDT length differ (e.g., input has stale content from a placeholder or a not-yet-synced remote edit). Verify the handler uses CRDT length.

4. Add test for `insertFromComposition` 🔴

   Verify `insertFromComposition` is dispatched to `handleInsertText` and produces the correct CRDT mutation.

## Phase 2: Fix `calculateNewCursor` 🔴

The cursor calculation function is wrong for several delete types. This phase corrects it.

### Tasks

1. Fix `deleteContentForward` cursor calculation 🔴

   When `inputType` is `deleteContentForward` and `start === end`, the cursor should stay at `start` (not `start - 1`). Forward delete removes the character *after* the cursor — the cursor doesn't move.

2. Fix word/line delete cursor calculation 🔴

   For word/line deletes that go through the CRDT-first path (valid `getTargetRanges` or non-collapsed selection), the cursor position should be the `start` of the deleted range. The handler already has this information — it's either `range.startOffset` from `getTargetRanges()` or `start` from the selection.

   The cleanest approach: `calculateNewCursor` should accept an optional `deleteRangeStart` parameter that word/line handlers can pass. When present, use it instead of the generic `start - 1` heuristic. For the passthrough/reconciliation case (Phase 3), cursor positioning is handled by the browser natively, so `calculateNewCursor` is not called.

   ```typescript
   export function calculateNewCursor(
     inputType: string,
     start: number,
     end: number,
     data: string | null,
     maxLength: number,
     deleteRangeStart?: number,
   ): number
   ```

3. Update `calculateNewCursor` call site to pass `deleteRangeStart` 🔴

   In the `beforeinput` handler, after the handler executes, determine the `deleteRangeStart`. For word/line deletes with valid `getTargetRanges()`, this is `ranges[0].startOffset`. For selection-based fallback, it's `start`. Pass it through to `calculateNewCursor`.

   This requires a small refactor: either the handler returns the computed delete start, or the `beforeinput` handler reads it from the event independently. The latter is simpler — re-read `getTargetRanges()` in the call site (it returns the same static ranges on repeated calls per the spec).

4. Correct existing `calculateNewCursor` tests 🔴

   Fix the expected values in the existing tests. For example, `deleteWordBackward` at position 5 with collapsed cursor should not produce `4` — it should produce the start of the deleted word range. Since `calculateNewCursor` doesn't have range information in the current tests, these tests should be updated to reflect the new `deleteRangeStart` parameter.

5. Add new tests for forward delete cursor positioning 🔴

   Verify `deleteContentForward` with collapsed cursor produces `start` (not `start - 1`).

## Phase 3: Word/Line Delete Fallback via Browser-Native Reconciliation 🔴

The core bug fix: when `handleDeleteByRange` cannot compute deletion boundaries, let the browser handle it natively and reconcile.

### Tasks

1. Change `InputHandler` return type from `void` to `boolean` 🔴

   All handlers return `true` unconditionally except `handleDeleteByRange`, which returns `false` when `getTargetRanges()` is empty and the cursor is collapsed. Since `InputHandler` is not exported (internal type), this is a non-breaking change.

2. Update all handler functions to return `boolean` 🔴

   All existing handlers (`handleInsertText`, `handleInsertLineBreak`, `handleDeleteBackward`, `handleDeleteForward`, `handleDeleteSelection`) return `true` unconditionally. `handleDeleteByRange` returns `false` in the collapsed-cursor-no-ranges case.

3. Move `e.preventDefault()` after handler dispatch, conditioned on return value 🔴

   Restructure the `beforeinput` handler:
   - Move `e.preventDefault()` to after the handler call
   - Only call it when the handler returns `true`
   - When `false`, attach a one-shot `input` event listener for reconciliation

4. Wire reconciliation via one-shot `input` event listener 🔴

   When the handler returns `false`:
   - Do NOT call `e.preventDefault()` — browser handles the deletion natively
   - Attach `target.addEventListener("input", reconcile, { once: true })`
   - The `reconcile` function: set `isLocalChangeRef.current = true`, call `textRef.update(input.value)`, update `lastKnownValueRef.current`, set `isLocalChangeRef.current = false`
   - The `isLocalChangeRef` guard is critical: without it, the Loro subscription fires and full-replaces `input.value`, potentially clobbering the browser's cursor position

5. Skip `calculateNewCursor` and manual `input.value` assignment on passthrough 🔴

   When the handler returns `false`, the existing post-handler code (`input.value = ...`, `setSelectionRange(...)`) must be skipped — the browser is handling the DOM update. Only the reconciliation listener runs (after the browser applies the change).

6. Handle the `onBeforeChange` gate for the passthrough case 🔴

   Currently, `onBeforeChange?.() === false` is checked after `e.preventDefault()`. With the restructuring, if `onBeforeChange` returns `false` during a passthrough (handler returns `false`), we should still call `e.preventDefault()` to suppress the browser's action — the user explicitly vetoed the change. This means the `onBeforeChange` check must happen before the handler dispatch (or between handler and `preventDefault`), and if it returns `false` during a passthrough, `preventDefault` is called explicitly.

## Phase 4: Tests 🔴

### Tasks

1. Unit test: `handleDeleteByRange` returns `false` on collapsed cursor with empty `getTargetRanges` 🔴

2. Unit test: `e.preventDefault()` NOT called when handler returns `false` 🔴

3. Integration test: word delete with empty `getTargetRanges` reconciles via input event 🔴

   Use the existing `createMockTextarea` + `createMockInputEvent` helpers. Simulate `beforeinput` with `deleteWordBackward`, empty `getTargetRanges`, collapsed cursor. Verify `preventDefault` was NOT called. Then simulate the browser's action (update `textarea.value`, dispatch `input` event). Verify CRDT reflects the deletion.

4. Integration test: word delete with valid `getTargetRanges` still uses CRDT-first path 🔴

   Same setup with valid `getTargetRanges`. Verify `preventDefault` WAS called and CRDT was updated synchronously.

5. Integration test: sequential word deletes via fallback 🔴

   Verify rapid-fire word deletes each reconcile correctly without listener leaks.

6. Verify all existing tests pass (with corrected expectations) 🔴

## Transitive Effect Analysis

### `InputHandler` return type change → `inputHandlers` map and all call sites

`InputHandler` is internal (not exported from `index.ts`). The only call site is in `useCollaborativeText`'s `handleBeforeInputRef.current` closure. The `inputHandlers` map type (`Record<string, InputHandler>`) inherits the new signature. TypeScript will flag any handler that forgets to return a boolean.

**Risk: Low.** All changes are in `input-handlers.ts` and `index.ts`.

### `calculateNewCursor` signature change → call sites and tests

`calculateNewCursor` is exported from `input-handlers.ts` and re-used in `index.ts`. It is also exported from the package (via `input-handlers.ts`), but only the internal `index.ts` call site uses it. The new optional `deleteRangeStart` parameter is backward-compatible — existing callers that don't pass it get the same behavior for non-word/line deletes.

**Risk: Low.** The parameter is optional. Existing external consumers (if any) are unaffected.

### `isLocalChangeRef` during reconciliation → subscription skip

The one-shot `input` listener must set `isLocalChangeRef.current = true` before calling `textRef.update()` and reset it after. Without this, the Loro subscription fires (since `textRef.update()` calls `commitIfAuto()` → Loro event → subscription callback). The subscription would then full-replace `input.value` and call `adjustSelectionFromDelta` — fighting the browser's already-correct cursor position.

**Risk: Medium.** If the flag is not set, the subscription fires and clobbers the input. Must be wrapped in try/finally.

### `onBeforeChange` gate interacts with passthrough

If `onBeforeChange` returns `false` during a passthrough (handler returns `false`), we must still `preventDefault` to suppress the browser. The current code checks `onBeforeChange` after `preventDefault`. The restructured code must handle the case where the handler returns `false` but `onBeforeChange` vetoes the change — in that case, `preventDefault` must be called to suppress the browser, and no reconciliation listener is attached.

**Risk: Low.** Straightforward conditional logic, but must be explicitly handled.

### `insertFromComposition` addition → IME composition flow

Adding `insertFromComposition` to the handler map means Chrome's composition commit event is now handled in the `beforeinput` path. The `compositionend` handler also fires — it checks `currentValue === oldValue` and no-ops if they match. Since the `beforeinput` handler will have already updated the CRDT and `lastKnownValueRef`, the `compositionend` handler should see no change and skip. This is safe.

**Risk: Low.** The `compositionend` handler's `currentValue === oldValue` guard prevents double-processing.

### `@loro-extended/react` and `@loro-extended/hono` downstream

Both packages re-export `createTextHooks` from `hooks-core`. Since the public API (`useCollaborativeText` return type, options) is unchanged, and `InputHandler` is internal, there are no downstream breaking changes.

**Risk: None.**

## Tests

| Test | Phase | What it proves | Risk addressed |
|---|---|---|---|
| `handleDeleteForward` uses CRDT length | 1.3 | Bounds check is correct | Issue B |
| `insertFromComposition` dispatched | 1.4 | IME commit handled | Issue D |
| `deleteContentForward` cursor = `start` | 2.5 | Forward delete cursor correct | Issue C |
| `calculateNewCursor` with `deleteRangeStart` | 2.4 | Word/line cursor correct | Issue C |
| `handleDeleteByRange` returns `false` | 4.1 | Handler signals passthrough | Issue A |
| `preventDefault` not called on passthrough | 4.2 | Browser handles deletion | Issue A |
| Word delete reconciliation round-trip | 4.3 | Full fallback path works | Issue A |
| CRDT-first word delete not regressed | 4.4 | Happy path preserved | Regression |
| Sequential word deletes | 4.5 | No listener leaks | Issue A edge case |
| All existing tests pass | 4.6 | No breakage | Backward compat |

## Alternatives Considered

### Port Kinetic's `inputTextRegion` / `setRangeText` Approach

Replace hooks-core's manual `input.value` + `setSelectionRange` with surgical `setRangeText("end")` / `setRangeText("preserve")` patching.

Rejected because:
- Would require a complete rewrite of the subscription path in `useCollaborativeText`
- hooks-core's subscription uses raw Loro events (`LoroEventBatch`), not `ReactiveDelta` — it would need the reactive bridge from `@loro-extended/reactive`
- The `isLocalChangeRef` skip-local pattern is deeply embedded in the hook's lifecycle
- The existing approach works correctly for all non-word/line-delete cases; the fix should be minimal

### Compute Word Boundaries in JavaScript with `Intl.Segmenter`

Rejected for the same reasons as in the Kinetic plan:
- Duplicates browser-native word-break rules
- `Intl.Segmenter` lacks Firefox support (behind flag as of early 2025)
- Line deletion depends on visual line wrapping (layout-dependent)
- The browser already has this information

### Make `calculateNewCursor` Read CRDT State Directly

Instead of passing `deleteRangeStart`, have `calculateNewCursor` accept the `TextRef` and compute the cursor from pre/post CRDT state.

Rejected because:
- Couples a pure utility function to the CRDT type
- The caller already has (or can cheaply obtain) the delete range info
- An optional parameter preserves the function's pure, testable nature

### Skip `calculateNewCursor` Entirely for Word/Line Deletes

Since the CRDT-first path already knows the exact delete range, just compute the cursor inline in the `beforeinput` handler.

This is viable and simpler, but rejected in favor of the `deleteRangeStart` parameter because:
- Keeps cursor logic centralized in one function
- The function is already exported and tested — splitting cursor logic across two locations increases maintenance burden
- The optional parameter is backward-compatible

## Resources for Implementation Context

### Files to Modify

- `packages/hooks-core/src/create-text-hooks/input-handlers.ts` — `InputHandler` type, handler return types, `handleDeleteForward` bounds check, `handleDeleteByRange` return value, `insertFromComposition` in map, `calculateNewCursor` signature
- `packages/hooks-core/src/create-text-hooks/index.ts` — `beforeinput` handler restructuring, conditional `preventDefault`, reconciliation wiring, `onBeforeChange` gate
- `packages/hooks-core/src/create-text-hooks/input-handlers.test.ts` — corrected `calculateNewCursor` expectations, new tests
- `packages/hooks-core/src/create-text-hooks/collaborative-text-sync.test.ts` — integration tests for passthrough, reconciliation

### Files to Read (context)

- `packages/kinetic/src/loro/edit-text.ts` — reference implementation with three-tier strategy (already implemented)
- `packages/kinetic/src/loro/edit-text.test.ts` — test patterns for passthrough/reconciliation
- `packages/kinetic/TECHNICAL.md` — "Integration with editText — three-tier strategy" section
- `.plans/edittext-word-delete-fallback.md` — Kinetic plan with learnings about DOM restore (not needed here due to architectural difference)

### Key Architectural Difference from Kinetic

hooks-core does NOT have an `inputTextRegion` subscription for local edits. The `isLocalChangeRef` flag skips the subscription during local changes. This means:

1. **No DOM-restore trick needed.** When `textRef.update(input.value)` fires in the reconciliation listener, `commitIfAuto()` triggers the Loro subscription, but `isLocalChangeRef = true` causes it to be skipped. No delta is applied to the DOM. The DOM is already correct (browser handled it).

2. **`isLocalChangeRef` must be set in the reconciliation listener.** Without it, the subscription fires, full-replaces `input.value`, and calls `adjustSelectionFromDelta` — fighting the browser's cursor placement.

3. **`calculateNewCursor` is not called for the passthrough case.** The browser positions the cursor natively. The reconciliation listener only syncs the CRDT — it does not touch `input.value` or cursor position.