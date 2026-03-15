/**
 * Combined integration tests.
 *
 * Compiler-only tests verify compiled output for complex patterns.
 * Runtime tests use mock refs instead of Loro documents.
 */

import { beforeEach, describe, expect, it } from "vitest"
import {
  conditionalRegion,
  createMockCounterRef,
  createMockTextRef,
  installDOMGlobals,
  listRegion,
  read,
  resetTestState,
  Scope,
  subscribe,
  valueRegion,
  transformSource,
  withTypes,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - combined scenarios", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("All patterns working together", () => {
    it("should compile list with reactive content and conditionals", () => {
      const source = withTypes(`
        declare const doc: {
          items: ListRef<{ name: TextRef, done: CounterRef }>
          showCompleted: CounterRef
        }

        div(() => {
          h1("Todo List")

          if (doc.showCompleted.get() > 0) {
            p("Showing completed items")
          }

          for (const item of doc.items) {
            li(() => {
              span(item.name.toString())
              if (item.done.get() > 0) {
                span(" ✓")
              }
            })
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should have one builder
      expect(result.ir.length).toBe(1)

      // Should contain list region
      expect(result.code).toContain("listRegion")

      // Should contain conditional region
      expect(result.code).toContain("conditionalRegion")

      // Should have subscription calls for reactive content
      expect(result.code).toContain("doc.showCompleted")
      expect(result.code).toContain("item.done")
    })



    it("should compile nested lists with reactive items", () => {
      const source = withTypes(`
        declare const doc: {
          categories: ListRef<{
            name: TextRef
            items: ListRef<{ text: TextRef }>
          }>
        }

        div(() => {
          for (const category of doc.categories) {
            section(() => {
              h2(category.name.toString())

              ul(() => {
                for (const item of category.items) {
                  li(item.text.toString())
                }
              })
            })
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should have nested list regions (at least 2 - may include import statement)
      const listRegionCount = (result.code.match(/listRegion/g) || []).length
      expect(listRegionCount).toBeGreaterThanOrEqual(2) // outer and inner lists
    })

    it("should compile conditional with different content types", () => {
      const source = withTypes(`
        declare const doc: {
          mode: CounterRef
          items: ListRef<string>
        }

        div(() => {
          if (doc.mode.get() === 0) {
            p("Empty state - no items")
          } else if (doc.mode.get() === 1) {
            ul(() => {
              for (const item of doc.items) {
                li(item)
              }
            })
          } else {
            div(() => {
              h2("Grid view")
              for (const item of doc.items) {
                span(item)
              }
            })
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should have conditional region with multiple branches
      const conditionalRegionNode = result.ir[0].children.find(
        c => c.kind === "conditional",
      )
      expect(conditionalRegionNode).toBeDefined()
      if (conditionalRegionNode && conditionalRegionNode.kind === "conditional") {
        expect(conditionalRegionNode.branches.length).toBe(3)
      }

      // Should have list regions inside branches
      expect(result.code).toContain("listRegion")
    })

  })

  describe("Runtime execution of combined patterns", () => {
    it("should handle reactive updates across multiple features", () => {
      const { ref: title } = createMockTextRef("Initial Title")
      const { ref: showDetails } = createMockCounterRef(0)

      const scope = new Scope()
      const container = document.createElement("div")

      // Title element with reactive text
      const h1 = document.createElement("h1")
      const titleText = document.createTextNode(read(title) as string)
      h1.appendChild(titleText)
      container.appendChild(h1)

      // Subscribe to title changes
      valueRegion(
        [title],
        () => read(title),
        value => {
          titleText.textContent = value
        },
        scope,
      )

      // Conditional details section
      const marker = document.createComment("kyneta:if")
      container.appendChild(marker)

      conditionalRegion(
        marker,
        showDetails,
        () => read(showDetails) > 0,
        {
          whenTrue: () => {
            const details = document.createElement("p")
            details.textContent = "Details are visible"
            return details
          },
          whenFalse: () => {
            const hidden = document.createElement("p")
            hidden.textContent = "Details hidden"
            return hidden
          },
        },
        scope,
      )

      // Initial state
      expect(container.querySelector("h1")?.textContent).toBe("Initial Title")
      expect(container.textContent).toContain("Details hidden")

      // Update title
      title.delete(0, (read(title) as string).length)
      title.insert(0, "Updated Title")
      expect(container.querySelector("h1")?.textContent).toBe("Updated Title")

      // Show details
      showDetails.increment(1)
      expect(container.textContent).toContain("Details are visible")

      scope.dispose()
    })
  })
})