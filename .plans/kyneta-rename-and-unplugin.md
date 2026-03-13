# Plan: Kyneta Rename & Universal Plugin (unplugin)

## Background

The web framework currently named "Kinetic" throughout the codebase is being renamed to **Kyneta** to align with the `@kyneta/core` package name that was adopted during the Loro decoupling. The old "Kinetic" name persists in ~832 locations across source code, tests, documentation, runtime identifiers (Symbol keys, DOM markers), error types, plugin names, and historical plan documents.

Separately, the framework's compiler transform is currently locked to Vite via a bespoke Vite plugin at `packages/core/src/vite/plugin.ts`. We discovered that [unplugin](https://unplugin.unjs.io/) provides a universal plugin system supporting **Vite, Bun, Rollup, Rolldown, esbuild, webpack, Rspack, and Farm** — all from a single plugin definition. The Kyneta compiler's core transform (`transformSourceInPlace`, `hasBuilderCalls`, `mergeImports`) is already host-agnostic; only a thin ~30-line Vite-specific wrapper exists.

This changes the framework's target: rather than being Vite-only, `@kyneta/core` can support any bundler a developer chooses. Starting with **Vite**, **Bun**, and **Farm** as our initial integration targets.

### Key Finding: `enforce: "pre"` Works Everywhere (For Different Reasons)

The Kyneta compiler must run **before** TypeScript type-stripping because it inspects types to detect reactive refs via the `CHANGEFEED` protocol. This was previously achieved via Vite's `enforce: "pre"`.

