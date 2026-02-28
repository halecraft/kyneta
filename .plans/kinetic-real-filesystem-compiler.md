# Plan: Switch Kinetic Compiler to Real Filesystem

## Background

The Kinetic compiler uses ts-morph with `useInMemoryFileSystem: true` to parse and analyze TypeScript source files for reactive detection. Because the in-memory filesystem cannot resolve imports from `node_modules`, the compiler maintains ~290 lines of hand-written type stubs that mirror the `@loro-extended/change` Shape type hierarchy, plus ~30 lines for `@loro-extended/kinetic` and `loro-crdt`.

Through empirical testing, we discovered that switching to `useInMemoryFileSystem: false` with the file's real path resolves ALL imports automatically — `@loro-extended/change`, `@loro-extended/kinetic`, `@loro-extended/repo`, and even cross-file imports like `./schema.js`. The key insight: ts-morph's Node module resolution uses the source file's directory, so creating the file at its real path (which the Vite plugin already knows via the `id` parameter) makes `node_modules` resolution work through pnpm symlinks.

Additionally, we discovered that `loro-crdt` is unnecessary in the example: TypedDoc refs auto-commit after each mutation, making explicit `loroDoc.commit()` calls an anti-pattern. The `loroDoc` parameter can be removed from `createApp` entirely.

## Problem Statement

The in-memory filesystem approach has caused a cascade of DX compromises:

1. **290 lines of type stubs** that must be manually maintained in sync with `@loro-extended/change`
2. **Schema duplication** — `app.ts` must define the schema inline because `./schema.js` can't be resolved cross-file
3. **Fragile type machinery** — the stubs approximate `Shape<P,M,D,Pl>` generics but don't cover all cases
4. **`loroDoc` anti-pattern** — the example passes raw `LoroDoc` for `commit()`, which TypedDoc handles automatically
5. **Maintenance burden** — every `@loro-extended/change` API change requires updating stubs

## Success Criteria

1. **Delete `type-stubs.ts`** — all 289 lines, the entire file
2. **Delete inline type stubs** from `getProject()` for kinetic and loro-crdt
3. **`app.ts` imports schema from `./schema.js`** — no inline duplication
4. **`createApp` accepts only `doc`** — no `loroDoc` parameter
5. **No `loro-crdt` import in `app.ts`** — completely unnecessary
6. **All 471 kinetic tests pass** (some tests will need updating)
7. **All 9 example tests pass**
8. **SSR still works** via `vite.ssrLoadModule`

## The Gap

| Current | Target |
|---------|--------|
| `useInMemoryFileSystem: true` | `useInMemoryFileSystem: false` |
| 289-line `type-stubs.ts` | Deleted |
| 30 lines of inline kinetic/loro-crdt stubs | Deleted |
| `parseSource(source, "input.ts")` (virtual path) | `parseSource(source, realFilePath)` (real path) |
| `app.ts` duplicates schema inline | `app.ts` imports from `./schema.js` |
| `createApp(doc, loroDoc)` | `createApp(doc)` |
| `import { LoroDoc } from "loro-crdt"` in app.ts | Removed |
| `loroDoc.commit()` in helpers | Removed (auto-commit) |

## Phases and Tasks

### Phase 1: Switch Compiler to Real Filesystem ✅

- ✅ **Task 1.1**: Modify `getProject()` in `transform.ts`
  - Change `useInMemoryFileSystem: true` to `useInMemoryFileSystem: false`
  - Use `moduleResolution: 100` (Bundler) for pnpm symlink compatibility
  - Remove all `createSourceFile` calls for type stubs (change, kinetic, loro-crdt)
  - Remove the `LORO_CHANGE_TYPE_STUBS` import

