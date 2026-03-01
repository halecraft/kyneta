# Plan: Text Patching for Direct TextRef Reads

## Background

Kinetic's delta-driven reactivity system already carries structured deltas through the entire pipeline: Loro emits `TextDiff` events, the reactive bridge translates them to `{ type: "text", ops: [retain/insert/delete] }` deltas, and the IR tracks `deltaKind: "text"` on dependencies. However, the codegen **ignores delta kind entirely** — every reactive text content node generates `textNode.textContent = String(value)`, which is O(n) where n is the full string length.

The DOM provides `Text.insertData(offset, text)` and `Text.deleteData(offset, count)` for O(k) surgical updates where k is the edit size. For a 10,000-character `TextRef` with a single character insertion, this is the difference between replacing the entire string and inserting one character.

The optimization is only valid when the content expression is a **direct read** — i.e., the expression is exactly `ref.get()` (or `ref.toString()`), not `ref.get().toUpperCase()` or `ref.get() + other.get()`. For non-direct reads, the delta ops describe changes to the *source* string, not the *output* string, so surgical patching would produce incorrect results.

### Key Infrastructure Already in Place

- `TextRef.get()` exists as alias for `.toString()` (Phase 1 ✅)
- `Dependency.deltaKind` carries `"text"` for TextRef dependencies through the IR
- `translateTextDiff` in `reactive-bridge.ts` correctly produces `TextDeltaOp[]`
- `subscribeMultiple` handles multi-dep expressions (Phase 3 ✅)
- Runtime subpath `@loro-extended/kinetic/runtime` exists with clean names (Phase 0a/0b ✅)
- `listRegion` demonstrates the FC/IS pattern for delta-aware DOM updates
- jsdom supports `Text.insertData()` and `Text.deleteData()` for testing

## Problem Statement

Every reactive text content node generates the same code regardless of delta kind:

```typescript
// Single dep — subscribeWithValue always re-reads and replaces
subscribeWithValue(doc.title, () => doc.title.get(), (v) => {
  _text0.textContent = String(v)
}, scope)
```

For `doc.title.get()` where `doc.title` is a `TextRef`, the runtime receives `{ type: "text", ops }` deltas with character-level precision, but throws that information away and re-reads the entire string.

## Success Criteria

1. Expressions like `doc.title.get()` where the single dependency has `deltaKind: "text"` generate a `textRegion` call instead of `subscribeWithValue`
2. `textRegion` applies `insertData`/`deleteData` for text deltas and falls back to full `textContent` replacement for non-text deltas
3. Non-direct expressions (e.g., `doc.title.get().toUpperCase()`, `doc.title.get() + " suffix"`) continue to use `subscribeWithValue` / `subscribeMultiple` (fallback is always safe)
4. The `planTextPatch` function is pure and independently testable
5. All existing tests pass (608+ kinetic, 968+ change, 57+ reactive)

**Achieved**: 662 kinetic tests (up from 635 baseline), 968 change, 57 reactive — all passing.

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Codegen for direct TextRef read | `subscribeWithValue` (full replacement) | `textRegion` (surgical patching) |
| `ContentValue` IR node | No direct-read tracking | `directReadSource?: string` field |
| `analyzeExpression` | Doesn't detect direct reads | Structural AST detection via `detectDirectRead` |
| Text patch runtime | Does not exist | `planTextPatch`, `patchText`, `textRegion` |
| `deltaKind` usage in codegen | Stored but never read | Dispatched on for text patching |
| Reactive content codegen | Duplicated across `generateChild` and `generateBodyWithReturn` | Extracted into shared `generateReactiveContentSubscription` helper |

## Phases and Tasks

### Phase 1: Pure Text Patch Functions ✅

Runtime functions with zero DOM or subscription dependencies. Pure input→output.

- ✅ Task 1.1: Implement `planTextPatch(ops: TextDeltaOp[]): TextPatchOp[]` in new file `runtime/text-patch.ts`
- ✅ Task 1.2: Implement `patchText(textNode: Text, ops: TextDeltaOp[]): void` composing plan + execute
- ✅ Task 1.3: Add unit tests for `planTextPatch` (retain+insert, retain+delete, complex sequences, empty ops, insert-at-start)
- ✅ Task 1.4: Add unit tests for `patchText` with jsdom Text nodes