| Bundler | Why it works |
|---|---|
| **Vite** | `enforce: "pre"` is native — unplugin passes it through directly |
| **Farm** | unplugin maps `enforce: "pre"` → `priority: 102` (above Farm's internal plugins at 100) |
| **Bun** | `enforce` is ignored, but Bun's `onLoad` intercepts raw file contents before Bun's parser strips types — the compiler sees full TypeScript |

### Key Finding: SSR Target Is Vite-Specific

Vite passes `transformOptions.ssr` to the `transform` hook; unplugin's unified API strips this away. Bun and Farm have no equivalent concept. The solution: accept an explicit `target` option in the plugin config, with Vite-specific detection as a fallback via unplugin's `vite:` escape hatch.

### Prior Art

The existing Vite plugin (`packages/core/src/vite/plugin.ts`) is the reference implementation. Its core logic is a ~30-line function `transformKineticSource` that calls three compiler functions:

1. `hasBuilderCalls(code)` — fast regex pre-scan, skip files without builder patterns
2. `transformSourceInPlace(code, { filename, target })` — parse → analyze → codegen via ts-morph
3. `mergeImports(result.sourceFile, result.requiredImports)` — inject `@kyneta/core/runtime` imports

These are already exported from `@kyneta/core/compiler`. The Vite wrapper adds file filtering (`shouldTransform`), SSR target detection, debug logging, HMR support, and error handling.

## Problem Statement

1. The framework is named "Kyneta" but the codebase says "Kinetic" in ~832 places, including runtime wire-format identifiers that affect cross-version compatibility.
2. The compiler plugin is Vite-only. Developers using Bun, Farm, Rolldown, or other bundlers cannot use the framework.
3. No integration tests validate that the compiler transform actually works end-to-end through any real bundler — the existing tests mock the plugin host.

## Success Criteria

1. Zero remaining "Kinetic"/"kinetic" references in source code, runtime identifiers, public API types, error messages, and documentation (excluding `.plans/` historical records)
2. A new `unplugin`-based plugin exported from `@kyneta/core` that works across Vite, Bun, and Farm
3. Integration tests for each target bundler that compile a real builder pattern through the actual plugin pipeline and verify correct output
4. The existing Vite plugin remains as a thin re-export from the unplugin adapter for backward compatibility
5. SSR target selection works via explicit option (all bundlers) and via Vite's `ssr` flag detection (Vite only)

## The Gap

| What exists | What's missing |
|---|---|
| `@kyneta/core/vite` — Vite-only plugin | No Bun, Farm, or universal plugin |
| `transformSourceInPlace` et al. — host-agnostic compiler | No unplugin wrapper |
| Vite plugin tests — mock the host | No real bundler integration tests |
| "Kinetic" name in ~832 locations | No "Kyneta" name anywhere in code |
| `Symbol.for("kinetic:changefeed")` — runtime protocol key | Needs rename to `"kyneta:changefeed"` |
| DOM markers `kinetic:list:N`, `kinetic:if:N`, etc. | Need rename to `kyneta:*` |

## Phases

### Phase 1: Rename — Runtime Identifiers ✅

These are wire-format-breaking changes that must happen atomically across `@kyneta/schema` and `@kyneta/core`.

- **Task 1.1**: Rename `Symbol.for("kinetic:changefeed")` → `Symbol.for("kyneta:changefeed")` in `packages/schema/src/changefeed.ts` ✅
- **Task 1.2**: Update compiler's symbol detection string `"kinetic:changefeed"` → `"kyneta:changefeed"` in `packages/core/src/compiler/reactive-detection.ts` ✅
- **Task 1.3**: Rename all DOM comment marker prefixes from `kinetic:` → `kyneta:` across SSR codegen, html-constants, hydration regex, and regions ✅
  - `packages/core/src/server/render.ts` — marker generation
  - `packages/core/src/compiler/codegen/html.ts` — SSR codegen markers
  - `packages/core/src/compiler/codegen/dom.ts` — DOM codegen markers
  - `packages/core/src/compiler/html-constants.ts` — shared marker templates
  - `packages/core/src/runtime/hydrate.ts` — `MARKER_REGEX` pattern
  - `packages/core/src/runtime/regions.ts` — slot markers (`kyneta:start`, `kyneta:end`, `kyneta:item`)
- **Task 1.4**: Update all test assertions that match on marker strings or Symbol keys ✅
  - `packages/schema/src/__tests__/interpret.test.ts`
  - `packages/schema/src/__tests__/with-changefeed.test.ts`
  - `packages/core/src/server/render.test.ts`
  - `packages/core/src/runtime/hydrate.test.ts`
  - `packages/core/src/compiler/template.test.ts`
  - `packages/core/src/compiler/transform.test.ts`
  - `packages/core/src/compiler/codegen/html.test.ts`
  - `packages/core/src/compiler/codegen/dom.test.ts`
  - `packages/core/src/compiler/integration/*.test.ts`
- **Task 1.5**: Run full test suites for both `packages/schema` and `packages/core` ✅

### Phase 2: Rename — Public API & Source Code ✅

These affect TypeScript API surface. The old names get deprecated re-exports.

- **Task 2.1**: Rename `KineticError` → `KynetaError`, `KineticErrorCode` → `KynetaErrorCode` in `packages/core/src/errors.ts`; add deprecated re-exports for the old names ✅
- **Task 2.2**: Rename `KineticPluginOptions` → `KynetaPluginOptions`, `kineticPlugin` → `kynetaPlugin` in `packages/core/src/vite/plugin.ts`; add deprecated re-exports ✅
- **Task 2.3**: Rename internal function `transformKineticSource` → `transformKynetaSource` in `packages/core/src/vite/plugin.ts` ✅
- **Task 2.4**: Update all console log prefixes from `[kinetic]` → `[kyneta]` ✅
- **Task 2.5**: Update error message strings: `"Kinetic code must run..."` → `"Kyneta code must run..."`, `"Kinetic Compiler Error:"` → `"Kyneta Compiler Error:"` ✅
- **Task 2.6**: Update all `@loro-extended/kinetic` import paths in JSDoc examples → `@kyneta/core` ✅
- **Task 2.7**: Update `packages/core/src/index.ts` re-exports to use new names (with deprecated aliases) ✅
- **Task 2.8**: Update all test files that reference renamed identifiers ✅
- **Task 2.9**: Run full test suite ✅

### Phase 3: Rename — Documentation ✅

- **Task 3.1**: Rename all "Kinetic" → "Kyneta" in `packages/core/README.md` ✅
- **Task 3.2**: Rename all "Kinetic" → "Kyneta" in `packages/core/TECHNICAL.md` ✅
- **Task 3.3**: Rename all "Kinetic" → "Kyneta" in `packages/core/LEARNINGS.md` ✅
- **Task 3.4**: Rename in `packages/schema/TECHNICAL.md` ✅
- **Task 3.5**: Rename in all JSDoc comments and module-level docstrings across `packages/core/src/` ✅
- **Task 3.6**: Replace root `TECHNICAL.md` (currently stale `loro-extended` content) with a monorepo overview for the Kyneta project 🔴 (no root TECHNICAL.md exists; deferred to separate task)

Plan documents in `.plans/` and `packages/core/.plans/` are historical records and will NOT be renamed. They reflect the state of the world at the time they were written.

### Phase 4: unplugin — Core Plugin 🔴

- **Task 4.1**: Add `unplugin` as a dependency of `@kyneta/core` 🔴
- **Task 4.2**: Create `packages/core/src/unplugin/index.ts` — the universal plugin factory 🔴
- **Task 4.3**: Create `packages/core/src/unplugin/transform.ts` — extract the host-agnostic transform logic from the Vite plugin into a shared module 🔴
- **Task 4.4**: Create `packages/core/src/unplugin/filter.ts` — extract `shouldTransform` into a shared module 🔴
- **Task 4.5**: Rewrite `packages/core/src/vite/plugin.ts` as a thin re-export from the unplugin adapter 🔴
- **Task 4.6**: Add subpath exports to `packages/core/package.json` 🔴

The unplugin factory:

```typescript
// packages/core/src/unplugin/index.ts
import type { UnpluginFactory } from "unplugin"
import { createUnplugin } from "unplugin"

export interface KynetaPluginOptions {
  /** File extensions to transform. Default: [".ts", ".tsx"] */
  extensions?: string[]
  /** Patterns to include (substring match). */
  include?: string | string[]
  /** Patterns to exclude. Default: ["node_modules"] */
  exclude?: string | string[]
  /** Compile target. Default: "dom". Vite auto-detects "html" for SSR. */
  target?: "dom" | "html"
  /** Enable debug logging. Default: false */
  debug?: boolean
}

export const unpluginFactory: UnpluginFactory<KynetaPluginOptions | undefined>
export const unplugin: ReturnType<typeof createUnplugin>

// Bundler-specific exports
export const vitePlugin:    typeof unplugin.vite
export const bunPlugin:     typeof unplugin.bun
export const farmPlugin:    typeof unplugin.farm
export const rollupPlugin:  typeof unplugin.rollup
export const rolldownPlugin: typeof unplugin.rolldown
export const esbuildPlugin: typeof unplugin.esbuild
```

The factory uses `enforce: "pre"` (works on Vite and Farm via unplugin; Bun doesn't need it since `onLoad` intercepts raw source). SSR detection uses the explicit `target` option, with a Vite-specific fallback:

```typescript
// Inside the factory
return {
  name: "kyneta",
  enforce: "pre",

  transform: {
    filter: { id: /\.tsx?$/ },
    handler(code, id) {
      if (!shouldTransform(id, extensions, include, exclude)) return null
      // Default target from options; Vite override happens in vite: escape hatch
      return transformKynetaSource(code, id, resolvedTarget, debug)
    },
  },

  // Vite-specific: capture per-request SSR flag
  vite: {
    transform(code, id, transformOptions) {
      if (!shouldTransform(id, extensions, include, exclude)) return null
      const target = options?.target ?? (transformOptions?.ssr ? "html" : "dom")
      return transformKynetaSource(code, id, target, debug)
    },
    handleHotUpdate(ctx) { /* HMR support — Vite only */ },
  },
}
```

New subpath exports in `package.json`:

```json
{
  "exports": {
    "./unplugin":       { "types": "...", "import": "..." },
    "./unplugin/vite":  { "types": "...", "import": "..." },
    "./unplugin/bun":   { "types": "...", "import": "..." },
    "./unplugin/farm":  { "types": "...", "import": "..." },
    "./vite":           "..."
  }
}
```

The `./vite` export remains for backward compatibility, re-exporting from `./unplugin/vite`.

### Phase 5: unplugin — Integration Tests 🔴

Each integration test validates the full pipeline: source code with builder patterns → plugin transform → verify compiled output contains the expected runtime calls (`listRegion`, `textRegion`, `conditionalRegion`, etc.) and does NOT contain raw builder calls.

- **Task 5.1**: Create `packages/core/src/unplugin/__tests__/vite.test.ts` — integration test using unplugin's Vite adapter 🔴
- **Task 5.2**: Create `packages/core/src/unplugin/__tests__/bun.test.ts` — integration test using unplugin's Bun adapter via `Bun.build()` 🔴
- **Task 5.3**: Create `packages/core/src/unplugin/__tests__/farm.test.ts` — integration test using unplugin's Farm adapter 🔴
- **Task 5.4**: Create shared test fixture: a `.ts` file with builder patterns, a `.ts` file without (control), and expected output assertions 🔴
- **Task 5.5**: Run full test suite 🔴

Test shape for each target:

```typescript
// Shared fixture
const BUILDER_SOURCE = `
  /// <reference types="@kyneta/core/types/elements" />
  div(() => { h1("Hello") })
`

// Per-target test
it("transforms builder patterns through <target> plugin", async () => {
  // Use the target's build API with the kyneta plugin
  const result = await buildWith<Target>(BUILDER_SOURCE, kynetaPlugin())
  expect(result.code).toContain("document.createElement")
  expect(result.code).not.toContain("div(() =>")
})

it("skips files without builder patterns", async () => {
  const result = await buildWith<Target>("const x = 1", kynetaPlugin())
  expect(result.code).toContain("const x = 1")
})
```

The Bun test requires `bun` to be available; it can be skipped in CI environments without Bun via a conditional `describe.skipIf`. Similarly, Farm requires `@farmfe/core` as a devDependency.

### Phase 6: Cleanup & Verification 🔴

- **Task 6.1**: Grep entire codebase for remaining `kinetic` references (case-insensitive) outside `.plans/` and `node_modules/` — should be zero 🔴
- **Task 6.2**: Verify `@kyneta/core/vite` backward-compat export works (import the old path, get a working plugin) 🔴
- **Task 6.3**: Run full test suites for `packages/schema` and `packages/core` 🔴
- **Task 6.4**: Build both packages (`tsup`) and verify exports resolve 🔴

## Transitive Effect Analysis

| Change | Direct impact | Transitive impact |
|---|---|---|
| `Symbol.for("kinetic:changefeed")` → `"kyneta:changefeed"` | `@kyneta/schema` changefeed.ts | `@kyneta/core` compiler's `reactive-detection.ts` hardcodes the string for type-level Symbol.for tracing. All integration test type stubs that use `Symbol.for("kinetic:changefeed")` must update. Any external consumer using the old symbol key will silently fail to detect changefeeds. |
| DOM markers `kinetic:*` → `kyneta:*` | SSR codegen, hydration, regions | **Server-rendered HTML from old code will not hydrate with new code** (the hydration regex won't match). This is acceptable for a pre-1.0 prototype. Test assertions on marker strings (~40 locations) must update in lockstep. |
| `KineticError` → `KynetaError` | `errors.ts`, `index.ts` re-exports | Every `catch (e) { if (e instanceof KineticError) }` breaks without the deprecated re-export. Tests that assert `error.name === "KineticError"` must update. The deprecated re-export (`export { KynetaError as KineticError }`) provides a migration path. |
| New `unplugin` dependency | `package.json` | `unplugin` is a small package (~50KB) with zero runtime deps. Increases install size minimally. Must be a `dependency` (not devDependency) since it's needed by consumers. |
| New subpath exports (`./unplugin`, `./unplugin/vite`, etc.) | `package.json` exports map | Consumers using the old `@kyneta/core/vite` import are unaffected (it re-exports from unplugin). New consumers can choose their target. TypeScript must resolve the new subpaths — verify with `moduleResolution: "bundler"`. |
| Rewriting Vite plugin as re-export | `packages/core/src/vite/plugin.ts` | Existing Vite plugin tests must continue passing — they should import from `./vite/plugin.js` which now re-exports from `./unplugin/index.js`. The Vite-specific `handleHotUpdate` hook moves into the unplugin factory's `vite:` escape hatch. |
| Bun integration test needs `bun` binary | CI environment | Use `describe.skipIf(!hasBun)` to skip gracefully. Same pattern for Farm (`@farmfe/core` devDep). |
| `@farmfe/core` as devDependency for Farm tests | `package.json` devDeps | Farm's JS plugin API is stable. Only needed for tests, not shipped to consumers. |

## Resources for Implementation Context

**Phase 1 (Runtime identifiers):**
- `packages/schema/src/changefeed.ts` — `CHANGEFEED` symbol definition
- `packages/core/src/compiler/reactive-detection.ts` L212 — hardcoded `"kinetic:changefeed"` string
- `packages/core/src/compiler/html-constants.ts` — marker template strings
- `packages/core/src/runtime/hydrate.ts` L105 — `MARKER_REGEX`
- `packages/core/src/runtime/regions.ts` L109–138, 414–415 — slot markers

**Phase 2 (Public API):**
- `packages/core/src/errors.ts` — `KineticError`, `KineticErrorCode`
- `packages/core/src/vite/plugin.ts` — `KineticPluginOptions`, `kineticPlugin`, console prefixes
- `packages/core/src/index.ts` — barrel re-exports
- `packages/core/src/compiler/analyze.ts` L906 — error message string
- `packages/core/src/runtime/scope.ts` L232 — error message string

**Phase 4 (unplugin):**
- `packages/core/src/vite/plugin.ts` — reference implementation to decompose
- `packages/core/src/compiler/transform.ts` — `transformSourceInPlace`, `hasBuilderCalls`, `mergeImports` signatures
- `packages/core/src/compiler/index.ts` — compiler subpath exports
- unplugin docs: https://unplugin.unjs.io/guide/ — API, hook matrix, bundler-specific escape hatches
- `packages/core/package.json` — current exports map

**Phase 5 (Integration tests):**
- `packages/core/src/vite/plugin.test.ts` — existing Vite plugin test patterns
- `packages/core/src/compiler/integration/helpers.ts` — `CHANGEFEED_TYPE_STUBS`, `COMPONENT_PREAMBLE`
- unplugin Bun adapter: `onLoad`-based transform chain
- Bun build API: https://bun.sh/docs/bundler/plugins
- Farm plugin API: https://farm-fe.github.io/docs/plugins/official-plugins/overview

## File Inventory

New files:
```
packages/core/src/unplugin/
  index.ts              — unplugin factory + all bundler exports
  transform.ts          — host-agnostic transform logic (extracted from vite/plugin.ts)
  filter.ts             — shouldTransform file filtering (extracted from vite/plugin.ts)
  __tests__/
    fixture.ts          — shared builder pattern test source
    vite.test.ts        — Vite integration test
    bun.test.ts         — Bun integration test
    farm.test.ts        — Farm integration test
```

Modified files:
- `packages/schema/src/changefeed.ts` — Symbol key rename
- `packages/core/src/compiler/reactive-detection.ts` — symbol detection string
- `packages/core/src/compiler/codegen/html.ts` — marker prefix
- `packages/core/src/compiler/codegen/dom.ts` — marker prefix
- `packages/core/src/compiler/html-constants.ts` — marker templates
- `packages/core/src/server/render.ts` — marker generation
- `packages/core/src/runtime/hydrate.ts` — marker regex
- `packages/core/src/runtime/regions.ts` — slot markers
- `packages/core/src/errors.ts` — type renames + deprecated re-exports
- `packages/core/src/vite/plugin.ts` — rewrite as re-export from unplugin
- `packages/core/src/index.ts` — re-export renames
- `packages/core/package.json` — new subpath exports, new dependency
- `packages/core/README.md` — rename throughout
- `packages/core/TECHNICAL.md` — rename throughout
- `packages/core/LEARNINGS.md` — rename throughout
- `packages/schema/TECHNICAL.md` — rename throughout
- `TECHNICAL.md` (root) — replace with monorepo overview
- ~20 test files — assertion string updates

## Alternatives Considered

### Alternative: Keep "Kinetic" name internally, only use "Kyneta" for the package

This creates permanent cognitive dissonance — the package is `@kyneta/core` but the code says `Kinetic` everywhere. Error stack traces show `KineticError`, DOM comments say `kinetic:list:1`, the Vite plugin registers as `"kinetic"`. Every new contributor would ask why. A clean rename now (pre-1.0, no external consumers) is the cheapest it will ever be.

### Alternative: Write separate plugins for Vite, Bun, and Farm

Three separate plugin files (~30 lines each) sharing the compiler functions. This works but misses the point: unplugin already abstracts the differences, supports 8 bundlers (not just 3), handles edge cases (nested plugins, context methods, filter patterns), and is maintained by the UnJS team. Writing our own adapters means maintaining our own compatibility matrix. unplugin is ~50KB with zero deps — trivial overhead for significant leverage.

### Alternative: Support only Vite and Bun (skip Farm)

Farm is the least common of the three, but it's also the fastest growing (Rust-based, Vite-compatible). More importantly, supporting Farm is free — unplugin handles it. The only cost is one integration test file (~30 lines). Excluding it sends the wrong signal about the framework's universality.

### Alternative: Rename Symbol.for key but keep DOM markers as `kinetic:*`

This would reduce the blast radius of the rename but creates an inconsistency: the protocol symbol says "kyneta" but the DOM markers say "kinetic". Since there are no external consumers and no deployed SSR content to preserve, a clean rename is better.

### Alternative: Use `@kyneta/core/plugin` as the unplugin export path (not `@kyneta/core/unplugin`)

Shorter, but ambiguous — "plugin" could mean anything. `@kyneta/core/unplugin` makes the dependency explicit and matches the ecosystem convention (e.g., `unplugin-vue-components/vite`). The per-bundler subpaths (`@kyneta/core/unplugin/vite`) are what most consumers will actually import.