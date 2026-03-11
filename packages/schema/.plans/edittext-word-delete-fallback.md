# Plan: Browser-Native Word/Line Deletion Fallback

## Background

Kinetic's `editText(ref)` returns a `beforeinput` handler that translates DOM editing operations into CRDT `insert()`/`delete()` calls on a `TextRef`. The handler calls `e.preventDefault()` for every recognized `inputType`, then performs the equivalent CRDT mutation. The synchronous commit fires the `inputTextRegion` subscription, which applies the delta back to the DOM via `setRangeText` with origin-driven selectMode — completing the round-trip within a single tick.

This works perfectly for operations where the deletion boundaries are trivially derivable from event metadata:

- **Character insert**: `e.data` + `selectionStart` → `ref.insert(start, data)`
- **Character delete**: `selectionStart ± 1` → `ref.delete(start - 1, 1)` or `ref.delete(start, 1)`
- **Selection delete**: `selectionStart`/`selectionEnd` → `ref.delete(start, end - start)`

Word and line deletions (Option+Delete, Cmd+Delete on Mac; Ctrl+Backspace, Ctrl+Shift+K on Linux/Windows) are different. The browser computes the deletion boundaries using locale-aware word-break rules, line-wrapping geometry, and Unicode segmentation. It communicates these boundaries through `getTargetRanges()`, which returns `StaticRange` objects.

## Problem Statement

`getTargetRanges()` was designed for `contentEditable` and is unreliable for `<input>` elements. Many browsers return an empty array. When this happens, `handleDeleteByRange` has no information about the deletion boundaries, and if the cursor is a collapsed caret (`start === end`), the fallback branch (`else if (start !== end)`) does not fire either. The result:

1. `e.preventDefault()` has already suppressed the browser's native word/line delete
2. The handler silently does nothing — no CRDT mutation, no DOM change
3. The user's keystroke is eaten

This affects six `inputType` values: `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`, `deleteSoftLineForward`, `deleteHardLineBackward`, `deleteHardLineForward`.

The `hooks-core` React implementation has the identical bug.

## Success Criteria

- Option+Delete (word backward), Option+Fn+Delete (word forward), Cmd+Delete (line backward), and their Windows/Linux equivalents all work correctly in `<input>` and `<textarea>` elements managed by `editText`
- When `getTargetRanges()` returns valid ranges, the current CRDT-first path is used (no behavior change)
- When `getTargetRanges()` returns empty with a collapsed cursor, the browser performs the deletion natively, and the CRDT is reconciled from the resulting DOM state
- The reconciliation produces character-level CRDT operations (via Loro's Myers' diff in `LoroText.update()`)
- Remote peers see the correct delta
- Cursor position is correct after the operation
- The `editText` public API (`(ref: TextRef) => (e: InputEvent) => void`) does not change
- All existing tests continue to pass

## The Gap

| Aspect | Current | Target |
|---|---|---|
| `e.preventDefault()` | Called unconditionally for all recognized `inputType`s | Deferred for word/line deletes when `getTargetRanges()` fails |
| Fallback when `getTargetRanges()` returns `[]` and cursor is collapsed | Silent no-op | Browser performs native delete; CRDT reconciled from DOM |
| Reconciliation path | Does not exist | One-shot `input` event listener calls `ref.update(input.value)` |
| `handleDeleteByRange` return value | `void` (no signal) | Returns whether it handled the deletion (boolean) |
| `editText` return type | `(e: InputEvent) => void` | Unchanged — reconciliation listener is wired internally |

## Phase 1: Refactor `editText` to Conditionally Prevent Default 🟢

The core architectural change: move `e.preventDefault()` from the top-level dispatch into the conditional path, so that handlers that *cannot* fulfill their contract can signal a passthrough.

### Tasks