### Phase 2: IR Extension & Direct-Read Detection ✅

Compiler changes to detect when a content expression is a direct `.get()` / `.toString()` call on a single reactive dependency.

- ✅ Task 2.1: Add `directReadSource?: string` field to `ContentValue` interface in `ir.ts`
- ✅ Task 2.2: Update `createContent` factory to accept optional `directReadSource` parameter
- ✅ Task 2.3: Implement `detectDirectRead(expr: Expression): string | undefined` in `analyze.ts`
- ✅ Task 2.4: Call `detectDirectRead` from `analyzeExpression` and pass result to `createContent`
- ✅ Task 2.5: Add analyze tests for direct-read detection (positive and negative cases)

### Phase 3: `textRegion` Runtime Function ✅

The runtime function that generated code calls for direct TextRef reads.

- ✅ Task 3.1: Define `TextRefLike` interface in `runtime/text-patch.ts` (mirrors `ListRefLike` pattern from `regions.ts`)
- ✅ Task 3.2: Implement `textRegion(textNode: Text, ref: unknown, scope: Scope): void` in `runtime/text-patch.ts`, casting `ref` to `TextRefLike` internally
- ✅ Task 3.3: Export `textRegion` from `runtime/index.ts`
- ✅ Task 3.4: Add unit tests for `textRegion` with mock TextRef emitting text deltas
- ✅ Task 3.5: Add unit test for `textRegion` fallback (non-text delta triggers full replacement)

### Phase 4: Codegen & Import Updates ✅

Wire the IR's `directReadSource` + `deltaKind` into code generation. First eliminate pre-existing duplication, then add the new branch once.

- ✅ Task 4.1: Extract `generateReactiveContentSubscription(node: ContentNode, textVar: string, state: CodegenState): string[]` helper from the duplicated reactive-content codegen in `generateChild` (L372–399) and `generateBodyWithReturn` (L498–530). Both callers use the helper and handle text-node creation + placement themselves.
- ✅ Task 4.2: Add `textRegion` branch to the extracted helper: when `node.directReadSource && node.dependencies[0].deltaKind === "text"`, emit `textRegion(textVar, node.directReadSource, scopeVar)` instead of `subscribeWithValue`/`subscribeMultiple`
- ✅ Task 4.3: Update `collectRequiredImports` to add `"textRegion"` to runtime imports when a content node has `directReadSource` and `dependencies[0].deltaKind === "text"`
- ✅ Task 4.4: Add codegen test: direct TextRef read generates `textRegion`
- ✅ Task 4.5: Add codegen test: non-direct TextRef read falls back to `subscribeWithValue`
- ✅ Task 4.6: Add codegen test: multi-dep expression with TextRef falls back to `subscribeMultiple`

### Phase 5: Integration Tests ✅

End-to-end tests with real `TextRef` and Loro docs.

- ✅ Task 5.1: Integration test — TextRef direct read with character insertion uses `insertData`
- ✅ Task 5.2: Integration test — TextRef direct read with character deletion uses `deleteData`
- ✅ Task 5.3: Integration test — non-direct read (template literal) uses full replacement
- ✅ Task 5.4: Integration test — multi-dep text expression uses replace semantics

### Phase 6: Documentation 🔴

- 🔴 Task 6.1: Update `TECHNICAL.md` — document text patching optimization in a new "Text Region Architecture" section alongside List Region Architecture
- 🔴 Task 6.2: Update `TECHNICAL.md` — fix stale `__` prefix references in Runtime Dependencies section (pre-existing debt)
- 🔴 Task 6.3: Update `TECHNICAL.md` — add direct-read detection to the Reactive Detection section

## Critical Type Declarations

