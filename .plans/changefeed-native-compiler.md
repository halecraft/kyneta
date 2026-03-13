# Plan: Changefeed-Native Compiler & SSR Integration Tests

## Background

`@kyneta/core` was decoupled from `@loro-extended/change` in Phases 1–5 of the core-schema-decoupling plan. The runtime now consumes the `CHANGEFEED` protocol from `@kyneta/schema`. However, the decoupling left behind several inconsistencies:

1. **The compiler still speaks a legacy API dialect.** `detectDirectRead` recognizes `.get()` and `.toString()` — methods from the old `@loro-extended/change` ref shape. Schema-interpreted refs are callable functions (`ref()` → value) with no `.get()` method. The implicit-read synthesizer emits `ref.get()` into generated browser code, which crashes against schema refs.

2. **Mock refs and type stubs diverge from schema.** The integration test infrastructure (`createMockTextRef`, `createMockCounterRef`, `createMockSequenceRef`, `CHANGEFEED_TYPE_STUBS`) implements a `.get()`/`.toString()`/`.toArray()`/`.entries()` API surface that doesn't exist on schema-interpreted refs. Counter stubs declare `HasChangefeed<number, ReplaceChange<number>>` but schema counters emit `IncrementChange`.

3. **`subscribeWithValue` is conceptually a region but named as a subscription primitive.** `textRegion`, `listRegion`, `conditionalRegion` are all "regions" — functions that wire a Changefeed to a DOM target within a scope. `subscribeWithValue` does the same thing (wire a Changefeed to text content or an attribute) but has a different naming convention. The single-dep and multi-dep paths are split across `subscribeWithValue` and `subscribeMultiple` + manual init, hiding their shared structure.

4. **No SSR integration tests against real schema refs.** The deleted `ssr.test.ts` and `todo.test.ts` were Loro-specific. Nobody tests that `@kyneta/schema`'s interpreter stack works end-to-end with core's runtime.

### The Changefeed as Universal Adapter

The `Changefeed<S, C>` is a Moore machine — the universal adapter that any reactive backend implements:

- `current: S` — pull: observe the head state
- `subscribe(cb: (change: C) => void): () => void` — push: observe the delta stream

The **runtime** speaks only this protocol. `textRegion` reads `ref[CHANGEFEED].current` and subscribes. `listRegion` subscribes and dispatches on `isSequenceChange`. The runtime is already backend-agnostic.

The **compiler** should also speak only this protocol. The question "should this expression get surgical delta support?" reduces to: **is this expression itself a Changefeed?** If yes, dispatch on delta kind. If no (the user transformed the value), fall back to re-read semantics. No method-name heuristics, no `.get()` synthesis.

### Delta Kind ↔ DOM Region Correspondence

Analysis of the change type algebra against DOM mutation surfaces reveals that `TextChange` and `SequenceChange` are the two change types with **unique canonical DOM correspondences** where the cursor-based `retain/insert/delete` algebra is isomorphic to the DOM mutation API:

| Change Type | DOM Target | Planning Function | Isomorphism |
|---|---|---|---|
| `TextChange` | `Text.insertData/deleteData` | `planTextPatch` | Cursor ops ↔ offset ops over characters |
| `SequenceChange` | `parent.insertBefore/removeChild` | `planDeltaOps` | Cursor ops ↔ index ops over child nodes |