1. Change handler return type from `void` to `boolean` 🟢

   `InputHandler` becomes `(ctx: InputContext) => boolean`. Return `true` if the handler performed the CRDT mutation (caller should `preventDefault`), `false` if it could not (caller should let the browser handle it).

   All existing handlers (`handleInsertText`, `handleInsertLineBreak`, `handleDeleteBackward`, `handleDeleteForward`, `handleDeleteSelection`) return `true` unconditionally — they always have enough information.

   ```typescript
   type InputHandler = (ctx: InputContext) => boolean
   ```

2. Update `handleDeleteByRange` to return `false` on fallthrough 🟢

   When `getTargetRanges()` returns empty and the selection is collapsed, return `false` instead of silently doing nothing. The three branches become:

   - `getTargetRanges()` has ranges → apply CRDT delete → return `true`
   - `getTargetRanges()` empty, selection non-collapsed → delete selection → return `true`
   - `getTargetRanges()` empty, selection collapsed → return `false`

3. Move `e.preventDefault()` after the handler call, conditioned on its return value 🟢

   ```typescript
   const handled = handler({ ref, start, end, data: e.data, event: e })
   if (handled) {
     e.preventDefault()
   }
   ```

   This is the key structural inversion: instead of "prevent default, then try to handle," it becomes "try to handle, then prevent default only if we succeeded." For the 14 out of 20 input types where the handler always returns `true`, the behavior is identical. For the 6 word/line delete types, the browser's native behavior runs when we can't compute the CRDT equivalent.

   This ordering is safe: during `beforeinput`, the browser has not yet applied the default action. The spec guarantees that the browser waits for all listeners to complete before checking `defaultPrevented`. So calling `e.preventDefault()` after the CRDT mutation (and the synchronous subscription chain) is correct — the browser's own mutation is still suppressed.

4. Update existing tests to verify `preventDefault` is called conditionally 🟢

   The existing `preventDefault` tests verify it's called for `insertText`, `deleteContentBackward`, `deleteContentForward`. Add a test that verifies `preventDefault` is NOT called when `deleteWordBackward` has no target ranges and a collapsed cursor.

## Phase 2: Add `input` Event Reconciliation 🟢

When the browser handles a word/line deletion natively, the CRDT and DOM are out of sync. The reconciliation path uses the `input` event (which fires after the browser has applied the change) to sync the CRDT from the DOM state.

### Tasks

1. Wire reconciliation into `editText` via a one-shot `input` event listener 🟢

   When a handler returns `false` (passthrough), attach a one-shot `input` event listener to `e.target` that reconciles the CRDT. The reconciliation is a single call:

   ```typescript
   ref.update(target.value)
   ```

   `LoroText.update()` uses **Myers' diff algorithm** internally (in Loro's Rust core) to compute the optimal character-level CRDT operations from old→new text. This is the same function `hooks-core` uses for IME composition reconciliation. It is *not* a full-text replacement — it produces minimal `insert`/`delete` operations that preserve CRDT merge semantics.

   The full wiring in the `editText` closure:

   ```typescript
   const handled = handler({ ref, start, end, data: e.data, event: e })
   if (handled) {
     e.preventDefault()
   } else {
     // Browser will handle it — reconcile on the next input event
     target.addEventListener("input", () => {
       ref.update(target.value)
     }, { once: true })
   }
   ```

   The `{ once: true }` option ensures the listener is automatically removed after firing, preventing leaks. Rapid-fire word deletes (user holds Option+Delete) are safe because each `beforeinput` → browser-action → `input` cycle completes synchronously before the next `beforeinput` fires.

2. Verify subscription-triggered `setRangeText` is benign during reconciliation 🟢

   When `ref.update()` calls `commitIfAuto()`, the `inputTextRegion` subscription fires with `origin: "local"` and calls `patchInputValue(input, ops, "end")`. Since the browser already updated `input.value`, the `setRangeText` call applies text that's already present — a logical no-op. The `"end"` selectMode places the cursor at the deletion point, which should match where the browser already placed it.

   This task is empirical verification during implementation, not a code change. If cursor flicker is observed, a guard can be added, but it's likely unnecessary.

## Phase 3: Tests 🟢

### Tasks

