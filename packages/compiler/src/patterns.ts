import type { LoopNode, ConditionalNode, ContentNode, ChildNode } from "./ir.js"
import type { FilterMetadata } from "./ir.js"
import { isDOMProducing } from "./ir.js"
import { classifyDependencies } from "./classify.js"
import type { Dependency } from "./ir.js"

/**
 * Detect if a reactive LoopNode body represents a filter pattern.
 *
 * A filter pattern is:
 * 1. The loop iterates a reactive collection (iterableBindingTime === "reactive")
 * 2. The body contains only BindingNodes and exactly one ConditionalNode
 * 3. The ConditionalNode has no else branch (single `if`, no `else`)
 * 4. The ConditionalNode is reactive (subscriptionTarget !== null)
 * 5. The ConditionalNode wraps ALL DOM-producing content
 *    (no elements, content, loops, or conditionals outside the `if`)
 * 6. The condition has at least one dependency classifiable as item-dependent
 *
 * Operates entirely on IR — no BindingScope needed. By the time the IR
 * is constructed, `extractDependencies` has already resolved all bindings
 * to their leaf dependencies.
 *
 * Returns FilterMetadata if the pattern is detected, or null if not.
 * Returning null is always safe — the fallback (listRegion + conditionalRegion)
 * produces correct behavior, just without the subscription precision optimization.
 */
export function detectFilterPattern(
  loop: LoopNode,
): FilterMetadata | null {
  // 1. Static loops can't be filters — no reactive subscriptions to optimize
  if (loop.iterableBindingTime !== "reactive") {
    return null
  }

  // 2. Walk the body: collect the single ConditionalNode, reject if DOM outside it
  const conditional = findFilterConditional(loop.body)
  if (conditional === null) {
    return null
  }

  // 3. Must be a single `if` — no `else`, no `else if`
  //    One branch = single `if`. Multiple branches = else-if chain or if/else.
  if (conditional.branches.length !== 1) {
    return null
  }

  // 4. Must be a reactive condition
  if (conditional.subscriptionTarget === null) {
    return null
  }

  // 5. Flatten chained if-no-else into a single conjunctive predicate
  const predicate = flattenChainedFilters(conditional)

  // 6. Classify the flattened predicate's dependencies
  const classified = classifyDependencies(
    predicate.dependencies,
    loop.itemVariable,
    loop.iterableSource,
  )

  const itemDeps = classified.filter((d) => d.classification === "item")
  const externalDeps = classified.filter((d) => d.classification === "external")

  // Must have at least one item-dependent dep — pure external filters
  // have no per-item optimization benefit
  if (itemDeps.length === 0) {
    return null
  }

  return {
    predicate,
    itemDeps,
    externalDeps,
  }
}

/**
 * Find the single ConditionalNode in a loop body that wraps all DOM content.
 *
 * Returns the ConditionalNode if the body matches the filter shape:
 * - Zero or more BindingNodes (non-DOM-producing)
 * - Exactly one ConditionalNode
 * - No other DOM-producing nodes outside the conditional
 *
 * Returns null if the shape doesn't match.
 */
function findFilterConditional(body: ChildNode[]): ConditionalNode | null {
  let conditional: ConditionalNode | null = null

  for (const child of body) {
    if (child.kind === "conditional") {
      // More than one conditional → not a simple filter
      if (conditional !== null) {
        return null
      }
      conditional = child
    } else if (isDOMProducing(child)) {
      // DOM-producing content outside a conditional → not a filter
      return null
    }
    // Non-DOM-producing nodes (binding, statement, labeled-block) are fine
  }

  return conditional
}

/**
 * Flatten chained if-no-else conditionals into a single conjunctive predicate.
 *
 * Given:
 *   if (A) { if (B) { if (C) { ...DOM... } } }
 *
 * Produces a single ContentNode with:
 *   source: "(A) && (B) && (C)"
 *   dependencies: union of A, B, C deps
 *   bindingTime: "reactive"
 *
 * Stops recursing when the innermost then-body contains DOM elements
 * (not another filter-shaped conditional).
 */
function flattenChainedFilters(conditional: ConditionalNode): ContentNode {
  const conditions: ContentNode[] = []
  collectConditions(conditional, conditions)

  if (conditions.length === 1) {
    return conditions[0]
  }

  // Build the conjunctive predicate
  const source = conditions.map((c) => `(${c.source})`).join(" && ")
  const depsMap = new Map<string, Dependency>()
  for (const cond of conditions) {
    for (const dep of cond.dependencies) {
      if (!depsMap.has(dep.source)) {
        depsMap.set(dep.source, dep)
      }
    }
  }

  return {
    kind: "content",
    source,
    bindingTime: "reactive",
    dependencies: Array.from(depsMap.values()),
    span: conditions[0].span,
  }
}

/**
 * Recursively collect conditions from chained if-no-else.
 *
 * Descends into the then-body of each conditional: if the then-body
 * itself is filter-shaped (bindings + one if-no-else wrapping all DOM),
 * collects the inner condition and recurses.
 */
function collectConditions(
  conditional: ConditionalNode,
  conditions: ContentNode[],
): void {
  const firstBranch = conditional.branches[0]
  if (firstBranch.condition === null) {
    return
  }
  conditions.push(firstBranch.condition)

  // Check if the then-body is itself a filter-shaped conditional
  const innerConditional = findFilterConditional(firstBranch.body)
  if (
    innerConditional !== null &&
    innerConditional.branches.length === 1 &&
    innerConditional.subscriptionTarget !== null
  ) {
    collectConditions(innerConditional, conditions)
  }
}