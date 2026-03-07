# Plan: Delta-Aware Input Text Region

## Background

Kinetic's delta region algebra applies a consistent pattern across DOM targets: subscribe to a reactive ref, receive structured deltas, and apply surgical DOM updates. This works for Text nodes (`textRegion` → `insertData`/`deleteData`), list containers (`listRegion` → `insertBefore`/`removeChild`), and conditional branches (`conditionalRegion` → `replaceChild`).

One DOM target is missing from this algebra: **`<input>` and `<textarea>` element values**. Today, `bind(doc.textRef)` uses `bindTextValue`, which:

1. **Reads via raw container**: calls `loro(ref)` to get the native `LoroText`, bypassing the typed ref API
2. **Writes via full replacement**: `delete(0, length)` + `insert(0, newValue)` on every keystroke, destroying CRDT character-level merge semantics
3. **Never commits**: raw `LoroText` mutations don't call `commitIfAuto()`, so changes are invisible to subscriptions and remote peers
4. **Ignores deltas**: the subscription callback re-reads the full value and assigns `element.value = ref.toString()`, which resets the cursor

The `beforeinput` DOM event provides the user's actual editing operations (`inputType`, `data`, `selectionStart`/`selectionEnd`), and Loro's subscription system provides structured text deltas (`retain`/`insert`/`delete`). The browser's `setRangeText(text, start, end, "preserve")` API applies surgical edits to input values while automatically preserving cursor position. All three pieces exist — they just need to be connected.

## Problem Statement

1. **Remote peers never see text input changes.** `bindTextValue` mutates the raw `LoroText` container without committing. Changes accumulate silently until an unrelated commit (e.g., clicking "Add") flushes them. Confirmed via diagnostic logging.

2. **CRDT merge semantics are destroyed.** Full-text replacement on every keystroke means concurrent edits overwrite each other entirely instead of merging at the character level.

3. **Cursor position is lost on remote updates.** The subscription callback does `element.value = ref.toString()`, which resets the cursor to the end. Collaborative editing in a shared text field is unusable.

4. **The delta region algebra is incomplete.** `textRegion` handles Text nodes surgically, but `<input>.value` is a different DOM target that needs its own delta-aware strategy. The compiler already has the information (`deltaKind: "text"`, `directReadSource`) but doesn't use it for attributes.

## Success Criteria

- `inputTextRegion(element, ref, scope)` exists as a runtime function analogous to `textRegion`, applying text deltas to `<input>`/`<textarea>` values via `setRangeText("preserve")` with automatic cursor preservation
- The compiler generates `inputTextRegion` for `value:` attributes when the dependency is a direct TextRef read (`deltaKind: "text"` + `directReadSource`)
- `editText(ref)` exists as a plain runtime function returning a `beforeinput` handler that translates DOM editing operations into typed-ref `insert()`/`delete()` calls with auto-commit
- The todo app's text input uses `value: doc.newTodoText.toString()` + `onBeforeInput: editText(doc.newTodoText)` — two independent, composable props
- Collaborative editing works: typing on Client A is visible on Client B without cursor disruption
- `onBeforeInput`, `onCompositionStart`, and `onCompositionEnd` are added to the `Props` type
- Diagnostic logging in `bindTextValue` is removed (already done)
- `bind()` continues to work for checkboxes and other non-text use cases

## The Gap

| Aspect | Current | Target |
|---|---|---|
| Read direction (CRDT → DOM) for input values | `element.value = ref.toString()` (full replacement, cursor lost) | `inputTextRegion` → `setRangeText("preserve")` (surgical, cursor preserved) |
| Read direction (CRDT → DOM) for Text nodes | `textRegion` → `insertData`/`deleteData` (already works) | No change |
| Write direction (DOM → CRDT) for input values | `bindTextValue` → raw container `delete(0,len)` + `insert(0,val)`, no commit | `editText(ref)` → typed ref `insert(pos,text)` / `delete(pos,len)` with auto-commit |
| Compiler attribute subscription strategy | Always naive `element.value = expr` | Delta-aware when `deltaKind === "text"` + `directReadSource` on `value` attribute |
| `Props.onBeforeInput` | Not in type | Added |
| Diagnostic logging in `bindTextValue` | ~~Present~~ Already removed | ✅ Done |

