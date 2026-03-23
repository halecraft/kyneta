import { describe, expect, it } from "vitest"
import type {
  ChildNode,
  ConditionalNode,
  Dependency,
  LoopNode,
  SourceSpan,
} from "./ir.js"
import {
  createBinding,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
} from "./ir.js"
import { detectFilterPattern } from "./patterns.js"

// =============================================================================
// Helpers
// =============================================================================

function span(): SourceSpan {
  return createSpan(1, 1, 1, 1)
}

function dep(
  source: string,
  deltaKind: Dependency["deltaKind"] = "replace",
): Dependency {
  return { source, deltaKind }
}

function reactiveCond(
  source: string,
  deps: Dependency[],
  body: ChildNode[],
): ConditionalNode {
  const condition = createContent(source, "reactive", deps, span())
  const branch = createConditionalBranch(condition, body, span())
  return createConditional([branch], deps[0] ?? dep("unknown"), span())
}

function renderCond(source: string, body: ChildNode[]): ConditionalNode {
  const condition = createContent(source, "render", [], span())
  const branch = createConditionalBranch(condition, body, span())
  return createConditional([branch], null, span())
}

function reactiveCondWithElse(
  source: string,
  deps: Dependency[],
  thenBody: ChildNode[],
  elseBody: ChildNode[],
): ConditionalNode {
  const condition = createContent(source, "reactive", deps, span())
  const thenBranch = createConditionalBranch(condition, thenBody, span())
  const elseBranch = createConditionalBranch(null, elseBody, span())
  return createConditional([thenBranch, elseBranch], deps[0], span())
}

function reactiveCondElseIf(
  conditions: Array<{ source: string; deps: Dependency[]; body: ChildNode[] }>,
): ConditionalNode {
  const branches = conditions.map(c =>
    createConditionalBranch(
      c.source === "__else__"
        ? null
        : createContent(c.source, "reactive", c.deps, span()),
      c.body,
      span(),
    ),
  )
  const firstDeps = conditions[0]?.deps ?? []
  return createConditional(branches, firstDeps[0] ?? null, span())
}

/** A simple DOM element for use as loop body content */
function li(...textArgs: string[]): ChildNode {
  const children: ChildNode[] = textArgs.map(t => createLiteral(t, span()))
  return createElement("li", [], [], children, [], span())
}

function reactiveLoop(
  iterableSource: string,
  itemVariable: string,
  body: ChildNode[],
  loopDeps?: Dependency[],
): LoopNode {
  const deps = loopDeps ?? [dep(iterableSource, "sequence")]
  return createLoop(
    iterableSource,
    "reactive",
    itemVariable,
    null,
    body,
    deps,
    span(),
  )
}

function renderLoop(
  iterableSource: string,
  itemVariable: string,
  body: ChildNode[],
): LoopNode {
  return createLoop(
    iterableSource,
    "render",
    itemVariable,
    null,
    body,
    [],
    span(),
  )
}

function binding(name: string, source: string, deps: Dependency[]): ChildNode {
  return createBinding(
    name,
    createContent(
      source,
      deps.length > 0 ? "reactive" : "render",
      deps,
      span(),
    ),
    span(),
  )
}

// =============================================================================
// Tests
// =============================================================================

