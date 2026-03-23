/**
 * End-to-end integration tests for filter pattern recognition.
 *
 * These tests compile real TypeScript source through the full analysis
 * pipeline (ts-morph → IR) and verify that `LoopNode.filter` is populated
 * correctly. Unlike patterns.test.ts (which builds IR by hand), these
 * tests exercise the complete path: parsing, reactive detection, dependency
 * extraction, binding scope threading, and pattern detection.
 *
 * @packageDocumentation
 */

import { Project } from "ts-morph"
import { beforeEach, describe, expect, it } from "vitest"
import { analyzeBuilder, findBuilderCalls } from "./analyze.js"

// =============================================================================
// Test Helpers
// =============================================================================

function createProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      target: 99, // ESNext
      module: 99, // ESNext
      strict: true,
    },
  })
}

function createSourceFile(
  project: Project,
  code: string,
  filename = "test.ts",
) {
  return project.createSourceFile(filename, code, { overwrite: true })
}

function addBaseChangefeedTypes(project: Project) {
  project.createSourceFile(
    "changefeed-base.d.ts",
    `
    export const CHANGEFEED: unique symbol

    export interface ChangeBase {
      readonly type: string
    }

    export interface Changeset<C = ChangeBase> {
      readonly changes: readonly C[]
      readonly origin?: string
    }

    export interface Changefeed<S, C extends ChangeBase = ChangeBase> {
      readonly current: S
      subscribe(callback: (changeset: Changeset<C>) => void): () => void
    }

    export interface HasChangefeed<S = unknown, C extends ChangeBase = ChangeBase> {
      readonly [CHANGEFEED]: Changefeed<S, C>
    }
  `,
    { overwrite: true },
  )
}

function addSchemaTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "schema-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed } from "./changefeed-base"

    export type TextChange = { readonly type: "text"; readonly ops: readonly unknown[] }
    export type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }
    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }

    export interface TextRef extends HasChangefeed<string, TextChange> {
      readonly [CHANGEFEED]: Changefeed<string, TextChange>
      (): string
      toString(): string
      toLowerCase(): string
      toUpperCase(): string
      includes(searchString: string): boolean
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
    }

    export interface BooleanRef extends HasChangefeed<boolean, ReplaceChange<boolean>> {
      readonly [CHANGEFEED]: Changefeed<boolean, ReplaceChange<boolean>>
      (): boolean
    }

    export interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {
      readonly [CHANGEFEED]: Changefeed<T[], SequenceChange<T>>
      (): T[]
      get(index: number): T | undefined
      push(item: T): void
      insert(index: number, item: T): void
      delete(index: number, len?: number): void
      readonly length: number
      [Symbol.iterator](): Iterator<T>
    }

    export interface RecipeRef {
      name: TextRef
      vegetarian: BooleanRef
    }

    export interface IngredientRef {
      category: TextRef
    }

    export interface RecipeBookDoc {
      recipes: ListRef<RecipeRef>
      ingredients: ListRef<IngredientRef>
    }
  `,
    { overwrite: true },
  )
}

function addReactiveTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "reactive-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed } from "./changefeed-base"
    export { CHANGEFEED, ChangeBase, Changefeed, HasChangefeed }

    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }

    export interface LocalRef<T> extends HasChangefeed<T, ReplaceChange<T>> {
      (): T
      readonly [CHANGEFEED]: Changefeed<T, ReplaceChange<T>>
      set(value: T): void
    }
    export declare function state<T>(initial: T): LocalRef<T>
  `,
    { overwrite: true },
  )
}

function setupImports(project: Project) {
  addSchemaTypes(project)
  addReactiveTypes(project)
}

function analyzeFirst(project: Project, code: string) {
  const sourceFile = createSourceFile(project, code)
  const calls = findBuilderCalls(sourceFile)
  expect(calls.length).toBeGreaterThan(0)
  const builder = analyzeBuilder(calls[0])
  expect(builder).not.toBeNull()
  return builder!
}

// =============================================================================
// Tests
// =============================================================================