```typescript
// runtime/text-patch.ts

/** Offset-based patch operation for DOM Text nodes */
type TextPatchOp =
  | { kind: "insert"; offset: number; text: string }
  | { kind: "delete"; offset: number; count: number }

/**
 * Structural interface for text refs.
 * Keeps runtime Loro-agnostic — any type with get(): string and [REACTIVE] works.
 * Mirrors the ListRefLike pattern from regions.ts.
 */
interface TextRefLike {
  get(): string
}
```

```typescript
// compiler/ir.ts — ContentValue extension

interface ContentValue extends IRNodeBase {
  kind: "content"
  source: string
  bindingTime: BindingTime
  dependencies: Dependency[]
  directReadSource?: string  // NEW — set when expression is exactly `ref.get()` or `ref.toString()`
}
```

```typescript
// compiler/analyze.ts — detection function signature

/** Returns the source ref name if the expression is a direct .get()/.toString() on a single reactive, else undefined */
function detectDirectRead(expr: Expression): string | undefined
```

```typescript
// compiler/codegen/dom.ts — extracted helper signature

/** Generate subscription code for reactive text content. Shared by generateChild and generateBodyWithReturn. */
function generateReactiveContentSubscription(
  node: ContentNode,
  textVar: string,
  state: CodegenState,
): string[]
```

```typescript
// runtime/text-patch.ts — region function signature

/** Subscribe to a TextRef and apply surgical text patches to a DOM Text node */
function textRegion(textNode: Text, ref: unknown, scope: Scope): void
```

## Direct-Read Detection Algorithm

The detection is **structural AST analysis** at the root of the content expression. It does NOT use string pattern matching.

A direct read must satisfy all of:
1. The root node is a `CallExpression`
2. The callee is a `PropertyAccessExpression` (i.e., `receiver.method()`)
3. The method name is `"get"` or `"toString"`
4. The call has zero arguments
5. The receiver's type is reactive (via `isReactiveType`)

**Positive cases**: `title.get()`, `doc.title.get()`, `title.toString()`
**Negative cases**: `title.get().toUpperCase()` (root is a different CallExpression wrapping the `.get()` result), `title.get() + subtitle.get()` (root is BinaryExpression), `` `${title.get()}` `` (root is TemplateExpression), `title.get("arg")` (has arguments)

The key insight is that checking the *root* node type implicitly rejects nested `.get()` calls — if `title.get()` is inside a larger expression, it's not the root.

## `textRegion` Runtime Design

Follows the same FC/IS pattern as `listRegion`:

**Functional Core** (pure):
- `planTextPatch(ops: TextDeltaOp[]): TextPatchOp[]` — converts retain/insert/delete delta ops to offset-based `{ kind, offset, text/count }` operations

**Imperative Shell** (DOM):
- `patchText(textNode: Text, ops: TextDeltaOp[]): void` — composes `planTextPatch` + applies via `insertData`/`deleteData`
- `textRegion(textNode: Text, ref: unknown, scope: Scope): void` — casts `ref` to `TextRefLike`, sets initial value, subscribes, dispatches on delta type

The `textRegion` function uses `subscribe` directly (not a hypothetical `subscribeIncremental` abstraction). This matches how `listRegion` and `conditionalRegion` work today. If a common abstraction proves valuable later, all three can be refactored together.

The `TextRefLike` interface mirrors the `ListRefLike` pattern from `regions.ts`, keeping the runtime Loro-agnostic. Any type with `get(): string` and `[REACTIVE]` works — `TextRef`, custom text reactives, etc.

**Delta dispatch logic within `textRegion`:**
- `delta.type === "text"` → call `patchText(textNode, delta.ops)` (surgical O(k) update)
- Any other delta type → `textNode.textContent = ref.get()` (safe O(n) fallback)

**Initial value:** `textNode.textContent = ref.get()` is called once before subscribing, similar to how `subscribeWithValue` works.

## `planTextPatch` Algorithm

Converts a sequence of retain/insert/delete ops (cursor-based, left-to-right) into absolute offset-based patch operations:

```
cursor = 0
for each op:
  if op.retain → cursor += op.retain
  if op.insert → emit { kind: "insert", offset: cursor, text: op.insert }; cursor += op.insert.length
  if op.delete → emit { kind: "delete", offset: cursor, count: op.delete }
    (cursor does NOT advance on delete — subsequent ops apply at same position)
```

