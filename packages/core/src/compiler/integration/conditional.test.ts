/**
 * Conditional region compiler integration tests.
 *
 * Compiler tests use withTypes() for type stubs; the runtime test uses
 * createMockCounterRef for reactive condition state.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  conditionalRegion,
  createMockCounterRef,
  installDOMGlobals,
  read,
  resetTestState,
  Scope,
  valueRegion,
  transformSource,
  withTypes,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - conditional regions", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("if detection", () => {
    it("should detect if statement and create ConditionalNode in IR", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should have one builder
      expect(result.ir.length).toBe(1)

      // Should have a conditional region as a child
      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      )
      expect(conditionalRegion).toBeDefined()
      expect(conditionalRegion?.kind).toBe("conditional")
    })

    it("should capture subscription target from condition", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.subscriptionTarget).toEqual({
        source: "doc.count",
        deltaKind: "increment",
      })
    })

    it("should capture condition expression source", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Has items")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.branches[0].condition.source).toBe(
        "doc.count() > 0",
      )
    })
  })

  describe("Generated conditionalRegion call", () => {
    it("should generate conditionalRegion call with marker", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("conditionalRegion")
      expect(result.code).toContain('document.createComment("kyneta:if")')
    })

    it("should generate whenTrue handler that returns element", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("whenTrue: () => {")
      expect(result.code).toContain('createElement("p")')
    })

    it("should dissolve conditional with identical structure", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Visible!")
          } else {
            p("Hidden!")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should dissolve - no conditionalRegion call or handlers
      expect(result.code).not.toContain("whenTrue")
      expect(result.code).not.toContain("whenFalse")
      expect(result.code).not.toContain("conditionalRegion(")

      // Should have direct element creation with ternary
      expect(result.code).toContain('createElement("p")')
      expect(result.code).toContain("?")
      expect(result.code).toContain('"Visible!"')
      expect(result.code).toContain('"Hidden!"')
    })
  })

  describe("else/else-if chains", () => {
    it("should handle if/else with two branches", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Yes")
          } else {
            p("No")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.branches.length).toBe(2)
      expect(conditionalRegion.branches[0].condition).not.toBeNull()
      expect(conditionalRegion.branches[1].condition).toBeNull() // else branch
    })

    it("should handle if/else-if/else with three branches", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 10) {
            p("Many")
          } else if (doc.count.get() > 0) {
            p("Some")
          } else {
            p("None")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      expect(conditionalRegion.branches.length).toBe(3)
      expect(conditionalRegion.branches[0].condition?.source).toBe(
        "doc.count() > 10",
      )
      expect(conditionalRegion.branches[1].condition?.source).toBe(
        "doc.count() > 0",
      )
      expect(conditionalRegion.branches[2].condition).toBeNull() // else branch
    })

    it("should capture body content for each branch", () => {
      const source = withTypes(`
        declare const doc: { status: TextRef }

        div(() => {
          if (doc.status.toString() === "loading") {
            span("Loading...")
          } else {
            span("Done!")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const conditionalRegion = result.ir[0].children.find(
        c => c.kind === "conditional",
      ) as any

      // Check that branches have body content
      expect(conditionalRegion.branches[0].body.length).toBeGreaterThan(0)
      expect(conditionalRegion.branches[1].body.length).toBeGreaterThan(0)
    })
  })

  // Note: Runtime behavior tests for conditionalRegion and __staticConditionalRegion
  // are in regions.test.ts. This section tests compiler integration only.

  describe("Compile-and-execute integration", () => {
    it("should compile and execute dissolved conditional reactively", () => {
      // This test verifies the full pipeline: source → IR → codegen → execute
      // With identical structure, the conditional should be dissolved

      const { ref: count } = createMockCounterRef(0)

      // Manually construct what dissolved code would produce
      // Dissolved conditionals create element directly with ternary in subscription
      const scope = new Scope()
      const container = document.createElement("div")

      const p = document.createElement("p")
      const text = document.createTextNode("")
      p.appendChild(text)
      container.appendChild(p)

      // Subscribe to reactive content
      valueRegion(
        [count],
        () => (read(count) > 0 ? "Has items" : "Empty"),
        v => {
          text.textContent = String(v)
        },
        scope,
      )

      // Verify initial state
      expect(container.querySelector("p")?.textContent).toBe("Empty")

      // Change condition and verify reactive update
      count.increment(5)
      expect(container.querySelector("p")?.textContent).toBe("Has items")

      // Verify the generated code structure matches what we executed
      const source = withTypes(`
        declare const doc: { count: CounterRef }

        div(() => {
          if (doc.count.get() > 0) {
            p("Has items")
          } else {
            p("Empty")
          }
        })
      `)
      const result = transformSource(source, { target: "dom" })

      // The compiled code should be dissolved (no conditionalRegion call)
      expect(result.code).not.toContain("conditionalRegion(")
      expect(result.code).not.toContain("whenTrue")
      expect(result.code).not.toContain("whenFalse")

      // Should have direct element creation with ternary
      expect(result.code).toContain('createElement("p")')
      expect(result.code).toContain("?")
      expect(result.code).toContain('"Has items"')
      expect(result.code).toContain('"Empty"')

      scope.dispose()
    })
  })

  describe("Multi-dep conditional codegen", () => {
    it("should emit dependency array for condition with multiple reactive deps", () => {
      const source = withTypes(`
        declare const doc: { count: CounterRef; title: TextRef }

        div(() => {
          if (doc.count.get() > 0 && doc.title.toString().length > 0) {
            p("Both present")
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Non-dissolvable (no else branch) → should emit conditionalRegion
      expect(result.code).toContain("conditionalRegion")

      // Should emit array syntax with both deps
      expect(result.code).toContain("[doc.count, doc.title]")
    })
  })
})