- ✅ **Task 1.2**: Modify `parseSource()` in `transform.ts`
  - Accept the real file path from the caller (the Vite plugin's `id` parameter)
  - Use the real path when calling `project.createSourceFile(realPath, source, { overwrite: true })`
  - The `overwrite: true` option is critical — with real FS, ts-morph may auto-discover the file from disk, causing a conflict on `createSourceFile`
  - This enables ts-morph to resolve `node_modules` and relative imports from the correct directory

- ✅ **Task 1.3**: Update `transformSourceInPlace()` signature
  - The `filename` option already exists in `TransformOptions`
  - Ensure the Vite plugin passes the full absolute path (it already does via `id`)
  - `transformSource()` (standalone) continues to work with a default filename for tests

- ✅ **Task 1.4**: Update `hasBuilderCalls()` to use a stable virtual path
  - Existing cleanup logic works — `check.ts` is created and removed within the same call
  - With real FS, `createSourceFile` with `overwrite: true` handles any conflicts

- ✅ **Task 1.5**: Delete `type-stubs.ts`
  - Remove the entire file
  - Remove the import from `transform.ts`
  - Remove from `compiler/index.ts` if exported

### Phase 2: Clean Up Example — Remove loroDoc Anti-Pattern ✅

- ✅ **Task 2.1**: Refactor `app.ts` — remove loroDoc and inline schema
  - Change `createApp(doc: AppDoc, loroDoc: LoroDoc)` to `createApp(doc)`
  - The `doc` parameter type: `ReturnType<typeof createTypedDoc<typeof TodoSchema>>`
  - Import `TodoSchema` from `./schema.js` (cross-file import now works)
  - Remove `import type { LoroDoc, LoroText } from "loro-crdt"`
  - Remove all `loroDoc.commit()` calls (TypedDoc auto-commits)
  - Remove the `loro()` call for clearing text input — use `doc.newTodoText.delete(0, ...)` directly
  - Delete the inline `_schema` / `AppDoc` type definitions

- ✅ **Task 2.2**: Update `server.ts` — remove loroDoc from createApp call
  - Change `createApp(doc, loroDoc)` to `createApp(doc)`
  - Keep `sync(doc).loroDoc` only where needed for `generateStateScript` / `deserializeState`

- ✅ **Task 2.3**: Update `main.ts` — remove loroDoc from createApp call
  - Change `createApp(doc, loroDoc)` to `createApp(doc)`
  - Remove `loroDoc.commit()` from the seed logic (auto-commit handles it)
  - Keep `syncRef.loroDoc` only for `deserializeState`

### Phase 3: Update Tests ✅

- ✅ **Task 3.1**: Update `transform.test.ts` type stub injection tests
  - The "type stub injection" describe block tests that imports from `@loro-extended/change` resolve
  - These tests pass source strings with `import { ListRef } from "@loro-extended/change"`
  - With real FS, these imports resolve natively — the tests should still pass but the test descriptions should be updated to reflect "real filesystem resolution" instead of "type stub injection"

- ✅ **Task 3.2**: Update `transform.test.ts` zero-ceremony tests
  - These tests verify `createTypedDoc(Schema)` resolves reactive types
  - Should continue passing with real FS (types come from real `.d.ts` files)
  - Update descriptions if they reference type stubs

- ✅ **Task 3.3**: Address test files that use virtual paths
  - Tests that call `transformSource(source)` without a filename default to `"input.ts"`
  - With real FS, this resolves relative to the project root — `node_modules` is accessible
  - Verify these tests still pass; if not, adjust the default path

- ✅ **Task 3.4**: Verify SSR end-to-end
  - Start the kinetic-todo dev server
  - Confirm `GET /` returns SSR HTML with hydration markers and reactive regions
  - Confirm the client script tag is included

## Tests

Existing test suites should pass with minimal changes. The high-risk areas:

1. **`transform.test.ts` "type stub injection" tests** — these explicitly test that imports from `@loro-extended/change` produce reactive types. They should continue to pass because the real FS resolves the same types, but test names/descriptions may need updating.

2. **`transform.test.ts` standalone `transformSource()` tests** — these use default filename `"input.ts"`. With real FS, the file is created at a path that may or may not have access to `node_modules`. If these fail, the fix is to use a path under the monorepo root.

3. **`vite/plugin.test.ts`** — these call the plugin's transform function with source strings. The plugin passes `id` (file path) to `transformSourceInPlace`. These should work since the test passes real-looking paths.

4. **Integration test** — start the server, curl `GET /`, verify SSR output includes `__listRegion`-generated list items and hydration markers.

## Transitive Effect Analysis

| Change | Direct Impact | Transitive Impact |
|--------|---------------|-------------------|
| `useInMemoryFileSystem: false` | ts-morph uses real FS | All module resolution changes from stubs to real `.d.ts` files |
| Delete `type-stubs.ts` | No stubs loaded | Tests that relied on stub-specific type text may see different type strings (e.g. full import paths vs short names) |
| Real file paths in `parseSource` | Correct `node_modules` resolution | Cross-file imports work; test files at virtual paths may not resolve |
| Remove `loroDoc` param from `createApp` | `server.ts` and `main.ts` must update call sites | No cascading — these are the only callers |
| Remove `loro-crdt` from `app.ts` | One fewer dependency in the builder code | `package.json` still needs `loro-crdt` (it's a peer dep of `@loro-extended/change`) |

**Risk Assessment**:
- **Phase 1** has **medium risk** — the compiler is core infrastructure; changing filesystem mode affects all transforms. However, the change is well-understood from empirical testing and the existing test suite provides strong regression coverage.
- **Phase 2** has **low risk** — example-only changes with no dependents.
- **Phase 3** has **low risk** — test description updates, not logic changes.

## Resources for Implementation

1. **`packages/kinetic/src/compiler/transform.ts`** — `getProject()`, `parseSource()`, `transformSourceInPlace()`, `hasBuilderCalls()`
2. **`packages/kinetic/src/compiler/type-stubs.ts`** — to be deleted
3. **`packages/kinetic/src/vite/plugin.ts`** — passes `id` (file path) to `transformKineticSource()`
4. **`packages/kinetic/src/compiler/transform.test.ts`** — type stub and zero-ceremony test sections
5. **`examples/kinetic-todo/src/app.ts`** — remove inline schema, loroDoc param
6. **`examples/kinetic-todo/src/main.ts`** — remove loroDoc usage
7. **`examples/kinetic-todo/src/server.ts`** — remove loroDoc from createApp call
8. **`packages/change/src/typed-refs/base.ts`** — documents `commitIfAuto()` behavior (confirms auto-commit)

## Changeset

A patch changeset for `@loro-extended/kinetic` is appropriate. The type stubs were internal but the compiler behavior change (real FS resolution) is meaningful for any downstream tooling.

## README Updates

Update `packages/kinetic/README.md`:
- Remove any references to type stubs or manual type declarations
- The "How It Works" section should mention that the compiler resolves types from the real filesystem

## TECHNICAL.md Updates

Update `.plans/kinetic-delta-driven-ui.md` and `.plans/kinetic-todo-real-example.md` Learnings sections:

### Real Filesystem Replaces Type Stubs

**Previous approach**: The compiler used `useInMemoryFileSystem: true` with 289 lines of hand-written type stubs that approximated the `@loro-extended/change` Shape type hierarchy. This required manual maintenance, couldn't resolve cross-file imports, and forced schema duplication in `app.ts`.

**New approach**: The compiler uses `useInMemoryFileSystem: false` with `moduleResolution: Bundler`. The Vite plugin passes the file's real absolute path (from the `id` parameter), enabling ts-morph to resolve `node_modules` and relative imports naturally. No stubs needed.

**Key requirement**: The source file must be created at its real path in the ts-morph Project. ts-morph's module resolution walks up from the file's directory to find `node_modules`. If the file is created at a virtual path like `"input.ts"`, resolution fails.

**Performance**: Project creation is ~0.2ms (vs 539ms with `tsConfigFilePath`). Per-file parse+resolve is ~57ms on first access, with subsequent accesses benefiting from ts-morph's caching.

### TypedDoc Auto-Commit Eliminates loroDoc Parameter

TypedDoc refs call `commitIfAuto()` after each mutation (`push`, `delete`, `insert`, `set`, `increment`, etc.). There is no need to pass a raw `LoroDoc` and call `commit()` manually. The only exception is `change(doc, draft => { ... })` blocks, which batch mutations and commit at the end.

This means `createApp(doc)` needs only the typed document — no `loroDoc` parameter, no `loro-crdt` import.

### Learnings to Remove/Update

The following learnings in `kinetic-todo-real-example.md` are now obsolete and should be removed or rewritten:
- "Explicit Type Annotation Required for Reactive Detection" — no longer needed
- "Type Stubs Needed for All Import Sources" — eliminated
- "Type Resolution in ts-morph In-Memory Filesystem" — replaced by real FS approach
- "Type Stub Maintenance" — no longer applies