The output `TextPatchOp[]` can be applied sequentially to a DOM Text node via `insertData`/`deleteData`.

## Codegen Refactoring: `generateReactiveContentSubscription`

### Pre-existing duplication

The reactive content subscription codegen is currently duplicated between `generateChild` (L372–399) and `generateBodyWithReturn` (L498–530) in `dom.ts`. The two copies are nearly identical — they differ only in whether the text node is `appendChild`'d to a parent or `return`'d. Both handle the single-dep (`subscribeWithValue`) and multi-dep (`subscribeMultiple`) branches identically.

### Extraction

Extract the subscription-related lines into a shared helper:

```typescript
function generateReactiveContentSubscription(
  node: ContentNode,
  textVar: string,
  state: CodegenState,
): string[]
```

This returns just the subscription lines (everything after the text node is created). Both `generateChild` and `generateBodyWithReturn` create the text node themselves, call the helper for subscription lines, and then handle placement (`appendChild` vs `return`) themselves.

### Adding `textRegion`

The `textRegion` branch is added **once** inside this helper, before the existing single-dep / multi-dep dispatch:

```
if directReadSource && deps[0].deltaKind === "text":
  → emit textRegion(textVar, directReadSource, scopeVar)
else if deps.length === 1:
  → emit subscribeWithValue (existing)
else:
  → emit subscribeMultiple (existing)
```

## Codegen Output Examples

**Before (current — all reactive text content):**
```javascript
const _text0 = document.createTextNode("")
parent.appendChild(_text0)
subscribeWithValue(doc.title, () => doc.title.get(), (v) => {
  _text0.textContent = String(v)
}, scope)
```

**After (direct TextRef read detected):**
```javascript
const _text0 = document.createTextNode("")
parent.appendChild(_text0)
textRegion(_text0, doc.title, scope)
```

**Fallback (non-direct read, unchanged):**
```javascript
const _text0 = document.createTextNode("")
parent.appendChild(_text0)
subscribeWithValue(doc.title, () => doc.title.get().toUpperCase(), (v) => {
  _text0.textContent = String(v)
}, scope)
```

## Tests

Tests are organized by phase. All test files already exist — new tests are appended to existing `describe` blocks or added as new `describe` blocks.

### Phase 1: `planTextPatch` and `patchText`

New file: `runtime/text-patch.test.ts`

```typescript
describe("planTextPatch", () => {
  it("converts retain + insert to offset-based insert op")
  // { retain: 5, insert: "X" } → [{ kind: "insert", offset: 5, text: "X" }]

  it("converts retain + delete to offset-based delete op")
  // { retain: 3, delete: 2 } → [{ kind: "delete", offset: 3, count: 2 }]

  it("handles insert at start (no retain)")
  // { insert: "Hello" } → [{ kind: "insert", offset: 0, text: "Hello" }]

  it("handles complex sequence")
  // { retain: 2, delete: 3, insert: "abc" } → two ops

  it("handles empty ops")
  // [] → []
})

describe("patchText", () => {
  // Uses jsdom Text nodes
  it("applies insert delta")
  // "Hello" + { retain: 5, insert: " World" } → "Hello World"

  it("applies delete delta")
  // "Hello World" + { retain: 5, delete: 6 } → "Hello"

  it("applies complex delta sequence")
  // "abcdef" + { retain: 2, delete: 2, insert: "XY" } → "abXYef"
})
```

### Phase 2: Direct-Read Detection

Added to: `compiler/analyze.test.ts`

```typescript
describe("detectDirectRead", () => {
  it("detects title.get() as direct read")
  it("detects title.toString() as direct read")
  it("rejects title.get().toUpperCase() — root is outer call")
  it("rejects title.get() + subtitle.get() — root is binary expr")
  it("rejects template literal with embedded .get()")
  it("rejects title.get('arg') — has arguments")
  it("rejects non-reactive receiver")
  it("sets directReadSource on ContentValue for direct reads")
  it("leaves directReadSource undefined for non-direct reads")
})
```

