# Plan: Unify `Element` Type with Scope-Passing Convention

## Background

Kinetic's compiler transforms builder calls like `div(() => { h1("Hello") })` into scope-accepting factory functions: `(scope) => { ... return _div0 }`. The `scope` parameter is load-bearing — reactive subscriptions (`subscribe`, `listRegion`, `conditionalRegion`, `textRegion`) all take `scope` as their first argument to register cleanup handlers and manage lifecycle.

However, the user-facing type system tells a different story:

```ts
type Element = () => Node                    // ← no scope parameter
type ComponentFactory<P> = (props: P) => Element  // ← returns () => Node
```

And `mount()` follows the type system, not the compiler:

```ts
function mount(element: () => Node, container: Element): MountResult {
  const rootScope = new Scope()   // creates a scope...
  setRootScope(rootScope)
  node = element()                // ...but never passes it
}
```

The compiler produces `(scope: Scope) => Node`. The type says `() => Node`. These are different types. The only production consumer (the todo app) papers over this with a double cast:

```ts
const appFactory = appResult as unknown as (scope: Scope) => Node
const node = appFactory(scope)
```

This happened because `Element = () => Node` and `mount()` were written as pre-compiler API concepts. The compiler was built later and introduced explicit scope-passing. The types and `mount()` were never updated to reflect the actual calling convention.

## Problem Statement

1. **The `Element` type is wrong.** `() => Node` does not describe what the compiler produces. Compiled builders are `(scope: Scope) => Node`. The type system lies to users and to the compiler's own type detection (`isComponentFactoryType`).

2. **`mount()` is broken for compiled output.** It creates a `rootScope` but calls `element()` with zero arguments. Any compiled builder that references `scope` (i.e., any builder with reactive content) would crash with `Cannot read properties of undefined`. The todo app works around this by not using `mount()` at all.

3. **`ComponentFactory` return type cascades the lie.** `ComponentFactory<P> = (props: P) => Element` means `(props) => () => Node`. The compiler produces `(props) => (scope) => Node`. The codegen emits `Factory(props)(scope.createChild())` — passing a scope to something the types say takes no arguments.

4. **`isComponentFactoryType` accidentally works.** It checks whether the return type's call signature returns `Node`. Both `() => Node` and `(scope: Scope) => Node` have call signatures returning `Node`. But the detection logic and its comments describe `() => Node`, not the actual post-compilation shape.

5. **Test preambles embed the wrong type.** `COMPONENT_PREAMBLE` in integration tests defines `type Element = () => Node`, which is the lie the tests compile against. The analyze tests do the same.

## Success Criteria

- `Element = (scope: Scope) => Node` throughout the codebase
- `ComponentFactory<P>` returns the corrected `Element`
- `mount(element, container)` creates a root scope and calls `element(rootScope)` — no manual scope wiring needed
- The todo app's `main.ts` uses `mount()` instead of manual scope creation and `as unknown as` casts
- `isComponentFactoryType` comments and logic reflect the actual `(scope) => Node` shape
- All `ElementFactory` overloads in `elements.d.ts` return the corrected `Element`
- Test preambles and inline type definitions use `(scope: Scope) => Node`
- All 823+ tests pass
- TECHNICAL.md documents the corrected calling convention

## The Gap

