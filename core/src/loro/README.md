# Loro-Specific Bindings

This subpath contains runtime functions that require direct access to Loro containers. These are **Loro-specific extensions** to the core Kinetic runtime.

## Why a Separate Subpath?

The core Kinetic runtime (`@loro-extended/kinetic`) is **Loro-agnostic**. It uses the `[REACTIVE]` symbol from `@loro-extended/reactive` to subscribe to changes uniformly, supporting any type that implements the `Reactive` interface:

- `LocalRef` from `@loro-extended/reactive`
- Loro typed refs from `@loro-extended/change`
- Custom reactive types

However, **two-way bindings** (`bind:value`, `bind:checked`) require direct Loro container access for mutations. They can't work through the generic `[REACTIVE]` interface because:

1. **Read path** — Uses `[REACTIVE]` for subscriptions ✅
2. **Write path** — Needs raw Loro container methods like `textRef.delete()` + `textRef.insert()` ❌

This asymmetry is intentional and explicit. By placing Loro-specific bindings in a separate subpath, we:

- Keep the core runtime minimal and portable
- Make Loro dependencies visible in import statements
- Enable future extensibility (other CRDT libraries could have their own binding subpaths)

## Usage

Generated code imports from both paths when bindings are used:

```typescript
// Core runtime (Loro-agnostic)
import { __subscribe, __listRegion } from "@loro-extended/kinetic"

// Loro-specific bindings
import { __bindTextValue, __bindChecked } from "@loro-extended/kinetic/loro"
```

## Exported Functions

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

## Local State and Bindings

Local state created with `state()` works with the core runtime via `[REACTIVE]`, but **does not participate in two-way bindings**. For local UI state, use event handlers instead:

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