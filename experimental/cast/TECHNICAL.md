# @kyneta/cast — Technical Reference

> **Package**: `@kyneta/cast`
> **Role**: Web rendering target for `@kyneta/compiler` — a compiled delta-driven UI framework. Consumes classified IR, emits code that calls a tiny runtime (`mount`, `hydrate`, `scope`, `subscribe`, `regions`) to produce O(k) DOM/HTML updates from `[CHANGEFEED]` deltas. Ships with a universal build plugin (`unplugin`) and a local reactive primitive (`state()`).
> **Depends on**: `@kyneta/compiler`, `@kyneta/schema`, `@kyneta/changefeed`, `ts-morph`, `unplugin`, `js-beautify` (build only)
> **Depended on by**: Application code that renders Kyneta documents to the web.
> **Canonical symbols**: `mount`, `hydrate`, `MountOptions`, `MountResult`, `Scope`, `ScopeInterface`, `setRootScope`, `subscribe`, `state`, `LocalRef`, `isLocalRef`, `transformKynetaSource`, `shouldTransform`, `kyneta` (unplugin factory), `vite` (Vite adapter), `listRegion`, `filteredListRegion`, `conditionalRegion`, `textRegion`, `valueRegion`, `inputTextRegion`, `patchInputValue`, `diffText`, `ListRegionHandlers`, `ListRegionOp`, `FilteredListRegionHandlers`, `ConditionalRegionHandlers`, `Slot`, `KineticError`, `KineticErrorCode` (all error types re-exported under Kyneta prefix as canonical), `HydrationMismatchError`, `InvalidMountTargetError`, `ScopeDisposedError`, `BindingError`, `CompilerError`
> **Key invariant(s)**:
> 1. **The cast runtime never traverses the DOM as a VDOM.** Every update is an O(k) operation on a delta, where k is the number of items in the change (one `SequenceInstruction`, one `TextInstruction`, etc.). There is no reconciliation pass.
> 2. **Every subscription is owned by a `Scope`.** A scope is disposed by its parent on cleanup — subscription lifetime is structural, not reference-counted.
> 3. **The compiled output is target-specific code, not a general-purpose wrapper.** Cast's codegen emits direct runtime calls (`listRegion(...)`, `textRegion(...)`) with inlined closures; there is no dispatch table or framework runtime beyond those regions.

A compile-to-runtime web framework for Kyneta. Application code writes builder-pattern TypeScript (`div(() => { h1("hi"); for (const todo of doc.todos) li(todo.text) })`). Cast's build plugin runs `@kyneta/compiler` over the source, then generates JS that calls `mount` / `hydrate` / region functions. At runtime, changes to any `[CHANGEFEED]`-carrying value trigger exactly the DOM/HTML operations needed — no VDOM, no dirty checking.

Consumed by application code at build and runtime. Depends on `@kyneta/compiler` for IR. Does not import `@kyneta/exchange` directly — applications that want sync integrate `@kyneta/cast` + `@kyneta/exchange` separately.

---

## Questions this document answers

