/**
 * Template Extraction and Walk Planning
 *
 * This module provides two key capabilities for template cloning:
 *
 * 1. **Template Extraction**: Extracts static HTML templates with dynamic holes
 *    from IR nodes. Consumes events from the generator-based walker (`walk.ts`)
 *    to produce `TemplateNode` structures.
 *
 * 2. **Walk Planning**: Converts hole paths into optimal DOM navigation operations.
 *    The planner produces a sequence of `NavOp` operations that can be used to
 *    grab references to all holes in a single pass through the cloned DOM.
 *
 * Used for:
 * - **Template Cloning**: `template.innerHTML = html; template.content.cloneNode(true)`
 * - **SSR**: Static HTML generation with interpolation points
 *
 * @packageDocumentation
 */

import type {
  BuilderNode,
  ConditionalNode,
  ElementNode,
  LoopNode,
  TemplateHole,
  TemplateNode,
} from "@kyneta/compiler"
import { generateRegionMarkers } from "@kyneta/compiler"
import { walkIR, type WalkEvent } from "./walk.js"

// =============================================================================
// Template Extraction
// =============================================================================

/**
 * Extract a template from an IR node.
 *
 * Walks the IR tree and produces a `TemplateNode` containing:
 * - Static HTML string with placeholders for dynamic content
 * - Ordered list of holes describing where dynamic content goes
 *
 * The holes are ordered by document position (depth-first pre-order),
 * matching the order they would be encountered when walking the cloned DOM.
 *
 * @param node - The root node to extract (BuilderNode or ElementNode)
 * @returns TemplateNode with HTML and holes
 *
 * @example
 * ```typescript
 * const ir = analyzeBuilder(sourceFile)
 * const template = extractTemplate(ir)
 *
 * // Use for template cloning
 * const tmpl = document.createElement("template")
 * tmpl.innerHTML = template.html
 * const clone = tmpl.content.cloneNode(true)
 *
 * // Walk clone to grab hole references using template.holes
 * ```
 */
export function extractTemplate(node: BuilderNode | ElementNode): TemplateNode {
  const htmlParts: string[] = []
  const holes: TemplateHole[] = []
  let markerIdCounter = 0

  // Track whether we're in an unclosed opening tag (need ">" before content)
  let inOpeningTag = false

  for (const event of walkIR(node)) {
    inOpeningTag = processEvent(
      event,
      htmlParts,
      holes,
      inOpeningTag,
      () => ++markerIdCounter,
    )
  }

  return {
    html: htmlParts.join(""),
    holes,
    markerIdCounter,
  }
}

/**
 * Process a single walk event and update the template state.
 *
 * @param event - The walk event to process
 * @param htmlParts - Array of HTML parts being accumulated
 * @param holes - Array of holes being accumulated
 * @param inOpeningTag - Whether we're currently inside an unclosed opening tag
 * @param nextMarkerId - Function to get next marker ID
 * @returns New value of inOpeningTag
 *
 * @internal
 */
function processEvent(
  event: WalkEvent,
  htmlParts: string[],
  holes: TemplateHole[],
  inOpeningTag: boolean,
  nextMarkerId: () => number,
): boolean {
  switch (event.type) {
    case "elementStart":
      // Close any previous unclosed opening tag
      if (inOpeningTag) {
        htmlParts.push(">")
      }
      htmlParts.push(`<${event.tag}`)
      return true // Now we're in a new opening tag

    case "elementEnd":
      if (event.isVoid) {
        // Void elements just need ">" to close opening tag
        htmlParts.push(">")
      } else {
        // Non-void: close opening tag if needed, then emit closing tag
        if (inOpeningTag) {
          htmlParts.push(">")
        }
        htmlParts.push(`</${event.tag}>`)
      }
      return false // No longer in opening tag

    case "staticAttribute":
      // Attributes go inside the opening tag (no state change)
      htmlParts.push(` ${event.name}="${event.value}"`)
      return inOpeningTag

    case "dynamicAttribute":
      // Record hole for dynamic attribute
      holes.push({
        path: event.path,
        kind: "attribute",
        attributeName: event.attr.name,
        contentNode: event.attr.value,
      })
      // Emit placeholder attribute (empty value, will be filled at runtime)
      htmlParts.push(` ${event.attr.name}=""`)
      return inOpeningTag

    case "eventHandler":
      // Record hole for event handler
      holes.push({
        path: event.path,
        kind: "event",
        eventName: event.handler.event,
        handlerSource: event.handler.handlerSource,
      })
      // No HTML output for event handlers
      return inOpeningTag



    case "staticText":
      // Close opening tag if needed before content
      if (inOpeningTag) {
        htmlParts.push(">")
      }
      htmlParts.push(event.text)
      return false

    case "dynamicContent":
      // Close opening tag if needed
      if (inOpeningTag) {
        htmlParts.push(">")
      }
      // Record hole for dynamic content
      holes.push({
        path: event.path,
        kind: "text",
        contentNode: event.node,
      })
      // Emit a comment placeholder so the cloned DOM has a real node at
      // this child position.  Without it, adjacent static text would merge
      // into one Text node and the walker couldn't reach the correct child
      // index (e.g. "Hello <!----> world" keeps three children instead of
      // one merged "Hello  world" text node).
      htmlParts.push("<!---->")
      return false

    case "regionPlaceholder":
      // Close opening tag if needed
      if (inOpeningTag) {
        htmlParts.push(">")
      }
      // Record hole for region
      const regionType = getRegionType(event.node)
      const markerId = nextMarkerId()
      const markers = generateRegionMarkers(regionType, markerId)

      holes.push({
        path: event.path,
        kind: "region",
        regionNode: event.node,
      })

      // Emit comment markers for hydration compatibility
      htmlParts.push(markers.open)
      htmlParts.push(markers.close)
      return false

    case "componentPlaceholder":
      // Close opening tag if needed
      if (inOpeningTag) {
        htmlParts.push(">")
      }
      // Record hole for component — instantiated at runtime, not serialized
      holes.push({
        path: event.path,
        kind: "component",
        elementNode: event.node,
      })
      // Emit a comment placeholder so the walker can grab a reference node
      htmlParts.push("<!---->")
      return false
  }

  return inOpeningTag
}

