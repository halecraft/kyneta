/**
 * Algebraic property tests for BindingScope + analysis pipeline integration.
 *
 * These tests verify the core properties of the binding system:
 * 1. Transitivity — reactive deps flow through bindings
 * 2. Dependency preservation — binding deps match direct analysis
 * 3. Scope nesting — bindings respect lexical scoping
 * 4. Backward compatibility — code without bindings is unchanged
 * 5. Mutable binding rejection — let/var are rejected
 * 6. Multiple bindings compose
 * 7. Filter pattern in loop body
 *
 * Tests use ts-morph with in-memory filesystem (same pattern as analyze.test.ts).
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

/**
 * Add the shared changefeed type definitions (CHANGEFEED symbol, ChangefeedProtocol interface).
 */
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

    export interface ChangefeedProtocol<S, C extends ChangeBase = ChangeBase> {
      readonly current: S
      subscribe(callback: (changeset: Changeset<C>) => void): () => void
    }

    export interface HasChangefeed<S = unknown, C extends ChangeBase = ChangeBase> {
      readonly [CHANGEFEED]: ChangefeedProtocol<S, C>
    }
  `,
    { overwrite: true },
  )
}

/**
 * Add schema-style type definitions to the project.
 */
function addSchemaTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "schema-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, ChangefeedProtocol, HasChangefeed } from "./changefeed-base"

    export type TextChange = { readonly type: "text"; readonly ops: readonly unknown[] }
    export type SequenceChange<T = unknown> = { readonly type: "sequence"; readonly ops: readonly unknown[] }
    export type MapChange = { readonly type: "map"; readonly set?: Record<string, unknown>; readonly delete?: readonly string[] }
    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }
    export type IncrementChange = { readonly type: "increment"; readonly amount: number }

    export interface TextRef extends HasChangefeed<string, TextChange> {
      readonly [CHANGEFEED]: ChangefeedProtocol<string, TextChange>
      (): string
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
      [Symbol.toPrimitive](hint: string): string
    }

    export interface CounterRef extends HasChangefeed<number, IncrementChange> {
      readonly [CHANGEFEED]: ChangefeedProtocol<number, IncrementChange>
      (): number
      increment(n: number): void
    }

    export interface ListRef<T> extends HasChangefeed<T[], SequenceChange<T>> {
      readonly [CHANGEFEED]: ChangefeedProtocol<T[], SequenceChange<T>>
      (): T[]
      get(index: number): T | undefined
      push(item: T): void
      insert(index: number, item: T): void
      delete(index: number, len?: number): void
      readonly length: number
      [Symbol.iterator](): Iterator<T>
    }

    export interface StructRef<T> extends HasChangefeed<T, MapChange> {
      readonly [CHANGEFEED]: ChangefeedProtocol<T, MapChange>
      (): T
    }

    export type TypedDoc<Shape> = Shape & HasChangefeed<unknown, MapChange> & {
      readonly [CHANGEFEED]: ChangefeedProtocol<unknown, MapChange>
      toJSON(): unknown
    }

    export declare function read<T>(ref: HasChangefeed<T>): T
  `,
    { overwrite: true },
  )
}

/**
 * Add reactive type definitions (LocalRef, state, etc.) to the project.
 */
function addReactiveTypes(project: Project) {
  addBaseChangefeedTypes(project)
  project.createSourceFile(
    "reactive-types.d.ts",
    `
    import { CHANGEFEED, ChangeBase, ChangefeedProtocol, HasChangefeed } from "./changefeed-base"
    export { CHANGEFEED, ChangeBase, ChangefeedProtocol, HasChangefeed }

    export type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }

    export interface LocalRef<T> extends HasChangefeed<T, ReplaceChange<T>> {
      (): T
      readonly [CHANGEFEED]: ChangefeedProtocol<T, ReplaceChange<T>>
      set(value: T): void
    }
    export declare function state<T>(initial: T): LocalRef<T>
  `,
    { overwrite: true },
  )
}

/**
 * Resolve imports so ts-morph can resolve reactive types.
 */
function setupImports(project: Project) {
  addSchemaTypes(project)
  addReactiveTypes(project)
}