| Aspect | Current | Target | Status |
|---|---|---|---|
| `Element` type | `() => Node` | `(scope: Scope) => Node` | 🟢 Phase 1 |
| `ComponentFactory` return | `() => Node` | `(scope: Scope) => Node` | 🟢 Phase 1 (cascaded) |
| `mount()` | Calls `element()` — ignores scope | Calls `element(rootScope)` | 🟢 Phase 2 |
| `ElementFactory` return | `Element` = `() => Node` | `Element` = `(scope: Scope) => Node` | 🟢 Phase 1 (cascaded) |
| Todo app `main.ts` | Manual `Scope` + double cast | `mount(createApp(doc), container)` | 🔴 Phase 3 |
| `isComponentFactoryType` | Describes `() => Node`, happens to work | Describes `(scope: Scope) => Node`, works by design | 🔴 Phase 4 |
| `COMPONENT_PREAMBLE` | `type Element = () => Node` | `type Element = (scope: Scope) => Node` | 🔴 Phase 4 |
| TECHNICAL.md Component Model | "returns `Element` (which is `() => Node`)" | "returns `Element` (which is `(scope: Scope) => Node`)" | 🔴 Phase 4 |
| TECHNICAL.md Current Limitations | "SSR not implemented" (stale) | Corrected: SSR implemented, binding-through-props unsupported | 🔴 Phase 4 |
| `mount()` doc example | `const app = div(() => {...}); mount(app, el)` | Same — still works, type just changes | 🟢 Phase 2 |
| `mount()` tests | Hand-written `() => Node` thunks | Hand-written `(scope) => Node` factories | 🟢 Phase 2 |

## Phase 1: Unify the `Element` Type 🟢

Update the canonical type definition and all downstream references.

### Tasks

1. **Change `Element` type in `types.ts`** 🟢

   From: `export type Element = () => Node`
   To: `export type Element = (scope: ScopeInterface) => Node`

   Use `ScopeInterface` (already exported from `types.ts`) rather than the concrete `Scope` class to keep the type file free of runtime imports. The `Scope` class structurally conforms to `ScopeInterface` (see Task 5).

2. **Update `ComponentFactory` return type** 🟢

   No code change needed — `ComponentFactory` already returns `Element`. Changing `Element` cascades automatically. Verify that all four union members still type-check.

3. **Update `ElementFactory` interface in `elements.d.ts`** 🟢

   No code change needed — `ElementFactory` overloads return `Element`. The import `import type { Element } from "../types.js"` picks up the new definition automatically. Verify the `PropsWithBindings` and `Builder` types don't conflict.

4. **Update `ScopeInterface` import in `types.ts`** 🟢

   `ScopeInterface` is already defined in `types.ts` at L394. The `Element` type can reference it directly — no circular dependency.

5. **Add `implements ScopeInterface` to the `Scope` class** 🟢

   `Scope` in `runtime/scope.ts` structurally conforms to `ScopeInterface` but doesn't declare it. Add `implements ScopeInterface` to make the contract explicit and catch drift at compile time. This requires importing `ScopeInterface` from `../types.js` in `scope.ts`. One subtlety: `Scope.createChild()` returns `Scope` (covariant with `ScopeInterface.createChild()` returning `ScopeInterface`), so the `implements` clause should type-check without changes to the method signature.

## Phase 2: Fix `mount()` 🟢

Make `mount()` pass the scope it already creates.

### Tasks