### Phase 3: `textRegion`

Added to: `runtime/text-patch.test.ts`

```typescript
describe("textRegion", () => {
  // Uses jsdom + mock reactive ref
  it("sets initial text content from ref.get()")
  it("applies text delta via insertData")
  it("applies text delta via deleteData")
  it("falls back to full replacement for non-text delta")
  it("registers cleanup with scope")
})
```

### Phase 4: Codegen

Added to: `compiler/codegen/dom.test.ts`

```typescript
describe("text patching codegen", () => {
  it("generates textRegion for direct TextRef read")
  // createContent("title.get()", "reactive", [dep("title", "text")], span, "title")
  // → output contains "textRegion"

  it("generates subscribeWithValue for non-direct TextRef read")
  // createContent("`Hello ${title.get()}`", "reactive", [dep("title", "text")], span)
  // directReadSource is undefined → output contains "subscribeWithValue", NOT "textRegion"

  it("generates subscribeMultiple for multi-dep with TextRef")
  // two deps, one is text → subscribeMultiple, NOT textRegion
})
```

Existing codegen tests for `subscribeWithValue` and `subscribeMultiple` must continue to pass after the `generateReactiveContentSubscription` extraction — this validates the refactor is behavior-preserving.

### Phase 5: Integration

Added to: `compiler/integration.test.ts`

```typescript
describe("text patching integration", () => {
  it("compiles direct TextRef read with textRegion call")
  // Full compile from source: p(doc.title.get())
  // → verify textRegion in output + import from runtime

  it("compiles non-direct TextRef read with subscribeWithValue")
  // Full compile from source: p(`Hello ${doc.title.get()}`)
  // → verify subscribeWithValue, no textRegion (template literal is reactive but not direct)

  it("runtime: textRegion applies insert delta to DOM text node")
  // Create real TextRef, subscribe via textRegion, insert text, verify DOM uses insertData

  it("runtime: textRegion applies delete delta to DOM text node")
  // Create real TextRef, subscribe via textRegion, delete text, verify DOM uses deleteData
})
```

## Transitive Effect Analysis

### Package Dependency Graph

```
@loro-extended/reactive  ← TextDeltaOp types (already exist, no changes)
       ↓
@loro-extended/change    ← TextRef, reactive bridge (no changes needed)
       ↓
@loro-extended/kinetic   ← IR extension, detection, codegen, runtime (ALL changes here)
```

### Direct Impact

| File | Change | Risk |
|------|--------|------|
| `compiler/ir.ts` | Add optional `directReadSource` field to `ContentValue` | **Low** — optional field, all existing code unaffected |
| `compiler/ir.ts` | Update `createContent` signature | **Medium** — 15+ call sites pass positional args; new param must be optional and last |
| `compiler/analyze.ts` | New `detectDirectRead` function + call from `analyzeExpression` | **Low** — additive, only affects reactive expressions |
| `compiler/codegen/dom.ts` | Extract helper, add `textRegion` branch | **Medium** — refactor touches two functions, but existing tests validate behavior preservation |
| `compiler/transform.ts` | `collectRequiredImports` adds `"textRegion"` | **Low** — additive branch |
| `runtime/text-patch.ts` | New file | **None** — no existing code affected |
| `runtime/index.ts` | Export `textRegion` | **Low** — additive |

### Transitive Impact