Other change types either degrade to replace (`IncrementChange` — the DOM has no Number node; positional numeral systems don't preserve locality under addition), have multiple valid DOM targets (`MapChange` → style map, attribute map, dataset, class-as-boolean-map), or are deferred (`TreeChange`). `ReplaceChange` is the terminal object — every other change type can be degraded into it.

This means the runtime's current architecture — `textRegion` + `listRegion` as surgical regions, plus a universal re-read fallback — is well-motivated. The compiler's job is to identify which expressions ARE Changefeeds and dispatch on their delta kind.

## Problem Statement

1. The compiler synthesizes `.get()` calls into generated browser code. Schema refs don't have `.get()`. **Compiled code crashes against schema-interpreted documents.**
2. `detectDirectRead` is a method-name heuristic (`.get()`, `.toString()`) that should be a type-level question: "is this expression a Changefeed?"
3. Mock refs and type stubs implement a phantom API that doesn't exist on the actual schema refs (`.get()`, `.toString()`, `.toArray()`, `.entries()`, `.value`, `ReplaceChange` for counters).
4. `subscribeWithValue` / `subscribeMultiple` + manual init are the same concept (re-read region) split across two calling conventions. The naming doesn't reflect that they're regions like `textRegion` and `listRegion`.
5. No test exercises the full path: schema definition → interpret → server render → hydrate → mutate → verify reactive DOM update.

## Success Criteria

1. The compiler emits `read(ref)` for synthesized value reads — no `.get()` synthesis.
2. The surgical delta dispatch question is reduced to a single type-level check: "is this expression itself a Changefeed?" If yes, dispatch on delta kind. If the user extracts a value (`ref()`, `ref.get()`, or any transformation), the result is NOT a Changefeed and gets replace semantics. This is explicit and predictable — no AST heuristics.
3. `subscribeWithValue` and `subscribeMultiple` + manual init are unified into `valueRegion(refs, getValue, onValue, scope)`.
4. Mock refs match schema ref shapes (callable, correct change types, no phantom methods).
5. Type stubs match schema's actual `Readable<S> & Writable<S>` types.
6. A schema-driven integration test validates each region type against real interpreted refs.
7. All 110 existing integration tests continue to pass.

## Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Compiler read synthesis | Synthesizes `ref.get()` | Synthesizes `read(ref)` via runtime helper |
| Surgical delta dispatch | `detectDirectRead` heuristic (`.get()`, `.toString()`) + `detectImplicitRead` | Single question: `isChangefeedType(expr.getType())` — if yes, dispatch on delta kind; if no, replace semantics |
| `detectDirectRead` | Five-step AST heuristic | Eliminated — the user controls the boundary by passing a Changefeed (surgical) vs. extracting a value (replace) |
| Region naming | `textRegion`, `listRegion`, `conditionalRegion`, `subscribeWithValue` | All named as regions: + `valueRegion` |
| Single vs multi dep | Separate code paths (`subscribeWithValue` vs `subscribeMultiple`) | Unified `valueRegion(refs[], getValue, onValue, scope)` |
| Counter delta kind | Stubs declare `ReplaceChange<number>`; mocks emit `replaceChange(count)` | Stubs declare `IncrementChange`; mocks emit `incrementChange(n)`. Note: `getDeltaKind` in `reactive-detection.ts` and the `DeltaKind` type in `ir.ts` already handle `"increment"` correctly — the gap is entirely in the test infrastructure (mocks + stubs), not the compiler/runtime. |
| Mock ref shape | Plain objects with `.get()`, `.toString()` | Callable functions matching schema's `ReadableSequenceRef` etc. |
| Schema → Core runtime | Untested | Integration tests with `interpret()` refs |
| SSR full cycle | Deleted (was Loro-specific) | Server render → hydrate → live updates with schema refs |

## Phase 1: `valueRegion` — Unified Fallback Region 🟢

Unify `subscribeWithValue` and the `subscribeMultiple` + manual-init pattern into a single `valueRegion` that accepts an array of refs.

### Tasks

1. Create `valueRegion` in `src/runtime/subscribe.ts` 🟢

   ```ts
   function valueRegion<T>(
     refs: unknown[],
     getValue: () => T,
     onValue: (value: T) => void,
     scope: Scope,
   ): void
   ```

   Implementation: call `onValue(getValue())` for initial render, then `subscribe(ref, () => onValue(getValue()), scope)` for each ref in `refs`. This collapses single-dep and multi-dep into one path.

2. Deprecate `subscribeWithValue` 🟢

   Mark as `@deprecated` with reference to `valueRegion`. Keep for backward compatibility during migration. `subscribeWithValue(ref, gv, ov, scope)` becomes `valueRegion([ref], gv, ov, scope)`.

   **`subscribeMultiple` disposition:** If Phase 2 replaces all three codegen emission sites (text content, attribute subscriptions, hole setup) with `valueRegion`, then also deprecate `subscribeMultiple`. If any codegen site retains it, keep it as a low-level primitive. Decide during Phase 2 implementation.

3. Export `valueRegion` and `read` from runtime barrel and testing barrel 🟢

   Also update `textRegion` and `inputTextRegion` to use `read()` internally for their `readValue` closures, replacing the inline `(ref as HasChangefeed<string>)[CHANGEFEED].current` cast pattern. This gives `read()` consistent internal usage and keeps the cast centralized.

4. Add `valueRegion` tests 🟢

   - Single ref: initial value + update on change.
   - Multiple refs: fires on any ref's change, re-evaluates getValue.
   - Scope disposal stops updates.
   - Empty refs array: initial value only, no subscriptions.

### Tests

Tests in `src/runtime/subscribe.test.ts`, extending the existing `subscribeWithValue` describe block.

## Phase 2: Changefeed-Native Compiler Analysis 🟢

Eliminate `detectDirectRead` entirely. Replace with a single type-level question: "is this expression itself a Changefeed?" Make codegen emit `valueRegion` and `read()`.

### Design Principle

The user controls the boundary between surgical deltas and replace semantics:

| User writes | Expression type | Compiler emits | Semantics |
|---|---|---|---|
| `doc.title` | `TextRef` (has `[CHANGEFEED]`) | `textRegion(node, doc.title, scope)` | Surgical O(k) |
| `doc.title()` | `string` | `valueRegion(...)` | Replace O(n) |
| `doc.title.get()` | `string` | `valueRegion(...)` | Replace O(n) |
| `doc.title.get().toUpperCase()` | `string` | `valueRegion(...)` | Replace O(n) |
| `doc.items` | `SequenceRef` (has `[CHANGEFEED]`) | `listRegion(...)` | Surgical O(k) |
| `doc.count` | `CounterRef` (has `[CHANGEFEED]`) | `valueRegion(...)` | Replace (no surgical counter region) |

This is **explicit and predictable** — pass the Changefeed itself for delta support, or extract a value for replace. No heuristics, no method-name recognition, no peeking into expressions.

### Tasks

1. Introduce `read()` runtime helper 🟢

   In `src/runtime/subscribe.ts`:
   ```ts
   function read<T = unknown>(ref: HasChangefeed<T>): T {
     return ref[CHANGEFEED].current
   }
   ```

   This is the universal read — a tiny function the compiler can reference in generated code without embedding `[CHANGEFEED].current` syntax (which would require importing the symbol). Exported from runtime barrel.

2. Eliminate `detectDirectRead` 🟢

   Remove `detectDirectRead` from `analyze.ts` entirely. The five-step AST heuristic (check if root is `CallExpression`, callee is `PropertyAccessExpression`, method is `get` or `toString`, zero args, receiver is reactive) is replaced by the type-level check in `analyzeExpression`.

   **Why this is correct:** `detectDirectRead` tried to infer "is this expression just reading a Changefeed's value?" from the expression's AST shape. But the user should control this boundary explicitly. `doc.title` in content position IS a Changefeed → surgical. `doc.title.get()` returns `string` → replace. The user can predict reliably that passing a Changefeed gets delta support, while extracting a value falls back to replace.

   **Impact on `LocalRef`:** Users who write `ref.get()` with a `LocalRef` today get `textRegion` via `detectDirectRead`. After removal, `ref.get()` returns `string` → `valueRegion` (replace). But `LocalRef` emits `ReplaceChange`, so `textRegion`'s surgical path was never invoked anyway — it always hit the fallback `textNode.textContent = readValue()`. There is no performance regression.

3. Simplify `analyzeExpression` to use single Changefeed check 🟢

   The current flow is:
   ```
   expressionIsReactive(expr) → detectDirectRead(expr) → detectImplicitRead(expr)
   ```

   The new flow:
   ```
   expressionIsReactive(expr) → isChangefeedType(expr.getType()) ?
     yes → directReadSource = expr.getText(), source = read(expr.getText())
     no  → source = expr.getText() (user's expression as-is)
   ```

   When the expression IS a Changefeed (`isChangefeedType` true):
   - Set `directReadSource` to the expression's source text (e.g., `"doc.title"`)
   - Synthesize `read(doc.title)` as `node.source` (the `getValue` closure content)
   - Codegen dispatch checks `directReadSource && deps.length === 1 && deltaKind === "text"` → `textRegion`
   - Other delta kinds with `directReadSource` → `valueRegion` with `read()` getter

   When the expression is NOT a Changefeed but depends on one(s):
   - `directReadSource` is NOT set
   - `node.source` is the user's expression verbatim (e.g., `"doc.title.get().toUpperCase()"`)
   - Codegen emits `valueRegion([...deps], () => userExpr, setter, scope)`

   `detectImplicitRead` is subsumed by this logic. `detectDirectRead` is removed entirely.

4. Update codegen to emit `valueRegion` 🟢

   Today there are two codegen paths — **createElement** and **template cloning** — with different attribute subscription patterns:

   | Path | Single-dep text content | Single-dep attribute | Multi-dep attribute |
   |------|------------------------|---------------------|-------------------|
   | **createElement** | `subscribeWithValue` (init + subscribe) | `generateAttributeSet` sets initial value, then `subscribe` in `generateAttributeSubscription` | `generateAttributeSet` sets initial value, then `subscribeMultiple` in `generateAttributeSubscription` |
   | **Template cloning** | `subscribeWithValue` via `generateReactiveContentSubscription` | `subscribe` only (initial value is placeholder `attr=""` from template — **latent gap**: no explicit init for single-dep) | Manual init + `subscribeMultiple` in `generateHoleSetup` |

   After this task, both paths emit `valueRegion`, which always calls `onValue(getValue())` for initialization and then subscribes — collapsing the init/subscribe split and fixing the cloning-path single-dep gap.

   **Code shape change:** Today's attribute subscription fuses the expression and DOM write in one callback: `subscribe(dep, () => { el.className = expr }, scope)`. Under `valueRegion`, the generated code splits into a getter and a setter: `valueRegion([dep], () => expr, (v) => { el.className = v }, scope)`. The setter is derived from `generateAttributeUpdateCode` with the value parameterized. Tests asserting on generated code strings must be updated to match this new shape.

   In `codegen/dom.ts`, `generateReactiveContentSubscription`:
   - `isTextRegionContent` path: unchanged (emits `textRegion`).
   - All other paths: emit `valueRegion([...deps], () => expr, setter, scope)`.
   - No more `if (deps.length === 1) ... else ...` branch.

   In `generateAttributeSubscription`:
   - `isInputTextRegionAttribute` path: unchanged (emits `inputTextRegion`).
   - All other paths: emit `valueRegion([...deps], () => expr, (v) => { updateCode(v) }, scope)`, where `updateCode` is derived from `generateAttributeUpdateCode` with the value as a parameter instead of the inline expression. This replaces the current split between `subscribe` (single-dep) and `subscribeMultiple` (multi-dep).

   In `generateAttributeSet`:
   - Add early return for reactive attributes (`attr.value.bindingTime === "reactive"`) when `valueRegion` will handle the initial value. Keep `generateAttributeSet` for literal and render-time attributes — it still serves those cases. Today `generateAttributeSet` already bails for `inputTextRegion` attributes; this extends the same pattern to all reactive attributes.

   In `generateHoleSetup` (template cloning path):
   - `"text"` holes: unchanged — delegates to `generateReactiveContentSubscription` which now emits `valueRegion`.
   - `"attribute"` holes: replace the inline single-dep `subscribe` / multi-dep `subscribeMultiple` with `valueRegion`, using the same getter/setter shape as `generateAttributeSubscription`. This fixes the latent gap where single-dep cloning-path attributes had no explicit initial-value set.

5. Update `collectRequiredImports` 🟢

   `collectRequiredImports` (in `transform.ts`, not `ir.ts`) walks the IR structurally — it does NOT scan generated source strings. It checks node kinds, binding times, dependency counts, and predicates like `isTextRegionContent` / `isInputTextRegionAttribute` to decide which runtime functions to import.

   Current detection logic:
   - Any reactive builder → unconditionally adds `subscribe` + `subscribeWithValue`
   - `isTextRegionContent(child)` → adds `textRegion`
   - `isInputTextRegionAttribute(attr)` → adds `inputTextRegion`
   - Reactive content or attribute with `deps.length > 1` → adds `subscribeMultiple`
   - Reactive loop → adds `listRegion`
   - Reactive conditional → adds `conditionalRegion`

   Required changes:
   - Reactive builder → add `valueRegion` (replacing `subscribeWithValue`). Keep `subscribe` for attribute subscriptions only if any codegen path still emits bare `subscribe` — but since `valueRegion` replaces all attribute subscription paths too, `subscribe` can be dropped from the blanket add. It is still needed for `textRegion` and `listRegion` internals, but those are runtime-internal imports, not codegen-emitted calls.
   - Add `read` when any content node has `directReadSource` set (the node's `source` will contain a `read()` call).
   - Remove `subscribeMultiple` detection — `valueRegion` replaces all three emission sites: (a) multi-dep text content, (b) multi-dep attribute subscriptions in createElement path, (c) multi-dep attribute holes in template cloning path.
   - Keep `textRegion`, `inputTextRegion`, `listRegion`, `conditionalRegion` detection unchanged.

6. Update `analyzeForOfStatement` to strip `.entries()` 🔴 (deferred — not blocking; schema refs use `[Symbol.iterator]` directly)

   When the iterable expression is `ref.entries()` and the ref is reactive, capture `iterableSource` as the base ref (stripping `.entries()`), preserving the index variable from the destructuring pattern. This prevents passing an iterator object to `listRegion`.

### Tests

- Update `src/compiler/analyze.test.ts`: remove `detectDirectRead` tests; add tests verifying that bare Changefeed expressions (e.g., `doc.title`) set `directReadSource` and synthesize `read()`; verify that `doc.title.get()` does NOT set `directReadSource` (returns `string`, not a Changefeed); verify that `doc.title()` does NOT set `directReadSource` (returns `string`).
- Update `src/compiler/codegen/dom.test.ts`: verify `valueRegion` emission instead of `subscribeWithValue`/`subscribeMultiple`.
- Update `src/compiler/transform.test.ts`: update source strings and expected outputs.

## Phase 3: Align Mock Refs and Type Stubs 🟢

Make the test infrastructure match schema's actual ref shapes.

### Tasks

1. Rewrite `createMockTextRef` — remove `.get()` and `.toString()` 🟢

   The ref should be an arrow function (`ref()` → string) with `.insert()`, `.delete()` mutation methods and `[CHANGEFEED]` attached via `Object.defineProperty` (non-enumerable), matching schema's `readableInterpreter` + `withMutation` + `withChangefeed` output. Remove `.get()` and `.toString()`.

2. Rewrite `createMockCounterRef` — emit `IncrementChange`, remove `.get()` and `.value` 🟢

   `ref()` → number. `.increment(n)` emits `IncrementChange` (not `ReplaceChange`). Remove `.get()` and `.value`.

3. Rewrite `createMockSequenceRef` — keep `.get(index)` (legitimate schema method) 🟢

   `ref()` → `T[]`. `.at(i)` returns child refs (callable functions), not raw items. `[Symbol.iterator]` yields child refs. Remove `.get()`, `.toArray()`, `.entries()`, `.set()`.

4. Rewrite `createMockPlainRef` — unchanged (`.get()`/`.set()` are its native API) 🟢

   `ref()` → `T`. `.set(value)` emits `ReplaceChange`. Remove `.get()`.

5. Update `CHANGEFEED_TYPE_STUBS` 🟢

   - `TextRef`: add call signature `(): string`, remove `.get()`, `.toString()`, add `[Symbol.toPrimitive]`.
   - `CounterRef`: add call signature `(): number`, change to `HasChangefeed<number, IncrementChange>`, remove `.get()`, `.value`.
   - `ListRef<T>`: add call signature `(): T[]`, remove `.get()`, `.toArray()`, `.entries()`, `.set()`. **Note:** schema's `ReadableSequenceRef` legitimately has `.get(index: number)` as a convenience method (shortcut for `.at(i)?()`), but core's `ListRefLike<T>` contract requires only `length` + `at(index)` + `[CHANGEFEED]`. The stubs should reflect core's contract boundary, not schema's full surface — encoding schema-specific convenience methods in core's type stubs reintroduces the coupling the decoupling work eliminated. The same principle applies to `.toArray()` and `.entries()`: they may exist on schema refs, but core doesn't consume them.
   - `StructRef<T>`: add call signature, remove `.get(key)`, add lazy property getters in doc comment.

6. Update duplicate stubs in `transform.test.ts` and `analyze.test.ts` 🟢

   **Note:** These three copies have diverged structurally. `helpers.ts` uses an exported string constant with typed ops. `transform.test.ts` uses a local string constant with `unknown[]` ops and includes `TypedDoc`. `analyze.test.ts` uses a fundamentally different mechanism — real `.d.ts` files added to a ts-morph project via `createSourceFile()`, with separate `addBaseChangefeedTypes()` and `addSchemaTypes()` helpers. Each must be updated according to its own mechanism. Consider whether the `analyze.test.ts` approach (real `.d.ts` files through the type checker) should become the canonical pattern and the string-constant approach phased out.

7. Update all test source strings 🟢

   Replace `ref.get()` with `ref()` or `read(ref)` throughout test source strings in `reactive.test.ts`, `conditional.test.ts`, `combined.test.ts`, `text.test.ts`, `list.test.ts`, `statements.test.ts`, `components.test.ts`. Replace `ref.toString()` with template literal coercion or `read(ref)`. Replace `.toArray()` with `ref()` (callable snapshot).

8. Verify all 888 tests pass 🟢

### Tests

No new test files — this phase updates existing tests to use the aligned shapes. The verification is that all existing tests pass with the new mocks and stubs.

## Phase 4: Schema-Driven Integration Tests 🟢

A single focused test file that validates core's runtime against schema-interpreted documents.

### Tasks

1. Create `src/compiler/integration/schema-ssr.test.ts` 🔴 (deferred)

   Shared fixture using the canonical `createChangefeedChatDoc` pattern from `packages/schema/src/__tests__/with-changefeed.test.ts`:

   ```ts
   const schema = LoroSchema.doc({
     title: LoroSchema.text(),
     count: LoroSchema.counter(),
     items: Schema.list(Schema.struct({
       text: LoroSchema.text(),
       done: LoroSchema.plain.boolean(),
     })),
   })

   function createDoc(seed?: Record<string, unknown>) {
     const store = { ...Zero.structural(schema), ...seed }
     const wCtx = createWritableContext(store)
     const cfCtx = createChangefeedContext(wCtx)
     const enriched = enrich(withMutation(readableInterpreter), withChangefeed)
     const doc = interpret(schema, enriched, cfCtx)
     return { doc, store, cfCtx }
   }
   ```

   Schema refs are callable (`doc.title()` → string), have `[CHANGEFEED]` (non-enumerable), and mutation methods (`.insert()`, `.increment()`, `.push()`). No `.get()`.

2. Test: `textRegion` with schema text ref 🔴 (deferred)

   Wire `textRegion(textNode, doc.title, scope)`, call `doc.title.insert(5, " World")`, verify `textNode.textContent` updates surgically via `insertData` (not full replacement).

3. Test: `valueRegion` with schema counter ref 🔴 (deferred)

   Wire `valueRegion([doc.count], () => read(doc.count), (v) => { textNode.textContent = String(v) }, scope)`, call `doc.count.increment(1)`, verify text content updates. Also verify `doc.count.increment()` emits `IncrementChange` (type `"increment"`), not `ReplaceChange`.

4. Test: `listRegion` with schema sequence ref 🔴 (deferred)

   Wire `listRegion(container, doc.items, { create: (item) => { ... }, ... }, scope)`, call `doc.items.push({ text: "new", done: false })`. Verify DOM updates. Validates `ListRefLike<T>` structural satisfaction by schema's `ReadableSequenceRef` (callable, `.at()`, `.length`, non-enumerable `[CHANGEFEED]`). Verify child refs from `.at()` are themselves callable with `[CHANGEFEED]`.

5. Test: `conditionalRegion` with schema counter ref 🔴 (deferred)

   Wire `conditionalRegion(marker, doc.count, () => read(doc.count) > 0, { whenTrue, whenFalse }, scope)`, increment counter, verify branch swap.

6. Test: SSR render → hydrate → live update cycle 🔴 (deferred)

   Server-side: call `renderList`/`renderConditional` with data read from interpreted refs (`doc.title()`, `[...doc.items].map(...)`) to produce HTML with hydration markers. Client-side: parse HTML into JSDOM, call `hydrate()`, attach `textRegion`/`listRegion` subscriptions, mutate the document, verify the hydrated DOM updates reactively.

7. Test: O(k) list verification with schema sequence ref 🔴 (deferred)

   Use `createCountingContainer` + schema sequence ref with 10 items, insert 1 via `.push()`, assert `insertBefore === 1`.

8. Test: Scope disposal stops schema ref subscriptions 🔴 (deferred)

   Subscribe via `textRegion` and `listRegion`, dispose scope, mutate refs, verify no DOM change and `getActiveSubscriptionCount() === 0`.

### Tests

All tests in `src/compiler/integration/schema-ssr.test.ts`. Uses:
- `LoroSchema`, `Schema`, `interpret`, `enrich`, `readableInterpreter`, `withMutation`, `createWritableContext`, `withChangefeed`, `createChangefeedContext`, `Zero`, `CHANGEFEED` from `@kyneta/schema`
- `subscribe`, `textRegion`, `listRegion`, `conditionalRegion`, `valueRegion`, `read` from the runtime
- `hydrate`, `adoptNode`, `adoptTextNode` from hydration
- `renderList`, `renderConditional`, `escapeHtml`, `generateMarkerId`, `openMarker`, `closeMarker` from server render
- `Scope`, `resetScopeIdCounter`, `activeSubscriptions`, `getActiveSubscriptionCount`, `resetSubscriptionIdCounter`, `createCountingContainer`, `assertMaxMutations` from testing helpers
- `installDOMGlobals`, `dom`, `resetTestState` from `./helpers.js`

## Phase 5: Documentation Updates 🟢

### Tasks

1. Update `TECHNICAL.md` — Direct-Read Detection section 🟢

   Replace the `detectDirectRead` / `detectImplicitRead` documentation with the Changefeed-expression-check model. Document `read()` helper. Remove `.get()` / `.toString()` method-name tables.

2. Update `TECHNICAL.md` — Delta Region Algebra section 🟢

   Add `valueRegion` to the region table. Document the unified naming: all Changefeed → DOM wiring functions are "regions." Document the `read()` helper as the universal value accessor.

3. Update `TECHNICAL.md` — Reactive Detection section 🟢

   Document that the compiler is Changefeed-native: the question is "is this expression a Changefeed?" not "does this expression call .get()?". Document the `read()` synthesis for implicit reads.

4. Create changeset 🔴

   `@kyneta/core` minor: `valueRegion` public API addition, `read()` public API addition, `subscribeWithValue` deprecated.

## Transitive Effect Analysis

### `detectDirectRead` elimination → codegen dispatch

`detectDirectRead` populated `ContentValue.directReadSource`. The codegen checks `isTextRegionContent(node)` which requires `directReadSource && deps.length === 1 && deltaKind === "text"`. The replacement — a type-level `isChangefeedType` check in `analyzeExpression` — populates the same `directReadSource` field when the expression IS a Changefeed. Codegen is unaffected; the change is confined to `analyze.ts`.

**Behavioral change:** `doc.title.get()` previously triggered `textRegion` (via `detectDirectRead`). Now it triggers `valueRegion` (because the expression returns `string`, not a Changefeed). This is **intentionally correct** — `LocalRef`'s `ReplaceChange` never invoked `textRegion`'s surgical path anyway (always hit the `else` fallback). For schema text refs, the user writes bare `doc.title` to get surgical support. The boundary is explicit and predictable.

### `.get()` synthesis removal → generated code shape

Today, bare `doc.title` in content position with `deltaKind === "text"` generates `textRegion(_text0, doc.title, scope)` (via `detectDirectRead` → `detectImplicitRead`). After Phase 2, the same expression generates the same `textRegion(_text0, doc.title, scope)` — but via the simpler `isChangefeedType` check. No behavioral change for the `textRegion` path.

For non-text Changefeeds (e.g., bare `doc.count`), today generates `subscribeWithValue(doc.count, () => doc.count.get(), ...)`. After Phase 2, generates `valueRegion([doc.count], () => read(doc.count), ...)`. The `read` function is a new runtime import. The `collectRequiredImports` function in `ir.ts` must be updated to detect `read(` in generated source and add the import.

### Mock ref shape change → existing test assertions

Existing tests assert on generated code strings containing `.get()` (e.g., `expect(result.code).toContain("count.get()")`). Phase 3 must update all such assertions to the new patterns (`read(count)`, `count()`, etc.). This is the largest mechanical change. Note that `ref.get()` remains a valid user-written pattern (for `LocalRef`) — it just produces a `string`/`number` return type and gets `valueRegion` (replace semantics), not `textRegion`. What changes is: (a) the compiler no longer *synthesizes* `.get()`, (b) `detectDirectRead` is removed so `.get()` no longer triggers `textRegion`, and (c) the type stubs no longer *declare* `.get()` on Changefeed refs.

### `valueRegion` replaces `subscribeWithValue` in generated code → import collection

`collectRequiredImports` (in `transform.ts`) walks the IR structurally to decide runtime imports. Today it unconditionally adds `subscribe` + `subscribeWithValue` for any reactive builder. After Phase 2, it should add `valueRegion` instead. Since `valueRegion` replaces all three `subscribeMultiple` emission sites (multi-dep text content, multi-dep attribute subscriptions in createElement path, multi-dep attribute holes in template cloning path), `subscribeMultiple` detection can also be removed. The blanket `subscribe` add can be dropped too — no codegen path will emit bare `subscribe()` calls after `valueRegion` replaces attribute subscriptions. (`subscribe` is still called internally by `textRegion`, `listRegion`, etc., but those are runtime-internal, not codegen-emitted.)

### Counter `IncrementChange` → conditional region behavior

`conditionalRegion` ignores the change type and re-evaluates `getCondition()`. Changing counter's emitted change from `ReplaceChange` to `IncrementChange` has no effect on conditional regions. However, if any code path in tests asserts on the change type received from a counter subscription, those assertions must be updated from `"replace"` to `"increment"`.

**Research note:** The runtime and compiler infrastructure already handle `"increment"` correctly. `getDeltaKind` in `reactive-detection.ts` (L388–393) has an explicit check for `value === "increment"` and returns it as a valid `DeltaKind`. The `DeltaKind` type in `ir.ts` includes `"increment"`. The gap is entirely in the **test infrastructure**: `createMockCounterRef` in `helpers.ts` calls `replaceChange(count)` instead of `incrementChange(n)`, and all three copies of `CHANGEFEED_TYPE_STUBS` declare `CounterRef extends HasChangefeed<number, ReplaceChange<number>>` despite `IncrementChange` being declared but unreferenced. The test `"should produce deltaKind 'replace' for CounterRef"` in `transform.test.ts` (≈L1507) will need to assert `"increment"` after Phase 3 corrects the stubs.

### `ListRefLike<T>` structural satisfaction

Schema's `ReadableSequenceRef` has `at(index: number): T | undefined` and `readonly length: number`. It also has extra capabilities (callable, `[Symbol.iterator]`, `.get()`). `ListRefLike<T>` is a structural interface — extra properties are fine. The mock sequence ref must also match this: `.at()` must return child refs, not raw items.

### Non-enumerable `[CHANGEFEED]` on schema refs

`withChangefeed` attaches `[CHANGEFEED]` via `Object.defineProperty` with `enumerable: false`. Core's `hasChangefeed()` uses `CHANGEFEED in obj` which finds non-enumerable properties. The `read()` helper accesses `ref[CHANGEFEED].current` — also unaffected by enumerability. No issue.

### Schema text changes lack `origin` field

Schema's `textChange()` constructor doesn't set `origin`. Core's `inputTextRegion` checks `change.origin === "local"` for cursor management, falling back to `"preserve"` when `origin` is `undefined`. This is correct behavior (unknown origin → preserve cursor). The SSR integration tests in Phase 4 use `textRegion` (not `inputTextRegion`), so this doesn't affect them.

### `hydrateConditionalRegion` subscription handler is a no-op stub

The hydration module's `hydrateConditionalRegion` subscribes but its handler does nothing — hydration only sets up initial state, not live updates. Phase 4 Task 6 (SSR full cycle) must account for this by manually attaching `textRegion`/`listRegion`/`conditionalRegion` to hydrated DOM nodes after hydration, rather than relying on hydration alone.

### Schema package must be built before core tests run

Core imports `@kyneta/schema` via its `exports` field pointing to `./dist/index.js`. The schema package has no `dist/` until `npx tsup` runs. CI and local test runs must build schema first.

## Resources for Implementation Context

### Core — compiler (Phase 2 targets)
- `packages/core/src/compiler/analyze.ts` — `detectDirectRead`, `detectImplicitRead`, `analyzeExpression`, `expressionIsReactive`, `extractDependencies`, `analyzeForOfStatement`
- `packages/core/src/compiler/reactive-detection.ts` — `isChangefeedType`, `getDeltaKind`, `isChangefeedSymbolProperty`
- `packages/core/src/compiler/ir.ts` — `ContentValue`, `isTextRegionContent`, `isInputTextRegionAttribute`, `collectRequiredImports`
- `packages/core/src/compiler/codegen/dom.ts` — `generateReactiveContentSubscription`, `generateAttributeSubscription`, `generateAttributeSet`, `generateReactiveLoopBody`

### Core — runtime (Phase 1 targets)
- `packages/core/src/runtime/subscribe.ts` — `subscribe`, `subscribeWithValue`, `subscribeMultiple`
- `packages/core/src/runtime/text-patch.ts` — `textRegion`, `inputTextRegion`
- `packages/core/src/runtime/regions.ts` — `listRegion`, `conditionalRegion`, `ListRefLike`
- `packages/core/src/runtime/hydrate.ts` — `hydrate`, `hydrateListRegion`, `hydrateConditionalRegion`
- `packages/core/src/server/render.ts` — `renderList`, `renderConditional`, `renderToString`

### Core — test infrastructure (Phase 3 targets)
- `packages/core/src/compiler/integration/helpers.ts` — `CHANGEFEED_TYPE_STUBS`, `createMockTextRef`, `createMockCounterRef`, `createMockSequenceRef`, `createMockPlainRef`, `createMockDoc`
- `packages/core/src/compiler/transform.test.ts` — duplicate type stubs
- `packages/core/src/compiler/analyze.test.ts` — duplicate type stubs

### Schema — reference implementations
- `packages/schema/src/__tests__/with-changefeed.test.ts` — canonical `createChangefeedChatDoc` pattern
- `packages/schema/src/interpreters/readable.ts` — `readableInterpreter`, `ReadableSequenceRef` shape (callable, `.at()`, `.length`, `[Symbol.iterator]`, `[INVALIDATE]`)
- `packages/schema/src/interpreters/writable.ts` — `withMutation`, mutation method shapes (`TextRef.insert`, `CounterRef.increment` dispatching `incrementChange`, `SequenceRef.push` dispatching `sequenceChange`)
- `packages/schema/src/interpreters/with-changefeed.ts` — `withChangefeed` attaching `[CHANGEFEED]` non-enumerably via `Object.defineProperty`
- `packages/schema/src/changefeed.ts` — `CHANGEFEED`, `Changefeed<S, C>`, `HasChangefeed`, `hasChangefeed`
- `packages/schema/src/change.ts` — `IncrementChange`, `incrementChange()` constructor, `TextChange`, `SequenceChange`

### Core — TECHNICAL.md sections to update
- `Reactive Detection` (L492–L671) — `detectDirectRead`, `detectImplicitRead`, dependency extraction
- `Delta Region Algebra` (L1475–L1538) — region pattern table
- `Runtime Dependencies` (L777–L1133) — subscription, text region, list region architecture

## Alternatives Considered

### Add `.get()` to all schema refs instead of changing the compiler

Rejected. `.get()` is a redundant method — schema refs are callable functions where `ref()` IS the read. Adding `.get()` would increase the API surface for no algebraic reason, and schema's callable-ref design is the more principled representation (a ref IS an observation thunk). The compiler should converge toward the schema, not the other way around. Note: `LocalRef` retains `.get()` as its native read API, but calling it produces a plain value (not a Changefeed), so it gets replace semantics — which is correct since `LocalRef` emits `ReplaceChange`.

### Keep `subscribeWithValue` and `subscribeMultiple` as separate functions

Rejected. They implement the same concept — "when any of these Changefeeds fire, re-evaluate an expression and apply the result." The single/multi distinction is an implementation detail (how many `subscribe` calls to make), not a semantic difference. `valueRegion(refs[], getValue, onValue, scope)` unifies both with `refs.length >= 1`. The naming also hides that `subscribeWithValue` is conceptually a region like `textRegion` and `listRegion`.

### Use `ref[CHANGEFEED].current` directly in generated code instead of `read()` helper

Considered. This would avoid adding a new runtime function. However, it requires the generated code to import `CHANGEFEED` (a symbol from `@kyneta/schema`) — adding a cross-package import to every compiled component. The `read()` helper is a thin indirection that keeps the generated code simple and the protocol symbol internal to the runtime.

### Introduce a `styleRegion` for `MapChange` → CSS style properties

Deferred. Analysis shows `MapChange` has multiple natural DOM targets (style map, attribute map, dataset, class-as-boolean-map), and the compiler currently destructures props into individual attribute bindings. A `styleRegion` is a valid future optimization but not a missing structural piece today. The per-attribute `valueRegion` pattern is correct and sufficient.

### Extend `detectDirectRead` to recognize `ref()` callable pattern (instead of eliminating it)

Rejected. `detectDirectRead` is an AST heuristic that tries to infer "is this expression just reading a Changefeed's value?" from the method name (`.get()`, `.toString()`). Extending it to also recognize `ref()` would add another heuristic. The cleaner design is to eliminate the heuristic entirely: the user controls the boundary by passing a Changefeed (surgical deltas) vs. extracting a value (replace). `doc.title` in content position IS a Changefeed → `textRegion`. `doc.title.get()` or `doc.title()` returns a string → `valueRegion`. This is explicit and predictable. No AST pattern matching on method names, no "peeking into" what the user wrote.

**On the `doc.title.get()` → `textRegion` regression:** Today, `doc.title.get()` triggers `textRegion` via `detectDirectRead`. After elimination, it gets `valueRegion` (replace). This is correct: (a) for `LocalRef`, `textRegion`'s surgical path was never invoked anyway (`LocalRef` emits `ReplaceChange`, which hits the `else` fallback), so there's no performance regression; (b) for schema text refs, the user writes bare `doc.title` to get surgical support — this is the intended pattern.