1. Unit test: `handleDeleteByRange` returns `false` on collapsed cursor with empty `getTargetRanges` 🟢

   Covered by Phase 2 test: "should NOT call preventDefault for deleteWordBackward with empty getTargetRanges and collapsed cursor". The handler returning `false` is verified via the observable behavior (preventDefault not called, CRDT unchanged).

2. Unit test: `e.preventDefault()` NOT called when handler returns `false` 🟢

   Covered by Phase 2 test (same as above).

3. Round-trip test: word delete with empty `getTargetRanges` 🟢

   Wire `editText` + `inputTextRegion` on a real Loro `TextRef`. Simulate `beforeinput` with `deleteWordBackward`, empty `getTargetRanges`, collapsed cursor. Then manually simulate what the browser would do: update `input.value` and dispatch an `input` event. Verify:
   - `ref.toString()` reflects the deletion
   - `input.value` is correct
   - `preventDefault` was NOT called on the `beforeinput` event

   Added round-trip tests for `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`, and sequential word deletes — all with `inputTextRegion` wired.

   **Discovery:** Round-trip tests revealed that `ref.update(target.value)` triggers `inputTextRegion`'s subscription synchronously, which applies the text delta to `input.value` via `setRangeText`. If the browser has already updated `input.value`, the delta double-applies (e.g., deleting already-deleted characters). Fix: restore `input.value` to old CRDT state (`ref.toString()`) before calling `ref.update(newValue)`, so the subscription applies the delta to the correct base.

4. Round-trip test: word delete with valid `getTargetRanges` still uses CRDT-first path 🟢

   Same setup, but `getTargetRanges` returns a valid range. Verify:
   - `ref.toString()` reflects the deletion
   - `preventDefault` WAS called

5. Verify all existing tests pass 🟢

   All 971 tests pass across 24 test files.

## Transitive Effect Analysis

### `InputHandler` return type change → all handler call sites

`InputHandler` changes from `(ctx) => void` to `(ctx) => boolean`. Every handler function must be updated to return `true` or `false`. The handler map type (`Record<string, InputHandler>`) inherits the new signature. The only call site is in `editText`'s returned closure — updated in Phase 1, Task 3.

**Risk: Low.** All changes are in `edit-text.ts`. TypeScript will catch any handler that forgets to return a boolean.

### `e.preventDefault()` timing → subscription chain correctness

Moving `e.preventDefault()` after the handler call means the CRDT mutation and synchronous subscription fire *before* `preventDefault` is called. This is safe because `beforeinput` is dispatched synchronously, and the browser does not apply the default action until all event listeners have completed. The subscription's `setRangeText` modifies `input.value` before the browser would have — so when `preventDefault` suppresses the default, the DOM is already correct.

**Risk: None.** The HTML spec guarantees this ordering.

### One-shot `input` listener → event listener leaks

The `{ once: true }` option on `addEventListener` ensures automatic removal. If the `input` event never fires (e.g., the browser decided not to apply the change after all), the listener persists until the next `input` event on that element — which is a normal user action. No leak risk for practical usage.

**Risk: None.**

### Reconciliation `ref.update()` → subscription fires on already-correct DOM

~~When `ref.update(target.value)` fires, `commitIfAuto()` triggers the subscription with `origin: "local"`. The subscription calls `patchInputValue(input, ops, "end")`. Since the browser already updated `input.value`, the `setRangeText` calls apply text that's already present. This is harmless — `setRangeText` with identical content at the correct range is a no-op for the value, and `"end"` mode places the cursor at the deletion point (where the browser already put it).~~

**CORRECTION (Phase 3):** The subscription-applied delta is NOT benign when `input.value` has already been updated by the browser. The delta represents old→new CRDT state, and `patchInputValue` applies it surgically via `setRangeText`. If `input.value` already shows the new state, the delta double-applies (e.g., "delete 5 chars at offset 0" removes from the already-correct value). **Fix:** The reconciliation listener restores `input.value` to the old CRDT state (`ref.toString()`) before calling `ref.update(newValue)`. This ensures the subscription applies the delta to the correct base value.