describe("detectFilterPattern", () => {
  // ---------------------------------------------------------------------------
  // Positive detections
  // ---------------------------------------------------------------------------

  describe("positive detections", () => {
    it("Test 1 — simple filter detected", () => {
      // for (const item of list) { if (item.active()) { li(item.name()) } }
      const loop = reactiveLoop("list", "item", [
        reactiveCond(
          "item.active()",
          [dep("item.active")],
          [li("item.name()")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("item.active")
      expect(result?.itemDeps[0].classification).toBe("item")
      expect(result?.externalDeps).toHaveLength(0)
    })

    it("Test 2 — filter with external dep detected", () => {
      // for (const item of list) { if (item.name().includes(search())) { li(...) } }
      const loop = reactiveLoop("list", "item", [
        reactiveCond(
          "item.name().includes(search())",
          [dep("item.name", "text"), dep("search", "text")],
          [li("item.name()")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("item.name")
      expect(result?.externalDeps).toHaveLength(1)
      expect(result?.externalDeps[0].source).toBe("search")
    })

    it("Test 3 — filter with bindings detected", () => {
      // for (const item of list) {
      //   const match = item.name().includes(search())
      //   if (match) { li(item.name()) }
      // }
      // After analysis, the condition's deps are already [item.name, search] (flattened)
      const loop = reactiveLoop("list", "item", [
        binding("match", "item.name().includes(search())", [
          dep("item.name", "text"),
          dep("search", "text"),
        ]),
        reactiveCond(
          "match",
          [dep("item.name", "text"), dep("search", "text")],
          [li("item.name()")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("item.name")
      expect(result?.externalDeps).toHaveLength(1)
      expect(result?.externalDeps[0].source).toBe("search")
    })

    it("Test 4 — chained filters flatten to single predicate", () => {
      // for (const recipe of doc.recipes) {
      //   if (recipe.name().includes(searchText())) {
      //     if (!veggieOnly() || recipe.vegetarian()) {
      //       if (recipe.ingredients.length > 0) {
      //         RecipeCard({ recipe })
      //       }
      //     }
      //   }
      // }
      const innermost = reactiveCond(
        "recipe.ingredients.length > 0",
        [dep("recipe.ingredients", "sequence")],
        [li("RecipeCard")],
      )
      const middle = reactiveCond(
        "!veggieOnly() || recipe.vegetarian()",
        [dep("veggieOnly"), dep("recipe.vegetarian")],
        [innermost],
      )
      const outer = reactiveCond(
        "recipe.name().includes(searchText())",
        [dep("recipe.name", "text"), dep("searchText", "text")],
        [middle],
      )
      const loop = reactiveLoop("doc.recipes", "recipe", [outer])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      // Predicate is conjunction of all three
      expect(result?.predicate.source).toBe(
        "(recipe.name().includes(searchText())) && (!veggieOnly() || recipe.vegetarian()) && (recipe.ingredients.length > 0)",
      )
      // Item deps
      const itemSources = result?.itemDeps.map(d => d.source).sort()
      expect(itemSources).toEqual([
        "recipe.ingredients",
        "recipe.name",
        "recipe.vegetarian",
      ])
      // External deps
      const extSources = result?.externalDeps.map(d => d.source).sort()
      expect(extSources).toEqual(["searchText", "veggieOnly"])
    })

    it("Test 5 — cross-list join (external collection dep)", () => {
      // for (const recipe of doc.recipes) {
      //   if (doc.favorites.includes(recipe.id())) { RecipeCard({ recipe }) }
      // }
      const loop = reactiveLoop("doc.recipes", "recipe", [
        reactiveCond(
          "doc.favorites.includes(recipe.id())",
          [dep("doc.favorites", "sequence"), dep("recipe.id")],
          [li("RecipeCard")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("recipe.id")
      expect(result?.externalDeps).toHaveLength(1)
      expect(result?.externalDeps[0].source).toBe("doc.favorites")
    })

    it("Test 6 — self-mutation pattern", () => {
      // for (const task of doc.tasks) {
      //   if (!task.completed()) { li(() => { span(task.title) }) }
      // }
      const loop = reactiveLoop("doc.tasks", "task", [
        reactiveCond(
          "!task.completed()",
          [dep("task.completed")],
          [li("task.title")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("task.completed")
      expect(result?.externalDeps).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Negative rejections
  // ---------------------------------------------------------------------------

  describe("negative rejections", () => {
    it("Test 7 — NOT a filter — has else branch", () => {
      // for (const item of doc.ingredients) {
      //   if (item.category() === "legume") { LegumeCard() } else { IngredientCard() }
      // }
      const loop = reactiveLoop("doc.ingredients", "item", [
        reactiveCondWithElse(
          'item.category() === "legume"',
          [dep("item.category")],
          [li("LegumeCard")],
          [li("IngredientCard")],
        ),
      ])

      const result = detectFilterPattern(loop)
      expect(result).toBeNull()
    })

    it("Test 8 — NOT a filter — DOM outside if", () => {
      // for (const item of list) {
      //   p("header")
      //   if (pred) { li(...) }
      // }
      const loop = reactiveLoop("list", "item", [
        createElement(
          "p",
          [],
          [],
          [createLiteral("header", span())],
          [],
          span(),
        ),
        reactiveCond(
          "item.active()",
          [dep("item.active")],
          [li("item.name()")],
        ),
      ])

      const result = detectFilterPattern(loop)
      expect(result).toBeNull()
    })

    it("Test 9 — NOT a filter — non-reactive condition", () => {
      // for (const item of list) {
      //   if (true) { li(...) }
      // }
      const loop = reactiveLoop("list", "item", [
        renderCond("true", [li("item.name()")]),
      ])

      const result = detectFilterPattern(loop)
      expect(result).toBeNull()
    })

    it("Test 10 — NOT a filter — static loop", () => {
      // for (const item of [1, 2, 3]) {
      //   if (item > 1) { li(item) }
      // }
      const loop = renderLoop("[1, 2, 3]", "item", [
        reactiveCond("item > 1", [dep("item")], [li("item")]),
      ])

      const result = detectFilterPattern(loop)
      expect(result).toBeNull()
    })

    it("Test 11 — NOT a filter — only external deps", () => {
      // for (const item of list) {
      //   if (globalFlag()) { li(item.name()) }
      // }
      const loop = reactiveLoop("list", "item", [
        reactiveCond("globalFlag()", [dep("globalFlag")], [li("item.name()")]),
      ])

      const result = detectFilterPattern(loop)
      expect(result).toBeNull()
    })

    it("Test 12 — NOT a filter — if/else-if without final else", () => {
      // for (const item of doc.ingredients) {
      //   if (item.category() === "legume") { LegumeCard() }
      //   else if (item.inStock()) { IngredientCard() }
      // }
      const loop = reactiveLoop("doc.ingredients", "item", [
        reactiveCondElseIf([
          {
            source: 'item.category() === "legume"',
            deps: [dep("item.category")],
            body: [li("LegumeCard")],
          },
          {
            source: "item.inStock()",
            deps: [dep("item.inStock")],
            body: [li("IngredientCard")],
          },
        ]),
      ])

      const result = detectFilterPattern(loop)
      expect(result).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Real-world integration patterns
  // ---------------------------------------------------------------------------

  describe("real-world patterns", () => {
    it("Test 13 — filter + map (derived binding in predicate and render body)", () => {
      // for (const recipe of doc.recipes) {
      //   const displayName = recipe.name().toUpperCase()
      //   if (displayName.includes(filterText().toUpperCase())) { p(displayName) }
      // }
      // After analysis: condition deps are [recipe.name, filterText] (flattened through binding)
      const loop = reactiveLoop("doc.recipes", "recipe", [
        binding("displayName", "recipe.name().toUpperCase()", [
          dep("recipe.name", "text"),
        ]),
        reactiveCond(
          "displayName.includes(filterText().toUpperCase())",
          [dep("recipe.name", "text"), dep("filterText", "text")],
          [
            createElement(
              "p",
              [],
              [],
              [
                createContent(
                  "displayName",
                  "reactive",
                  [dep("recipe.name", "text")],
                  span(),
                ),
              ],
              [],
              span(),
            ),
          ],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("recipe.name")
      expect(result?.externalDeps).toHaveLength(1)
      expect(result?.externalDeps[0].source).toBe("filterText")
    })

    it("Test 14 — recipe-book compound filter (the motivating example)", () => {
      // for (const recipe of doc.recipes) {
      //   const nameMatch = recipe.name().toLowerCase().includes(filterText().toLowerCase())
      //   const veggieMatch = !veggieOnly() || recipe.vegetarian()
      //   if (nameMatch && veggieMatch) { RecipeCard({ recipe }) }
      // }
      // After analysis: condition deps are [recipe.name, filterText, veggieOnly, recipe.vegetarian]
      const loop = reactiveLoop("doc.recipes", "recipe", [
        binding(
          "nameMatch",
          "recipe.name().toLowerCase().includes(filterText().toLowerCase())",
          [dep("recipe.name", "text"), dep("filterText", "text")],
        ),
        binding("veggieMatch", "!veggieOnly() || recipe.vegetarian()", [
          dep("veggieOnly"),
          dep("recipe.vegetarian"),
        ]),
        reactiveCond(
          "nameMatch && veggieMatch",
          [
            dep("recipe.name", "text"),
            dep("filterText", "text"),
            dep("veggieOnly"),
            dep("recipe.vegetarian"),
          ],
          [li("RecipeCard")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()

      const itemSources = result?.itemDeps.map(d => d.source).sort()
      expect(itemSources).toEqual(["recipe.name", "recipe.vegetarian"])

      const extSources = result?.externalDeps.map(d => d.source).sort()
      expect(extSources).toEqual(["filterText", "veggieOnly"])
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("empty loop body returns null", () => {
      const loop = reactiveLoop("list", "item", [])
      expect(detectFilterPattern(loop)).toBeNull()
    })

    it("loop body with only bindings and no conditional returns null", () => {
      const loop = reactiveLoop("list", "item", [
        binding("x", "item.name()", [dep("item.name", "text")]),
      ])
      expect(detectFilterPattern(loop)).toBeNull()
    })

    it("chained filter predicate has reactive bindingTime", () => {
      const inner = reactiveCond(
        "recipe.vegetarian()",
        [dep("recipe.vegetarian")],
        [li("RecipeCard")],
      )
      const outer = reactiveCond(
        "recipe.name().includes(search())",
        [dep("recipe.name", "text"), dep("search", "text")],
        [inner],
      )
      const loop = reactiveLoop("doc.recipes", "recipe", [outer])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.predicate.bindingTime).toBe("reactive")
    })

    it("chained filter deduplicates dependencies", () => {
      // Both conditions reference recipe.name
      const inner = reactiveCond(
        "recipe.name().length > 0",
        [dep("recipe.name", "text")],
        [li("RecipeCard")],
      )
      const outer = reactiveCond(
        "recipe.name().includes(search())",
        [dep("recipe.name", "text"), dep("search", "text")],
        [inner],
      )
      const loop = reactiveLoop("doc.recipes", "recipe", [outer])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      // recipe.name should appear only once (deduplicated)
      const allSources = [
        // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
        ...result!.itemDeps.map(d => d.source),
        // biome-ignore lint/style/noNonNullAssertion: asserted non-null above
        ...result!.externalDeps.map(d => d.source),
      ]
      const recipeName = allSources.filter(s => s === "recipe.name")
      expect(recipeName).toHaveLength(1)
    })

    it("structural deps from predicate are excluded from itemDeps and externalDeps", () => {
      // Predicate depends on the iterable source itself
      const loop = reactiveLoop("doc.recipes", "recipe", [
        reactiveCond(
          "doc.recipes.length > 0 && recipe.active()",
          [dep("doc.recipes", "sequence"), dep("recipe.active")],
          [li("RecipeCard")],
        ),
      ])

      const result = detectFilterPattern(loop)

      expect(result).not.toBeNull()
      expect(result?.itemDeps).toHaveLength(1)
      expect(result?.itemDeps[0].source).toBe("recipe.active")
      expect(result?.externalDeps).toHaveLength(0)
      // structural deps are classified but not in itemDeps or externalDeps
    })
  })
})
