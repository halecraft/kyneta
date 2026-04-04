import { beforeEach, describe, expect, it } from "vitest"
import {
  assertMaxMutations,
  createCountingContainer,
  createMockSequenceRef,
  installDOMGlobals,
  listRegion,
  resetTestState,
  Scope,
  transformSource,
  withTypes,
} from "./helpers.js"

installDOMGlobals()

describe("compiler integration - list regions", () => {
  beforeEach(() => {
    resetTestState()
  })

  describe("for-of detection", () => {
    it("should detect for-of loop and create ListRegionNode in IR", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      expect(result.ir).toHaveLength(1)
      expect(result.ir[0].children).toHaveLength(1)
      expect(result.ir[0].children[0].kind).toBe("loop")

      const loop = result.ir[0].children[0] as any
      expect(loop.iterableSource).toBe("items")
      expect(loop.iterableBindingTime).toBe("reactive")
      expect(loop.itemVariable).toBe("item")
      expect(loop.indexVariable).toBeNull()
    })

    it("should capture index variable from array destructuring", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const [i, item] of items.entries()) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const loop = result.ir[0].children[0] as any
      expect(loop.kind).toBe("loop")
      expect(loop.iterableBindingTime).toBe("reactive")
      expect(loop.itemVariable).toBe("item")
      expect(loop.indexVariable).toBe("i")
    })

    it("should capture loop body as list region body", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      const listRegionNode = result.ir[0].children[0] as any
      expect(listRegionNode.body).toHaveLength(1)
      expect(listRegionNode.body[0].kind).toBe("element")
      expect(listRegionNode.body[0].tag).toBe("li")
    })
  })

  describe("Generated listRegion call", () => {
    it("should generate listRegion call with correct parameters", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      expect(result.code).toContain("listRegion")
      expect(result.code).toContain("items")
      expect(result.code).toContain("create:")
      expect(result.code).toContain("(item, _index)")
      expect(result.code).toContain("scope")
    })

    it("should generate create handler that returns element", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should create li element
      expect(result.code).toContain('document.createElement("li")')
      // Should return element directly (optimized path for single element)
      expect(result.code).toContain("return _li")
    })

    it("should use index variable when provided", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const [idx, item] of items.entries()) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Should use the actual index variable name
      expect(result.code).toContain("(item, idx)")
    })
  })

  describe("Nested reactive content in list items", () => {
    it("should handle static content in list items", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // Item access in list should be treated as expression
      expect(result.code).toContain("createTextNode(String(item))")
    })
  })

  describe("O(k) verification with runtime", () => {
    it("should render initial list items", () => {
      const { ref: items } = createMockSequenceRef<string>([])
      items.push("item1")
      items.push("item2")
      items.push("item3")

      const scope = new Scope()
      const ul = document.createElement("ul")

      listRegion(
        ul,
        items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(ul.children.length).toBe(3)
      expect(ul.children[0].textContent).toBe("item1")
      expect(ul.children[1].textContent).toBe("item2")
      expect(ul.children[2].textContent).toBe("item3")

      scope.dispose()
    })

    it("should achieve O(1) DOM operations for single insert", () => {
      const { container, counts, reset } = createCountingContainer("ul")
      const { ref: items } = createMockSequenceRef<string>([])

      // Add initial items
      for (let i = 0; i < 10; i++) {
        items.push(`item-${i}`)
      }

      const scope = new Scope()

      listRegion(
        container,
        items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(10)
      reset() // Clear initial render counts

      // Insert ONE item in the middle
      items.insert(5, "new-item")

      // Should be O(1), not O(n)
      assertMaxMutations(counts, 1)
      expect(counts.insertBefore).toBe(1)

      scope.dispose()
    })

    it("should achieve O(1) DOM operations for single delete", () => {
      const { container, counts, reset } = createCountingContainer("ul")
      const { ref: items } = createMockSequenceRef<string>([])

      // Add initial items
      for (let i = 0; i < 10; i++) {
        items.push(`item-${i}`)
      }

      const scope = new Scope()

      listRegion(
        container,
        items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(container.children.length).toBe(10)
      reset() // Clear initial render counts

      // Delete ONE item
      items.delete(5, 1)

      // Should be O(1), not O(n)
      assertMaxMutations(counts, 1)
      expect(counts.removeChild).toBe(1)
      expect(container.children.length).toBe(9)

      scope.dispose()
    })

    it("should clean up item scopes when items are deleted", () => {
      const { ref: items } = createMockSequenceRef<string>([])
      items.push("a")
      items.push("b")
      items.push("c")

      const scope = new Scope()
      const ul = document.createElement("ul")

      listRegion(
        ul,
        items,
        {
          create: (item: string) => {
            const li = document.createElement("li")
            li.textContent = item
            return li
          },
        },
        scope,
      )

      expect(ul.children.length).toBe(3)

      // Delete middle item
      items.delete(1, 1)

      expect(ul.children.length).toBe(2)
      expect(ul.children[0].textContent).toBe("a")
      expect(ul.children[1].textContent).toBe("c")

      scope.dispose()
    })
  })

  describe("filter pattern end-to-end", () => {
    it("should detect filter pattern and emit filteredListRegion in codegen", () => {
      const source = withTypes(`
        interface RecipeRef {
          name: TextRef
          vegetarian: BooleanRef
        }

        interface BooleanRef extends HasChangefeed<boolean, ReplaceChange<boolean>> {
          (): boolean
        }

        type ReplaceChange<T = unknown> = { readonly type: "replace"; readonly value: T }

        interface LocalRef<T> extends HasChangefeed<T, ReplaceChange<T>> {
          (): T
        }

        declare const doc: { recipes: ListRef<RecipeRef> }
        declare const filterText: LocalRef<string>
        declare const veggieOnly: LocalRef<boolean>

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
      `)

      const result = transformSource(source, { target: "dom" })

      // The loop should have filter metadata in the IR
      expect(result.ir).toHaveLength(1)
      const loop = result.ir[0].children[0] as any
      expect(loop.kind).toBe("loop")
      expect(loop.filter).toBeDefined()

      if (loop.filter) {
        // Item deps should include recipe.name and recipe.vegetarian
        const itemSources = loop.filter.itemDeps
          .map((d: any) => d.source)
          .sort()
        expect(itemSources).toContain("recipe.name")
        expect(itemSources).toContain("recipe.vegetarian")

        // External deps should include filterText and veggieOnly
        const extSources = loop.filter.externalDeps
          .map((d: any) => d.source)
          .sort()
        expect(extSources).toContain("filterText")
        expect(extSources).toContain("veggieOnly")
      }

      // Generated code should use filteredListRegion, not listRegion
      expect(result.code).toContain("filteredListRegion")
      expect(result.code).not.toMatch(/\blistRegion\(/)

      // Should contain the expected handler properties
      expect(result.code).toContain("create:")
      expect(result.code).toContain("predicate:")
      expect(result.code).toContain("externalRefs:")
      expect(result.code).toContain("itemRefs:")

      // Should import filteredListRegion (not listRegion) from runtime
      expect(result.code).toContain("filteredListRegion")
    })

    it("should still emit listRegion for non-filter loops", () => {
      const source = withTypes(`
        declare const items: ListRef<string>

        ul(() => {
          for (const item of items) {
            li(item)
          }
        })
      `)

      const result = transformSource(source, { target: "dom" })

      // No filter metadata
      const loop = result.ir[0].children[0] as any
      expect(loop.kind).toBe("loop")
      expect(loop.filter).toBeUndefined()

      // Should use listRegion, not filteredListRegion
      expect(result.code).toContain("listRegion")
      expect(result.code).not.toContain("filteredListRegion")
    })
  })
})