1. **Update `mount()` signature and implementation** 🟢

   Change parameter type from `() => Node` to `Element` (which is now `(scope: ScopeInterface) => Node`). In the non-hydrate branch, change `node = element()` to `node = element(rootScope)`.

   ```ts
   export function mount(
     element: Element,
     container: globalThis.Element,
     options: MountOptions = {},
   ): MountResult
   ```

   **Naming collision:** `Element` (Kinetic's type) would shadow `Element` (DOM global) if imported into `mount.ts`. The file currently uses the DOM `Element` for the `container` parameter type and `instanceof Element` validation. Do **not** import Kinetic's `Element` into this file. Instead, import `ScopeInterface` from `types.ts` and write the parameter type inline:

   ```ts
   element: (scope: ScopeInterface) => Node
   ```

   This avoids the collision entirely, keeps the file's existing use of the DOM `Element` global undisturbed, and communicates the contract directly in the signature without requiring readers to look up the `Element` alias.

2. **Update `mount()` tests** 🟢

   Change all 15 hand-written element thunks from `() => Node` to `(_scope) => Node`. The scope parameter can be ignored in tests that don't exercise reactive behavior — `(_scope) => document.createElement("div")` is fine. The hydration test's element thunk also changes shape but continues to be unused (hydration adopts existing DOM).

   Add one new test: pass a factory that actually _uses_ the scope (e.g., calls `scope.onDispose(() => { ... })`), then verify that `dispose()` triggers the cleanup. This proves `mount()` actually passes the scope, not just that the signature changed.

3. **Update `mount()` JSDoc and doc example** 🟢

   The example currently shows:
   ```ts
   const app = div(() => { h1("Hello, World!") })
   const { dispose } = mount(app, document.getElementById("root")!)
   ```

   This pattern is still correct — `div(() => {...})` is compiled into `(scope) => Node`, which matches the new `Element` type. Update the comment that says "A function that returns a DOM node" to "A scope-accepting factory that returns a DOM node."

## Phase 3: Update Todo App 🟢

Replace manual scope wiring with `mount()`.

### Tasks

1. **Simplify `main.ts`** 🟢

   Replace:
   ```ts
   const appResult = createApp(doc)
   const scope = new Scope("app")
   const appFactory = appResult as unknown as (scope: Scope) => Node
   const node = appFactory(scope)
   // ... manual container wiring ...
   ```

   With:
   ```ts
   const app = createApp(doc)
   const { node, dispose: disposeMount } = mount(app, container)
   ```

   **Hydration path:** The current code checks `container.firstElementChild` and does `replaceChildren`. `mount()` in non-hydrate mode does `container.textContent = ""` followed by `appendChild` — same net effect (clear container, insert fresh node). Use the non-hydrate path. Full hydration is a Phase 10 concern per existing code comments.

   **App-specific cleanup:** The current `main.ts` defines a `dispose` function that calls both `scope.dispose()` and `repo.reset()`. After switching to `mount()`, the Kinetic lifecycle cleanup comes from `mount()`'s returned `dispose`. The app-specific `repo.reset()` must still be called separately. Compose them:

   ```ts
   const { node, dispose: disposeMount } = mount(app, container)
   const dispose = () => { disposeMount(); repo.reset() }
   Object.assign(window, { doc, repo, dispose })
   ```

2. **Change import from `Scope` to `mount`** 🟢

   The import changes from:
   ```ts
   import { Scope } from "@loro-extended/kinetic"
   ```
   To:
   ```ts
   import { mount } from "@loro-extended/kinetic"
   ```

   `mount` is already re-exported from `index.ts` via `runtime/mount.js`. No new export wiring needed.

3. **Remove the manual container wiring block** 🟢

   Delete the entire `// Mount: if SSR content exists...` block (the `if (container.firstElementChild)` / `else` / `appendChild` block). `mount()` handles container attachment internally.

4. **Simplify the module doc comment** 🟢

   The JSDoc currently describes 5 steps including manual hydration. After the change, step 3/4 collapse into "Mounts the app via `mount()`". Keep it accurate.

5. **Verify the app runs** 🟢

   `cd examples/kinetic-todo && npm run dev` — add a todo, remove a todo, confirm identical behavior. View source to confirm SSR output still contains `<li class="todo-item">`, not `<TodoItem>`.

## Phase 4: Update Detection, Tests, and Docs 🔴

### Tasks

1. **Update `isComponentFactoryType` comments** 🔴

   Three comment locations in `reactive-detection.ts` reference the old `() => Node` shape:
   - JSDoc block (L380-391): `"Returns an Element (a function that returns Node)"` and `"The return type is a function type (Element = () => Node)"`
   - Inline comment at L417: `"Element = () => Node, which is a function returning Node"`
   - Inline comment at L421: `"Element is a function type: () => Node"`

   Update all three to reference `(scope: ScopeInterface) => Node`. The actual detection logic doesn't change — it already checks that the return type has call signatures returning `Node`, which works for both shapes.

2. **Update `COMPONENT_PREAMBLE` in integration tests** 🔴

   Change `type Element = () => Node` to a definition that includes the scope parameter. Since test source strings don't import `Scope` (it's injected via `new Function`), use an inline type:

   ```ts
   type Element = (scope: any) => Node
   ```

   Using `any` for the scope type in the preamble is pragmatic — the test source doesn't need to type-check scope usage, it just needs ts-morph to resolve `ComponentFactory`'s return type as a function returning `Node`.