| Affected | Via | Risk |
|----------|-----|------|
| `mergeContentValue` in `ir.ts` | `ContentValue` type change | **Low** — `directReadSource` is not involved in merge logic (merging two text nodes doesn't preserve direct-read status since the merged expression is a ternary). The three inline `ContentValue` constructions in `mergeContentValue` omit `directReadSource`, which is correct. |
| `generateHTML` (html codegen) | `ContentValue` type change | **None** — HTML codegen doesn't handle reactive subscriptions; `directReadSource` is irrelevant for SSR |
| `tree-merge` | `ContentValue` type change | **Low** — merge creates new `ContentValue` via inline construction, direct-read status is lost (correct behavior: merged ternary is not a direct read) |
| Vite plugin | Imports change | **Low** — plugin delegates to `transformSourceInPlace` which calls `collectRequiredImports` |
| Existing codegen tests | `createContent` signature change | **None** if new param is optional with default `undefined` |
| Existing codegen tests | `generateReactiveContentSubscription` extraction | **None** — extraction is behavior-preserving; existing tests validate this |

### Breaking Change Assessment

**Non-breaking**: All changes are additive. The `directReadSource` field is optional. Existing `createContent` calls continue to work. Generated code that doesn't use `textRegion` is unchanged. The codegen refactoring is internal and behavior-preserving.

## Resources for Implementation

### Files to Read Before Implementing

| File | Why |
|------|-----|
| `packages/kinetic/src/compiler/ir.ts` L128–155 | `ContentValue` interface and `createContent` factory |
| `packages/kinetic/src/compiler/analyze.ts` L236–412 | `expressionIsReactive`, `extractDependencies`, `analyzeExpression` |
| `packages/kinetic/src/compiler/codegen/dom.ts` L340–434 | `generateChild` — reactive text content codegen (duplication source) |
| `packages/kinetic/src/compiler/codegen/dom.ts` L453–538 | `generateBodyWithReturn` — parallel reactive text codegen (duplication source) |
| `packages/kinetic/src/compiler/codegen/dom.ts` L178–224 | `generateAttributeSubscription` — pattern reference for multi-dep |
| `packages/kinetic/src/compiler/transform.ts` L211–278 | `collectRequiredImports` — import collection logic |
| `packages/kinetic/src/runtime/regions.ts` L193–198 | `ListRefLike` interface — pattern for `TextRefLike` |
| `packages/kinetic/src/runtime/regions.ts` L413–460 | `listRegion` — FC/IS pattern reference for `textRegion` |
| `packages/kinetic/src/runtime/subscribe.ts` | `subscribe`, `subscribeWithValue` — subscription primitives |
| `packages/kinetic/src/runtime/index.ts` | Runtime exports |
| `packages/kinetic/src/compiler/reactive-detection.ts` | `isReactiveType`, `getDeltaKind` |
| `packages/change/src/reactive-bridge.ts` | `translateTextDiff` — how text deltas are produced |
| `packages/reactive/src/index.ts` | `TextDeltaOp` type definition |

### Files to Modify

| File | Changes |
|------|---------|
| `packages/kinetic/src/compiler/ir.ts` | Add `directReadSource` to `ContentValue`, update `createContent` |
| `packages/kinetic/src/compiler/analyze.ts` | Add `detectDirectRead`, wire into `analyzeExpression` |
| `packages/kinetic/src/compiler/codegen/dom.ts` | Extract `generateReactiveContentSubscription` helper, add `textRegion` branch |
| `packages/kinetic/src/compiler/transform.ts` | Update `collectRequiredImports` for `textRegion` |
| `packages/kinetic/src/runtime/index.ts` | Export `textRegion` |
| `packages/kinetic/TECHNICAL.md` | Document text region architecture, fix stale `__` references |

### Files to Create

| File | Purpose |
|------|---------|
| `packages/kinetic/src/runtime/text-patch.ts` | `TextRefLike`, `TextPatchOp`, `planTextPatch`, `patchText`, `textRegion` |
| `packages/kinetic/src/runtime/text-patch.test.ts` | Tests for `planTextPatch`, `patchText`, `textRegion` |

### Existing Test Files to Extend

| File | New Tests |
|------|-----------|
| `packages/kinetic/src/compiler/analyze.test.ts` | `detectDirectRead` positive/negative cases |
| `packages/kinetic/src/compiler/codegen/dom.test.ts` | `textRegion` codegen tests, validates extraction is behavior-preserving |
| `packages/kinetic/src/compiler/integration.test.ts` | End-to-end compile + runtime tests |

## Learnings

### `expressionIsReactive` Limitation

The `expressionIsReactive` function doesn't recursively traverse into call chains. For `title.get().toUpperCase()`:
- The receiver of `toUpperCase()` is `title.get()` which has type `string`
- `isReactiveType(string)` returns false
- The function doesn't dig deeper to find that `title` is reactive

**Consequence**: `title.get().toUpperCase()` is classified as **render-time**, not reactive. This is existing behavior and not a bug introduced by this work. In practice, such expressions typically appear in contexts where the parent (like a builder argument) extracts dependencies differently.

**Impact on tests**: Test cases for "non-direct reads" should use template literals (which ARE detected as reactive) rather than chained method calls.

### Text Delta Cursor Model

Loro's `TextDeltaOp` uses cursor-based operations:
- `retain: n` — advance cursor by n characters
- `insert: s` — insert string s at cursor position, then advance cursor by s.length
- `delete: n` — delete n characters at cursor position, cursor does NOT advance

The last point is critical: after a delete, subsequent ops apply at the same position. This is why `planTextPatch` doesn't increment the cursor on delete ops.

### Test Type Definitions Need Maintenance

The test helpers (`addLoroTypes`, `addReactiveTypes`) create minimal `.d.ts` stubs. When testing new features, these may need updating. For this work, we added `get(): string` to `TextRef` in the test type definitions to match the real implementation.

### Optional IR Fields Pattern

When adding optional fields to IR nodes, conditionally set them to keep serialized IR clean:
```typescript
if (directReadSource !== undefined) {
  result.directReadSource = directReadSource
}
```

### Stale Build Artifacts Can Cause Mysterious Failures

During integration testing, `doc.title.get()` returned `undefined` even though the method was clearly defined in `TextRef`. The cause: **stale build artifacts** in `packages/change`. After running `pnpm build` in that package, the method appeared.

**Lesson**: When methods appear undefined on Loro refs, rebuild the dependent package (`packages/change`) first before debugging further.

### Pre-existing Type Mismatch in `TransformInPlaceResult`

The `TransformInPlaceResult.requiredImports` field was typed as `Set<string>` but `collectRequiredImports` actually returns `{ runtime: Set<string>; loro: Set<string> }`. Tests passed because Vitest doesn't run TypeScript type checking during execution.

**Fixed in Phase 4**: Updated the interface to match the actual return type.

### Codegen Condition Must Check `dependencies.length === 1`

The `textRegion` dispatch condition requires checking both `directReadSource` AND `dependencies.length === 1`:

```typescript
// CORRECT
if (directReadSource && deps.length === 1 && deps[0].deltaKind === "text")

// WRONG (would access deps[0] on empty array for edge cases)
if (directReadSource && deps[0]?.deltaKind === "text")
```

Multi-dep expressions can never use surgical patching — the delta describes changes to one source, but the output depends on multiple sources.

### Testing O(k) vs O(n) Behavior with Method Spying

To verify surgical updates, tests spy on DOM methods rather than just checking final content:

```typescript
let insertDataCalls: Array<{ offset: number; data: string }> = []
const originalInsertData = textNode.insertData.bind(textNode)
textNode.insertData = (offset: number, data: string) => {
  insertDataCalls.push({ offset, data })
  originalInsertData(offset, data)
}

// After edit, verify surgical API was called
expect(insertDataCalls).toEqual([{ offset: 5, data: " World" }])
```

### `textRegion` Follows `listRegion` Pattern Exactly

No new abstraction (like `subscribeIncremental`) was needed. The implementation mirrors `listRegion`:
1. Cast ref to typed interface (`TextRefLike`)
2. Set initial value via `ref.get()`
3. Subscribe with `subscribe(ref, delta => ...)`
4. Dispatch on `delta.type`: surgical path for `"text"`, fallback for others

## Changeset

```markdown
---
"@loro-extended/kinetic": minor
---

feat: surgical text patching for direct TextRef reads

When a reactive text content expression is a direct `.get()` call on a single
`TextRef` dependency, the compiler now generates `textRegion()` instead of
`subscribeWithValue()`. This uses the DOM's `insertData()`/`deleteData()` APIs
for O(k) text updates where k is the edit size, rather than O(n) full string
replacement.

Non-direct expressions (e.g., `.toUpperCase()`, template literals, multi-dep)
continue to use the existing full-replacement strategy as a safe fallback.
```
