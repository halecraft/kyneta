# Plan: Polish kinetic-todo into a Kinetic Showcase

## Background

The kinetic-todo example app has evolved through several rounds of infrastructure work — SSR codegen, component compilation, scope-passing unification — but the app itself hasn't kept pace. It still uses a flat builder function with no components, carries a `state(0)` / `requestAnimationFrame` animation loop that belongs in a test harness, has an unused `completedCount` schema field, and a README that describes a "simulated compiled output" architecture that hasn't been true since the Vite plugin was integrated.

The component pipeline is proven end-to-end (6 integration tests, DOM + SSR), the `Element` type is unified, `mount()` passes scope correctly, and the todo app already uses `mount()`. The infrastructure is ready — the demo just needs to use it.

## Problem Statement

1. **No components in the demo.** The todo app is the only real-world Kinetic application. It demonstrates builder patterns, reactive loops, conditionals, bindings, and SSR — but not components. The component pipeline has zero production usage.

2. **Distracting tech demo artifact.** The `state(0)` + `requestAnimationFrame` animation loop and its `h2(x.get().toString())` display are a `client:` target label test, not a todo app feature. They make the demo look like a test harness.

3. **Dead schema field.** `completedCount: Shape.counter()` is defined but never referenced in the UI. Dead code in a showcase undermines credibility.

4. **Stale README.** The README describes "simulated compiled output" and references runtime internals (`__subscribeWithValue`, `__listRegion`, etc.) that users never see. The "What the Compiler Would Transform" section has the relationship backwards — the builder pattern _is_ the code users write, not a hypothetical.

## Success Criteria

- `app.ts` uses at least two components: a `TodoItem` (props-based) and a `TodoHeader` (closure-based), demonstrating both component patterns
- The animation loop and `state(0)` / `h2` counter are removed
- The `completedCount` field is removed from the schema
- The README accurately describes how the app works today (Vite plugin compiles builder patterns, same file serves DOM + SSR)
- TECHNICAL.md Component Model section documents the "Builder Components" pattern and the proven calling convention
- The app runs identically in the browser — add, remove, SSR, collaboration all work
- SSR output contains `<li class="todo-item">`, not `<TodoItem>`

## The Gap

| Aspect | Current | Target | Phase |
|---|---|---|---|
| Components in app | None | `TodoItem` + `TodoHeader` | 1 |
| Animation loop | `state(0)` + rAF + `h2` counter | Removed | 1 |
| `completedCount` schema field | Defined, unused | Removed | 1 |
| `ComponentFactory` import | Not in `app.ts` | Imported and used | 1 |
| README | Describes "simulated compiled output" | Describes real Vite-compiled architecture | 2 |
| TECHNICAL.md Component Model | No "Builder Components" pattern, no proven convention note | Both documented | 2 |
| `app.ts` JSDoc | No component documentation | Components have JSDoc | 1 |

## Phase 1: Extract Components and Clean Up 🟢

### Tasks

1. **Remove the animation loop from `app.ts`** 🟢

   Delete the `const x = state(0)`, the entire `client: { ... }` block (the `requestAnimationFrame` loop), and the `h2(x.get().toString())` line. Remove the `state` import from `@loro-extended/kinetic` if it becomes unused.

2. **Remove `completedCount` from `TodoSchema`** 🟢

   Delete `completedCount: Shape.counter()` from `schema.ts`. Verify no references exist in `app.ts`, `server.ts`, or `main.ts`.

3. **Define `TodoItem` as a props-based component** 🟢

   Defined inside `createApp` with the specific `(props: P) => Element` overload type rather than the `ComponentFactory<P>` union. TypeScript can't resolve which union member to call at call sites (see Learning 5). The compiler's `isComponentFactoryType` detection works on structural call signatures, not on the `ComponentFactory` name, so the specific overload is fully equivalent.

   Imported `Element` type from `@loro-extended/kinetic` for the annotation. Added JSDoc explaining the props-based pattern and the type annotation rationale.

4. **Define `TodoHeader` as a closure-based component** 🟢

   Defined inside `createApp` with `() => Element` type annotation. Closes over `doc`, `addTodo`, and `handleKeyDown`. Added JSDoc explaining the closure pattern and why it's necessary for `bind()`.