## Phase 1: `inputTextRegion` — Delta-Aware Input Value Patching 🟢

The read direction: CRDT deltas applied surgically to `<input>.value` via `setRangeText`.

### Tasks

1. **Implement `patchInputValue` in `packages/kinetic/src/runtime/text-patch.ts`** 🟢

   Add alongside the existing `patchText` function. Reuses the existing `planTextPatch` pure function to convert cursor-based deltas to offset-based ops, then applies them via `setRangeText("preserve")` instead of `insertData`/`deleteData`.

   Signature:

   ```ts
   export function patchInputValue(
     input: HTMLInputElement | HTMLTextAreaElement,
     ops: TextDeltaOp[],
   ): void
   ```

   Translation: `{ kind: "insert", offset, text }` → `input.setRangeText(text, offset, offset, "preserve")`. `{ kind: "delete", offset, count }` → `input.setRangeText("", offset, offset + count, "preserve")`.

2. **Implement `inputTextRegion` in `packages/kinetic/src/runtime/text-patch.ts`** 🟢

   Follows the same pattern as `textRegion`: set initial value, subscribe, dispatch deltas surgically.

   Signature:

   ```ts
   export function inputTextRegion(
     input: HTMLInputElement | HTMLTextAreaElement,
     ref: unknown,
     scope: Scope,
   ): void
   ```

   For `delta.type === "text"`, calls `patchInputValue`. For other delta types (fallback), assigns `input.value = ref.get()`.

3. **Export `inputTextRegion` from `packages/kinetic/src/runtime/index.ts`** 🟢

4. **Add tests for `patchInputValue` and `inputTextRegion`** 🟢

   In `packages/kinetic/src/runtime/text-patch.test.ts`. Extract the existing `createMockTextRef` helper (currently scoped inside the `textRegion` describe block) to the top level of the test file so both `textRegion` and `inputTextRegion` test suites share it without duplication. Tests:

   - `patchInputValue` insert at offset preserves cursor (mock `setRangeText`)
   - `patchInputValue` delete at offset preserves cursor
   - `patchInputValue` combined retain + delete + insert
   - `inputTextRegion` sets initial value
   - `inputTextRegion` applies text delta via `patchInputValue` on subscription
   - `inputTextRegion` falls back to full replacement for non-text deltas
   - `inputTextRegion` cleans up subscription on scope dispose

## Phase 2: Compiler — Delta-Aware `value` Attribute Subscription 🟢

Extend attribute codegen to use property-based setters consistently, then add `inputTextRegion` dispatch for direct TextRef reads on `value` attributes.

### Tasks

1. **Extract `generateAttributeUpdateCode` helper in `packages/kinetic/src/compiler/codegen/dom.ts`** ✅

   The template cloning path (`generateHoleSetup`, `"attribute"` case) uses `setAttribute` for all attributes, while the non-cloning path (`generateAttributeSet`, `generateAttributeSubscription`) correctly uses DOM properties for `value`, `checked`, `disabled`, `class`, and `style`. This is a latent bug: `setAttribute("value", x)` does not update `input.value` after user interaction — it only changes the HTML default attribute.

   Extract a pure function that maps `(elementVar, attrName, valueExpr)` → the correct DOM update expression string. Both `generateAttributeSet`, `generateAttributeSubscription`, and the `"attribute"` case in `generateHoleSetup` should call this function, collapsing their duplicated if/else chains and fixing the cloning path by construction.

   ```ts
   function generateAttributeUpdateCode(
     elementVar: string,
     attrName: string,
     valueExpr: string,
   ): string
   ```

   Property-based mappings: `value` → `.value =`, `checked` → `.checked =`, `disabled` → `.disabled =`, `class` → `.className =`, `style` → `Object.assign(el.style, expr)`, `data-*` → `.dataset.X =`. Everything else → `setAttribute`. Note: the cloning path currently uses `setAttribute` for **all** of these (including render-time attributes, not just reactive ones), so the fix covers both binding times.