3. **Update analyze test inline type definitions** 🔴

   The three `ComponentFactory` detection tests in `analyze.test.ts` define `type Element = () => Node` inline. Update them to match the new definition. Also update the mock component bodies from `return () => document.createElement("div")` to `return (scope: any) => document.createElement("div")`. Update test descriptions (the `it("should recognize...")` strings) — e.g., "should recognize a function that returns () => Node as ComponentFactory" becomes "should recognize a function that returns (scope) => Node as ComponentFactory".

4. **Update TECHNICAL.md** 🔴

   - Component Model section: Change "returns an `Element` (which is `() => Node`)" to "returns an `Element` (which is `(scope: Scope) => Node`)"
   - Current Limitations: Remove "SSR not implemented" (it was implemented in the component-demo commit). Add "Bindings through props are architecturally unsupported" (documented in kinetic-component-demo plan)
   - Codegen Output section: The example already shows `Avatar({ src: "photo.jpg" })(scope.createChild())` — correct
   - DOM Codegen section: The output pattern already shows `(scope) => { ... }` — correct
   - Add a note in the Architecture Overview or Design Decisions section explaining that `Element = (scope: Scope) => Node` is the universal shape for both DOM and conceptual purposes, while SSR render functions have their own `SSRRenderFunction` type

5. **Update `mount()` export and README if applicable** 🟢 (verified — no changes needed)

   `mount` is re-exported from `index.ts` — no change needed. README does not mention the `Element` type shape (confirmed via grep). The README's `ComponentFactory` example shows usage patterns, not type definitions, so it remains correct.

## Tests

Phases 1–2 are complete. The mount test changes are done (826 tests pass). Remaining test changes are in Phase 4.

| Test file | Change | Status | What it validates |
|---|---|---|---|
| `mount.test.ts` | 15 thunks → `(_scope) => Node` | 🟢 Done (Phase 2) | Signature matches new `Element` type |
| `mount.test.ts` | 3 new scope-passing tests | 🟢 Done (Phase 2) | `mount()` passes scope, cleanups cascade |
| `integration.test.ts` `COMPONENT_PREAMBLE` | `Element` type includes scope param | 🔴 Phase 4 | Component type detection still works with new type |
| `analyze.test.ts` ComponentFactory tests | Inline `Element` type includes scope param | 🔴 Phase 4 | `isComponentFactoryType` detects the updated shape |
| All existing tests (826) | Must still pass | ✅ Verified | No regressions |

No new test files are needed. The risk is in type-level changes breaking detection, which is covered by the existing `isComponentFactoryType` tests and integration tests.

## Transitive Effect Analysis

### `Element` type change → `ComponentFactory` → `isComponentFactoryType`

`Element` is referenced by `ComponentFactory` (same file). `ComponentFactory` is what users annotate their functions with. `isComponentFactoryType` inspects call signatures at compile time via ts-morph. The detection checks:

1. Does the return type have call signatures? — Yes, `(scope: Scope) => Node` has one.
2. Does the inner return type text contain `"Node"`? — Yes.
3. Does the return type text contain `"=> Node"`? — Yes.

All three checks pass for the new shape. **No detection logic changes needed.**

However, the *test preambles* that define `type Element = () => Node` inline for ts-morph to resolve during testing — these must be updated, or the tests will be checking the old shape.

### `Element` type change → `elements.d.ts` → ambient declarations