5. **Replace inline builders with component calls** 🟢

   In the main builder inside `createApp`:
   - Replace the `header(() => { ... })` block with `TodoHeader()`
   - Replace the `li({ class: "todo-item" }, () => { ... })` block inside the `for` loop with `TodoItem({ label: item, onRemove: () => removeTodo(item) })`

6. **Rebuild the kinetic package dist** 🟢

   Run `npx tsup` in `packages/kinetic` so the todo app resolves the `ComponentFactory` type export from the built `dist/`. (The dist is gitignored — this is a local step, not a committed artifact.)

7. **Verify the app type-checks and the kinetic tests pass** 🟢

   - `cd packages/kinetic && npx vitest run` — all 826 tests pass
   - `cd examples/kinetic-todo && npx tsc --noEmit` — no type errors

## Phase 2: Documentation 🔴

### Tasks

1. **Rewrite `examples/kinetic-todo/README.md`** 🔴

   The README should reflect the app as it actually works today:

   - **What This Shows**: Builder patterns, components (props-based + closure-based), reactive loops, conditionals, two-way bindings, SSR via dual compilation, collaborative editing via WebSocket
   - **Project Structure**: `schema.ts` (shared CRDT schema), `app.ts` (UI with components — compiled by Vite plugin for both targets), `main.ts` (client entry — Repo + mount), `server.ts` (SSR + Vite middleware + WebSocket)
   - **How It Works**: The Vite plugin compiles `app.ts` into DOM code for the client and HTML code for the server. Same source, two targets. `mount()` handles scope creation and DOM attachment. Components dissolve at compile time — SSR output is pure HTML.
   - **Components section**: Explain the two patterns demonstrated — `TodoItem` (props) and `TodoHeader` (closure). Note the binding-through-props limitation and why `TodoHeader` uses closure capture instead.
   - **Running**: Keep the existing instructions, verify the port number
   - Remove all references to "simulated compiled output", `__subscribeWithValue`, `__listRegion`, manual DOM construction, etc.
   - Remove the "What the Compiler Would Transform" section — the builder pattern _is_ the user's code, not a hypothetical

2. **Update TECHNICAL.md Component Model section** 🔴

   Add a "Builder Components" subsection after "Codegen Output":

   - Name the pattern: a **Builder Component** is a function typed as `ComponentFactory` that returns a builder expression. The builder expression _is_ the template — no JSX, no virtual DOM, no render function to write.
   - Two flavors: **props-based** (receives data via typed props object) and **closure-based** (captures data from enclosing scope). Both compile identically — the compiler doesn't distinguish them.
   - Props are captured at instantiation time and are not reactive. If a prop value changes, the component must be destroyed and recreated. This happens naturally for list items (insert/delete) but not for in-place updates.
   - The calling convention is proven end-to-end: DOM (`Factory(props)(scope.createChild())`) and SSR (`Factory(props)()`) both work. Cite the integration tests.

3. **Update `app.ts` module-level JSDoc** 🔴

   Update the file-level doc comment to mention components as a demonstrated feature. The current comment is accurate but doesn't mention the component patterns.

## Tests

No new test files or test cases are needed. The component pipeline is already proven by 6 integration tests (basic component, event handler props, static loop, scope disposal, expression-body arrow, SSR HTML output). This plan is about demonstrating the proven pipeline in a real app, not adding new compiler functionality.

| Verification | Method | What it proves |
|---|---|---|
| Kinetic tests pass | `npx vitest run` (826 tests) | No regressions from app changes |
| Todo app type-checks | `npx tsc --noEmit` | `ComponentFactory` type used correctly |
| App runs in browser | Manual: add todo, remove todo | Components render and handle events |
| SSR output correct | View page source | `<li class="todo-item">` not `<TodoItem>` |

## Transitive Effect Analysis

### `ComponentFactory` type import in `app.ts`

`ComponentFactory` is a type-only export from `@loro-extended/kinetic`. The import is `import type { ComponentFactory }`, so it's erased at compile time. The Vite plugin compiles the builder expressions inside the component bodies. No new runtime dependency is introduced.

### Component bodies are builder calls — the compiler already handles them