- How does source → compiled output work end-to-end? → [Build-time pipeline](#build-time-pipeline)
- What does the runtime do? Why is there one at all? → [Runtime — the five primitives](#runtime--the-five-primitives)
- Why "delta regions" instead of VDOM? → [Delta regions — O(k) not O(N)](#delta-regions--ok-not-on)
- What is `Scope` and how does disposal work? → [`Scope` — structural subscription lifetime](#scope--structural-subscription-lifetime)
- How does `mount` differ from `hydrate`? → [Mount vs hydrate](#mount-vs-hydrate)
- What is `state()` and how does it relate to schema refs? → [`LocalRef` — the local reactive primitive](#localref--the-local-reactive-primitive)
- How does the build plugin integrate with Vite, Bun, Rollup, etc.? → [The universal plugin](#the-universal-plugin)
- How does `inputTextRegion` rebase selection during remote edits? → [`inputTextRegion` — selection-stable text patching](#inputtextregion--selection-stable-text-patching)
- Why doesn't SSR hydration re-render on mount? → [Hydration — claim, don't rebuild](#hydration--claim-dont-rebuild)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| Cast | This package — the web rendering target for Kyneta. | The TV casting protocol; the verb "to cast" |
| Builder pattern | Source-level idiom: `div(() => { h1("x"); for (...) li(...) })`. Cast's compiler recognises and transforms these. | The GoF builder pattern |
| Element factory | A runtime function like `div`, `h1`, `li` that produces DOM or HTML. Compile-time: the symbol cast's compiler pattern-matches. | A factory *function* in general |
| Delta region | A runtime object that maps a `[CHANGEFEED]` delta to O(k) DOM/HTML ops. Five kinds: list, filtered-list, conditional, text, value. | A React component, a virtual DOM node |
| `listRegion` | Delta region for sequences. Handles `SequenceChange` incrementally. | A React list |
| `filteredListRegion` | Delta region for filtered sequences. Combines per-item + external subscriptions from `FilterMetadata`. | A filter function that returns a new array |
| `conditionalRegion` | Delta region for `if/else`. Swaps branches atomically. | A ternary expression |
| `textRegion` | Delta region for `TextRef` children. Applies `TextInstruction[]` via surgical `insertData` / `deleteData`. | A text node |
| `valueRegion` | Delta region for scalar reactive content (numbers, strings, booleans in content position). | A primitive |
| `inputTextRegion` | Attaches a `TextRef` to an `<input>` / `<textarea>`. Selection-stable across remote edits. | A React controlled input — `inputTextRegion` is uncontrolled |
| `Scope` | Structural subscription lifetime. Every `mount` creates a root scope; every nested region creates a child scope. Disposal cascades. | A JavaScript lexical scope |
| `ScopeInterface` | The public scope contract: `register(unsubscribe)`, `child()`, `dispose()`, `disposed`. | `Scope` — the class implementing it |
| `Element` | The type `(scope: ScopeInterface) => Node`. What cast's compiler emits from a builder call. | A DOM element |
| `mount(element, container, options?)` | Insert a cast `Element` into a DOM container, register for reactive updates, return `{ dispose, root }`. | `document.appendChild` |
| `hydrate(element, container)` | Claim an existing SSR-produced DOM subtree without re-rendering; attach subscriptions. | `mount` — hydrate reuses existing nodes |
| `HydrationMismatchError` | Thrown when the DOM doesn't match the `element`'s expected shape during hydration. | A schema validation error |
| `state<T>(initial)` | Create a `LocalRef<T>` — a local reactive primitive satisfying `[CHANGEFEED]`. | `React.useState` |
| `LocalRef<T>` | A callable ref carrying `[CHANGEFEED]`. `ref()` reads; `ref.set(v)` writes. Emits `ReplaceChange<T>`. | A schema `Ref<S>` — `LocalRef` has no persistence, no sync |
| `isLocalRef` | Type guard via brand symbol. | `hasChangefeed` (broader) |
| `transformKynetaSource(source, id)` | Pure function: source text + filename → transformed source text with compiled region calls. | A Vite transform hook |
| `shouldTransform(id, extensions)` | Pure predicate: does this file need transformation? | Cast's `hasBuilderCalls` from `@kyneta/compiler` — `shouldTransform` is plugin-level, `hasBuilderCalls` is source-level |
| `kyneta(options)` | The unplugin factory. Produces a plugin object consumable by Vite, Rollup, esbuild, Bun, Farm, webpack. | A Vite plugin directly |
| `vite(options)` | The `./vite` entry that wraps `kyneta(options).vite`. Convenience re-export. | A Vite adapter |
| Binding time | `"literal" \| "render" \| "reactive"` — from `@kyneta/compiler`. Drives whether the codegen emits a constant, a once-computed expression, or a subscribe block. | Build-time, runtime |
| SSR | Server-Side Rendering — compile-time mode that emits HTML strings. | "SSR" as a general web concept; cast's SSR is specifically `html`-label-block output + codegen |

---

## Architecture

**Thesis**: solve rendering at two layers. The compiler (a separate package) understands reactivity; the target (this package) emits code that calls a small set of runtime primitives at the O(k) delta granularity. No VDOM, no reconciliation, no framework runtime beyond the primitives.

Three top-level sub-systems:

| Sub-system | Source | Runs at |
|------------|--------|---------|
| Codegen | `src/compiler/` | Build time. IR → JS source. |
| Runtime | `src/runtime/`, `src/reactive/` | Runtime. Five region primitives, scope, subscribe, mount, hydrate, local ref. |
| Build plugin | `src/unplugin/`, `src/vite/` | Build time. Orchestrates parse → compile → codegen → output. |

```
source.ts (builder patterns)
     │
     ▼
┌──────────────────────────┐
│ @kyneta/compiler         │  Parse + classify → IR
│ analyze / walk / classify│
└──────────┬───────────────┘
           │ IR
           ▼
┌──────────────────────────┐
│ src/compiler/transform.ts│  Orchestrate: choose label (client/server),
│ transformKynetaSource    │  run IR→IR transforms, dispatch codegen
└──────────┬───────────────┘
           │
           ├─► src/compiler/codegen/dom.ts    (client / DOM)
           └─► src/compiler/codegen/html.ts   (server / SSR)
           │
           ▼
        Transformed source text (JS with runtime calls)
           │
           ▼  at bundle time
     bundled JS
           │
           ▼  at runtime
┌──────────────────────────┐
│ src/runtime/             │  Mount, scope, region, subscribe
│ mount / regions / scope  │  textRegion, listRegion, …
└──────────┬───────────────┘
           │
           ▼
        DOM updates (O(k) per delta)
```

### What this package is NOT

- **Not a VDOM framework.** No virtual tree, no reconciliation, no diffing of rendered output.
- **Not React.** No JSX (the compiler recognises builder-pattern calls, not JSX elements). No hooks. No component tree in the React sense.
- **Not a template engine.** Templates (from `@kyneta/compiler`) are an optional optimisation; the primary path is direct element factory calls.
- **Not sync-aware.** Cast renders whatever `Ref<S>` it's given. Sync integration happens in `@kyneta/exchange`; applications compose the two.
- **Not a state library.** `state()` is a single local-reactive primitive with one method (`.set`). For CRDT state, applications use `@kyneta/schema` + a substrate.

---

## Build-time pipeline

Source: `src/compiler/transform.ts` → `transformKynetaSource`; `src/compiler/codegen/dom.ts`, `codegen/html.ts`.

```
transformKynetaSource(source, id):
  1. parseSource(source) ──► ts-morph SourceFile
  2. hasBuilderCalls(source) ──► quick reject if no builder pattern
  3. analyzeAllBuilders(sourceFile) ──► [{ callExpr, ir }]
  4. For each builder:
       a. filterTargetBlocks(ir, target)   // "dom" or "html"
       b. dissolveConditionals(ir)
       c. emit(ir) ──► codegen (dom.ts or html.ts)
       d. replaceSource(callExpr, emitted)
  5. Return transformed source text
```

### `src/compiler/transform.ts`

The orchestrator. Reads compilation options (target `"dom"` vs `"html"`), walks the source file via `@kyneta/compiler`'s `parseSource` + `findBuilderCalls`, applies IR→IR transforms from `@kyneta/compiler/transforms`, dispatches to the appropriate codegen, and splices the emitted JS back into the source.

### `src/compiler/codegen/dom.ts`

Emits client-side code. For each IR node:
- `ElementNode` → `document.createElement("tag")` + attributes + children + append.
- `ContentNode` with reactive `ExpressionIR` → `textRegion(scope, parent, () => expr())` or `valueRegion(...)` depending on classification.
- `LoopNode` → `listRegion(scope, parent, iterable, itemHandler)`.
- `LoopNode` with `filter` metadata → `filteredListRegion(scope, parent, iterable, predicate, externalRefs, itemRefs, itemHandler)`.
- `ConditionalNode` → `conditionalRegion(scope, parent, condition, branches)`.

The emitted code closes over references the builder's caller passed in (`doc`, local `state()` refs) — no framework-provided context.

### `src/compiler/codegen/html.ts`

Emits server-side SSR code. Similar structure but produces HTML strings. Reactive content becomes placeholder markers (`<!--k:42-->` pairs) for later hydration; the initial HTML carries the first-render value of every expression, and hydration attaches subscriptions in place.

### Label-specific output

`filterTargetBlocks(ir, target)` from `@kyneta/compiler/transforms` strips branches not belonging to the current compilation target. Authoring:

```ts
div(() => {
  client: { interactiveButton(doc) }
  server: { staticMarker("bot-view") }
})
```

Compiled for `target: "dom"`: only the `client:` block survives. For `target: "html"`: only `server:`.

### What the codegen is NOT

- **Not producing a VDOM.** Direct runtime calls. One region function per delta kind.
- **Not producing React hooks.** No hook registry, no dependency arrays visible in output.
- **Not template-literal strings.** The codegen writes TypeScript (or JavaScript, depending on the source), which the bundler handles further. The output is readable JS, not a compressed template.

---

## The universal plugin

Source: `src/unplugin/index.ts`, `src/unplugin/transform.ts`, `src/unplugin/filter.ts`, `src/vite/plugin.ts`.

```ts
import { kyneta } from "@kyneta/cast/unplugin"

// Vite
import vitePlugin from "@kyneta/cast/vite"
export default {
  plugins: [vitePlugin({ extensions: [".ts", ".tsx"] })]
}
```

`kyneta(options)` is an `unplugin` factory. `unplugin` normalises plugin surfaces across Vite, Rollup, Rolldown, esbuild, Bun, Farm, and webpack. `kyneta` returns a single plugin definition that works on all of them.

### `enforce: "pre"`

The cast compiler must run **before TypeScript type-stripping** because reactive detection inspects TypeScript type annotations (`[CHANGEFEED]` on a ref's type). By the time type-stripping completes, the type has become `unknown` and reactive classification fails.

Cast sets `enforce: "pre"` which Vite honours natively. Farm maps it to `priority: 102`. Bun's `onLoad` intercepts source before any other transformer. Other bundlers follow their own conventions via unplugin.

### `shouldTransform` filter

Before invoking `transformKynetaSource`, the plugin checks `shouldTransform(id, extensions)`:
- File extension matches (`.ts`, `.tsx` by default).
- `hasBuilderCalls(source)` from `@kyneta/compiler` — cheap regex pre-scan.

Files without builder calls pass through untransformed. This makes the plugin nearly free on non-cast code.

### What the plugin is NOT

- **Not a bundler replacement.** It runs inside the host bundler. Vite / Rollup / etc. still do resolution, bundling, minification.
- **Not an HMR system.** HMR is the bundler's concern. Cast's compiled output is re-emitted on source change; the runtime's scope system disposes the old mount and the new one starts fresh. Per-region HMR is a future concern.

---

## Runtime — the five primitives

Source: `src/runtime/`.

The entire cast runtime is five region functions plus mount, hydrate, scope, and subscribe. Region functions are plain imperative DOM builders parameterised by the scope and a reactive value.

| Primitive | File | Role |
|-----------|------|------|
| `mount` | `src/runtime/mount.ts` | Insert an `Element` into a container, manage root scope, return `dispose`. |
| `hydrate` | `src/runtime/hydrate.ts` | Claim an existing SSR-rendered DOM subtree; attach subscriptions without rebuilding nodes. |
| `Scope` | `src/runtime/scope.ts` | Structural subscription lifetime; parent disposes children. |
| `subscribe` | `src/runtime/subscribe.ts` | Standard `[CHANGEFEED]` subscription with automatic scope registration. |
| `listRegion` | `src/runtime/regions.ts` | Reactive list with incremental item add/remove/move. |
| `filteredListRegion` | `src/runtime/regions.ts` | Reactive list with per-item + external filter predicates. |
| `conditionalRegion` | `src/runtime/regions.ts` | Reactive `if/else` branches. |
| `textRegion` | `src/runtime/regions.ts` | Reactive text binding (character-level insert/delete via `TextInstruction`). |
| `valueRegion` | `src/runtime/regions.ts` | Reactive scalar in content position (numbers, strings, booleans). |
| `inputTextRegion` | `src/runtime/regions.ts` | Uncontrolled `<input>` / `<textarea>` bound to a `TextRef` with selection rebasing. |

Plus:

| Helper | File | Role |
|--------|------|------|
| `patchInputValue` | `src/runtime/text-patch.ts` | Apply a `TextChange` to an input element's value, rebasing selection. |
| `diffText` | `src/runtime/text-patch.ts` | Pure: produce a `TextChange` from `oldValue + newValue + cursorHint`. |

### What the runtime is NOT

- **Not a render loop.** No microtask queue managed by cast, no request-animation-frame scheduling. Every delta is applied synchronously during the changefeed subscriber's execution.
- **Not a component model.** Builder-pattern authored code *resembles* components structurally (nested functions that produce DOM), but there is no `Component` abstraction, no props system, no children.
- **Not a state manager.** State lives in the `Ref<S>` / `LocalRef<T>` it subscribes to. Cast doesn't own any state between renders.

---

## Delta regions — O(k) not O(N)

Source: `src/runtime/regions.ts`.

A **delta region** owns a contiguous slice of DOM corresponding to one reactive expression or iteration. When the expression's `[CHANGEFEED]` emits, the region applies the delta directly — not by re-rendering from scratch.

### `listRegion`

```ts
listRegion(scope, parent, listRef, itemHandler)
```

Handles `SequenceChange` with instruction-level precision. On `insert(i, items)` it creates new DOM for each inserted item and splices them into the parent at index `i`. On `delete(i, count)` it removes the corresponding nodes. On `move(from, to)` it reparents without re-rendering the moved items.

Cost: O(k) where `k` is the number of instructions in the change. A list of 10,000 items with one insert produces one DOM operation, not 10,000.

### `filteredListRegion`

```ts
filteredListRegion(scope, parent, listRef, predicate, externalRefs, itemRefs, itemHandler)
```

Produced when `@kyneta/compiler` detects a filter pattern (`for (x of xs) if (pred(x)) ...`). Carries two dependency kinds:
- `itemRefs` — refs derived from the loop variable (per-item subscriptions).
- `externalRefs` — refs shared across iterations (single subscription; re-evaluates every item on fire).

On structural change (item added/removed), filter the incoming item. On external change (e.g., filter text), re-evaluate every item's predicate and add/remove DOM nodes as membership flips.

### `conditionalRegion`

```ts
conditionalRegion(scope, parent, condition, branches)
```

Reactive `if/else`. On condition change, dispose the current branch's scope, call the new branch's element factory, mount into place. No DOM diffing within branches — each branch is a complete factory.

### `textRegion`

```ts
textRegion(scope, parent, textRef)
```

Owns a `Text` node. On `TextChange` emission, applies the instructions with surgical `CharacterData.insertData(offset, data)` / `deleteData(offset, count)`. A 10,000-character string with one inserted character performs one `insertData` call, not a text node replacement.

### `valueRegion`

```ts
valueRegion(scope, parent, reactiveExpr)
```

For reactive content that isn't a `TextRef` — scalars, computed expressions, counters rendered as numbers. Emits `ReplaceChange` semantics; updates a `Text` node via assignment. Cheaper than `textRegion` because it doesn't need instruction-level diffing.

### `inputTextRegion` — selection-stable text patching

Source: `src/runtime/regions.ts` (`inputTextRegion`) + `src/runtime/text-patch.ts` (`patchInputValue`, `diffText`).

Attaches a `TextRef` to an `<input>` or `<textarea>`. Bidirectional:
- Local keystrokes (`input` event) → `diffText(oldValue, newValue, selectionStart)` → `TextChange` → write to ref.
- Remote edits (ref emits `TextChange` with non-local origin) → `patchInputValue(element, change)` — surgical `setRangeText` + selection rebase via `transformSelection`.

The element is **uncontrolled**: cast never sets `element.value` from the reactive value on every render. The DOM and the ref are kept in sync incrementally. Cursor position survives remote edits.

This parallels `@kyneta/react`'s `useText`: same pure `diffText` / `transformSelection` logic (lifted into `@kyneta/schema` as shared primitives), different imperative shells.

### What a delta region is NOT

- **Not a React-style re-render.** A region doesn't compute a new VDOM and diff; it applies a specific instruction to specific DOM nodes.
- **Not a virtual boundary.** Regions are marked by DOM comment markers for SSR hydration purposes only; at runtime the DOM is flat.
- **Not independent of the changefeed.** Every region carries a `subscribe` call in its construction; disposing the scope unsubscribes.

---

## `Scope` — structural subscription lifetime

Source: `src/runtime/scope.ts`.

```ts
class Scope implements ScopeInterface {
  register(unsubscribe: () => void): void
  child(): Scope
  dispose(): void
  get disposed(): boolean
}
```

Every `mount` creates a root scope. Every nested region (list item, conditional branch, child element) creates a child scope via `rootScope.child()`. When a parent scope disposes, it disposes all children first, which in turn dispose all their children, ...

Subscriptions register themselves on their enclosing scope via `scope.register(unsubscribe)`. On dispose, every registered unsubscribe fires in LIFO order.

### The `setRootScope` global

`mount` calls `setRootScope(rootScope)` so that element factories called *outside* of an explicit scope (at module load, for test setup) can locate a sensible default. Production code running through the compiler always passes `scope` explicitly; `setRootScope` is a compatibility hatch.

### `ScopeDisposedError`

Operating on a disposed scope throws `ScopeDisposedError`. Catches bugs where a handler fires after the region it belongs to has been torn down. Common under list reorderings: a subscription fires just as the item moves; the error surfaces rather than corrupting DOM.

### What `Scope` is NOT

- **Not a React hook scope.** No dependency arrays, no cleanup hooks at the language level. Just a `register` / `dispose` tree.
- **Not reference-counted.** Disposal is explicit. No ref counts, no automatic GC of subscriptions.
- **Not an effect system.** It doesn't track inputs. It only tracks *what must be undone* when a region is destroyed.

---

## Mount vs hydrate

Source: `src/runtime/mount.ts`, `src/runtime/hydrate.ts`.

### `mount`

```ts
mount(element, container, options?) → { dispose, root }
```

1. Validate `container` is an `Element`.
2. Create a root `Scope`. `setRootScope(rootScope)`.
3. Clear `container` (if `options.clear !== false`).
4. Call `element(rootScope)` → returns a `Node`.
5. Append the node to `container`.
6. Return `{ dispose: () => rootScope.dispose(), root: node }`.

Standard client-side rendering.

### `hydrate`

```ts
hydrate(element, container) → { dispose, root }
```

1. Validate `container`.
2. Create a root `Scope`.
3. Walk the existing DOM subtree under `container` in lockstep with the element factory, *claiming* existing nodes instead of creating new ones.
4. Attach subscriptions via the regions' `subscribe` calls; do not regenerate content.
5. If the DOM doesn't match the expected shape, throw `HydrationMismatchError`.

SSR-produced HTML is preserved byte-for-byte on the client. The reactive subscriptions activate; the first interactive update produces the first DOM mutation.

### Why a separate `hydrate`

Re-rendering on mount would:
- Duplicate work: both SSR and client produce the same initial content.
- Break focus, selection, and scroll state of the already-rendered DOM.
- Flash the user's view as the DOM is destroyed and rebuilt.

`hydrate` claims instead of rebuilds. 461 tests in `hydrate.test.ts` exercise every IR shape's hydration path.

### `HydrationMismatchError`

Thrown when the live DOM differs from what the compiled element factory expects. Contains enough context (node path, expected/actual) to diagnose SSR drift. Typical causes: server and client computed different values (clock skew, environment differences); the compilation targets diverged; the HTML was modified between SSR and hydrate.

### What hydrate is NOT

- **Not a re-render.** The DOM produced by SSR is the DOM that the user sees. Hydrate doesn't touch visible content unless a reactive update fires.
- **Not suspense-aware.** No async boundaries in cast. Data fetching happens before mount/hydrate.
- **Not progressive.** Every region attaches at once. Partial / streaming hydration is a future concern.

---

## `LocalRef` — the local reactive primitive

Source: `src/reactive/local-ref.ts`.

```ts
const count = state(0)
count()         // 0           (call to read)
count.set(1)    // emits ReplaceChange<number>
count()         // 1

count[CHANGEFEED].subscribe(changeset => { /* ... */ })
```

`state<T>(initial)` returns a `LocalRef<T>`:
- Callable: `ref()` returns the current value.
- `.set(value)` writes and emits `ReplaceChange<T>` via the changefeed.
- `[CHANGEFEED]` participates in the universal reactive protocol.
- `isLocalRef(x)` type guard via an internal brand symbol.

### Why a local-only primitive

Application UI often needs reactive state that isn't part of the synced document model: a text input's draft value, a modal's open/close flag, a form's validation state. `Ref<S>` from `@kyneta/schema` would be overkill — it requires a substrate and a `BoundSchema`. `state()` is a one-line alternative for ephemeral UI state.

The price of that simplicity: no persistence, no sync, no undo, no history. For anything that must survive a reload or peer into other peers' state, use a schema-backed ref.

### Integration with the runtime

Any region (list, conditional, text, value) can subscribe to a `LocalRef` identically to a schema ref — both carry `[CHANGEFEED]`. The runtime doesn't distinguish.

### What `LocalRef` is NOT

- **Not a substrate.** No merge, no version, no sync. Pure in-memory state.
- **Not schema-aware.** No validation, no typed children, no navigation beyond reading the value.
- **Not a signal in the SolidJS sense.** No auto-tracked dependencies; application code subscribes explicitly.
- **Not React's `useState`.** No re-render lifecycle, no stale-closure gotchas. A `LocalRef` held in a module variable is a singleton; one held in a function call is that call's local state.

---

## SSR, the `html:` label, and the `counting-dom` test harness

Cast compiles both client code (target `"dom"`) and server code (target `"html"`). The `html:` / `client:` label blocks let a single source file emit different output for each:

```ts
div(() => {
  client: { interactiveCounter(doc) }
  server: { staticFallback() }
})
```

The compiler's `filterTargetBlocks` strips the non-matching block before codegen. Cast's DOM codegen runs with `target: "dom"` and sees only `client:` branches; its HTML codegen sees only `server:` branches.

### `counting-dom` — testing without a real DOM

Source: `src/testing/counting-dom.ts`.

A minimal DOM implementation that counts operations without performing them. Used in tests to assert runtime behaviour:

```ts
const dom = new CountingDOM()
listRegion(scope, dom.body, listRef, itemHandler)
listRef.push(newItem)
expect(dom.opCount("createElement")).toBe(1)
expect(dom.opCount("removeChild")).toBe(0)
```

Ensures that a single item append is an O(1) DOM operation, not O(N). 197 tests use this.

---

## Error types

Source: `src/errors.ts`.

| Type | Thrown when |
|------|-------------|
| `InvalidMountTargetError` | `mount(element, null)` or `mount(element, nonElement)` |
| `ScopeDisposedError` | Operating on a scope after `.dispose()` |
| `HydrationMismatchError` | DOM doesn't match element during `hydrate` |
| `BindingError` | Reactive binding misconfiguration detected at runtime |
| `CompilerError` | Used by the compiler to surface diagnostics via the unplugin |
| `KineticError` / `KineticErrorCode` | Deprecated aliases; kept for back-compat (will be removed) |
| `KynetaError` / `KynetaErrorCode` | Canonical aliases |

All inherit from `Error` with a `code` field (typed as `KynetaErrorCode`) and an optional `location: SourceLocation`.

### What the error types are NOT

- **Not a warning system.** Cast throws. Applications that want soft failures wrap in `try`/`catch` at the mount boundary.
- **Not localised.** Messages are English, suitable for developer diagnostics.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `MountOptions`, `MountResult` | `src/types.ts` | `mount` inputs and outputs. |
| `ScopeInterface` | `src/types.ts` | Public scope contract. |
| `Element` | `src/types.ts` | `(scope: ScopeInterface) => Node`. |
| `Slot` | `src/types.ts` | Content-slot type used by region handlers. |
| `ListRegionOp<T>` | `src/types.ts` | Discriminated union of list operations. |
| `ListRegionHandlers` | `src/types.ts` | `{ create, update?, destroy? }` hooks passed to `listRegion`. |
| `FilteredListRegionHandlers` | `src/types.ts` | Handlers for `filteredListRegion`, with predicate + item-refs + external-refs. |
| `FilterUpdateOp` | `src/types.ts` | Filter-specific op (add/remove due to filter flip). |
| `ConditionalRegionHandlers`, `ConditionalRegionOp` | `src/types.ts` | Branch handlers. |
| `Scope` | `src/runtime/scope.ts` | Concrete implementation of `ScopeInterface`. |
| `mount`, `hydrate` | `src/runtime/mount.ts`, `src/runtime/hydrate.ts` | Entry points. |
| `subscribe` | `src/runtime/subscribe.ts` | `[CHANGEFEED]` subscription with scope registration. |
| `listRegion`, `filteredListRegion`, `conditionalRegion`, `textRegion`, `valueRegion`, `inputTextRegion` | `src/runtime/regions.ts` | Delta regions. |
| `patchInputValue`, `diffText` | `src/runtime/text-patch.ts` | Text-patching primitives. |
| `LocalRef<T>`, `state`, `isLocalRef` | `src/reactive/local-ref.ts` | Local reactive primitive. |
| `transformKynetaSource` | `src/unplugin/transform.ts` | Pure compilation function. |
| `shouldTransform` | `src/unplugin/filter.ts` | File-filter predicate. |
| `kyneta` | `src/unplugin/index.ts` | Universal unplugin factory. |
| `vite` | `src/vite/plugin.ts` | Vite-flavoured wrapper. |
| `HydrationMismatchError`, `InvalidMountTargetError`, `ScopeDisposedError`, `BindingError`, `CompilerError`, `KineticError`, `KineticErrorCode`, `KynetaError`, `KynetaErrorCode`, `SourceLocation` | `src/errors.ts` | Error types. |
| `CountingDOM` | `src/testing/counting-dom.ts` | Test-only DOM mock. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | — | Public barrel. Re-exports mount, hydrate, regions, scope, subscribe, state, types, errors. |
| `src/errors.ts` | — | Error types (Kyneta-prefixed canonical + Kinetic-prefixed deprecated aliases). |
| `src/types.ts` | — | Public type declarations: `MountOptions`, `MountResult`, `Scope`, handlers, ops. |
| `src/types/elements.d.ts` | 206 | Ambient element-factory declarations (`div`, `h1`, `li`, …). |
| `src/types/reactive-view.d.ts` | 75 | Ambient reactive-view type declarations. |
| `src/runtime/mount.ts` | 111 | `mount(element, container, options?)`. |
| `src/runtime/hydrate.ts` | 597 | `hydrate(element, container)` — claim existing DOM. |
| `src/runtime/scope.ts` | 236 | `Scope` class, `setRootScope`. |
| `src/runtime/subscribe.ts` | 222 | Scope-registered `[CHANGEFEED]` subscription. |
| `src/runtime/regions.ts` | 1401 | All five region functions + `inputTextRegion`. |
| `src/runtime/text-patch.ts` | 226 | `patchInputValue`, `diffText` — selection-stable text patching. |
| `src/runtime/index.ts` | 53 | Runtime barrel. |
| `src/reactive/local-ref.ts` | 215 | `state`, `LocalRef<T>`, `isLocalRef`. |
| `src/reactive/index.ts` | 12 | Reactive barrel. |
| `src/compiler/transform.ts` | 591 | Compilation orchestrator. |
| `src/compiler/codegen/dom.ts` | — | Client-side (DOM) codegen. |
| `src/compiler/codegen/html.ts` | — | Server-side (HTML / SSR) codegen. |
| `src/compiler/transform.test.ts` | — | 69 tests — end-to-end compilation. |
| `src/compiler/integration/reactive.test.ts` | — | Reactive-content compilation tests. |
| `src/compiler/integration/statements.test.ts` | — | Statement-node integration tests (20 tests). |
| `src/unplugin/index.ts` | 164 | Universal plugin factory. |
| `src/unplugin/transform.ts` | 73 | Thin wrapper over `transformKynetaSource`. |
| `src/unplugin/filter.ts` | 56 | `shouldTransform` predicate. |
| `src/vite/plugin.ts` | 21 | Vite adapter (`kyneta(...).vite`). |
| `src/vite/plugin.test.ts` | 337 | 14 tests — Vite-specific transform behaviour. |
| `src/testing/counting-dom.ts` | 245 | Minimal DOM mock with op counters. |
| `src/testing/counting-dom.test.ts` | 197 | Tests for `counting-dom` itself. |
| `src/testing/runtime.ts` | 39 | Test-runtime utilities. |
| `src/testing/index.ts` | 58 | Testing barrel. |
| `src/runtime/mount.test.ts` | 328 | Mount lifecycle, dispose, error handling. |
| `src/runtime/hydrate.test.ts` | 461 | Hydration for every IR shape. |
| `src/runtime/scope.test.ts` | 333 | Scope creation, child dispose order, `ScopeDisposedError`. |
| `src/runtime/regions.test.ts` | 2226 | Exhaustive region coverage — every delta shape. |
| `src/runtime/subscribe.test.ts` | 406 | Subscription lifecycle + scope integration. |
| `src/runtime/text-patch.test.ts` | 966 | `diffText` / `patchInputValue` — edit detection, selection rebasing. |
| `src/reactive/local-ref.test.ts` | 311 | `state` / `LocalRef` / brand detection. |
| `src/types/reactive-view.test.ts` | 250 | Ambient declaration behaviour. |
| `src/errors.test.ts` | — | Error-type round-trips, code mapping. |

## Testing

Tests run both with `jsdom` (for DOM-dependent region and mount tests) and with `CountingDOM` (for performance-invariant assertions — "this update is O(k), not O(N)"). The compilation tests drive the full pipeline: source → `@kyneta/compiler` IR → cast codegen → assert on the emitted JavaScript string. The Vite-plugin tests spin up a Vite instance with the cast plugin and verify end-to-end transform behaviour, including `enforce: "pre"` ordering with other plugins.

The `regions.test.ts` file alone is 2,226 lines, exercising every combination of delta kind × region type × edge case (empty input, single-item lists, filter flips, hydration boundaries).

**Tests**: 634 passed, 0 skipped across 27 files. Run with `cd experimental/cast && pnpm exec vitest run`.