2. **Extend `generateAttributeSubscription` for delta-aware `value` dispatch** ✅

   When `attr.name === "value"` and `attr.value.directReadSource` is set and `attr.value.dependencies.length === 1` and `attr.value.dependencies[0].deltaKind === "text"`, emit `inputTextRegion(elementVar, directReadSource, scopeVar)` instead of the naive subscription. Apply the same dispatch in `generateHoleSetup`'s `"attribute"` case for cloning.

   This parallels the existing `textRegion` dispatch in `generateReactiveContentSubscription`. Both `generateAttributeSet` (non-cloning) and the static-set portion of `generateHoleSetup` (cloning) must skip the initial value set for this attribute, since `inputTextRegion` handles initialization internally.

3. **Add `inputTextRegion` to `collectRequiredImports` in `packages/kinetic/src/compiler/transform.ts`** ✅

   When an element has a `value` attribute with `directReadSource` and `deltaKind === "text"`, include `inputTextRegion` in the runtime imports.

4. **Add codegen unit tests in `packages/kinetic/src/compiler/codegen/dom.test.ts`** ✅

   - `value: doc.ref.toString()` with `deltaKind: "text"` → generates `inputTextRegion`
   - `value: doc.ref.toString()` with `deltaKind: "replace"` → generates naive `subscribe`
   - `value: someExpr` without `directReadSource` → generates naive `subscribe`
   - Template cloning path: `value` attribute hole uses `.value =` (not `setAttribute`)
   - Template cloning path: `checked` attribute hole uses `.checked =` (not `setAttribute`)
   - Template cloning path: `style` attribute hole uses `Object.assign(el.style, ...)` (not `setAttribute`)
   - Template cloning path: render-time `value` attribute uses `.value =` (not `setAttribute`)

5. **Add integration test in `packages/kinetic/src/compiler/integration.test.ts`** ✅

   Compile a component with `input({ value: doc.title.toString() })` where `doc.title` is a `TextRef`, verify the generated code calls `inputTextRegion`, and verify that a subsequent `doc.title.insert()` updates `element.value` via surgical patching (mock `setRangeText`). Also added schema-inferred TextRef test (verifying narrow-delta-types fix works end-to-end for value attributes).

## Phase 3: `editText` — Operation-Aware Write Direction 🟢

The write direction: `beforeinput` DOM events translated into CRDT operations on the typed ref.

### Tasks

1. **Add `onBeforeInput`, `onCompositionStart`, `onCompositionEnd` to `Props` type in `packages/kinetic/src/types.ts`** ✅

   ```ts
   onBeforeInput?: (e: InputEvent) => void
   onCompositionStart?: (e: CompositionEvent) => void
   onCompositionEnd?: (e: CompositionEvent) => void
   ```

   The analyzer's `isEventHandlerProp` already matches any `on[A-Z]` prop, and the codegen emits `addEventListener(eventName, handler)` — no analyzer or codegen changes needed.