`findBuilderCalls` walks all `CallExpression` nodes. A component's inner builder (e.g., `li(() => { ... })`) is found as a top-level builder call because the arrow function containing it is a variable initializer, not an argument to an element factory call. `transformSourceInPlace` processes both the component body and the parent builder in a single pass, sorted back-to-front. The template counter threads across calls (fixed in the `templateCounterOffset` work). No compiler changes needed.

### Schema change — `completedCount` removal

`completedCount` is defined in `TodoSchema` but never referenced in `app.ts`, `main.ts`, or `server.ts` (confirmed via grep during research). Removing it changes the schema shape, but since this is a dev example (not a production deployment with persisted data), there's no migration concern. The LevelDB database can be deleted and recreated.

### SSR path — components dissolve transparently

The HTML codegen's `emitElement` already handles `factorySource` (added in the component-demo Phase 1 work). Components emit `_html += Factory(props)()`, producing their actual HTML output. The server path (`vite.ssrLoadModule → createApp → renderToDocument`) is unchanged. SSR continues to work because the compiler handles the new component nodes the same way it handles any builder call.

### `state` import removal

If the animation loop is the only consumer of `state` in `app.ts`, removing it makes the `state` import unused. The `bind` import is still used by the input binding. Verify the import line after removal and adjust as needed.

## Resources for Implementation Context

- `examples/kinetic-todo/src/app.ts` — the file being refactored (components extracted here)
- `examples/kinetic-todo/src/schema.ts` — remove `completedCount`
- `examples/kinetic-todo/src/main.ts` — verify no references to removed items
- `examples/kinetic-todo/src/server.ts` — verify no references to removed items
- `examples/kinetic-todo/README.md` — full rewrite
- `packages/kinetic/TECHNICAL.md` L1082–1155 — Component Model section to update
- `packages/kinetic/src/types.ts` L197–202 — `ComponentFactory` type definition
- `packages/kinetic/src/compiler/integration.test.ts` L3332–3490 — existing component tests (prove the pipeline works; reference for documentation)
- `.plans/kinetic-component-demo.md` — predecessor plan, Phase 1 ✅, Phases 2–3 superseded by this plan
- `.plans/kinetic-element-scope-unification.md` — completed plan, all 4 phases ✅

## Learnings

1. **Components in Kinetic have two idiomatic flavors, not one.** Props-based components (`ComponentFactory<P>`) receive data as typed arguments. Closure-based components (`ComponentFactory` with no type parameter) capture data from the enclosing scope. Both compile identically — the compiler doesn't distinguish them. The closure pattern is particularly natural for components that need `bind()`, since bindings through props are unsupported.

2. **The README was a liability, not documentation.** It described an architecture that hasn't existed for weeks ("simulated compiled output", manual DOM construction helpers). Stale documentation is worse than no documentation — it actively misleads. The rewrite should describe what the code _does_, not what it _used to do_ or what it _aspires to do_.

3. **Dead schema fields erode trust in a showcase.** `completedCount: Shape.counter()` sitting unused in a demo implies either the app is incomplete or the developers don't clean up after themselves. Neither message belongs in a showcase. Remove it.

4. **`bind()` works inside closure-components but not through props.** `bind(doc.newTodoText)` is recognized by `isBindCall()` because the compiler sees the literal `bind(...)` call expression. If the binding were passed as a prop, the component would see `props.inputBinding` — a property access, not a `bind()` call — and the compiler would not recognize it. This is why `TodoHeader` uses closure capture: it needs `bind()`, so it closes over `doc` directly. This is an important pattern to document.

5. **`ComponentFactory<P>` union type is not callable at call sites.** `ComponentFactory` is a union of 4 function types (`(props, builder) => Element | (props) => Element | (builder) => Element | () => Element`). When a variable is annotated as this union, TypeScript can't determine which overload to invoke — `TodoHeader()` matches both `(builder) => Element` (expecting an arg) and `() => Element` (expecting nothing), and `TodoItem({...})` is ambiguous between the props and builder overloads. The fix: annotate components with their specific overload (`(props: P) => Element` or `() => Element`). The compiler's `isComponentFactoryType` checks structural call signatures (does the return type have call signatures returning `Node`?), not the `ComponentFactory` name, so the specific overload is fully equivalent for compilation. This is a TypeScript ergonomics issue, not a compiler issue — the `ComponentFactory` type is useful for documentation and conceptual framing, but not as a variable annotation.