/**
 * Helper: analyze the first builder call in source code.
 */
function analyzeFirst(project: Project, code: string) {
  const sourceFile = createSourceFile(project, code)
  const calls = findBuilderCalls(sourceFile)
  expect(calls.length).toBeGreaterThan(0)
  const builder = analyzeBuilder(calls[0])
  expect(builder).not.toBeNull()
  return builder!
}

// =============================================================================
// Property Tests
// =============================================================================

describe("Binding analysis — algebraic properties", () => {
  let project: Project

  beforeEach(() => {
    project = createProject()
    setupImports(project)
  })

  // ---------------------------------------------------------------------------
  // Property 1 — Transitivity
  // ---------------------------------------------------------------------------

  describe("Property 1 — Transitivity", () => {
    it("classifies conditional as reactive when condition uses a binding with reactive deps", () => {
      const builder = analyzeFirst(
        project,
        `
        import { CounterRef } from "./schema-types"
        declare const count: CounterRef

        div(() => {
          const isPositive = count() > 0
          if (isPositive) {
            p("positive")
          }
        })
      `,
      )

      // Children: BindingNode("isPositive"), ConditionalNode
      expect(builder.children.length).toBe(2)
      expect(builder.children[0].kind).toBe("binding")
      expect(builder.children[1].kind).toBe("conditional")

      if (builder.children[1].kind === "conditional") {
        // The conditional must be reactive — subscriptionTarget is non-null
        expect(builder.children[1].subscriptionTarget).not.toBeNull()
      }
    })

    it("classifies conditional as reactive through chained method calls on binding", () => {
      const builder = analyzeFirst(
        project,
        `
        import { TextRef } from "./schema-types"
        declare const title: TextRef

        div(() => {
          const lower = title().toLowerCase()
          if (lower.includes("hello")) {
            p("found")
          }
        })
      `,
      )

      expect(builder.children[0].kind).toBe("binding")
      expect(builder.children[1].kind).toBe("conditional")

      if (builder.children[1].kind === "conditional") {
        expect(builder.children[1].subscriptionTarget).not.toBeNull()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 2 — Dependency preservation
  // ---------------------------------------------------------------------------

  describe("Property 2 — Dependency preservation", () => {
    it("BindingNode.value.dependencies equals direct analysis of the initializer", () => {
      const builder = analyzeFirst(
        project,
        `
        import { CounterRef, TextRef } from "./schema-types"
        declare const count: CounterRef
        declare const title: TextRef

        div(() => {
          const combined = count() + title().length
          p("placeholder")
        })
      `,
      )

      expect(builder.children[0].kind).toBe("binding")
      if (builder.children[0].kind === "binding") {
        const binding = builder.children[0]
        expect(binding.name).toBe("combined")
        expect(binding.value.bindingTime).toBe("reactive")
        // Should have deps for both count and title
        const depSources = binding.value.dependencies.map(d => d.source)
        expect(depSources).toContain("count")
        expect(depSources).toContain("title")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 3 — Scope nesting
  // ---------------------------------------------------------------------------

  describe("Property 3 — Scope nesting", () => {
    it("binding inside loop body is not visible outside", () => {
      const builder = analyzeFirst(
        project,
        `
        import { ListRef, TextRef } from "./schema-types"
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            const upper = item.toUpperCase()
            li(upper)
          }
        })
      `,
      )

      // Top-level child should be a loop
      expect(builder.children.length).toBe(1)
      expect(builder.children[0].kind).toBe("loop")

      if (builder.children[0].kind === "loop") {
        // Loop body should have binding + element
        expect(builder.children[0].body.length).toBe(2)
        expect(builder.children[0].body[0].kind).toBe("binding")
        expect(builder.children[0].body[1].kind).toBe("element")
      }
    })

    it("binding in if-branch is not visible in else-branch", () => {
      const builder = analyzeFirst(
        project,
        `
        import { CounterRef, read } from "./schema-types"
        declare const count: CounterRef

        div(() => {
          if (read(count) > 0) {
            const msg = "positive"
            p(msg)
          } else {
            p("negative")
          }
        })
      `,
      )

      expect(builder.children[0].kind).toBe("conditional")
      if (builder.children[0].kind === "conditional") {
        const branches = builder.children[0].branches
        // Then branch has binding + element
        expect(branches[0].body.length).toBe(2)
        expect(branches[0].body[0].kind).toBe("binding")
        // Else branch has just the element
        expect(branches[1].body.length).toBe(1)
        expect(branches[1].body[0].kind).toBe("element")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 4 — Backward compatibility
  // ---------------------------------------------------------------------------

  describe("Property 4 — Backward compatibility", () => {
    it("code without bindings-in-conditions produces identical IR to before", () => {
      const builder = analyzeFirst(
        project,
        `
        div(() => {
          h1("static")
          p("also static")
        })
      `,
      )

      expect(builder.children.length).toBe(2)
      expect(builder.children[0].kind).toBe("element")
      expect(builder.children[1].kind).toBe("element")
      expect(builder.isReactive).toBe(false)
    })

    it("expression statements still produce StatementNode", () => {
      const builder = analyzeFirst(
        project,
        `
        div(() => {
          console.log("debug")
          p("hello")
        })
      `,
      )

      expect(builder.children.length).toBe(2)
      expect(builder.children[0].kind).toBe("statement")
      expect(builder.children[1].kind).toBe("element")
    })
  })

  // ---------------------------------------------------------------------------
  // Property 5 — Mutable binding rejection
  // ---------------------------------------------------------------------------

  describe("Property 5 — Mutable binding rejection", () => {
    it("rejects let declarations with instructive error", () => {
      expect(() =>
        analyzeFirst(
          project,
          `
          div(() => {
            let x = 1
            p(String(x))
          })
        `,
        ),
      ).toThrow(/Mutable binding.*let/)
    })

    it("rejects var declarations with instructive error", () => {
      expect(() =>
        analyzeFirst(
          project,
          `
          div(() => {
            var x = 1
            p(String(x))
          })
        `,
        ),
      ).toThrow(/Mutable binding.*var/)
    })

    it("error message suggests state() for mutable state", () => {
      try {
        analyzeFirst(
          project,
          `
          div(() => {
            let x = 1
            p(String(x))
          })
        `,
        )
        expect.fail("Should have thrown")
      } catch (e) {
        expect((e as Error).message).toContain("state(")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 6 — Multiple bindings compose
  // ---------------------------------------------------------------------------

  describe("Property 6 — Multiple bindings compose", () => {
    it("conditional depending on two bindings gets both dependency sets", () => {
      const builder = analyzeFirst(
        project,
        `
        import { CounterRef, TextRef } from "./schema-types"
        declare const count: CounterRef
        declare const title: TextRef

        div(() => {
          const a = count() > 0
          const b = title().length > 0
          if (a && b) {
            p("both")
          }
        })
      `,
      )

      // Children: binding("a"), binding("b"), conditional
      expect(builder.children.length).toBe(3)
      expect(builder.children[0].kind).toBe("binding")
      expect(builder.children[1].kind).toBe("binding")
      expect(builder.children[2].kind).toBe("conditional")

      if (builder.children[2].kind === "conditional") {
        const cond = builder.children[2]
        // Must be reactive
        expect(cond.subscriptionTarget).not.toBeNull()

        // Condition deps should include deps from both bindings
        const condDeps = cond.branches[0].condition?.dependencies.map(
          d => d.source,
        )
        expect(condDeps).toContain("count")
        expect(condDeps).toContain("title")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 7 — Binding in loop body with filter pattern
  // ---------------------------------------------------------------------------

  describe("Property 7 — Filter pattern in loop body", () => {
    it("binding in loop body preserves reactive deps for filter-like conditional", () => {
      const builder = analyzeFirst(
        project,
        `
        import { ListRef, TextRef } from "./schema-types"
        declare const items: ListRef<{ name(): string }>
        declare const search: TextRef

        ul(() => {
          for (const item of items) {
            const match = item.name().includes(search())
            if (match) {
              li(item.name())
            }
          }
        })
      `,
      )

      expect(builder.children[0].kind).toBe("loop")
      if (builder.children[0].kind === "loop") {
        const body = builder.children[0].body
        // body: binding("match"), conditional
        expect(body.length).toBe(2)
        expect(body[0].kind).toBe("binding")
        expect(body[1].kind).toBe("conditional")

        if (body[0].kind === "binding") {
          expect(body[0].name).toBe("match")
          expect(body[0].value.bindingTime).toBe("reactive")
          // The binding's deps should include search (a TextRef)
          const bindingDeps = body[0].value.dependencies.map(d => d.source)
          expect(bindingDeps).toContain("search")
        }

        if (body[1].kind === "conditional") {
          // The conditional must be reactive — subscriptionTarget is non-null
          expect(body[1].subscriptionTarget).not.toBeNull()
        }
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 8 — Binding transitivity (binding referencing binding)
  // ---------------------------------------------------------------------------

  describe("Property 8 — Binding transitivity", () => {
    it("binding referencing another binding inherits reactive classification", () => {
      const builder = analyzeFirst(
        project,
        `
        import { CounterRef } from "./schema-types"
        declare const count: CounterRef

        div(() => {
          const value = count()
          const doubled = value * 2
          p(String(doubled))
        })
      `,
      )

      // Children: binding("value"), binding("doubled"), element
      expect(builder.children.length).toBe(3)
      expect(builder.children[0].kind).toBe("binding")
      expect(builder.children[1].kind).toBe("binding")

      if (builder.children[0].kind === "binding") {
        expect(builder.children[0].name).toBe("value")
        expect(builder.children[0].value.bindingTime).toBe("reactive")
      }

      if (builder.children[1].kind === "binding") {
        expect(builder.children[1].name).toBe("doubled")
        // doubled references value which is reactive → doubled is reactive too
        expect(builder.children[1].value.bindingTime).toBe("reactive")
        // deps should include count (transitive through value)
        const deps = builder.children[1].value.dependencies.map(d => d.source)
        expect(deps).toContain("count")
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Property 9 — Render-time bindings don't pollute reactivity
  // ---------------------------------------------------------------------------

  describe("Property 9 — Render-time bindings", () => {
    it("render-time binding does not make conditional reactive", () => {
      const builder = analyzeFirst(
        project,
        `
        div(() => {
          const x = 42
          if (x > 0) {
            p("yes")
          }
        })
      `,
      )

      expect(builder.children[0].kind).toBe("binding")
      expect(builder.children[1].kind).toBe("conditional")

      if (builder.children[0].kind === "binding") {
        expect(builder.children[0].value.bindingTime).toBe("render")
      }

      if (builder.children[1].kind === "conditional") {
        // Render-time binding → render-time conditional
        expect(builder.children[1].subscriptionTarget).toBeNull()
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Destructuring — deferred (kept as StatementNode)
  // ---------------------------------------------------------------------------

  describe("Destructuring declarations", () => {
    it("destructuring declarations are kept as StatementNode (deferred)", () => {
      const builder = analyzeFirst(
        project,
        `
        div(() => {
          const { x, y } = { x: 1, y: 2 }
          p(String(x))
        })
      `,
      )

      // Destructuring should fall through to StatementNode
      expect(builder.children[0].kind).toBe("statement")
      expect(builder.children[1].kind).toBe("element")
    })
  })

  // ---------------------------------------------------------------------------
  // Builder-level dependency collection
  // ---------------------------------------------------------------------------

  describe("Builder-level dependency collection", () => {
    it("builder.allDependencies includes deps from binding values", () => {
      const builder = analyzeFirst(
        project,
        `
        import { CounterRef, TextRef } from "./schema-types"
        declare const count: CounterRef
        declare const title: TextRef

        div(() => {
          const a = count()
          const b = title()
          p("static")
        })
      `,
      )

      expect(builder.isReactive).toBe(true)
      const depSources = builder.allDependencies.map(d => d.source)
      expect(depSources).toContain("count")
      expect(depSources).toContain("title")
    })

    it("builder with only render-time bindings is not reactive", () => {
      const builder = analyzeFirst(
        project,
        `
        div(() => {
          const x = 1
          const y = 2
          p(String(x + y))
        })
      `,
      )

      expect(builder.isReactive).toBe(false)
      expect(builder.allDependencies).toHaveLength(0)
    })
  })
})