2. **Implement `editText` in `packages/kinetic/src/loro/edit-text.ts`** ✅

   A plain runtime function that returns a `beforeinput` event handler. No compiler magic — it's just a function the developer calls.

   Signature:

   ```ts
   import type { TextRef } from "@loro-extended/change"

   export function editText(
     ref: TextRef,
   ): (e: InputEvent) => void
   ```

   The returned handler:
   - Checks `e.isComposing` — if true, returns (lets browser manage IME composition)
   - Passes through `historyUndo`/`historyRedo` (don't `preventDefault`)
   - Calls `e.preventDefault()` for all other input types
   - Reads `selectionStart`/`selectionEnd` from `e.target`, clamped to `ref.length`
   - Dispatches to an `inputType` → handler strategy map (duplicated from `hooks-core/create-text-hooks/input-handlers.ts` — see divergences below)
   - Each handler calls `ref.insert()` / `ref.delete()` on the typed ref (auto-commits via `commitIfAuto`)

   `inputType` handlers to implement:

   | `inputType` | Strategy |
   |---|---|
   | `insertText`, `insertFromPaste`, `insertFromDrop`, `insertFromComposition` | Delete selection if non-collapsed, then `ref.insert(start, data)` |
   | `insertLineBreak`, `insertParagraph` | Delete selection if non-collapsed, then `ref.insert(start, "\n")` |
   | `deleteContentBackward` | Delete selection, or `ref.delete(start-1, 1)` if collapsed |
   | `deleteContentForward` | Delete selection, or `ref.delete(start, 1)` if collapsed (use `ref.length` for bounds check, not `input.value.length`) |
   | `deleteByCut` | Delete selection |
   | `deleteWordBackward`, `deleteWordForward`, `deleteSoftLineBackward`, `deleteSoftLineForward`, `deleteHardLineBackward`, `deleteHardLineForward` | Use `e.getTargetRanges()` if available, fall back to selection |

   **Deliberate divergences from `hooks-core/input-handlers.ts`:**
   - `calculateNewCursor` is **not duplicated** — `setRangeText("preserve")` handles cursor positioning natively via the `inputTextRegion` subscription
   - `handleDeleteForward` uses `ref.length` for the forward-deletion bounds check instead of `input.value.length`, because `e.preventDefault()` means the input value hasn't been updated yet
   - The `input` field is removed from the context type (not needed — cursor management is handled by `setRangeText`)
   - Add a source comment referencing `hooks-core/create-text-hooks/input-handlers.ts` as the origin

   After the CRDT mutation, `commitIfAuto` fires synchronously → the `inputTextRegion` subscription runs → `setRangeText("preserve")` updates the DOM with cursor preservation. The handler does not need to manage the cursor.

3. **Export `editText` from `packages/kinetic/src/loro/index.ts`** ✅

4. **Re-export `editText` from `packages/kinetic/src/index.ts`** ✅

5. **Add tests for `editText` in `packages/kinetic/src/loro/edit-text.test.ts`** ✅

   Use the existing JSDOM + Loro test setup pattern from `binding.test.ts`.

   - Insert text at cursor → `ref.toString()` reflects the insertion
   - Delete backward (backspace) → correct character removed
   - Delete forward → correct character removed
   - Replace selection → delete range + insert at position
   - Paste (`insertFromPaste`) → multi-char insert at position
   - `e.isComposing === true` → handler returns without modifying ref
   - Auto-commit fires → `ref.toString()` returns new value (proving typed ref path, not raw container)

   Note: JSDOM does not implement `getTargetRanges()` on `InputEvent`. Tests for word/line deletion should mock `getTargetRanges` via `Object.defineProperty`. The primary position source is `selectionStart`/`selectionEnd`, which JSDOM supports.

## Phase 4: Update the Todo App 🟢

### Tasks

1. **Update `examples/kinetic-todo/src/todo-header.ts`** ✅

   Replace `value: bind(doc.newTodoText)` with:
   - `value: doc.newTodoText.toString()` — reactive expression, compiler auto-subscribes via `inputTextRegion`
   - `onBeforeInput: editText(doc.newTodoText)` — operation-aware write handler

   Remove the `bind` import. Add `editText` import from `@loro-extended/kinetic`.

2. **Rebuild and verify** ✅

   - `npx tsc --noEmit` in `examples/kinetic-todo` — type checks pass (after `pnpm --filter @loro-extended/kinetic run build` to update dist)
   - `npx vitest run` in `packages/kinetic` — all 907 tests pass

## Phase 5: Documentation 🟢

### Tasks

1. **Update `packages/kinetic/TECHNICAL.md`** ✅

   - Add "Input Text Region Architecture" subsection under "Text Region Architecture", documenting `inputTextRegion` as the `<input>` analog of `textRegion`, the `patchInputValue` function, the `setRangeText("preserve")` mechanism, and the codegen dispatch condition
   - Update "Loro Bindings Subpath" to document `editText` alongside the existing `bind*` functions
   - Update "Builder Components" section to replace closure-based component example with props-based `editText` pattern
   - Update the "Delta Region Algebra" table and composability diagram to include `inputTextRegion`

2. **Update `examples/kinetic-todo/README.md`** ✅

   Replaced the "Two-Way Bindings" bullet and the "Components" section to show the `editText` + reactive `value` pattern instead of `bind()`.

3. **Update `packages/kinetic/src/loro/README.md`** ✅

   Added `editText(ref)` documentation as the recommended approach for text inputs, added comparison table between `editText` and `bind()`, updated framing from "Bindings" to "Extensions".

4. **Create changeset** ✅

   Minor changeset for `@loro-extended/kinetic` in `.changeset/input-text-region-edit-text.md`.

## Tests

| Test | Phase | What it proves | Risk addressed |
|---|---|---|---|
| `patchInputValue` insert at offset | 1.4 | `setRangeText` called with correct args | Core DOM operation translation |
| `patchInputValue` delete at offset | 1.4 | Delete range via `setRangeText("", start, end)` | Deletion offset math |
| `inputTextRegion` initial value | 1.4 | Element value set on initialization | Blank input on mount |
| `inputTextRegion` text delta | 1.4 | Subscription dispatches to `patchInputValue` | Delta-aware read direction |
| `inputTextRegion` fallback | 1.4 | Non-text delta triggers full replacement | Robustness for unexpected delta types |
| Codegen: `value` + TextRef → `inputTextRegion` | 2.4 | Compiler generates delta-aware code | Codegen dispatch condition |
| Codegen: `value` + non-TextRef → naive subscribe | 2.4 | Non-text deps use fallback | No false positive optimization |
| Codegen: cloning `value` hole uses `.value =` | 2.4 | Template cloning uses property setter | `setAttribute` latent bug |
| Codegen: cloning `checked` hole uses `.checked =` | 2.4 | Template cloning uses property setter | `setAttribute` latent bug |
| Codegen: cloning `style` hole uses `Object.assign` | 2.4 | Template cloning uses style API | `setAttribute("style", obj)` → `[object Object]` |
| Codegen: cloning render-time `value` uses `.value =` | 2.4 | Render-time path also fixed | `setAttribute` affects both binding times |
| Integration: compiled input with TextRef | 2.5 | End-to-end compile + runtime path | Full pipeline correctness |
| `editText` insert text | 3.5 | `ref.insert()` called at correct position | Write direction core |
| `editText` backspace | 3.5 | `ref.delete()` at correct position | Deletion position math |
| `editText` replace selection | 3.5 | Selection delete + insert | Selection handling |
| `editText` isComposing skip | 3.5 | IME events ignored | No double-apply during composition |
| `editText` auto-commit | 3.5 | `ref.toString()` reflects change immediately | The original bug (no commit) |

## Transitive Effect Analysis

### `generateAttributeUpdateCode` unification → template cloning codegen fixed

The template cloning path (`generateHoleSetup`, `"attribute"` case) currently uses `setAttribute` for all non-`data-*` attributes — for **both** render-time and reactive binding times. For user-mutable properties (`value`, `checked`), `setAttribute` only changes the HTML default attribute — not the live DOM property — after user interaction. For `style` with an object value, `setAttribute("style", obj)` produces `"[object Object]"`. Extracting `generateAttributeUpdateCode` and using it in all three codegen sites (non-cloning set, non-cloning subscription, cloning hole setup) fixes this entire class of bugs by construction. This is addressed in Phase 2 Task 1.

### `generateAttributeSubscription` changes → template cloning codegen

The template cloning path has its own attribute subscription logic in `generateHoleSetup`. The same `inputTextRegion` dispatch condition must be applied there. The hole-based codegen handles `value` attributes in the `"binding"` hole kind, not as regular attributes — but when `value:` is a reactive expression (not a `bind()` call), it flows through `"attribute"` holes. Both paths need the delta-aware dispatch.

### `inputTextRegion` sets initial value → `generateAttributeSet` must skip

If `inputTextRegion` is generated for a `value` attribute, the static initial-value set must be skipped for that attribute in both the non-cloning path (`generateAttributeSet`) and the cloning path (the render-time branch of `generateHoleSetup`'s `"attribute"` case), since `inputTextRegion` handles initialization internally. Otherwise the value would be set twice.

### `editText` calls `e.preventDefault()` → browser won't update the input

This is intentional. The `inputTextRegion` subscription handles all DOM updates. The flow is: `beforeinput` → `ref.insert()` → `commitIfAuto()` → subscription fires synchronously → `setRangeText("preserve")` updates the DOM. All within the same synchronous tick — the user never sees an intermediate state.

### `style` object via `setAttribute` in cloning path

`setAttribute("style", { color: "red" })` calls `.toString()` on the object, producing the inline style `"[object Object]"`. The non-cloning path correctly uses `Object.assign(el.style, expr)` for non-literal style values, but the cloning path falls through to `setAttribute`. The `generateAttributeUpdateCode` extraction fixes this — `style` is included in the property-based mapping with the `Object.assign` form.

### `setRangeText("preserve")` browser support

`setRangeText` with the `selectMode` parameter is Baseline Widely Available since January 2020. All modern browsers support it. No polyfill needed.

### IME composition handling

During IME composition, `beforeinput` fires with `e.isComposing === true`. The `editText` handler returns early, letting the browser manage the intermediate composition state. When composition ends, the browser fires `beforeinput` with `inputType: "insertFromComposition"` (or `"insertText"` in some browsers) and `e.isComposing === false`. The handler processes this as a normal insert. For more sophisticated IME handling (e.g., syncing intermediate composition text), the developer can add explicit `onCompositionEnd` handlers — this is an incremental enhancement, not a Phase 1 requirement.

### `getTargetRanges()` for `<input>` elements

`getTargetRanges()` returns `StaticRange` objects designed primarily for `contentEditable`. For `<input>` elements, it may return an empty array in some browsers. The implementation uses `selectionStart`/`selectionEnd` as the primary position source, with `getTargetRanges()` as a supplement for word/line deletion operations where the browser computes boundaries.

### `bindTextValue` still used by existing `bind()` calls

`bind(ref)` on a `value` attribute still generates `bindTextValue(element, ref, scope)` via the existing codegen path. This plan does not modify the `bind()` detection or codegen. The two paths coexist: `bind()` for backward compatibility, direct `value:` expression for the delta-aware path. `bind()` is still the correct mechanism for `checked` and numeric bindings.

### Runtime import registration

`inputTextRegion` must be added to the runtime import set in `transform.ts` (alongside `textRegion`, `listRegion`, etc.) and to the runtime dependency map in integration tests (`RUNTIME_DEPS` object in `integration.test.ts`).

### Remote sync after `editText` mutations

`TextRef.insert()` and `TextRef.delete()` call `commitIfAuto()` internally (confirmed in `TextRefInternals`). The commit triggers Loro's event system synchronously, which fires container subscriptions → `translateEventBatch` → `ReactiveDelta { type: "text", ops: [...] }` → `inputTextRegion`'s handler → `patchInputValue` → `setRangeText("preserve")`. The entire chain is synchronous within one event loop tick.

## Alternatives Considered

### `editText` as a compiler-recognized marker (like `bind`)

We considered having the compiler detect `editText(ref)` in props (or `...editText(ref)` as a spread) and generate specialized codegen that wires both read and write directions in a single `wireEditText(element, ref, scope)` call.

Rejected because it creates special syntax for a problem that decomposes into two independent, general concerns. The read direction is a compiler optimization that applies to *any* direct TextRef read on a `value` attribute — not just those paired with `editText`. The write direction is a plain runtime function. Keeping them independent means each works without the other and composes with other props naturally.

### `editText` returns a props object to spread

We considered `...editText(ref)` returning `{ value, onBeforeInput, onCompositionStart, onCompositionEnd }`. This is the most ergonomic API, but the compiler's `analyzeProps` does not handle `SpreadAssignment` nodes — it only processes `PropertyAssignment` and `ShorthandPropertyAssignment`. Adding generic spread support requires the compiler to handle opaque runtime objects, which is a fundamental architectural change. Adding `editText`-specific spread detection is the "special syntax" we want to avoid.

### Fix `bindTextValue` internally

We considered keeping `bind()` as the API and fixing `bindTextValue` to use `beforeinput` and typed ref methods. Rejected because `bind()` treats the ref as a value (get string, set string), which is the wrong abstraction for an operation log. The delta-aware read direction and operation-aware write direction are fundamentally different concerns that should be expressed independently.

### String diff for write direction

We considered computing a diff between old and new `element.value` strings to determine what was inserted/deleted. Rejected because it reverse-engineers information that `beforeinput` already provides, is more expensive (string comparison on every keystroke), and is lossy (can't distinguish between typed text and autocomplete replacement).

## Resources for Implementation Context

- `packages/kinetic/src/runtime/text-patch.ts` — existing `planTextPatch`, `patchText`, `textRegion` (add `patchInputValue` and `inputTextRegion` here)
- `packages/kinetic/src/runtime/text-patch.test.ts` — existing tests (add `patchInputValue` and `inputTextRegion` tests here)
- `packages/kinetic/src/compiler/codegen/dom.ts` L295–341 — `generateAttributeSubscription` (modify for delta-aware dispatch)
- `packages/kinetic/src/compiler/codegen/dom.ts` L162–225 — `generateReactiveContentSubscription` (reference pattern for delta-aware dispatch)
- `packages/kinetic/src/compiler/codegen/dom.ts` L958–1112 — `generateHoleSetup` (template cloning path, also needs delta-aware dispatch for attribute holes)
- `packages/kinetic/src/compiler/codegen/dom.ts` L255–290 — `generateAttributeSet` (must skip static set when `inputTextRegion` handles initialization)
- `packages/kinetic/src/compiler/transform.ts` — `collectRequiredImports` (add `inputTextRegion` to runtime imports)
- `packages/kinetic/src/compiler/integration.test.ts` L3279–3288 — `RUNTIME_DEPS` map (add `inputTextRegion`)
- `packages/kinetic/src/compiler/analyze.ts` L520–548 — `analyzeExpression` (already populates `directReadSource`)
- `packages/kinetic/src/compiler/ir.ts` L134–170 — `ContentValue` with `directReadSource` and `dependencies[].deltaKind`
- `packages/kinetic/src/loro/binding.ts` — `bindTextValue` (diagnostic logging already removed; file stays for reference)
- `packages/kinetic/src/loro/binding.test.ts` — test setup patterns for JSDOM + Loro
- `packages/kinetic/src/types.ts` L79–100 — `Props` event handlers (add `onBeforeInput`, `onCompositionStart`, `onCompositionEnd`)
- `packages/change/src/typed-refs/text-ref.ts` — `TextRef.insert()`, `.delete()`, `.length` API
- `packages/change/src/typed-refs/text-ref-internals.ts` L14–22 — confirms `commitIfAuto()` on mutations
- `packages/hooks-core/src/create-text-hooks/input-handlers.ts` — reference implementation for `inputType` → handler strategy map (duplicate, do not import)
- `packages/hooks-core/src/create-text-hooks/cursor-utils.ts` — `adjustCursorFromDelta` (not needed — `setRangeText("preserve")` handles cursor adjustment natively)
- `examples/kinetic-todo/src/todo-header.ts` — update to use new API
- MDN `HTMLInputElement.setRangeText()` — https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/setRangeText
- MDN `InputEvent.inputType` — https://developer.mozilla.org/en-US/docs/Web/API/InputEvent/inputType
- MDN `beforeinput` event — https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event

## Learnings

1. **The delta region algebra extends to input values.** `textRegion` (Text nodes), `listRegion` (list containers), and `conditionalRegion` (branch switching) each map CRDT deltas to surgical DOM operations. `inputTextRegion` is the fourth member: CRDT text deltas → `setRangeText("preserve")` on input elements. The pattern is: subscribe, receive structured delta, apply the minimum DOM mutation. The homomorphism `{ retain, insert, delete }` → `setRangeText` completes the algebra for all text-bearing DOM targets.

2. **~~`setRangeText("preserve")` eliminates cursor arithmetic.~~** **CORRECTED — see `.plans/delta-provenance.md`.** The original claim was incorrect. Per the HTML spec, `"preserve"` adjusts `selectionStart` only when it is *strictly greater than* the replacement range's `end`. When inserting at the cursor position (`start === end === selectionStart`), neither adjustment branch fires — the cursor stays put. This causes typing "Hello" to produce "olleH" because each character is inserted at position 0 (the cursor never advances). `"preserve"` is correct for **remote** edits (where the insertion point differs from the local cursor) but **incorrect** for local edits at the cursor. The fix adds delta provenance (`origin` field on `ReactiveDelta`) and a per-element active-edit flag: during `editText` handler execution, `inputTextRegion` skips `patchInputValue` entirely, and `editText` manages the cursor via `setSelectionRange`. Remote edits continue to use `setRangeText("preserve")` as before.

3. **The read and write directions are genuinely independent — with a coordination point.** The read direction (delta-aware subscription) is a compiler optimization that falls out of existing `deltaKind` analysis — it applies to any direct TextRef read on a `value` attribute, regardless of whether `editText` is used. The write direction (`editText`) is a plain runtime function that translates `beforeinput` events into CRDT operations. Neither requires the other, and both compose naturally with other props. However, when both are present on the same element, they share ephemeral DOM state (the cursor position) that requires coordination. This is handled via a per-element active-edit flag — a minimal coupling point that preserves independence for the common case (read-only display inputs, write-only CRDT inputs) while enabling correct cursor behavior when both are wired together.

4. **The compiler already knows everything it needs.** `analyzeExpression` populates `directReadSource` and `deltaKind` for all expressions, including attribute values. The `generateAttributeSubscription` function simply doesn't use this information yet. The fix is a conditional branch in codegen, not a new analysis pass.

5. **Raw Loro container mutations don't auto-commit.** The typed ref wrappers (`TextRef`, `ListRef`, etc.) call `commitIfAuto()` after each mutation. Going directly to the `LoroText` container via `loro(ref)` bypasses this. Any code that mutates Loro containers should use the typed ref API, not the raw container, unless it explicitly manages commits.

6. **`setAttribute` vs DOM properties is a class of bugs, not a single bug.** `setAttribute("value", x)` sets the HTML attribute (the default), not the live DOM property. After user interaction, the attribute and property diverge — `setAttribute` silently stops updating the visible input value. The same applies to `checked`. The template cloning codegen path uses `setAttribute` generically for all non-`data-*` attributes, while the non-cloning path correctly uses property-based setters. Extracting a shared `generateAttributeUpdateCode` function fixes this by construction and prevents future divergence.

7. **The `setAttribute` bug in the cloning path affects render-time attributes too, not just reactive ones.** Both the render-time branch and the reactive branch of `generateHoleSetup`'s `"attribute"` case use `setAttribute`. A render-time `value: someVar` in a cloned template would also fail to update the live DOM property. The `generateAttributeUpdateCode` extraction fixes both binding times.

8. **`style` with an object value via `setAttribute` produces `[object Object]`.** `setAttribute("style", { color: "red" })` calls `.toString()` on the object, which is always `"[object Object]"`. The non-cloning path correctly uses `Object.assign(el.style, expr)`. Including `style` in the `generateAttributeUpdateCode` property-based mapping fixes this for free.

9. **`insertFromComposition` is missing from `hooks-core`'s `inputHandlers` map.** When IME composition ends, browsers fire `beforeinput` with `inputType: "insertFromComposition"`. The existing `hooks-core` reference implementation doesn't handle this explicitly, so composition completion would silently do nothing. The `editText` strategy map must include `insertFromComposition` alongside `insertText`.

10. **`bindTextValue` diagnostic logging was already removed.** The four `console.log("[bindTextValue]...")` statements referenced in the original problem analysis are no longer present in the codebase. Phase 4 Task 2 (remove diagnostic logging) is already complete and has been struck from the plan.

11. **`collectRequiredImports` already has an attribute-scanning loop in the element branch.** It iterates `child.attributes` to detect `subscribeMultiple` needs. The `inputTextRegion` import check slots in alongside that existing loop — no new iteration structure needed.

12. **The `Props` type for `value` accepts `Binding<T>` only via the loose `Record<string, unknown>` intersection.** `value` is typed as `string | (() => string)`, but `bind()` returns `Binding<T>`. This works because the intersection with `Record<string, unknown>` allows any key. The new pattern (`value: doc.ref.toString()`) returns `string`, which is properly typed — an incidental type-safety improvement.