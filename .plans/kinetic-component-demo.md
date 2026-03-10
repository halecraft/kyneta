# Plan: Prove and Demonstrate Kinetic Components

## Background

Kinetic's component model was implemented in PR 7 of the template-cloning plan. The compiler detects functions typed as `ComponentFactory` via TypeScript type inspection, represents them as `ElementNode` with a `factorySource` field in the IR, and emits `Factory(props)(scope.createChild())` in the DOM codegen. Template cloning handles components via `componentPlaceholder` events and comment-node replacement.

All individual pieces have unit tests: type detection (`isComponentFactoryType`), IR generation (`analyzeElementCall` with `factorySource`), `findBuilderCalls` recognizing component calls, template extraction emitting `<!---->` placeholders, and codegen string output. However, **no test compiles a component definition + usage and executes the resulting DOM**. The component pipeline is theoretically complete but empirically unproven.

## Problem Statement

1. **Zero end-to-end component tests exist.** The generated code for components has never been executed. The double-invocation calling convention (`Factory(props)(scope.createChild())`) depends on the component body's builder expression compiling into `(scope) => Node`, which is structurally correct but never verified.

2. **The kinetic-todo demo app uses no components.** It's a flat builder function with inline `li`, `label`, `button` elements. There's no demonstration that components work in a real application context.

3. **SSR will break.** HTML codegen's `emitElement` does not handle `factorySource`. Introducing a component in the todo app would cause SSR to emit `<TodoItem>` as a literal HTML tag — a regression from the current fully-working SSR. The client would flash incorrect content until hydration replaces it.

4. **Several edge cases are untested.** Expression-body arrows, prop-less components, event handler props, and scope cleanup on component disposal have no coverage.

## Success Criteria

- An integration test compiles a `ComponentFactory`-typed function + its usage inside a parent builder, executes the result, and asserts correct DOM structure.
- HTML codegen emits `_html += Factory(props)()` for components — SSR renders the component's output, not a `<ComponentName>` tag.
- The kinetic-todo `app.ts` uses at least one component (`TodoItem`) to render list items.
- The demo app runs in the browser (Vite dev server) with the component working identically to the current inline version, **including SSR** — no flash, no regression.
- TECHNICAL.md documents the proven calling convention and known limitations.

## The Gap

| Capability | Status |
|---|---|
| `isComponentFactoryType` detection | ✅ Unit tested |
| IR generation with `factorySource` | ✅ Unit tested |
| `findBuilderCalls` finds component calls | ✅ Unit tested |
| Template extraction emits component holes | ✅ Unit tested |
| DOM codegen emits `Factory(props)(scope)` | ✅ String output tested |
| **Compile + execute component end-to-end** | 🔴 **No test** |
| **Component inside reactive loop** | 🔴 **No test** |
| **Component scope disposal** | 🔴 **No test** |
| **HTML codegen handles `factorySource`** | 🔴 **Not implemented** |
| **SSR with components** | 🔴 **Will emit `<ComponentName>` tag** |
| **Real app using a component** | 🔴 **Not demonstrated** |

## Phase 1: Prove Components End-to-End (DOM + SSR) ✅

Prove the full compile → execute pipeline for components — both DOM and HTML targets — before touching the demo app. The SSR codegen change (~10 lines in `emitElement`) and its tests belong here because: (a) the `compileInPlace` test helper serves both targets via its `target` parameter, (b) the SSR fix is the same pattern as the DOM codegen (props serialization + function call), and (c) splitting them into separate phases creates an artificial boundary around code that shares all context.

### Test Infrastructure

**Why a new helper is needed:** The existing `compileAndExecute` uses `transformSource`, which outputs only compiled builder factories — it does not preserve the surrounding source (component definitions, variable declarations). When a parent builder references `TodoItem`, the generated code contains the identifier `TodoItem`, but `transformSource` output has no definition for it. Component tests require `transformSourceInPlace`, which replaces builder calls inline within the full source.

**Design: Functional Core / Imperative Shell split.** The new helper is two functions, mirroring the existing `transformSource` / `executeGeneratedCode` split:

1. **`compileInPlace(source: string, target?: "dom" | "html"): string`** (pure) — Calls `transformSourceInPlace` → `mergeImports` → `sourceFile.getFullText()` to get the full compiled TypeScript source. Then passes it through `ts.transpileModule()` (from the TypeScript compiler API, already bundled with ts-morph) to strip all type annotations, producing clean executable JS. No regex, no manual AST removal — `transpileModule` handles imports-with-type-only-bindings, inline parameter types, type aliases, interfaces, generics, and `as` casts in one pass. Finally, filters out `import` lines (eval doesn't support ES imports; runtime symbols are already in the test module's lexical scope).

