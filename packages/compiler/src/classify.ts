import type { Dependency } from "./ir.js"

/**
 * Classification of a dependency relative to a loop variable.
 *
 * - "item": navigates from the loop variable (e.g., `recipe.name` where
 *   `recipe` is the loop var). Requires per-item subscription.
 * - "external": reactive but not derived from the loop variable (e.g.,
 *   `filterText`). Requires one shared subscription across all items.
 * - "structural": the iterable collection itself (e.g., `doc.recipes`).
 *   Already handled by the existing listRegion subscribe.
 */
export type DependencyClassification = "item" | "external" | "structural"

export interface ClassifiedDependency extends Dependency {
  classification: DependencyClassification
}

/**
 * Classify dependencies relative to a loop variable.
 *
 * By the time dependencies reach this function, `extractDependencies`
 * has already resolved bindings — transitive deps are flattened into
 * leaf dependency sources (e.g., `recipe.name`, `filterText`). So
 * classification is pure string-prefix matching:
 *
 * Algorithm:
 * 1. dep.source === iterableSource → "structural"
 * 2. dep.source starts with loopVariable + "." or equals loopVariable → "item"
 * 3. Otherwise → "external"
 *
 * The classification is sound (never misclassifies external as item)
 * and conservative (uncertain cases default to "external", which is
 * safe — causes O(n) re-evaluation instead of O(1), but never misses
 * an update).
 */
export function classifyDependencies(
  deps: readonly Dependency[],
  loopVariable: string,
  iterableSource: string,
): ClassifiedDependency[] {
  return deps.map((dep) => ({
    ...dep,
    classification: classifySingle(dep.source, loopVariable, iterableSource),
  }))
}

function classifySingle(
  source: string,
  loopVariable: string,
  iterableSource: string,
): DependencyClassification {
  // 1. Structural — the iterable collection itself
  if (source === iterableSource) {
    return "structural"
  }

  // 2. Item-dependent — navigates from the loop variable
  //    Must check exact match OR dot-boundary prefix to avoid
  //    false positives (e.g., "recipeCount" for loop var "recipe")
  if (source === loopVariable || source.startsWith(loopVariable + ".")) {
    return "item"
  }

  // 3. External — everything else (conservative default)
  return "external"
}