/**
 * Determine the region type from a loop or conditional node.
 *
 * @internal
 */
function getRegionType(node: LoopNode | ConditionalNode): "list" | "if" {
  return node.kind === "loop" ? "list" : "if"
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if a template has any dynamic holes.
 *
 * @param template - The template to check
 * @returns true if there are dynamic holes
 */
export function hasHoles(template: TemplateNode): boolean {
  return template.holes.length > 0
}

/**
 * Check if a template is completely static (no holes).
 *
 * @param template - The template to check
 * @returns true if there are no dynamic holes
 */
export function isStatic(template: TemplateNode): boolean {
  return template.holes.length === 0
}

/**
 * Get holes of a specific kind.
 *
 * @param template - The template to query
 * @param kind - The hole kind to filter for
 * @returns Array of holes matching the kind
 */
export function getHolesByKind(
  template: TemplateNode,
  kind: TemplateHole["kind"],
): TemplateHole[] {
  return template.holes.filter(hole => hole.kind === kind)
}

/**
 * Count holes by kind.
 *
 * @param template - The template to analyze
 * @returns Map of kind to count
 */
export function countHolesByKind(
  template: TemplateNode,
): Map<TemplateHole["kind"], number> {
  const counts = new Map<TemplateHole["kind"], number>()
  for (const hole of template.holes) {
    counts.set(hole.kind, (counts.get(hole.kind) ?? 0) + 1)
  }
  return counts
}

// =============================================================================
// Walk Planning
// =============================================================================

/**
 * Navigation operation for walking the cloned DOM to grab hole references.
 *
 * Operations:
 * - `down`: Navigate to firstChild
 * - `right`: Navigate to nextSibling
 * - `up`: Navigate to parentNode
 * - `grab`: Save current node reference for a hole
 */
export type NavOp =
  | { op: "down" }
  | { op: "right" }
  | { op: "up" }
  | { op: "grab"; holeIndex: number }

/**
 * Compare two paths lexicographically (document order).
 *
 * @internal
 */
function comparePaths(a: number[], b: number[]): number {
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length // shorter path comes first (parent before child)
}

/**
 * Plan an optimal walk to visit all holes in document order.
 *
 * The algorithm:
 * 1. Sort holes by path (document order - depth-first pre-order)
 * 2. For each hole, navigate from current position:
 *    - Go up to common ancestor if needed
 *    - Go down/right to reach target
 *    - Grab the node
 *
 * Invariant: holes are visited in document order, so we only move forward
 * (down/right) or up to a common ancestor, never backwards.
 *
 * @param holes - Array of template holes with paths
 * @returns Array of navigation operations
 *
 * @example
 * ```typescript
 * const holes = [
 *   { path: [0, 0], kind: "text" },
 *   { path: [1], kind: "attribute" }
 * ]
 * const ops = planWalk(holes)
 * // ops: [down, down, grab(0), up, right, grab(1)]
 * ```
 */
export function planWalk(holes: TemplateHole[]): NavOp[] {
  if (holes.length === 0) return []

  // Sort holes by document order, preserving original indices
  const sorted = holes
    .map((hole, originalIndex) => ({ hole, originalIndex }))
    .sort((a, b) => comparePaths(a.hole.path, b.hole.path))

  const ops: NavOp[] = []
  let current: number[] = [] // Current position as path

  for (const { hole, originalIndex } of sorted) {
    const target = hole.path

    // Handle empty path (root element attribute)
    if (target.length === 0) {
      ops.push({ op: "grab", holeIndex: originalIndex })
      current = target
      continue
    }

    // Find common prefix depth
    let commonDepth = 0
    while (
      commonDepth < current.length &&
      commonDepth < target.length &&
      current[commonDepth] === target[commonDepth]
    ) {
      commonDepth++
    }

    // Special case: same-depth siblings (e.g., [0] to [1])
    // Don't go up, just go right
    const isSameDepthSibling =
      current.length === target.length &&
      commonDepth === current.length - 1 &&
      current.length > 0

    if (isSameDepthSibling) {
      // Navigate right from current sibling to target sibling
      const currentIndex = current[current.length - 1]
      const targetIndex = target[target.length - 1]
      for (let i = currentIndex + 1; i <= targetIndex; i++) {
        ops.push({ op: "right" })
      }
    } else {
      // Go up from current position to common ancestor level
      // We need to go up (current.length - commonDepth) times
      for (let i = current.length; i > commonDepth; i--) {
        ops.push({ op: "up" })
      }

      // Now navigate from common ancestor to target
      for (let depth = commonDepth; depth < target.length; depth++) {
        const targetIndex = target[depth]

        if (depth === commonDepth) {
          // At common ancestor level
          if (commonDepth < current.length) {
            // We came from a deeper path - navigate right from child 0
            // After going up, we're at the parent; go right to target sibling
            for (let i = 0; i <= targetIndex; i++) {
              if (i === 0) {
                ops.push({ op: "down" })
              } else {
                ops.push({ op: "right" })
              }
            }
          } else if (current.length === 0) {
            // Starting from root - go down then right
            ops.push({ op: "down" })
            for (let i = 0; i < targetIndex; i++) {
              ops.push({ op: "right" })
            }
          } else {
            // We're at the end of common path but target goes deeper
            // Go down then navigate to target index
            ops.push({ op: "down" })
            for (let i = 0; i < targetIndex; i++) {
              ops.push({ op: "right" })
            }
          }
        } else {
          // Deeper than common ancestor - go down then right
          ops.push({ op: "down" })
          for (let i = 0; i < targetIndex; i++) {
            ops.push({ op: "right" })
          }
        }
      }
    }

    // Grab this hole
    ops.push({ op: "grab", holeIndex: originalIndex })
    current = target
  }

  return ops
}

/**
 * Generate JavaScript code to walk the cloned DOM and grab hole references.
 *
 * The generated code:
 * 1. Creates an array to store hole references
 * 2. Starts from the root node
 * 3. Navigates using firstChild/nextSibling/parentNode
 * 4. Grabs nodes at each hole position
 *
 * @param ops - Navigation operations from planWalk
 * @param holeCount - Total number of holes
 * @param rootVar - Variable name for the root node
 * @param indent - Indentation string
 * @returns Array of code lines
 *
 * @example
 * ```typescript
 * const code = generateWalkCode(ops, 2, "_root", "  ")
 * // [
 * //   "  const _holes = new Array(2)",
 * //   "  let _n = _root",
 * //   "  _n = _n.firstChild",
 * //   "  _holes[0] = _n",
 * //   "  _n = _n.nextSibling",
 * //   "  _holes[1] = _n",
 * // ]
 * ```
 */
export function generateWalkCode(
  ops: NavOp[],
  holeCount: number,
  rootVar: string,
  indent: string = "",
): string[] {
  if (holeCount === 0) return []

  const lines: string[] = []
  lines.push(`${indent}const _holes = new Array(${holeCount})`)
  lines.push(`${indent}let _n = ${rootVar}`)

  for (const op of ops) {
    switch (op.op) {
      case "down":
        lines.push(`${indent}_n = _n.firstChild`)
        break
      case "right":
        lines.push(`${indent}_n = _n.nextSibling`)
        break
      case "up":
        lines.push(`${indent}_n = _n.parentNode`)
        break
      case "grab":
        lines.push(`${indent}_holes[${op.holeIndex}] = _n`)
        break
    }
  }

  return lines
}

/**
 * Generate a template declaration statement.
 *
 * Creates a module-level template element that can be cloned.
 *
 * @param html - The template HTML string
 * @param varName - Variable name for the template
 * @returns JavaScript code declaring the template
 *
 * @example
 * ```typescript
 * generateTemplateDeclaration("<div><span></span></div>", "_tmpl_0")
 * // 'const _tmpl_0 = document.createElement("template"); _tmpl_0.innerHTML = "<div><span></span></div>"'
 * ```
 */
export function generateTemplateDeclaration(
  html: string,
  varName: string,
): string {
  const escapedHtml = JSON.stringify(html)
  return `const ${varName} = document.createElement("template"); ${varName}.innerHTML = ${escapedHtml};`
}

/**
 * Simple hash function for template deduplication.
 *
 * @param str - String to hash
 * @returns Hash string
 *
 * @internal
 */
export function simpleHash(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash + char) | 0
  }
  return hash.toString(36)
}
