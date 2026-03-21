import { describe, expect, it } from "vitest"
import { classifyDependencies } from "./classify.js"
import type { Dependency } from "./ir.js"

describe("classifyDependencies", () => {
  // ---------------------------------------------------------------------------
  // Property 1 — Partition
  // ---------------------------------------------------------------------------

  it("partitions deps into item, external, and structural with no overlap", () => {
    const deps: Dependency[] = [
      { source: "recipe.name", deltaKind: "text" },
      { source: "filterText", deltaKind: "replace" },
      { source: "doc.recipes", deltaKind: "sequence" },
    ]

    const result = classifyDependencies(deps, "recipe", "doc.recipes")

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({
      source: "recipe.name",
      deltaKind: "text",
      classification: "item",
    })
    expect(result[1]).toEqual({
      source: "filterText",
      deltaKind: "replace",
      classification: "external",
    })
    expect(result[2]).toEqual({
      source: "doc.recipes",
      deltaKind: "sequence",
      classification: "structural",
    })

    // Verify partition property: each classification appears exactly once
    const classifications = result.map((d) => d.classification)
    expect(classifications).toContain("item")
    expect(classifications).toContain("external")
    expect(classifications).toContain("structural")
  })

  // ---------------------------------------------------------------------------
  // Property 2 — Dot-boundary safety
  // ---------------------------------------------------------------------------

  it("does not classify 'recipeCount' as item-dependent for loop var 'recipe'", () => {
    const deps: Dependency[] = [
      { source: "recipeCount", deltaKind: "replace" },
      { source: "recipe.name", deltaKind: "text" },
      { source: "recipes", deltaKind: "sequence" },
    ]

    const result = classifyDependencies(deps, "recipe", "doc.recipes")

    // "recipeCount" starts with "recipe" but NOT "recipe." — must be external
    expect(result[0].classification).toBe("external")

    // "recipe.name" starts with "recipe." — item
    expect(result[1].classification).toBe("item")

    // "recipes" is not the loop var and not prefixed with "recipe." — external
    expect(result[2].classification).toBe("external")
  })

  // ---------------------------------------------------------------------------
  // Property 3 — Mixed deps
  // ---------------------------------------------------------------------------

  it("classifies mixed item+external deps from a single expression", () => {
    // recipe.name().includes(search()) → deps [recipe.name, search]
    const deps: Dependency[] = [
      { source: "recipe.name", deltaKind: "text" },
      { source: "search", deltaKind: "text" },
    ]

    const result = classifyDependencies(deps, "recipe", "doc.recipes")

    expect(result[0].classification).toBe("item")
    expect(result[1].classification).toBe("external")
  })

  // ---------------------------------------------------------------------------
  // Property 4 — Conservative fallback
  // ---------------------------------------------------------------------------

  it("classifies unknown deps as external", () => {
    const deps: Dependency[] = [
      { source: "someGlobal", deltaKind: "replace" },
      { source: "deeply.nested.ref", deltaKind: "text" },
    ]

    const result = classifyDependencies(deps, "item", "doc.items")

    // Neither matches the loop variable nor the iterable source
    expect(result[0].classification).toBe("external")
    expect(result[1].classification).toBe("external")
  })

  // ---------------------------------------------------------------------------
  // Property 5 — Structural detection
  // ---------------------------------------------------------------------------

  it("classifies the iterable source as structural", () => {
    const deps: Dependency[] = [
      { source: "doc.items", deltaKind: "sequence" },
    ]

    const result = classifyDependencies(deps, "item", "doc.items")

    expect(result[0].classification).toBe("structural")
  })

  it("classifies bare loop variable as item-dependent", () => {
    // Edge case: the loop variable itself appears as a dep
    // (e.g., iterating a list of refs where each item IS a Changefeed)
    const deps: Dependency[] = [
      { source: "item", deltaKind: "replace" },
    ]

    const result = classifyDependencies(deps, "item", "doc.items")

    expect(result[0].classification).toBe("item")
  })

  it("returns empty array for empty deps", () => {
    const result = classifyDependencies([], "item", "doc.items")
    expect(result).toEqual([])
  })
})