**Risk: Was low, turned out to be a real bug. Fixed and verified with round-trip tests.**

### `editText` return type unchanged → no downstream API breakage

The public API remains `(ref: TextRef) => (e: InputEvent) => void`. The reconciliation listener is wired internally. No changes needed in `todo-header.ts` or any consumer.

**Risk: None.**

### `hooks-core` has the same bug — no cross-package fix

This plan fixes `editText` only. The `hooks-core` React implementation has identical silent-failure behavior in `handleDeleteByRange`. This is noted for awareness but is out of scope.

## Tests

| Test | Phase | What it proves | Risk addressed |
|---|---|---|---|
| `handleDeleteByRange` returns `false` | 3.1 | Handler signals passthrough | New return-value contract |
| `preventDefault` not called on passthrough | 3.2 | Browser gets to handle the deletion | Core bug fix |
| Round-trip: word delete, empty `getTargetRanges` | 3.3 | Full fallback path works end-to-end | The actual user-facing bug |
| Round-trip: word delete, valid `getTargetRanges` | 3.4 | CRDT-first path not regressed | No regression on happy path |
| All existing tests pass | 3.5 | No breakage | Backward compatibility |

## Alternatives Considered

### Implement word-boundary detection with `Intl.Segmenter`

Use `Intl.Segmenter` with `granularity: "word"` to compute word boundaries ourselves, eliminating the need for `getTargetRanges()`.

Rejected because:
- It duplicates browser-native word-break logic that varies by locale, platform, and context
- `Intl.Segmenter` has limited browser support (no Firefox as of early 2025, behind a flag)
- Line deletion (`deleteSoftLineBackward`) depends on visual line wrapping, which `Intl.Segmenter` cannot compute — it's a layout-dependent concept
- The browser already has this information; the elegant solution is to let it use it

### Custom prefix/suffix string diff for reconciliation

Implement a custom `reconcileInputValue` function that finds common prefix/suffix lengths and calls `ref.delete()` + `ref.insert()` directly.

Rejected because:
- `LoroText.update(text)` already does this with Myers' diff (optimal, in Rust)
- Prefix/suffix matching is a heuristic that fails for edits in the middle of the string
- Myers' diff is battle-tested in Loro's core; a custom diff would need its own test suite
- `hooks-core` already uses `textRef.update(currentValue)` for the analogous IME composition reconciliation case — this is the established pattern

### Always use `input` event reconciliation (no `beforeinput` interception)

Remove the `beforeinput` handler entirely and reconcile all changes from the `input` event.