describe("Filter pattern integration", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    setupImports(project)
  })

  // ---------------------------------------------------------------------------
  // Test 1 — Recipe-book filter pattern (end-to-end)
  // ---------------------------------------------------------------------------

  it("detects recipe-book compound filter with classified deps", () => {
    const builder = analyzeFirst(
      project,
      `
      import { RecipeBookDoc } from "./schema-types"
      import { state } from "./reactive-types"
      declare const doc: RecipeBookDoc
      const filterText = state("")
      const veggieOnly = state(false)

      div(() => {
        for (const recipe of doc.recipes) {
          const nameMatch = recipe.name().toLowerCase().includes(
            filterText().toLowerCase(),
          )
          const veggieMatch = !veggieOnly() || recipe.vegetarian()
          if (nameMatch && veggieMatch) {
            p("RecipeCard")
          }
        }
      })
    `,
    )

    // The first child should be a loop
    const loop = builder.children[0]
    expect(loop.kind).toBe("loop")

    if (loop.kind === "loop") {
      expect(loop.filter).toBeDefined()
      expect(loop.filter).not.toBeNull()

      if (loop.filter) {
        // Item deps: recipe.name, recipe.vegetarian
        const itemSources = loop.filter.itemDeps.map(d => d.source).sort()
        expect(itemSources).toContain("recipe.name")
        expect(itemSources).toContain("recipe.vegetarian")

        // External deps: filterText, veggieOnly
        const extSources = loop.filter.externalDeps.map(d => d.source).sort()
        expect(extSources).toContain("filterText")
        expect(extSources).toContain("veggieOnly")

        // All item deps should be classified as "item"
        for (const d of loop.filter.itemDeps) {
          expect(d.classification).toBe("item")
        }

        // All external deps should be classified as "external"
        for (const d of loop.filter.externalDeps) {
          expect(d.classification).toBe("external")
        }
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Test 2 — Non-filter loop unchanged
  // ---------------------------------------------------------------------------

  it("non-filter loop has no filter metadata", () => {
    const builder = analyzeFirst(
      project,
      `
      import { RecipeBookDoc } from "./schema-types"
      declare const doc: RecipeBookDoc

      ul(() => {
        for (const recipe of doc.recipes) {
          li(recipe.name)
        }
      })
    `,
    )

    const loop = builder.children[0]
    expect(loop.kind).toBe("loop")

    if (loop.kind === "loop") {
      // No conditional in body → no filter
      expect(loop.filter).toBeUndefined()
    }
  })

  // ---------------------------------------------------------------------------
  // Test 3 — Codegen backward compatibility
  // ---------------------------------------------------------------------------

  it("filter loop still produces standard codegen (filter field is ignored)", () => {
    const builder = analyzeFirst(
      project,
      `
      import { RecipeBookDoc } from "./schema-types"
      declare const doc: RecipeBookDoc

      ul(() => {
        for (const recipe of doc.recipes) {
          if (recipe.vegetarian()) {
            li(recipe.name)
          }
        }
      })
    `,
    )

    const loop = builder.children[0]
    expect(loop.kind).toBe("loop")

    if (loop.kind === "loop") {
      // The filter IS detected (reactive condition with item dep)
      expect(loop.filter).toBeDefined()

      // But the loop body still contains the conditional —
      // the body is not transformed, just annotated
      expect(loop.body.some(c => c.kind === "conditional")).toBe(true)

      // iterableSource, hasReactiveItems, bodySlotKind etc. are unchanged
      expect(loop.iterableSource).toBe("doc.recipes")
      expect(loop.iterableBindingTime).toBe("reactive")
    }
  })

  // ---------------------------------------------------------------------------
  // Test 4 — Per-item conditional is NOT a filter (end-to-end)
  // ---------------------------------------------------------------------------

  it("per-item conditional with else branch is not a filter", () => {
    const builder = analyzeFirst(
      project,
      `
      import { RecipeBookDoc } from "./schema-types"
      declare const doc: RecipeBookDoc

      ul(() => {
        for (const item of doc.ingredients) {
          if (item.category() === "legume") {
            p("legume")
          } else {
            p("other")
          }
        }
      })
    `,
    )

    const loop = builder.children[0]
    expect(loop.kind).toBe("loop")

    if (loop.kind === "loop") {
      // Has else branch → per-item conditional, NOT a filter
      expect(loop.filter).toBeUndefined()

      // The conditional is still in the body (existing behavior)
      const conditional = loop.body.find(c => c.kind === "conditional")
      expect(conditional).toBeDefined()

      if (conditional?.kind === "conditional") {
        // Verify it has both branches
        expect(conditional.branches.length).toBe(2)
        // Second branch has null condition (the else)
        expect(conditional.branches[1].condition).toBeNull()
      }
    }
  })
})