`elements.d.ts` imports `Element` from `types.ts` and uses it as the return type for all `ElementFactory` overloads. Changing `Element` means all 130+ element factories (`div`, `span`, etc.) now return `(scope: Scope) => Node`. This is correct — it matches what the compiler actually produces. Users never call these functions directly at runtime (they're compiled away), so the return type is only relevant for:

- IDE autocompletion (shows the correct post-compilation shape)
- `isComponentFactoryType` (still works, as analyzed above)
- User code that captures the return value (e.g., `const app = div(...)`) — now correctly typed

### `mount()` change → todo app `main.ts`

`mount()` currently expects `() => Node`. After the change, it expects `(scope: Scope) => Node`. The todo app doesn't currently use `mount()`, so no breakage. After Phase 3, the app will use `mount()` with the correct type.

### `mount()` change → `mount.test.ts`

All 15 mount tests create inline `() => Node` thunks. These must become `(_scope) => Node`. Mechanical change.

### SSR path — unaffected (but has its own parallel mismatch)

The SSR path uses `SSRRenderFunction = (ctx: SSRContext) => string`, which is a completely separate type. The HTML codegen produces `() => { let _html = ""; ... return _html }` — no scope parameter. This is correct: SSR doesn't need scope because there are no subscriptions to manage. The `Element` type change does not affect SSR.

**Note:** SSR has its own version of the same disease this plan fixes for DOM. `SSRRenderFunction` says it takes `(ctx: SSRContext) => string`, but the compiled HTML output is `() => string` — no `ctx` parameter. The server passes the compiled function to `renderToDocument`, which calls `renderFn(ctx)` — the extra argument is silently ignored by JavaScript. This is out of scope for this plan but should be addressed in a future plan to unify SSR types with the compiled HTML output shape.

### `Scope` import in `types.ts` — no circular dependency

`ScopeInterface` is already defined in `types.ts`. The `Element` type references `ScopeInterface` from the same file. No new imports needed. The concrete `Scope` class in `runtime/scope.ts` implements `ScopeInterface` — this relationship is unchanged.

### `hasBuilderCalls` / `findBuilderCalls` — unaffected

These functions operate on AST structure (looking for call expressions with arrow arguments), not on the `Element` type. The type change doesn't affect builder detection.

### Vite plugin — unaffected

The Vite plugin calls `transformSourceInPlace` which operates on AST. The `Element` type is a user-facing concern, not a compiler-internal one. No plugin changes needed.

### External consumers — semver consideration

`Element` is a public export. Changing its shape from `() => Node` to `(scope: ScopeInterface) => Node` is a **breaking change** for anyone who:
- Annotates a variable as `Element` and assigns a `() => Node` to it
- Calls an `Element` value directly without passing a scope

However, the package is experimental (pre-1.0). The existing shape has never worked correctly with compiled output, so any external code using `Element` is either broken or not using it with the compiler. The changeset should note this as a breaking change.

## Alternatives Considered

### Alternative: Keep `Element = () => Node` and use a global/context for scope

Instead of passing scope explicitly, the compiler could capture scope from a global (`getRootScope()`) or a context variable. This would preserve the `() => Node` type.

**Rejected because:**
- Globals create implicit coupling and make testing harder
- Component child scopes (`scope.createChild()`) can't use a global — they need the parent scope explicitly
- The compiler already generates `(scope) => { ... }` — changing it to use globals would be a larger refactor with worse architecture
- Explicit scope passing is the functional core principle: dependencies are parameters, not ambient state

### Alternative: Introduce a new type `CompiledElement = (scope: Scope) => Node` alongside `Element`

Keep `Element = () => Node` for the pre-compilation mental model and add `CompiledElement` for post-compilation.

**Rejected because:**
- Two types for the same concept creates confusion about which to use where
- `mount()` would need to accept both (or one, forcing users to know which they have)
- The pre-compilation `Element` type is a fiction — no runtime code ever produces `() => Node` from a builder. The compiler always adds the scope parameter
- One concept, one type

### Alternative: Make scope optional — `Element = (scope?: Scope) => Node`

This would allow both `element()` and `element(scope)` to work.

**Rejected because:**
- Optional scope means the runtime can't rely on it being present
- Compiled code that calls `scope.createChild()` would crash if scope is undefined
- It papers over the problem instead of fixing it — the scope is always needed for reactive content

## Resources for Implementation Context

- `packages/kinetic/src/types.ts` — `Element`, `ComponentFactory`, `ScopeInterface`, `ElementFactory` types
- `packages/kinetic/src/types/elements.d.ts` — Ambient `ElementFactory` declarations (130+ elements)
- `packages/kinetic/src/runtime/mount.ts` — `mount()` implementation
- `packages/kinetic/src/runtime/mount.test.ts` — 15 mount tests to update
- `packages/kinetic/src/runtime/scope.ts` — `Scope` class (add `implements ScopeInterface`), `setRootScope`, `getRootScope`
- `packages/kinetic/src/compiler/reactive-detection.ts` L394-450 — `isComponentFactoryType`
- `packages/kinetic/src/compiler/analyze.test.ts` L185-300 — ComponentFactory detection tests
- `packages/kinetic/src/compiler/integration.test.ts` L3324-3331 — `COMPONENT_PREAMBLE`
- `packages/kinetic/TECHNICAL.md` L1069-1147 — Component Model section
- `examples/kinetic-todo/src/main.ts` — Todo app client entry (manual scope wiring to replace)
- `examples/kinetic-todo/src/server.ts` — SSR path (should be unaffected; verify)

## Changeset

A **minor** changeset for `@loro-extended/kinetic`:

> **BREAKING**: `Element` type changed from `() => Node` to `(scope: ScopeInterface) => Node` to match what the compiler actually produces. `mount()` now passes its internally-created root scope to the element factory. Code that manually calls an `Element` value must now pass a `Scope` instance. `ComponentFactory` return type updates automatically.

## Learnings

1. **`Scope` structurally conforms to `ScopeInterface` but never declared `implements`.** TypeScript's structural typing made this invisible — everything type-checked without the explicit declaration. Adding `implements ScopeInterface` is a zero-risk improvement that turns an implicit contract into a compile-time guarantee. If `Scope` drifts from the interface (e.g., someone renames `onDispose` to `addCleanup`), the compiler will catch it immediately rather than failing silently at call sites.

2. **The `Element` naming collision with the DOM global `Element` is a persistent source of friction.** `mount.ts` cannot import Kinetic's `Element` type without shadowing the DOM `Element` used for `container` parameter types and `instanceof` checks. The inline type approach (`element: (scope: ScopeInterface) => Node`) is the pragmatic fix, but this collision should be kept in mind for any future API that uses both Kinetic and DOM `Element` types in the same file.

3. **`mount()` and the compiler were never integrated.** The `mount()` function was written with hand-authored `() => Node` thunks in mind. The compiler was built later with `(scope) => Node` output. The todo app bridged them with a double cast. No test ever connected compiled output to `mount()`. This is a reminder that integration tests between independently-developed modules are essential — unit tests on both sides can pass while the interface between them is broken.

4. **SSR has a parallel type mismatch.** `SSRRenderFunction = (ctx: SSRContext) => string` but the compiled HTML output is `() => string`. The server passes the compiled function to `renderToDocument` which calls `renderFn(ctx)` — JavaScript silently ignores the extra argument. This is the same pattern as the DOM `Element` mismatch (types say one shape, compiler produces another, runtime happens to work because JS is lenient with extra arguments). A future plan should unify SSR types with the compiled output.

5. **There are two divergent `ElementFactory` interfaces.** `types.ts` (L220-225) defines `ElementFactory` with `Props` and 4 overloads. `elements.d.ts` (L55-65) defines a separate `ElementFactory` with `PropsWithBindings` (adds `Binding` support for `value`/`checked`) and 5 overloads (includes a props-only overload). Both return `Element`, so both cascade correctly with this plan's change. But the duplication is a maintenance risk — updates to one don't propagate to the other. This is pre-existing and out of scope, but should be consolidated in a future cleanup.

6. **`new Scope("app")` in the todo app is a silent type bug.** The `Scope` constructor accepts `id?: number`, but `main.ts` passes the string `"app"`. TypeScript would flag this, but the todo app likely has lenient checking or relies on the `as unknown as` cast context. At runtime, `scope.id` becomes the string `"app"` instead of a number — harmless because nothing relies on numeric IDs at runtime, but technically incorrect. This bug disappears naturally when Phase 3 replaces manual scope creation with `mount()`. **Lesson:** Pre-existing test files throughout the codebase (`binding.test.ts`, `hydrate.test.ts`, `subscribe.test.ts`) pass strings like `"test-scope"` to `new Scope()` — these are all the same class of bug. They show up as the only `tsc --noEmit` errors in the package. They work because JavaScript doesn't enforce parameter types, but they'd break if `Scope` ever validates its ID.

7. **The `Child` type transitively changes when `Element` changes.** `Child` is defined as `string | number | boolean | null | undefined | Element | Binding<unknown> | Node`. After changing `Element` from `() => Node` to `(scope: ScopeInterface) => Node`, `Child` now includes scope-accepting factories in its union. This is correct — children that are Elements should accept scope — but it's a transitive effect worth noting in case any code pattern-matches on `Child` union members.

8. **Covariant return types make `implements` clauses safe for subtype-returning methods.** `ScopeInterface.createChild()` returns `ScopeInterface`, but `Scope.createChild()` returns `Scope` (a more specific type). TypeScript allows this because return types are covariant — a method returning a subtype satisfies an interface expecting the supertype. This means adding `implements ScopeInterface` to `Scope` required zero method signature changes. **Mistake to avoid:** Don't widen `Scope.createChild()` to return `ScopeInterface` "for consistency" — the narrower return type is more useful to callers who know they have a concrete `Scope`.

9. **Testing the contract, not just the signature, requires scope-using factories.** Changing `mount()`'s parameter type from `() => Node` to `(scope) => Node` doesn't prove anything by itself — JavaScript doesn't enforce parameter types at runtime. The real proof that `mount()` passes scope is a test where the factory *uses* the scope (e.g., `scope.onDispose(...)`) and the test verifies the side effect fires on `dispose()`. We added three such tests: one confirming the received scope is the rootScope, one confirming `onDispose` callbacks fire, and one confirming child scope cascading. Without these, a regression that reverts `element(rootScope)` back to `element()` would silently pass all other tests.

## Amendment: Acknowledge parallel SSR type mismatch and `ElementFactory` duplication

**Discovered during:** Plan review (post-Phase 4 analysis)
**Targets:** Transitive Effect Analysis (SSR section), Learnings section

**Preamble:** While reviewing the plan for correctness, we discovered that the SSR rendering path has the exact same class of type mismatch that this plan fixes for the DOM path. `SSRRenderFunction` declares `(ctx: SSRContext) => string` but the compiler's HTML codegen produces `() => string` (no context parameter). The server code passes the compiled function to `renderToDocument`, which calls it with a `ctx` argument that is silently ignored. This works at runtime because JavaScript doesn't enforce arity, but the types are lying.

We also discovered that `ElementFactory` is defined in two places with slightly different overload sets — `types.ts` (user-facing, uses `Props`) and `elements.d.ts` (ambient declarations, uses `PropsWithBindings`). Both return `Element` and will cascade correctly, but the duplication is a drift risk.

**Changes made:**
- Added a "Note" paragraph to the "SSR path — unaffected" section of the Transitive Effect Analysis, acknowledging the parallel mismatch and flagging it for a future plan
- Added Learnings 4 (SSR parallel mismatch) and 5 (`ElementFactory` duplication)
- Updated Phase 4 Task 3 to include updating test description strings, not just type definitions and mock bodies

No new tasks or phases are needed — these are documentation-only amendments that improve the plan's completeness without changing its scope.