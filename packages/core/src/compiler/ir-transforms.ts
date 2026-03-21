/**
 * Consumer-side IR transforms.
 *
 * These are pipeline transforms invoked by the rendering target's orchestration
 * layer (transform.ts), not properties of the IR itself. They operate on IR
 * data structures but serve the consumer, not the producer.
 *
 * - `filterTargetBlocks` — strips/unwraps labeled blocks based on the active
 *   compilation target
 * - `dissolveConditionals` — replaces dissolvable conditionals with merged
 *   children containing ternary expressions
 *
 * @packageDocumentation
 */

import type {
  BuilderNode,
  ChildNode,
  ConditionalBranch,
} from "@kyneta/compiler"
import { mergeConditionalBodies } from "@kyneta/compiler"

// =============================================================================
// Target Block Filtering
// =============================================================================

/**
 * Maps raw block labels (as authored in source) to compilation targets.
 */
const LABEL_TARGET_MAP: Record<string, string> = {
  client: "dom",
  server: "html",
}

/**
 * Filter target blocks from an IR tree before codegen.
 *
 * This is a pure function that recursively walks the IR tree and:
 * - **Strips** `LabeledBlockNode` nodes whose target doesn't match (removes them entirely)
 * - **Unwraps** `LabeledBlockNode` nodes whose target matches (splices in their children)
 *
 * After filtering, the returned `BuilderNode` contains no `LabeledBlockNode` nodes
 * anywhere in the tree. Codegens, walkers, and template extraction never see them.
 *
 * @param node - The builder node to filter
 * @param target - The active compilation target ("dom" or "html")
 * @returns A new BuilderNode with target blocks resolved
 */
export function filterTargetBlocks(
  node: BuilderNode,
  target: string,
): BuilderNode {
  return {
    ...node,
    children: filterChildren(node.children, target),
  }
}

/**
 * Recursively filter target blocks from a list of child nodes.
 */
function filterChildren(
  children: ChildNode[],
  target: string,
): ChildNode[] {
  const result: ChildNode[] = []

  for (const child of children) {
    if (child.kind === "labeled-block") {
      if (LABEL_TARGET_MAP[child.label] === target) {
        // Matching target — unwrap: splice in the filtered children
        result.push(...filterChildren(child.children, target))
      }
      // Non-matching target — strip: omit entirely
    } else {
      // Recurse into nodes that contain child arrays
      result.push(filterChildNode(child, target))
    }
  }

  return result
}

/**
 * Recursively filter target blocks inside a single non-labeled-block child node.
 */
function filterChildNode(
  node: ChildNode,
  target: string,
): ChildNode {
  switch (node.kind) {
    case "element":
      return {
        ...node,
        children: filterChildren(node.children, target),
      }

    case "loop":
      return {
        ...node,
        body: filterChildren(node.body, target),
      }

    case "conditional":
      return {
        ...node,
        branches: node.branches.map(branch => ({
          ...branch,
          body: filterChildren(branch.body, target),
        })),
      }

    // Leaf nodes — no children to recurse into
    case "content":
    case "statement":
      return node

    // labeled-block is already handled by filterChildren before this function
    // is called, so this case should never be reached.
    case "labeled-block":
      return node
  }
}

// =============================================================================
// Conditional Dissolution
// =============================================================================

/**
 * Dissolve dissolvable conditionals in an IR tree before codegen.
 *
 * This is a pure function that recursively walks the IR tree and replaces
 * reactive conditionals whose branches have identical structure with their
 * merged children (elements/content with ternary expressions).
 *
 * A conditional is dissolvable when:
 * 1. It has a reactive subscription target (not render-time)
 * 2. It has an else branch (all branches covered)
 * 3. `mergeConditionalBodies` succeeds (branches are structurally identical)
 *
 * After dissolution, the returned `BuilderNode` contains no dissolvable
 * `ConditionalNode` nodes. Non-dissolvable conditionals are preserved.
 * The walker, template extraction, and codegen never see dissolvable
 * conditionals — they see regular elements/content with ternary values.
 *
 * @param node - The builder node to transform
 * @returns A new BuilderNode with dissolvable conditionals replaced
 */
export function dissolveConditionals(node: BuilderNode): BuilderNode {
  return {
    ...node,
    children: dissolveChildren(node.children),
  }
}

/**
 * Recursively dissolve conditionals from a list of child nodes.
 *
 * When a dissolvable conditional is encountered, its merged children are
 * spliced into the output array (replacing the single ConditionalNode).
 * All other nodes are recursed into via `dissolveChildNode`.
 */
function dissolveChildren(children: ChildNode[]): ChildNode[] {
  const result: ChildNode[] = []

  for (const child of children) {
    if (child.kind === "conditional") {
      // Only attempt dissolution for reactive conditionals with an else branch
      if (
        child.subscriptionTarget !== null &&
        child.branches.some((b: ConditionalBranch) => b.condition === null)
      ) {
        const mergeResult = mergeConditionalBodies(child.branches)
        if (mergeResult.success) {
          // Dissolution successful — splice merged children in place of
          // the ConditionalNode, then recurse into each merged child
          // (they may contain nested dissolvable conditionals).
          for (const merged of mergeResult.value) {
            result.push(dissolveChildNode(merged))
          }
          continue
        }
      }
      // Not dissolvable — recurse into branch bodies
      result.push(dissolveChildNode(child))
    } else {
      // Non-conditional — recurse into sub-trees
      result.push(dissolveChildNode(child))
    }
  }

  return result
}

/**
 * Recursively dissolve conditionals inside a single child node.
 */
function dissolveChildNode(node: ChildNode): ChildNode {
  switch (node.kind) {
    case "element":
      return {
        ...node,
        children: dissolveChildren(node.children),
      }

    case "loop":
      return {
        ...node,
        body: dissolveChildren(node.body),
      }

    case "conditional":
      return {
        ...node,
        branches: node.branches.map(branch => ({
          ...branch,
          body: dissolveChildren(branch.body),
        })),
      }

    // Leaf nodes — no children to recurse into
    case "content":
    case "statement":
      return node

    // labeled-block children are recursed into (dissolution may run
    // before or after filterTargetBlocks in the pipeline).
    case "labeled-block":
      return {
        ...node,
        children: dissolveChildren(node.children),
      }
  }
}