2. **`compileAndExecuteComponent(source: string): { node: Node; scope: Scope }`** (imperative shell) — Calls `compileInPlace(source, "dom")`, then `eval()` the result in the module's lexical scope. Finds the last variable assignment that holds a factory `(scope) => { ... }`, evaluates it, and calls it with a fresh `Scope`. Returns `{ node, scope }` matching the existing helper's return shape.

**Why `eval()` works without runtime injection:** `eval()` runs in the caller's lexical scope. The integration test file already imports `subscribe`, `subscribeMultiple`, `listRegion`, `conditionalRegion`, `Scope`, etc. at module level. Generated code references these as bare identifiers. When `eval()` executes the compiled code, those identifiers resolve to the module-level imports. The existing `compileAndExecute` helper already proves this pattern works for 40+ tests.

**Why `ts.transpileModule()` instead of ts-morph structural removal:** After `transformSourceInPlace`, the compiled source still contains TypeScript syntax: type annotations on variable declarations (`const TodoItem: ComponentFactory<...>`), function parameter types (`(props: { label: string })`), type aliases, interfaces, and generic parameters. Manual ts-morph AST removal (`getImportDeclarations().forEach(d => d.remove())`, `getTypeAliases().forEach(t => t.remove())`) misses inline parameter types and type casts. `ts.transpileModule()` is a single function call that strips *all* TypeScript syntax, is zero additional dependencies (ts-morph bundles TypeScript), and is the same mechanism esbuild uses internally.

The test source must include the `ComponentFactory` type alias and `Element` type so ts-morph can resolve types during analysis.

### SSR Codegen

Add `factorySource` handling to HTML codegen so components render their actual HTML output during SSR, not a `<ComponentName>` tag.

**Calling convention:** On the DOM side, a compiled component factory has the shape `(props) => (scope) => Node`. On the HTML side, `generateRenderFunction` wraps builder output in `() => { let _html = ""; ...; return _html }` — no scope parameter. So the compiled SSR component has the shape `(props) => () => string`. The SSR call site emits `_html += Factory(props)()` — call with props, invoke the returned render function, concatenate the result.

