# Plan: Decouple @kyneta/core from @loro-extended, Recouple to @kyneta/schema

## Background

`@kyneta/core` (formerly `@loro-extended/kinetic`) is a compiled delta-driven web framework that transforms natural TypeScript into code that directly consumes structured change deltas for O(k) DOM updates. It was originally built as part of the `@loro-extended` ecosystem and is tightly coupled to two packages that no longer exist in this repo:

- **`@loro-extended/reactive`** — defines the `REACTIVE` and `SNAPSHOT` symbols, the `Reactive` interface, `ReactiveDelta` types, and `LocalRef`/`state()` primitives
- **`@loro-extended/change`** — defines typed refs (`TextRef`, `CounterRef`, `ListRef`, etc.) and the `loro()` unwrapper

Neither package exists in this monorepo. Every import from them is a dead reference — `@kyneta/core` cannot compile or run tests.

Meanwhile, `@kyneta/schema` has been developed as a superior replacement. It provides:

- **`CHANGEFEED`** — a single symbol (`Symbol.for("kinetic:changefeed")`) that unifies the two-symbol `REACTIVE`+`SNAPSHOT` design into one coalgebra: `{ current: S, subscribe(cb: (change: C) => void): () => void }`
- **`Change` types** — `TextChange`, `SequenceChange`, `MapChange`, `ReplaceChange`, `TreeChange`, `IncrementChange` — the universal change vocabulary, isomorphic to the old `ReactiveDelta` but better explored and structurally richer (e.g., `SequenceChange` carries items, `MapChange` carries values and explicit deletes)
- **Interpreter algebra** — `readableInterpreter`, `withMutation`, `withChangefeed` compose to produce reactive ref trees from schema definitions, with no CRDT runtime dependency
- **`step()` functions** — pure `(State, Change) → State` transitions, enabling optimistic UI and testing without any backend

The goal is to make `@kyneta/core` depend on `@kyneta/schema` (which it already lists as a dependency but never imports) and remove all `@loro-extended/*` references. Loro becomes a future backend adapter, not a core dependency. The `@kyneta/perspective` package (state bus / Datalog solver) remains independent — core operates without state sync for now.

## Problem Statement

1. `@kyneta/core` has ~20 source files importing from `@loro-extended/reactive` and `@loro-extended/change`, neither of which exists in this repo
2. The compiler's reactive detection resolves `@loro-extended/reactive` and scans for `@loro-extended/*` imports
3. The runtime's `subscribe.ts` uses the `[REACTIVE]` symbol and `ReactiveDelta` types
4. The `types.ts` file depends on `@loro-extended/change` ref types (`TextRef`, `CounterRef`, `ListRef`, etc.)
5. The `src/loro/` subpath directly uses `loro-crdt` and `@loro-extended/change`'s `loro()` unwrapper
6. The IR's `DeltaKind` uses `"list"` where schema uses `"sequence"`, and lacks `"increment"`
7. `LocalRef`/`state()` (local reactive state) currently lives in `@loro-extended/reactive` with no replacement in schema
8. All existing documentation, comments, and import paths reference the old `@loro-extended/kinetic` package name

## Success Criteria

1. Zero imports from `@loro-extended/reactive` or `@loro-extended/change` anywhere in `packages/core`
2. `loro-crdt` removed from `peerDependencies` and `devDependencies`
3. The `src/loro/` subpath and `./loro` export removed from `package.json`
4. Runtime uses `CHANGEFEED` from `@kyneta/schema` — `hasChangefeed()` for detection, `ref[CHANGEFEED].current` for snapshots, `ref[CHANGEFEED].subscribe(cb)` for subscriptions
5. Compiler detects `[CHANGEFEED]` symbol via `isWellKnownSymbolProperty` with params `("kinetic:changefeed", "CHANGEFEED", "__@CHANGEFEED@")`
6. IR `DeltaKind` aligned to schema: `"replace" | "text" | "sequence" | "map" | "tree" | "increment"`
7. Runtime `planDeltaOps` accepts `SequenceChangeOp<T>[]` parameter type (replacing `ListDeltaOp[]`), reads `op.insert.length` as count, and uses `sequenceRef.at(index)` for ref lookup — plain values in the change ops are not consumed by the DOM runtime
8. A `LocalRef`/`state()` primitive exists in core (built on `CHANGEFEED`) for local reactive state
9. All compiler and runtime tests pass using in-memory type stubs (no external package resolution)
10. `tsc --noEmit` reports zero errors
11. TECHNICAL.md updated to reflect the new architecture
12. README.md updated to remove `@loro-extended` references

## Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Reactive symbol | `REACTIVE` + `SNAPSHOT` (two symbols from `@loro-extended/reactive`) | `CHANGEFEED` (one symbol from `@kyneta/schema`) |
| Subscribe API | `ref[REACTIVE](ref, handler)` → `ReactiveDelta` | `ref[CHANGEFEED].subscribe(handler)` → `ChangeBase` |
| Snapshot API | `ref[SNAPSHOT](ref)` | `ref[CHANGEFEED].current` |
| Detection guard | `isReactive(ref)` (requires both symbols) | `hasChangefeed(ref)` (one symbol) |
| Change vocabulary | `ReactiveDelta`: `"replace" \| "text" \| "list" \| "map" \| "tree"` | `ChangeBase`: `"replace" \| "text" \| "sequence" \| "map" \| "tree" \| "increment"` |
| Sequence insert | `{ insert: number }` (count — consumer calls `listRef.get(i)`) | `{ insert: readonly T[] }` (items carried in the change — used by `step()`; DOM runtime reads `insert.length` as count, uses ref tree via `.at(i)`) |
| List ref interface | `ListRefLike<T>` with `.get(index)` returning refs | `ListRefLike<T>` with `.at(index)` returning refs (aligns with schema's `ReadableSequenceRef` convention where `.at()` = ref, `.get()` = plain value) |
| Map change | `{ keys: string[] }` (consumer re-reads) | `{ set?: Record<string, unknown>, delete?: string[] }` (values carried) |
| IR `DeltaKind` | `"replace" \| "text" \| "list" \| "map" \| "tree"` | `"replace" \| "text" \| "sequence" \| "map" \| "tree" \| "increment"` |
| Local state | `LocalRef`/`state()` in `@loro-extended/reactive` | New `LocalRef`/`state()` in `@kyneta/core` built on `CHANGEFEED` |
| Typed ref types | `TextRef`, `CounterRef`, etc. from `@loro-extended/change` | Schema-based `Readable<S> & Writable<S>` from `@kyneta/schema`, or generic `HasChangefeed` |
| Loro bindings | `src/loro/` subpath with `loro()` unwrapper | Removed — future `@kyneta/loro` adapter package |
| Module resolution | `resolveAndAddModule("@loro-extended/reactive", ...)` | `resolveAndAddModule("@kyneta/schema", ...)` |
| Package name in docs | `@loro-extended/kinetic` | `@kyneta/core` |

## Phase 1: IR and Change Vocabulary Alignment 🟢

Align the IR's `DeltaKind` type with schema's change type discriminants. This is a pure data-level change with no runtime or compiler detection changes.

### Tasks

1. Update `DeltaKind` in `src/compiler/ir.ts` from `"replace" | "text" | "list" | "map" | "tree"` to `"replace" | "text" | "sequence" | "map" | "tree" | "increment"` 🟢

2. Update all `"list"` string literals to `"sequence"` in codegen dispatch sites (`src/compiler/codegen/dom.ts`, `src/compiler/codegen/html.ts`) 🟢 — `dom.ts` had no `"list"` delta kind literals; `html.ts` has `"list"` only as a DOM marker type (not delta kind), left as-is

3. Update the `TECHNICAL.md` delta kind table and all references from `"list"` to `"sequence"` 🟢

4. Update `regions.ts` delta dispatch from `delta.type === "list"` to `delta.type === "sequence"` (this is a string literal change only; the actual import rewiring happens in Phase 3) 🟢

5. Update all test assertions that reference `deltaKind: "list"` to `deltaKind: "sequence"` across `analyze.test.ts`, `ir.test.ts`, `template.test.ts`, `walk.test.ts`, `transform.test.ts` 🟢 — also added `"list"` → `"sequence"` mapping in `getDeltaKind` allowlist so legacy types still work

### Tests

- All existing `DeltaKind` tests pass with `"sequence"` replacing `"list"`
- Codegen tests verify `"sequence"` dispatch produces correct code

## Phase 2: Local Reactive State (`LocalRef`/`state()`) 🔴

Create a `LocalRef` implementation in `@kyneta/core` that uses `CHANGEFEED` instead of `REACTIVE`+`SNAPSHOT`. This is a prerequisite for Phases 3–4 because the runtime and compiler tests depend on having a local reactive primitive.

### Tasks

1. Create `src/reactive/local-ref.ts` with `LocalRef<T>` class and `state<T>(initial)` factory function 🔴

   Critical interface:

   ```typescript
   import { CHANGEFEED, getOrCreateChangefeed, type Changefeed, type ReplaceChange, replaceChange } from "@kyneta/schema"

   class LocalRef<T> {
     get [CHANGEFEED](): Changefeed<T, ReplaceChange<T>>  // uses getOrCreateChangefeed() for WeakMap caching
     get(): T
     set(value: T): void
   }

   function state<T>(initial: T): LocalRef<T>
   function isLocalRef(value: unknown): value is LocalRef<unknown>
   ```

   Use `getOrCreateChangefeed` from `@kyneta/schema` for the `[CHANGEFEED]` getter implementation — this provides WeakMap-based caching and referential identity (`ref[CHANGEFEED] === ref[CHANGEFEED]`) without re-implementing the pattern.

2. Create `src/reactive/index.ts` barrel that exports `LocalRef`, `state`, `isLocalRef` 🔴

3. Update `src/index.ts` to re-export from `src/reactive/index.ts` instead of `@loro-extended/reactive` 🔴

4. Remove the re-export block for `@loro-extended/reactive` from `src/index.ts` 🔴

### Tests

- `src/reactive/local-ref.test.ts`: `state(0)` creates a LocalRef; `.get()` returns initial value; `.set(v)` updates; `hasChangefeed(ref)` returns true; `ref[CHANGEFEED].current` returns live value; `ref[CHANGEFEED].subscribe(cb)` fires on `.set()` with `ReplaceChange`; unsubscribe stops notifications; multiple subscribers independent

## Phase 3: Runtime Subscription Rewiring 🔴

Replace the runtime's `REACTIVE`/`SNAPSHOT` subscription infrastructure with `CHANGEFEED` from `@kyneta/schema`.

### Tasks

1. Rewrite `src/runtime/subscribe.ts` to use `CHANGEFEED` 🔴

   - Replace `import { isReactive, REACTIVE, type ReactiveDelta } from "@loro-extended/reactive"` with `import { CHANGEFEED, hasChangefeed, type ChangeBase } from "@kyneta/schema"`
   - `subscribe(ref, handler, scope)`: validate via `hasChangefeed(ref)`, subscribe via `ref[CHANGEFEED].subscribe(handler)`, handler receives `ChangeBase` instead of `ReactiveDelta`
   - `subscribeWithValue(ref, getValue, onValue, scope)`: keep the caller-provided `getValue` closure — it evaluates the *user's expression* (e.g. `() => doc.count.get().toString()`), not just the raw ref value. `CHANGEFEED.current` returns the ref's own value, but codegen expressions may transform it. The `getValue` closure serves a different purpose than `.current`.
   - `subscribeMultiple(refs, handler, scope)`: same pattern, `ChangeBase` in wrapper

2. Rewrite `src/runtime/text-patch.ts` 🔴

   - Replace `SNAPSHOT` / `Snapshotable` / `ReactiveDelta` / `TextDeltaOp` imports with `CHANGEFEED` / `HasChangefeed` / `ChangeBase` / `TextChangeOp` from `@kyneta/schema`
   - `textRegion`: read initial via `(ref as HasChangefeed<string>)[CHANGEFEED].current`, subscribe via `subscribe(ref, ...)`, dispatch on `change.type === "text"` with `change.ops: TextChangeOp[]`
   - `inputTextRegion`: same pattern; delta provenance (`origin` field) needs to be addressed — schema's `ChangeBase` does not carry `origin`. Add an optional `origin?: string` field to `ChangeBase` in `@kyneta/schema` — this is a one-line, backward-compatible addition that aligns with the schema's open-protocol philosophy (the field is already documented as optional/undefined-safe in the old protocol). Without provenance, `inputTextRegion` would use `"preserve"` selectMode for all edits, causing incorrect cursor behavior for local typing.

3. Rewrite `src/runtime/regions.ts` 🔴

   - Replace `import type { ListDeltaOp, ReactiveDelta } from "@loro-extended/reactive"` with `import { type ChangeBase, type SequenceChange, type SequenceChangeOp } from "@kyneta/schema"`
   - Dispatch on `change.type === "sequence"` instead of `delta.type === "list"`

   **Critical design note — two-layer model (refs vs plain values):**

   Schema's `SequenceChangeOp.insert` carries `readonly T[]` where `T` is the **plain value** type — because `step()` operates on plain stores, not ref trees. But compiled `listRegion` handlers expect **refs** (with `.get()`, mutation methods, `[CHANGEFEED]`, etc.) because the user's code pattern is `for (const item of doc.items) { li(item.text) }` where `item` is a ref you can navigate into.

   The old system sidestepped this by carrying only a count in the delta, then calling `listRef.get(index)` to obtain a ref from the live ref tree. The correct design preserves this pattern:

   - **Rename `ListRefLike<T>.get()` → `.at()`** — keep `ListRefLike<T>` as a minimal core-owned interface (`{ readonly length: number; at(index: number): T | undefined }`), but rename `.get()` to `.at()` so it aligns with schema's `ReadableSequenceRef` convention where `.at()` returns refs and `.get()` returns plain values. Schema's `ReadableSequenceRef` structurally satisfies this interface without core importing it — the coupling stays at the protocol level, not the interpreter level. Test mocks remain trivial: `{ length: 3, at: (i) => items[i] }`.
   - **`planDeltaOps`**: change parameter from `ListDeltaOp[]` to `SequenceChangeOp<T>[]`, but for inserts, use `op.insert.length` as the count and call `sequenceRef.at(index)` on the live ref tree to obtain child refs — the plain values in the change are **not** passed to handlers
   - **`planInitialRender`**: update `listRef.get(i)` → `listRef.at(i)` — still iterates the sequence ref via `.length` + `.at(i)`, yielding refs
   - **`executeOp` (batch-insert path)**: update `state.listRef.get(op.index + i)` → `state.listRef.at(op.index + i)`
   - **`listRegion`**: still takes the sequence ref for both initial render and delta handling (ref lookup on insert)
   - **`ListRegionState<T>`**: still stores the sequence ref

   The change carries data (for `step()` / pure computation); the runtime uses the ref tree (for DOM). These are two different layers serving different purposes.

4. Update `src/runtime/index.ts` to remove references to `@loro-extended/kinetic` in doc comments 🔴

### Tests

- `subscribe.test.ts`: rewrite to use `LocalRef` from Phase 2 and `CHANGEFEED`; verify subscribe/unsubscribe/scope cleanup
- `text-patch.test.ts`: rewrite stubs to use `CHANGEFEED` protocol; verify `planTextPatch` (pure, unchanged), `textRegion` with changefeed-based refs, `inputTextRegion` with changefeed-based refs
- `regions.test.ts`: rewrite with `CHANGEFEED`-based mock refs using `.at()` (not `.get()`) for ref access; verify `planDeltaOps` with `SequenceChangeOp<T>[]` (uses `insert.length` + ref lookup, not plain values from change); verify `listRegion` initial render + subscription; verify `conditionalRegion` (largely unchanged)

## Phase 4: Compiler Detection Rewiring 🔴

Teach the compiler to detect `[CHANGEFEED]` instead of `[REACTIVE]`/`[SNAPSHOT]`, and extract delta kinds from the changefeed subscribe callback's change type.

### Tasks

1. Update `src/compiler/reactive-detection.ts` 🔴

   - Replace `isReactiveSymbolProperty` with `isChangefeedSymbolProperty` using params `("kinetic:changefeed", "CHANGEFEED", "__@CHANGEFEED@")`
   - Remove `isSnapshotSymbolProperty` (no longer needed — `CHANGEFEED` subsumes both)
   - Rename `isReactiveType` → `isChangefeedType` (checks for `[CHANGEFEED]` property)
   - Remove `isSnapshotableType` and `getSnapshotType` (subsumed by changefeed)
   - Rewrite `getDeltaKind`: extract change type from `Changefeed<S, C>`'s `subscribe` method's callback parameter. The `C` type has a `type` property with a string literal discriminant. The extraction path has **one more level of indirection** than the old `[REACTIVE]` path because `[CHANGEFEED]` yields an object (not a callable):

     Old (5 hops): `[REACTIVE]` property → call signature → `params[1]` (callback) → callback call signature → `params[0]` (delta `D`) → `.type` property

     New (6 hops): `[CHANGEFEED]` property → property type (`Changefeed<S, C>`) → `.subscribe` method → subscribe call signature → `params[0]` (callback `(change: C) => void`) → callback call signature → `params[0]` (change `C`) → `.type` property

   - Update the string literal allowlist in `getDeltaKind` to include `"sequence"` and `"increment"` (currently only allows `"replace" | "text" | "list" | "map" | "tree"` — without this update, `"sequence"` would silently fall back to `"replace"`, disabling list region optimizations)
   - Update `resolveReactiveImports` to resolve `@kyneta/schema` instead of `@loro-extended/reactive`, and scan for `@kyneta/*` imports instead of `@loro-extended/*`

2. Update `src/compiler/analyze.ts` 🔴

   - Rename imports: `isReactiveType` → `isChangefeedType`, `isSnapshotableType` → removed
   - `expressionIsReactive` → `expressionIsChangefeed` (or keep name, change internal check)
   - `detectImplicitRead`: check `isChangefeedType` instead of separate `isReactiveType` + `isSnapshotableType` (changefeed implies both capabilities)
   - `extractDependencies`: use `isChangefeedType` for the reactive check

3. Update `src/compiler/transform.ts` 🔴

   - Update `parseSource` to call renamed module resolution function (resolves `@kyneta/schema` instead of `@loro-extended/reactive`)
   - Update `generateDOMImports`: change `"@loro-extended/kinetic/runtime"` → `"@kyneta/core/runtime"`, remove the `loro` import line entirely (no `@loro-extended/kinetic/loro` subpath)
   - Update `mergeImports`: same import path changes for `mergeImportsForModule` calls; remove the `loro` merge entirely
   - Update `collectRequiredImports`: remove `loro` set from return type; remove binding-related collection (`bindChecked`, `bindTextValue`); keep `inputTextRegion` in `runtime` set
   - Update doc comments referencing `@loro-extended/kinetic`

4. Update `src/compiler/codegen/dom.ts` 🔴

   - Verify no direct imports from `@loro-extended/*` (there are none — codegen operates on IR)
   - The `"kinetic:if"` comment marker string in `generateConditional` is fine to keep (it's a DOM comment, not a package reference)
   - Remove `generateBinding` function and the `"binding"` case in `generateHoleSetup` — these generate `bindTextValue(...)`, `bindChecked(...)`, `bindNumericValue(...)` calls that would import from the now-removed `./loro` subpath

5. Remove binding infrastructure from IR and analysis 🔴

   - `src/compiler/ir.ts`: remove `BindingNode` interface, `ElementBinding` interface, `isBindingNode` type guard; remove `bindings` field from `ElementNode`; remove `"binding"` from `ChildNode` union; remove `"binding"` from `TemplateHoleKind`; remove `bindingType` and `refSource` from `TemplateHole`
   - `src/compiler/analyze.ts`: remove `BindingInfo` interface, remove binding detection code from `analyzeProps`, remove binding mapping in `analyzeElementCall`
   - `src/compiler/template.ts`: remove the binding case in `processEvent`
   - `src/compiler/index.ts`: remove `isBindingNode` re-export
   - `src/compiler/transform.ts`: already handled in Task 3 (remove `loro` set from `collectRequiredImports`)

### Tests

- `analyze.test.ts`: update `addBaseReactiveTypes` helper to define `CHANGEFEED` symbol and `Changefeed<S, C>` interface instead of `REACTIVE`/`SNAPSHOT`/`Reactive`; update `addLoroTypes` to define refs with `[CHANGEFEED]` instead of `[REACTIVE]`/`[SNAPSHOT]`; all detection, delta-kind, and dependency tests pass

  **Critical: narrow change types in test stubs.** Each ref type stub must declare a *specific* change type in its `Changefeed` — e.g., `[CHANGEFEED]: Changefeed<string, TextChange>` for text refs, `[CHANGEFEED]: Changefeed<T[], SequenceChange<T>>` for sequence refs, not `Changefeed<unknown, ChangeBase>`. Without narrowing, `getDeltaKind` sees `ChangeBase.type` as `string` (not a string literal), `isStringLiteral()` returns false, and delta kind silently falls back to `"replace"` — disabling all list/text region optimizations. This mirrors the existing constraint documented in TECHNICAL.md §Reactive Detection → Delta Kind Extraction: "Each typed ref must declare its specific delta type."

- `integration.test.ts`: update type stubs; test changefeed-based detection end-to-end from source → IR → codegen
- `transform.test.ts`: verify module resolution targets `@kyneta/schema`

## Phase 5: Type Definitions and Loro Subpath Removal 🔴

Remove Loro-specific types, bindings, and the `./loro` export. Make `src/types.ts` backend-agnostic.

### Tasks

1. Rewrite `src/types.ts` 🔴

   - Remove all imports from `@loro-extended/change` (`TextRef`, `CounterRef`, `ListRef`, etc.)
   - Remove `import type { Reactive } from "@loro-extended/reactive"`
   - Replace `AnyTypedRef` union with a generic `HasChangefeed` constraint from `@kyneta/schema`
   - `Binding<T>` ref type becomes `HasChangefeed` (or remove bindings entirely for now — they require a backend's write API, which is Loro-specific)
   - `Child` type: replace `Reactive<any, any>` with `HasChangefeed`

2. Remove `src/loro/` directory entirely (`binding.ts`, `binding.test.ts`, `edit-text.ts`, `edit-text.test.ts`, `index.ts`, `README.md`) 🔴

3. Clean up `src/server/render.ts` Loro type import 🔴

   - Remove `import type { LoroDoc } from "loro-crdt"` — this is the only `loro-crdt` import in the render module
   - Change `doc: LoroDoc | unknown` to `doc: unknown` in `SSRContext`, `executeRender`, `renderToString`, and `renderToDocument`
   - This is trivial but blocking — without it, `loro-crdt` cannot be removed from `peerDependencies`

4. Remove or relocate `src/server/serialize.ts` and `src/server/serialize.test.ts` 🔴

   These files have hard runtime imports from `@loro-extended/change` (`loro()` unwrapper) and `loro-crdt` (`LoroDoc` type). The entire `serializeState`/`deserializeState` implementation is Loro-specific — it calls `loroDoc.export({ mode: "snapshot" })` and `loroDoc.import(bytes)`. This cannot be made backend-agnostic by swapping types alone. Options:
   - **Remove entirely** — serialization moves to a future `@kyneta/loro` adapter package alongside the bindings
   - **Stub with a backend-agnostic interface** — define a `Serializable` interface in core, but defer the implementation (low value without a concrete backend)

   Recommendation: remove. The utility functions (`bytesToBase64`, `base64ToBytes`, `extractStateFromScript`, `extractStateFromGlobal`, `hasSerializedState`) are generic and could be preserved in a `src/server/utils.ts` if needed, but the Loro-specific serialization logic should go.

5. Update `src/server/index.ts` to remove serialization re-exports 🔴

   When `serialize.ts` is removed, the `server/index.ts` barrel's second export block (re-exporting `serializeState`, `deserializeState`, `bytesToBase64`, etc. from `"./serialize.js"`) becomes a broken import. Remove the entire "State Serialization" re-export block. The `./server` subpath remains valid — it still exports render functions.

6. Update `package.json` 🔴

   - Remove `"./loro"` from `exports`
   - Remove `"loro-crdt"` from `peerDependencies` and `devDependencies`
   - Remove `@loro-extended/change` from anywhere if listed (it is not currently, but verify)

7. Update `src/index.ts` to remove re-exports from `./loro/index.js` (`bind`, `isBinding`, `editText`) 🔴

8. Update `src/errors.ts` if any Loro-specific error codes exist (verify and clean) 🔴

### Tests

- Verify `tsc --noEmit` passes with all Loro references removed
- Existing tests that imported from `@loro-extended/change` (regions.test.ts, integration.test.ts) were already updated in Phases 3–4

## Phase 6: Documentation and Cleanup 🔴

Update all documentation, comments, and lingering references to reflect the new architecture.

### Tasks

1. Update `packages/core/README.md` 🔴

   - Replace all `@loro-extended/kinetic` references with `@kyneta/core`
   - Remove Loro-specific examples (bind, editText)
   - Update code examples to show schema-based usage
   - Remove "Bare Reactive Refs" section or update to show changefeed pattern

2. Update `packages/core/TECHNICAL.md` 🔴

   - **Reactive Detection** section: document `CHANGEFEED` symbol detection (replacing `REACTIVE`+`SNAPSHOT`)
   - **Delta Kind** section: update vocabulary to `"replace" | "text" | "sequence" | "map" | "tree" | "increment"`
   - **Runtime Dependencies** section: document `CHANGEFEED`-based subscribe, remove Loro bindings documentation
   - **Cross-Package Dependencies** section: replace dependency graph with `@kyneta/schema` → `@kyneta/core`
   - **List Region Architecture** section: document the two-layer model — `SequenceChange` carries plain values for `step()` / pure computation, but the DOM runtime uses the ref tree (`.at(i)`) for handler items. Document that `planDeltaOps` uses `op.insert.length` as the count and looks up refs from the live sequence ref, not from the change's plain values.
   - **Text Region Architecture** section: document `CHANGEFEED`-based initial value reads
   - **Delta Region Algebra** section: update delta type table. Add a new subsection **"Relationship to Schema's `step` Algebra"** that names the structural duality: *"The runtime's delta dispatch is `step` specialized to the DOM carrier. Schema provides `(State, Change) → State` for plain stores; the runtime provides the analogous `(DOMTarget, Change) → void` for each region type. Both dispatch on `change.type`, both fall back to full replacement for unrecognized change types, and both compose hierarchically via the schema tree. `step` folds a change into a plain value; the runtime folds a change into the DOM. They are the same algebra with a different carrier."* This note costs nothing but makes the pattern legible for future implementors adding `mapRegion`, `treeRegion`, or other change-type-specific region handlers.
   - **Delta Provenance** section: document the optional `origin?: string` field on `ChangeBase` (added in Phase 3); note that Loro adapter will forward `LoroEventBatch.by` to this field
   - **Loro Bindings Subpath** section: remove entirely
   - **Component Model** section: verify no Loro references

3. Grep for remaining `@loro-extended` and `kinetic` (old package name) references across all `.ts`, `.md`, and `.json` files in `packages/core` and fix 🔴

4. Update root `TECHNICAL.md` 🔴

   - Update the `@loro-extended/reactive` and `@loro-extended/change` architecture sections to note they are legacy
   - Add a section on the new `@kyneta/schema` → `@kyneta/core` architecture
   - Update the cross-package dependency graph

### Tests

- `grep -r "@loro-extended" packages/core/` returns zero results
- `grep -r "kinetic:reactive\|kinetic:snapshot" packages/core/src/` returns zero results (only `kinetic:changefeed` remains)

## Transitive Effect Analysis

### `packages/core/src/compiler/transform.ts`

This is the **primary source** of generated import path strings. `generateDOMImports` and `mergeImports` hardcode `"@loro-extended/kinetic/runtime"` and `"@loro-extended/kinetic/loro"` as module specifiers. `collectRequiredImports` returns `{ runtime: Set<string>, loro: Set<string> }` — the `loro` set and all its collection logic must be removed. `parseSource` calls `resolveReactiveImports` which resolves `@loro-extended/reactive`. All three functions are transitive coupling points — they don't import from the old packages directly, but they produce code/resolution that references them.

### `packages/core/src/compiler/codegen/dom.ts`

Codegen itself has no `@loro-extended` imports (it operates on IR). The `"kinetic:if"` and `"kinetic:start"`/`"kinetic:end"` comment markers are DOM comment strings, not package references — they can stay. However, any binding-related codegen (generating `bindTextValue(...)` calls etc.) produces code that would import from the now-removed `./loro` subpath and must be removed or stubbed.

### `packages/core/src/compiler/codegen/html.ts`

Same import-path-in-generated-code concern as `dom.ts`. HTML codegen emits server-side rendering code with import paths. Audit for hardcoded `@loro-extended/kinetic` strings.

### `packages/core/src/vite/plugin.ts` and `plugin.test.ts`

The Vite plugin calls `mergeImports` (from `transform.ts`) which handles the import paths. The plugin itself doesn't hardcode import paths, but `plugin.test.ts` asserts on generated import strings like `'@loro-extended/kinetic/runtime"'` and `'@loro-extended/kinetic"'`. These test assertions must be updated to `@kyneta/core/runtime` and `@kyneta/core`. The test also uses `@loro-extended/change` type stubs in source code strings passed to the transform — these must change to `@kyneta/schema` types.

### `packages/core/src/server/render.ts` and `render.test.ts`

`render.ts` has doc comments referencing `@loro-extended/kinetic/server` and "Loro document". The `generateMarkerId` function uses `kinetic:` prefix in DOM comment markers — these are fine (not package references). `render.test.ts` uses `kinetic:list:` and `kinetic:if:` in assertions — also fine.

### `packages/core/src/server/serialize.test.ts`

This test file imports `createTypedDoc` and `Shape` from `@loro-extended/change` to create Loro documents for serialization testing. This is a hard dependency on the old package. These tests must be rewritten to use plain JS objects as stores (matching schema's `WritableContext` pattern) or temporarily disabled.

### `packages/core/src/compiler/integration.test.ts`

This test file creates in-memory TypeScript projects with imports from `@loro-extended/change`. It adds type stubs for `TextRef`, `ListRef`, `CounterRef`, etc. These stubs must be rewritten to use `CHANGEFEED`-based types. This is the most test-heavy file in the project (~3400 lines) and touches every compiler feature. The stubs are localized in helper functions (`addLoroTypes`, `addBaseReactiveTypes`), so the blast radius is contained.

### `packages/core/tests/integration/ssr.test.ts` and `todo.test.ts`

These integration tests likely import from `@loro-extended/*`. They need the same stub/fixture treatment as the unit tests. If they depend on a running Loro instance, they will need to be either rewritten against schema-based stores or temporarily disabled.

### `packages/core/src/compiler/walk.ts` and `walk.test.ts`

Template cloning walk code. Verify no `@loro-extended` imports (expected: none — this is pure DOM traversal code).

### `packages/core/src/runtime/hydrate.ts` and `hydrate.test.ts`

Hydration code. May reference `@loro-extended/kinetic` in doc comments. Verify and update.

### `packages/core/src/runtime/scope.ts` and `scope.test.ts`

Scope management. No `@loro-extended` imports expected (scope is framework-agnostic), but doc comments may reference old package name.

### `planDeltaOps` signature change ripple

`planDeltaOps` changes from `(listRef, ListDeltaOp[])` to `(sequenceRef, SequenceChangeOp<T>[])` — the parameter type changes but the **ref lookup pattern is preserved**. The function still needs the sequence ref because insert ops require calling `sequenceRef.at(index)` to obtain child refs for handlers.

**`ListRefLike<T>` rename, not replacement:** The interface is retained as a core-owned minimal contract, but `.get()` is renamed to `.at()`:

```typescript
export interface ListRefLike<T> {
  readonly length: number
  at(index: number): T | undefined
}
```

**Why not import `ReadableSequenceRef` from schema?** `ReadableSequenceRef<T, V>` is a much heavier contract — callable, iterable, two type parameters. Core's planning functions need exactly two things: a length and a way to get a child ref by index. Importing `ReadableSequenceRef` would couple core's runtime to schema's *interpreter* layer rather than its *protocol* layer (`CHANGEFEED`, change types). Schema's `ReadableSequenceRef` structurally satisfies `ListRefLike<T>` (it has `.at()` returning `T` and `.length`), so no adapter is needed — the coupling stays structural, not nominal.

**Why `.at()` not `.get()`?** In schema's `ReadableSequenceRef`, `.get(index)` returns plain values (`V`) while `.at(index)` returns refs (`T`). The DOM runtime always operates in the ref layer, so `.at()` is the correct method. Renaming prevents a subtle semantic mismatch where core's `.get()` means "give me a ref" but schema's `.get()` means "give me a plain value."

Call sites that change: `planInitialRender` (`listRef.get(i)` → `listRef.at(i)`), `planDeltaOps` (single-insert path), and `executeOp` (batch-insert path: `state.listRef.get(op.index + i)` → `state.listRef.at(op.index + i)`). `planInitialRender` is otherwise unchanged. `ListRegionState<T>` still stores the sequence ref.

The key insight: `SequenceChangeOp.insert` carries plain values (for `step()` / pure state transitions), but the DOM runtime operates in the ref layer. The runtime reads `op.insert.length` for the count, then calls `sequenceRef.at(index)` on the live ref tree. The plain values in the change are not passed to handlers. This two-layer design is correct — changes describe data, refs describe reactive handles.

### `Binding<T>` removal ripple

Removing `Binding<T>`, `bind()`, `isBinding()`, and `editText()` affects:
- `src/types.ts` — the `Child` union includes `Binding<unknown>`; the `Binding<T>` interface references `PlainValueRef<T>` and `AnyTypedRef` from `@loro-extended/change`
- `src/index.ts` — re-exports `bind`, `isBinding`, `editText`
- `src/compiler/ir.ts` — `BindingNode` interface, `ElementBinding` interface, `isBindingNode` guard, `bindings` field on `ElementNode`, `"binding"` variant in `ChildNode` union, `"binding"` in `TemplateHoleKind`, `bindingType`/`refSource` on `TemplateHole`
- `src/compiler/analyze.ts` — `BindingInfo` interface, binding detection in `analyzeProps`, binding mapping in `analyzeElementCall`
- `src/compiler/codegen/dom.ts` — `generateBinding` function, `"binding"` case in `generateHoleSetup`
- `src/compiler/template.ts` — binding case in `processEvent`
- `src/compiler/template.test.ts` — binding hole test
- `src/compiler/transform.ts` — `loro` set in `collectRequiredImports`, `bindChecked`/`bindTextValue` collection
- `src/compiler/transform.test.ts` — binding import collection tests
- `src/compiler/index.ts` — `isBindingNode` re-export

All binding codegen paths become dead code and must be removed. The IR types (`BindingNode`, `ElementBinding`) are removed in Phase 4 Task 5. The `Binding<T>` type and runtime functions are removed in Phase 5.

### `@kyneta/schema` as sole runtime dependency

After this refactor, `@kyneta/schema` becomes the only runtime dependency (besides `js-beautify` and `ts-morph` which are compiler-only). Verify that schema's exports are sufficient — particularly that `CHANGEFEED`, `hasChangefeed`, `getOrCreateChangefeed`, `ChangeBase`, `TextChange`, `TextChangeOp`, `SequenceChange`, `SequenceChangeOp`, `MapChange`, `ReplaceChange`, `replaceChange`, `isTextChange`, `isSequenceChange` are all exported from `@kyneta/schema`.

### Schema change: `origin` on `ChangeBase`

Phase 3 requires adding an optional `origin?: string` field to `ChangeBase` in `packages/schema/src/change.ts`. This is a one-line, backward-compatible addition — all existing change constructors, type guards, and `step()` functions ignore unknown fields. The `inputTextRegion` runtime dispatches `setRangeText` selectMode based on `origin === "local"` vs everything else. Without this field, local typing in text inputs would have incorrect cursor behavior (cursor stays put instead of advancing past inserted text).

## Resources for Implementation Context

### Files to Read (core — primary modification targets)

- `packages/core/src/runtime/subscribe.ts` — subscription engine (Phase 3 rewrite target)
- `packages/core/src/runtime/text-patch.ts` — text/input patching (Phase 3 rewrite target)
- `packages/core/src/runtime/regions.ts` — list/conditional regions (Phase 3 rewrite target)
- `packages/core/src/compiler/reactive-detection.ts` — type detection (Phase 4 rewrite target)
- `packages/core/src/compiler/analyze.ts` — AST analysis (Phase 4 update target)
- `packages/core/src/compiler/ir.ts` — IR types (Phase 1 update target)
- `packages/core/src/types.ts` — core type definitions (Phase 5 rewrite target)
- `packages/core/src/index.ts` — barrel exports (Phases 2, 4, 5)
- `packages/core/src/loro/binding.ts` — Loro bindings to remove (Phase 5)
- `packages/core/src/loro/edit-text.ts` — Loro edit handler to remove (Phase 5)

### Files to Read (core — test modification targets)

- `packages/core/src/compiler/analyze.test.ts` — type stub helpers (`addBaseReactiveTypes`, `addLoroTypes`)
- `packages/core/src/compiler/integration.test.ts` — end-to-end compiler tests
- `packages/core/src/runtime/subscribe.test.ts` — subscription tests
- `packages/core/src/runtime/text-patch.test.ts` — text patching tests
- `packages/core/src/runtime/regions.test.ts` — region tests
- `packages/core/src/compiler/codegen/dom.test.ts` — codegen tests

### Files to Read (schema — reference for target APIs)

- `packages/schema/src/changefeed.ts` — `CHANGEFEED` symbol, `Changefeed` interface, `hasChangefeed`, `staticChangefeed`
- `packages/schema/src/change.ts` — all change types, type guards, constructors
- `packages/schema/src/step.ts` — pure state transitions (reference for change semantics)
- `packages/schema/src/index.ts` — full export surface (verify availability)
- `packages/schema/src/interpreters/with-changefeed.ts` — changefeed decorator pattern (reference for subscription architecture)
- `packages/schema/src/interpreters/readable.ts` — readable refs (reference for `INVALIDATE` pattern)
- `packages/schema/src/interpreters/writable.ts` — writable refs (reference for mutation methods)

### Files to Read (documentation)

- `packages/core/TECHNICAL.md` — current architecture docs (update target)
- `packages/core/README.md` — user-facing docs (update target)
- `packages/schema/TECHNICAL.md` — schema architecture (reference)
- `TECHNICAL.md` (root) — cross-package architecture (update target)

### Key Architectural Reference: Change Type Comparison

| Schema Change | Old ReactiveDelta | Structural Difference |
|---|---|---|
| `TextChange { type: "text", ops: TextChangeOp[] }` | `TextDelta { type: "text", ops: TextDeltaOp[] }` | Op types structurally identical: `retain \| insert \| delete` |
| `SequenceChange<T> { type: "sequence", ops: SequenceChangeOp<T>[] }` | `ListDelta { type: "list", ops: ListDeltaOp[] }` | **Insert carries `T[]` items** vs count (`number`). DOM runtime uses `insert.length` as count + ref tree lookup; `step()` uses the items directly. |
| `MapChange { type: "map", set?: Record, delete?: string[] }` | `MapDelta { type: "map", ops: { keys: string[] } }` | **Carries values and explicit deletes** vs key list |
| `ReplaceChange<T> { type: "replace", value: T }` | `ReplaceDelta { type: "replace" }` | **Carries new value** vs signal-only |
| `TreeChange { type: "tree", ops: TreeChangeOp[] }` | `TreeDelta { type: "tree", ops: TreeDeltaOp[] }` | Op types structurally identical |
| `IncrementChange { type: "increment", amount: number }` | *(none — mapped to "replace")* | **New kind** — compiler maps to `"replace"` behavior for now |

### Key Architectural Reference: Two-Layer Model (Refs vs Plain Values)

Schema's change types carry **plain values** — this is correct for `step()` (pure `(State, Change) → State` transitions) and for backends that operate on plain stores. But the DOM runtime operates in the **ref layer** — compiled handlers expect refs with mutation methods, `[CHANGEFEED]`, and navigation (`.at()`, property access).

For sequence regions, this means:
- `SequenceChangeOp.insert` carries `readonly T[]` (plain values for `step()`)
- The DOM runtime reads `op.insert.length` as the count, then calls `sequenceRef.at(index)` to obtain child refs from the live interpreted ref tree
- Handlers receive refs, not plain values — enabling patterns like `item.text` (ref navigation) and `item.set(...)` (mutation)

This two-layer design is intentional. Changes describe data; refs describe reactive handles. The schema layer provides both — `step()` consumes the data layer, `interpret()` produces the ref layer. The DOM runtime bridges both.

**Coupling boundary:** Core owns a minimal `ListRefLike<T>` interface (`{ readonly length: number; at(index: number): T | undefined }`) that schema's `ReadableSequenceRef` structurally satisfies. Core does not import `ReadableSequenceRef` — the coupling is structural (duck typing), not nominal (import). This keeps core dependent on schema's *protocol* (CHANGEFEED, change types) but not its *interpreter* layer (readable/writable ref shapes).

### Key Architectural Reference: Subscribe Protocol Comparison

Old (two symbols):
```
ref[SNAPSHOT](ref)           → S         (current value)
ref[REACTIVE](ref, cb)       → unsub     (subscribe to ReactiveDelta)
```

New (one symbol):
```
ref[CHANGEFEED].current      → S         (current value, live getter)
ref[CHANGEFEED].subscribe(cb) → unsub    (subscribe to ChangeBase)
```

## Alternatives Considered

### Keep `@loro-extended/reactive` as a thin shim

We considered creating a local shim that re-exports `REACTIVE`, `SNAPSHOT`, `Reactive`, `ReactiveDelta`, and `LocalRef` to minimize code changes. Rejected because:
- It preserves a protocol (`REACTIVE`+`SNAPSHOT`) that `@kyneta/schema` has already superseded with a cleaner single-symbol design
- It creates a translation layer between two isomorphic but differently-named change vocabularies
- It delays the inevitable full migration and doubles the number of reactive protocols to maintain

### Make `@kyneta/schema` export `REACTIVE`/`SNAPSHOT` aliases

We considered having schema export both `CHANGEFEED` and backward-compatible `REACTIVE`/`SNAPSHOT` symbols. Rejected because:
- Two protocols in one package creates confusion about which to use
- The two-symbol design has known ergonomic issues (functions taking `(self, ...)` pattern for prototype-level definitions) that `CHANGEFEED`'s object coalgebra solves
- Schema was designed from scratch without the two-symbol constraint

### Preserve `src/loro/` as a plugin subpath

We considered keeping the Loro bindings as an optional subpath that consumers could import if they had `loro-crdt` installed. Rejected because:
- The bindings depend on `@loro-extended/change`'s `loro()` unwrapper, which doesn't exist in this repo
- Two-way bindings require backend-specific write APIs — this should be a separate adapter package (`@kyneta/loro`) built when Loro re-integration is needed
- Keeping dead code increases maintenance burden and confuses the dependency graph

### Adapter pattern: core defines an abstract `ReactiveSource` interface

We considered having core define a backend-agnostic reactive interface and letting schema (or Loro) implement it. Rejected because:
- Schema's `CHANGEFEED` symbol + `Changefeed` coalgebra already *is* this interface
- Adding another abstraction layer between schema and core provides no value — schema's protocol is clean, minimal, and sufficient
- The symbol-based approach (duck typing via `Symbol.for`) already allows any object to participate without implementing an interface class