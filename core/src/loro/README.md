# Loro-Specific Extensions

This subpath contains runtime functions that require direct access to Loro containers. These are **Loro-specific extensions** to the core Kinetic runtime, including two-way bindings and operation-aware write functions.

## Why a Separate Subpath?

The core Kinetic runtime (`@loro-extended/kinetic`) is **Loro-agnostic**. It uses the `[REACTIVE]` symbol from `@loro-extended/reactive` to subscribe to changes uniformly, supporting any type that implements the `Reactive` interface:

- `LocalRef` from `@loro-extended/reactive`
- Loro typed refs from `@loro-extended/change`
- Custom reactive types

However, **write-direction functions** (two-way bindings, operation-aware text editing) require direct Loro container access for mutations. They can't work through the generic `[REACTIVE]` interface because:

1. **Read path** — Uses `[REACTIVE]` for subscriptions ✅
2. **Write path** — Needs Loro typed ref methods like `textRef.insert()` + `textRef.delete()` ❌

This asymmetry is intentional and explicit. By placing Loro-specific functions in a separate subpath, we:

- Keep the core runtime minimal and portable
- Make Loro dependencies visible in import statements
- Enable future extensibility (other CRDT libraries could have their own binding subpaths)

## Usage

Generated code imports from both paths when bindings are used:

```typescript
// Core runtime (Loro-agnostic)
import { __subscribe, __listRegion } from "@loro-extended/kinetic"

// Loro-specific write functions
import { __bindTextValue, __bindChecked } from "@loro-extended/kinetic/loro"
```

User code imports `editText` from the main package (re-exported from this subpath):

```typescript
import { editText } from "@loro-extended/kinetic"
```

## Exported Functions

### `editText(ref: TextRef)` — **Recommended for text inputs**

Returns a `beforeinput` event handler that translates DOM editing operations into CRDT operations on the TextRef. This is the write-direction complement to `inputTextRegion` (the read direction, generated automatically by the compiler).

```typescript
input({
  value: doc.title.toString(),          // compiler → inputTextRegion (read)
  onBeforeInput: editText(doc.title),   // editText handler (write)
})
```

**How it works:**
1. Intercepts `beforeinput` events and calls `e.preventDefault()`
2. Reads `selectionStart`/`selectionEnd` from the target element
3. Dispatches to the appropriate handler based on `e.inputType`:
   - `insertText`, `insertFromPaste`, `insertFromDrop`, `insertFromComposition` → `ref.insert()`
   - `deleteContentBackward`, `deleteContentForward`, `deleteByCut` → `ref.delete()`
   - Word/line deletions → `getTargetRanges()` for browser-computed boundaries
4. The typed ref's `commitIfAuto()` fires synchronously
5. The `inputTextRegion` subscription updates the DOM via `setRangeText("preserve")`

**IME handling:** Skips `isComposing === true` events (lets browser manage intermediate composition state). Processes `insertFromComposition` when composition ends.

**History:** Passes through `historyUndo` / `historyRedo` without intercepting.

**vs. `bindTextValue`:** `editText` preserves CRDT character-level merge semantics (individual `insert`/`delete` calls), while `bindTextValue` does full-text replacement (`delete(0, len)` + `insert(0, newValue)`) which destroys merge semantics. `editText` also doesn't manage the cursor — `setRangeText("preserve")` handles that automatically on the read side.

### `__bindTextValue(element, ref, scope)`

Two-way binding for text inputs (`<input type="text">`, `<textarea>`, `<select>`).

- **Subscribe side**: Uses `__subscribe` with `[REACTIVE]` to update input on ref changes
- **Write side**: Uses `loro()` to get the raw `LoroText` container, then `delete()` + `insert()` on input events

### `__bindChecked(element, ref, scope)`

Two-way binding for checkboxes (`<input type="checkbox">`).

- **Subscribe side**: Uses `__subscribe` with `[REACTIVE]` to update checked state
- **Write side**: Uses `loro()` to get the raw `LoroCounter`, then `increment()` on change events

### `__bindNumericValue(element, ref, scope)`

Two-way binding for numeric inputs (`<input type="number">`, `<input type="range">`).

- **Subscribe side**: Uses `__subscribe` with `[REACTIVE]` to update input value
- **Write side**: Uses `loro()` to get the raw `LoroCounter`, then `increment()` with the difference

### `bind(ref)`

Creates a binding marker object that the compiler recognizes. At compile time, the compiler generates code that calls the appropriate `__bind*` function.

```typescript
input({ type: "text", value: bind(doc.title) })
// Compiles to:
// __bindTextValue(inputElement, doc.title, scope)
```

### `isBinding(value)`

Type guard to check if a value is a binding marker.

## Choosing Between `editText` and `bind`

| Concern | `editText` + `value:` | `bind()` |
|---|---|---|
| Write mechanism | `beforeinput` → individual `insert`/`delete` | `input` event → full replacement |
| Read mechanism | `inputTextRegion` → `setRangeText("preserve")` | `subscribe` → `element.value =` |
| Cursor preservation | ✅ Automatic via `setRangeText` | ❌ Cursor resets on remote update |
| CRDT merge semantics | ✅ Character-level | ❌ Destroyed (full replacement) |
| Auto-commit | ✅ Via typed ref API | ❌ Raw container, no commit |
| IME support | ✅ `isComposing` + `insertFromComposition` | ❌ Not handled |
| Compiler recognition | Not needed (plain function) | Required (`bind()` call expression) |
| Use case | Text inputs backed by `TextRef` | Checkboxes, numeric inputs |

**Recommendation:** Use `editText` for all `TextRef`-backed text inputs. Use `bind()` for checkboxes (`bind:checked`) and other non-text bindings.

## Local State and Bindings

Local state created with `state()` works with the core runtime via `[REACTIVE]`, but **does not participate in two-way bindings or `editText`**. For local UI state, use event handlers instead:

```typescript
import { state } from "@loro-extended/kinetic"

// ✅ state() with event handlers
const searchQuery = state("")

input({
  type: "text",
  value: searchQuery.get(),
  onInput: (e) => searchQuery.set(e.target.value),
})

// ❌ This won't work — state() returns a LocalRef, not a Loro container
input({ type: "text", value: bind(searchQuery) })
```

This is by design — `state()` is for ephemeral UI state that doesn't need collaborative sync.