**Props serialization mirrors DOM codegen.** The DOM codegen builds `{ name: value.source, ... }` from `node.attributes` and re-capitalizes event handlers from `node.eventHandlers`. The HTML codegen does the same for attributes (since component props may influence rendered HTML), but skips event handlers (SSR doesn't wire events).

### Tasks

1. **Write `compileInPlace` + `compileAndExecuteComponent` helpers** ✅
   - `compileInPlace`: `transformSourceInPlace` → `mergeImports` → `getFullText()` → `ts.transpileModule()` → filter import lines → return JS string
   - `compileAndExecuteComponent`: `wrapLastBuilder` → `compileInPlace` → `new Function(...)` with runtime deps as params → call factory with `Scope` → return `{ node, scope }`
   - Uses `new Function` instead of `eval` because `const`/`var` declarations don't leak out of strict-mode `eval`
   - Import `mergeImports` from `./transform.js` (already available in the same module)
   - Import `ts` from `typescript` (already a transitive dependency via ts-morph)

2. **Test: basic component compile + execute** ✅
   - Define a `ComponentFactory`-typed function that returns a `span` with text from props
   - Use it inside a parent `div` builder
   - Compile, execute, assert the `<div>` contains a `<span>` with correct text
   - This is the minimum viable proof that the double-invocation works

3. **Test: component with event handler prop** ✅
   - Define a component that takes an `onClick` handler prop and attaches it to a button
   - Compile, execute, simulate click, assert the handler fires
   - Verifies that event handler props are threaded through the `{ onClick: handler }` object correctly

4. **Test: component inside a static loop** ✅
   - Render 3 components with different props (inline calls, not `for...of` — a `for...of` over a plain array triggers reactive list region detection)
   - Assert DOM contains 3 child elements with correct text

5. **Test: component scope disposal** ✅
   - Create a component, dispose the parent scope
   - Assert the child scope created by `scope.createChild()` is also disposed
   - Verifies scope tree integrity for component instances

6. **Test: expression-body arrow component** ✅
   - Define component as `(props) => span(...)` (no block body, no `return` keyword)
   - Compile, execute, assert correct DOM
   - Verifies both arrow body forms produce the right `(props) => (scope) => Node` shape

7. **Add `factorySource` branch to `emitElement` in `codegen/html.ts`** ✅
   - When `node.factorySource` is present, build a props object from `node.attributes` (same serialization as DOM codegen)
   - Emit `_html += ${node.factorySource}(${propsArg})()` for components with props
   - Emit `_html += ${node.factorySource}()()` for prop-less components
   - Skip event handlers (SSR-irrelevant)
   - Early return — don't emit opening/closing tags

8. **Test: HTML codegen emits component call** ✅
   - In `codegen/html.test.ts`, create an `ElementNode` with `factorySource`, verify the generated code contains `_html += FactoryName({ ... })()`
   - Verify it does NOT contain `<FactoryName>` or `</FactoryName>`

9. **Test: SSR integration — component renders its HTML, not a tag** ✅
   - In `integration.test.ts`, compile a component + parent builder with `target: "html"`
   - Assert output contains `<span>` (the component's output), not `<MyComponent>`

10. **Fix: duplicate `_tmpl_0` declarations in multi-builder files** ✅
    - `transformSourceInPlace` processes each builder independently, each starting `templateCounter` at 0 — producing duplicate `const _tmpl_0` declarations when a file has multiple builders (e.g., component definition + usage)
    - Added `templateCounterOffset` option to `DOMCodegenOptions`; `transformSourceInPlace` now threads a running counter across `generateElementFactoryWithResult` calls
    - This was a pre-existing production bug (affects Vite plugin), not just a test issue

## Phase 2: Extract `TodoItem` Component in Demo App 🔴

Refactor `app.ts` to extract a `TodoItem` component. Keep the scope minimal — only `TodoItem`, not `TodoHeader` — to minimize risk surface. The header's `bind(doc.newTodoText)` creates a `Binding<T>` object detected by `isBindCall()` / `extractBindRefSource()` at the call site. If passed as a prop, the component's `input({ value: props.inputBinding })` would reference `props.inputBinding` — a generic property access, not a `bind()` call — so the compiler would not recognize it as a binding target. **Bindings through props are architecturally unsupported**, not merely untested.

### Authoring Pattern: "Builder Components"

The component pattern that emerges is worth naming. A **Builder Component** is a function that closes over props and returns a builder expression:

```ts
const TodoItem: ComponentFactory<{ label: string; onRemove: () => void }> = (props) =>
  li({ class: "todo-item" }, () => {
    label(props.label)
    button({ class: "destroy", onClick: props.onRemove }, "×")
  })
```

This is a closure-as-component pattern: the builder expression *is* the template — no JSX, no virtual DOM. The compiler handles scope threading transparently, transforming `li(...)` into `(scope) => Node` inside the closure. The call site emits `TodoItem(props)(scope.createChild())`, but the user never writes or sees the double invocation.

### Tasks

1. **Define `TodoItem` component in `app.ts`** 🔴
   - Type: `ComponentFactory<{ label: string; onRemove: () => void }>`
   - Body: the existing `li({ class: "todo-item" }, () => { ... })` builder
   - Place above the `createApp` function in the same file (simplest; the Vite plugin compiles the whole file)

2. **Replace inline `li` with `TodoItem` call inside the `for` loop** 🔴
   - Replace the `li({ class: "todo-item" }, () => { ... })` block with `TodoItem({ label: item, onRemove: () => removeTodo(item) })`
   - The `for` loop, `if/else`, and `ul` wrapper remain in the parent builder

3. **Import `ComponentFactory` type from `@loro-extended/kinetic`** 🔴
   - Already exported from the package's main entry point

4. **Verify the app runs in the browser** 🔴
   - `cd examples/kinetic-todo && npm run dev` (or equivalent)
   - Add a todo, remove a todo, confirm identical behavior to pre-refactor
   - View page source to confirm SSR output contains `<li class="todo-item">`, not `<TodoItem>`

## Phase 3: Documentation Updates 🔴

### Tasks

1. **Update TECHNICAL.md Component Model section** 🔴
   - Add a "Proven Calling Convention" subsection confirming the double-invocation pattern works end-to-end
   - Name the pattern: "Builder Components" — closure over props, builder expression as template, compiler-transparent scope threading
   - Document that component props are captured at instantiation time (not reactive) — if a prop value changes, the component must be destroyed and recreated, which happens naturally for list insert/delete but not for in-place updates
   - Note that expression-body and block-body arrow forms both produce correct output
   - Document SSR calling convention: `Factory(props)()` — factory returns render function, render function returns HTML string
   - Update Current Limitations: remove "SSR not implemented", add "bindings through props are architecturally unsupported" alongside existing item (builder callbacks not wired)

2. **Update `examples/kinetic-todo/README.md`** 🔴
   - Note that the app demonstrates components via `TodoItem`
   - Brief explanation of the `ComponentFactory` pattern

3. **Add inline documentation to the `TodoItem` component in `app.ts`** 🔴
   - JSDoc explaining the component contract: takes props, returns an `Element`
   - Note that props are not reactive (captured at render time)

## Tests

All Phase 1 tests go in `integration.test.ts` under a new `describe("Component compilation")` section, except for the HTML codegen unit test which goes in `codegen/html.test.ts`.

| Test | Task | What it proves | Risk addressed |
|---|---|---|---|
| `compileInPlace` + `compileAndExecuteComponent` | 1 | `transformSourceInPlace` + `ts.transpileModule` produces executable output via `eval()` | Test infrastructure correctness |
| Basic component compile + execute | 2 | Double-invocation `Factory(props)(scope)` works | Core calling convention |
| Event handler prop | 3 | `onClick`/`onRemove` threaded through props object | Handler serialization in codegen |
| Component in static loop | 4 | Multiple component instances in sequence | `appendChild` ordering with components |
| Scope disposal | 5 | `scope.createChild()` in component is disposed with parent | Memory leak prevention |
| Expression-body arrow | 6 | `(props) => span(...)` form compiles correctly | Arrow body variant correctness |
| HTML codegen emits component call | 8 | `emitElement` emits `_html += Factory(props)()`, not `<Factory>` | SSR correctness |
| SSR integration | 9 | Full compile → HTML output contains component's HTML, not tag | SSR regression prevention |

## Transitive Effect Analysis

### Compilation pipeline (the critical transitive concern)

`transformSource` → `findBuilderCalls` → `analyzeBuilder` → `generateElementFactory`

- `findBuilderCalls` walks **all** `CallExpression` nodes and filters by `checkElementOrComponent` + "has arrow function argument". A component definition's inner builder (`li(() => ...)`) is found as a top-level builder call because `isNestedBuilderCall` returns `false` (the arrow function containing it is not an argument to an element factory call — it's a variable initializer). **No changes needed here.**

- `generateElementFactory` wraps output in `(scope) => { ... }` (default `scopeVar = "scope"`). For the component body, the `li(...)` builder compiles into `(scope) => { const _li0 = ...; return _li0 }`. The component function becomes `(props) => (scope) => { ... }`. The call site emits `TodoItem({ ... })(scope.createChild())`. Chain: `(props) → (scope) → Node`. **No codegen changes needed for DOM path.**

- `generateRenderFunction` wraps HTML output in `() => { let _html = ""; ...; return _html }` — no scope parameter. For the component body, the `li(...)` builder compiles into `() => { let _html = ""; _html += "<li ...>"; ...; return _html }`. The component function becomes `(props) => () => string`. The call site emits `_html += TodoItem({ ... })()`. Chain: `(props) → () → string`. **Task 7 adds the `factorySource` branch to `emitElement` to make this work.**

- **`transformSource` vs `transformSourceInPlace` — this is the key transitive concern for testing.** The existing `compileAndExecute` helper uses `transformSource`, which outputs *only the compiled builder factories* as `const element0 = ...`, `const element1 = ...` — it does NOT include the surrounding source (variable declarations, imports, component definitions). When a parent builder references `TodoItem`, the generated code contains the identifier `TodoItem`, but `transformSource` output has no definition for it.

  `transformSourceInPlace`, by contrast, preserves the full source and replaces builder calls inline. After in-place transformation, the source contains:
  - `const TodoItem: ComponentFactory<...> = (props) => { return (scope) => { ... } }` (component body's builder replaced inline)
  - The parent builder call replaced with `(scope) => { ... const _TodoItem0 = TodoItem({ ... })(scope.createChild()) ... }`

  Both the component definition and its usage are present in one contiguous source string.

  **Implication for tests:** The new `compileInPlace` helper uses `ts.transpileModule()` to strip all TypeScript syntax from the compiled source, then returns clean executable JS. `compileAndExecuteComponent` evals that JS in the integration test's module scope, where runtime symbols are already available. This mirrors what `compileAndExecute` does but with the full source preserved. The existing `compileAndExecute` helper remains valid for single-builder tests without cross-references.

### TypeScript stripping in tests

- After `transformSourceInPlace` + `mergeImports`, the compiled source still contains TypeScript syntax: type annotations on variable declarations (`const TodoItem: ComponentFactory<...>`), function parameter types (`(props: { label: string })`), type aliases, interfaces, generic parameters, and `import type { ... }` statements. `eval()` cannot execute TypeScript — it requires plain JS.
- `ts.transpileModule()` from the TypeScript compiler API (bundled with ts-morph as a transitive dependency) performs syntax-only stripping: no type checking, no module resolution. It handles all TypeScript syntax in one call, including inline parameter types, `as` casts, and import-type elision. This is more robust than manual ts-morph AST removal, which would miss inline parameter annotations and require iterating multiple AST node kinds.
- The transpile target should be `ESNext` to preserve `const`, arrow functions, and template literals as-is (no downleveling).

### Runtime

- `Scope.createChild()` is called for each component instance. In a reactive loop, items are created/destroyed as the list changes. When an item is deleted, the item's scope is disposed, which cascades to the component's child scope. **No runtime changes needed.**

### Vite plugin

- The Vite plugin uses `transformSourceInPlace` + `mergeImports`. Component definitions and usages in the same file are transformed in a single pass. The plugin processes all `.ts` files, so components in separate files also work. **No plugin changes needed.**

### SSR (resolved by Phase 1, Task 7)

- HTML codegen's `emitElement` currently emits `<tag>children</tag>` unconditionally. When `tag` is `"TodoItem"`, the output is `<TodoItem>children</TodoItem>` — invalid HTML that causes a visible flash when the client hydrates.
- Task 7 adds a `factorySource` branch to `emitElement` that emits `_html += Factory(props)()` instead. The component's SSR render function returns its actual HTML (e.g., `<li class="todo-item">...</li>`), which is concatenated into the parent's HTML output. Components become transparent at the SSR level — their output is indistinguishable from inline elements.
- **No changes to `generateHTML` or `generateRenderFunction` are needed.** Those functions handle `BuilderNode` (the top-level root), not `ElementNode` children. The `emitElement` function handles child elements, which is where component nodes appear.

### Eval scope for integration tests

- Generated code references runtime functions as bare identifiers: `subscribe`, `subscribeMultiple`, `listRegion`, `conditionalRegion`, `Scope`, `bindTextValue`, `bindChecked`. These come from `import { ... }` statements that `mergeImports` adds — but `eval` doesn't support `import` statements.
- **This is a non-issue.** `eval()` runs in the caller's lexical scope. The integration test file already imports these symbols at module level. `ts.transpileModule()` with `ESNext` target preserves import statements as-is; we strip them after transpilation with a simple line filter (imports are always top-level, one per line in the generated output).
- The `Scope` instance for `scope.createChild()` comes from the factory parameter `(scope) => { ... }`, not from the module scope. The test provides this when calling the factory.

### Binding-through-props architectural limitation

- `bind(ref)` is detected at the call site by `isBindCall()` which checks for a direct `bind(...)` call expression. When passed as a prop value, the compiler sees the call and extracts the ref source.
- However, **inside the component**, if the component tries to use `props.inputBinding` as a binding target in `input({ value: props.inputBinding })`, the compiler sees `props.inputBinding` — a plain property access — not a `bind()` call. `isBindCall()` returns false. The binding is lost.
- This means binding-bearing props cannot be forwarded from parent to component. This is an architectural limitation, not a bug. It would require either a runtime binding protocol or compiler support for tracking binding provenance through props. **Documenting this limitation is a Phase 3 task.**

### `transformSourceInPlace` replacement ordering

- `transformSourceInPlace` sorts replacements by position descending (back-to-front). When `app.ts` contains both a component body builder (`li(...)`) and the parent builder (`div(...)`), the inner `li(...)` is at a higher source position within the component definition, and the outer `div(...)` wraps the whole app. Both are found by `findBuilderCalls`. The inner replacement happens first (back-to-front), then the outer replacement sees the already-replaced inner code. This is correct by construction — no ordering issues.

## Learnings

1. **`ts.transpileModule()` is the right tool for TS→JS stripping in test helpers.** Manual ts-morph AST removal (`getImportDeclarations().forEach(d => d.remove())`, `getTypeAliases().forEach(t => t.remove())`) was the original plan, but it misses inline parameter type annotations, generic type parameters, `as` casts, and other TypeScript syntax that appears within expressions and function signatures. `ts.transpileModule()` handles all of these in one call, is zero additional dependencies (ts-morph bundles TypeScript), and is the same syntax stripping mechanism used by esbuild internally. Confirmed working.

2. **SSR component support is a ~10-line change, not a "future work" item.** The HTML codegen's `emitElement` needs a single `if (node.factorySource)` branch that builds a props object and emits `_html += Factory(props)()`. The props serialization mirrors the DOM codegen exactly. Deferring this would cause SSR regression in the demo app — the todo app currently has fully-working SSR, and introducing a component without SSR support would cause a visible flash during client hydration.

3. **The SSR calling convention is `Factory(props)()` — no scope parameter.** DOM components return `(scope) => Node`. HTML components return `() => string`. The Kinetic compiler already generates different wrapper shapes for each target (`generateElementFactory` wraps in `(scope) => { ... }` for DOM; `generateRenderFunction` wraps in `() => { ... }` for HTML). The SSR call site just needs to match: call with props, invoke the render function, concatenate. Confirmed working end-to-end.

5. **`const`/`var` declarations don't leak out of strict-mode `eval()`.** Vitest runs in strict mode, so `eval(js)` followed by `eval("varName")` doesn't work for extracting variables defined in the first eval. The fix is `new Function(...)` which receives runtime dependencies as named parameters and returns the factory directly. The `wrapLastBuilder` helper assigns the last builder call to `const __lastBuilder = ...` before compilation, and the `new Function` body appends `return __lastBuilder;`.

6. **Duplicate template variable names are a pre-existing production bug.** `transformSourceInPlace` called `generateElementFactoryWithResult` with a fresh `CodegenState` per builder, each starting `templateCounter` at 0. Any file with 2+ builders (which is exactly the component use case) would produce duplicate `const _tmpl_0` declarations. Fixed by adding `templateCounterOffset` to `DOMCodegenOptions` and threading the running total across calls.

7. **Component builder bodies must use the arrow-function builder pattern.** `findBuilderCalls` only finds calls with an arrow function argument. A component like `(props) => span(props.text)` (no arrow) won't have its body compiled. The correct pattern is `(props) => div(() => { span(props.text) })` where `div(() => { ... })` is the builder call. Nested element calls like `span(props.text)` inside the builder body are handled by `analyzeElementCall` during analysis.

4. **Components are transparent at the HTML level.** Best-in-class SSR (React, Solid, Svelte) never emits component "tags" — components are authoring abstractions that dissolve at render time. The SSR output for a component should be indistinguishable from the output of inline elements. Emitting `<ComponentName>` or `<!--component:ComponentName-->` is neither correct SSR nor acceptable UX.

## Resources for Implementation Context

- `packages/kinetic/src/compiler/integration.test.ts` — existing integration test file with `compileAndExecute` helper and JSDOM setup
- `packages/kinetic/src/compiler/codegen/dom.ts` L365–415 — `generateElement` with `factorySource` handling (DOM path to mirror in HTML)
- `packages/kinetic/src/compiler/codegen/html.ts` L247–280 — `emitElement` function (where the `factorySource` branch goes)
- `packages/kinetic/src/compiler/codegen/html.test.ts` — existing HTML codegen tests
- `packages/kinetic/src/compiler/transform.ts` — `transformSource`, `transformSourceInPlace`, and `mergeImports`
- `packages/kinetic/src/compiler/analyze.ts` L225–248 — `checkElementOrComponent` two-tier detection
- `packages/kinetic/src/compiler/analyze.ts` L1085–1148 — `findBuilderCalls` and `isNestedBuilderCall`
- `packages/kinetic/src/types.ts` — `ComponentFactory` type definition
- `packages/kinetic/TECHNICAL.md` L1069–1147 — Component Model section
- `examples/kinetic-todo/src/app.ts` — the demo app to refactor
- `examples/kinetic-todo/src/schema.ts` — `TodoSchema` definition
- `packages/kinetic/src/testing/index.ts` — test helpers (`resetScopeIdCounter`, `activeSubscriptions`, etc.)

## Changeset

A patch changeset for `@loro-extended/kinetic` documenting the new integration tests, SSR component codegen, and proven component pipeline. No version bump needed (experimental package).

A patch changeset for `kinetic-todo` example documenting the component extraction.