Rejected because:
- Loses the synchronous CRDT-first update for all operations, not just the fallback
- String diffing is lossy for some operations (can't distinguish between typed text and autocomplete)
- O(n) diff on every keystroke instead of O(1) insert/delete
- Loses the character-level CRDT operation metadata (the diff is a string comparison, not a structured operation)

### Expand `editText` return type to include an `onInput` handler

Return `{ onBeforeInput, onInput }` from `editText` so the consumer wires both events.

Rejected because:
- Changes the public API (`editText(ref)` currently returns a single function)
- Requires all consumers to wire two props instead of one
- The reconciliation listener is an internal implementation detail that should not leak into the API
- The `{ once: true }` one-shot pattern is more precise — it only listens when needed

### Use `requestAnimationFrame` instead of `input` event for reconciliation

After a passthrough, schedule reconciliation on the next animation frame.

Rejected because the `input` event is the precise signal that the browser has applied the change. `requestAnimationFrame` may fire before or after the DOM update depending on the browser's event processing order. The `input` event is guaranteed to fire after the default action has been applied.

## Resources for Implementation Context

### Files to Modify

- `packages/kinetic/src/loro/edit-text.ts` — `InputHandler` type, `handleDeleteByRange`, `editText` closure, reconciliation wiring
- `packages/kinetic/src/loro/edit-text.test.ts` — new tests for passthrough, reconciliation, round-trip

### Files to Read (context)

- `packages/kinetic/src/runtime/text-patch.ts` — `inputTextRegion`, `patchInputValue` (understand subscription path)
- `packages/kinetic/src/runtime/text-patch.test.ts` — round-trip test patterns with `Scope` + `inputTextRegion`
- `packages/change/src/reactive-bridge.ts` — `translateEventBatch` origin forwarding (understand delta provenance)
- `packages/change/src/typed-refs/text-ref-internals.ts` — `TextRefInternals.update()` calls `LoroText.update()` + `commitIfAuto()`
- `packages/kinetic/TECHNICAL.md` — Input Text Region Architecture section (document the fallback)

### Key Spec References

- [HTML spec: `beforeinput` event cancelation](https://w3c.github.io/uievents/#event-type-beforeinput) — "If the event is canceled, the user agent MUST NOT update the DOM"
- [HTML spec: `input` event](https://w3c.github.io/uievents/#event-type-input) — fires after the user agent has updated the DOM
- [Input Events Level 2: `getTargetRanges()`](https://w3c.github.io/input-events/#dom-inputevent-gettargetranges) — returns `StaticRange[]`, may be empty for `<input>` elements
- [MDN: `InputEvent.inputType`](https://developer.mozilla.org/en-US/docs/Web/API/InputEvent/inputType) — `deleteWordBackward`, `deleteSoftLineBackward`, etc.

## Documentation

### TECHNICAL.md Update

Add a subsection under "Input Text Region Architecture" documenting the browser-native fallback:

- The three-tier strategy: CRDT-first (character ops) → `getTargetRanges()` (word/line ops) → browser-native + reconciliation (fallback)
- Why `<input>` elements don't reliably support `getTargetRanges()`
- The `input` event reconciliation path using `ref.update()` (Loro's Myers' diff)
- Why `setRangeText` from the reconciliation subscription is benign (DOM already correct)

## Learnings

1. **`LoroText.update(text)` uses Myers' diff internally — don't reinvent it.** Loro's Rust core computes optimal character-level CRDT operations from an old→new string diff. This is the right tool for reconciliation when the browser has performed a DOM mutation we couldn't intercept. The `hooks-core` package already uses `textRef.update(currentValue)` for IME composition reconciliation — establishing the pattern. A custom prefix/suffix diff in JavaScript would be both less optimal (heuristic vs. optimal) and redundant.

2. **The contract pattern — "try to handle, then prevent default only on success" — is more principled than "prevent default unconditionally."** The original `editText` assumed it could always translate any recognized `inputType` into a CRDT operation. For word/line deletions via `getTargetRanges()`, this assumption fails. The boolean return from handlers makes the contract explicit: `true` means "I fulfilled my obligation, suppress the browser," `false` means "I couldn't, let it through." This is the same pattern used for `historyUndo`/`historyRedo` (return early without `preventDefault`) and unknown input types (return early without `preventDefault`) — it just wasn't applied to the partial-failure case within a recognized handler.

3. **`beforeinput` listeners can safely call `preventDefault()` after performing side effects.** The HTML spec guarantees the browser doesn't apply the default action until all listeners complete. This means "handler mutates CRDT → subscription updates DOM → `preventDefault()` suppresses browser action" is a valid sequence. The DOM is correct because the subscription updated it; `preventDefault` just prevents the browser from *also* updating it. No race, no double-mutation.

4. **Reconciliation requires DOM-state restoration before `ref.update()`.** When `ref.update(newValue)` fires, `commitIfAuto()` triggers the `inputTextRegion` subscription synchronously. The subscription applies a text delta via `patchInputValue` / `setRangeText` — but those ops are relative to the *old* CRDT state. If the browser has already updated `input.value` to the new state, the delta double-applies (e.g., a delete-5-chars op removes chars from the already-correct shorter string). The fix: save `target.value`, restore `target.value = ref.toString()` (old CRDT state), then call `ref.update(savedValue)`. The subscription then applies the delta to the correct base. This was flagged as "low risk, verify empirically" in the transitive effect analysis — the round-trip tests caught it.