/**
 * Template Extraction from IR
 *
 * This module extracts static HTML templates with dynamic holes from IR nodes.
 * It consumes events from the generator-based walker (`walk.ts`) to produce
 * `TemplateNode` structures that can be used for:
 *
 * - **Template Cloning**: `template.innerHTML = html; template.content.cloneNode(true)`
 * - **SSR**: Static HTML generation with interpolation points
 *
 * The extraction follows the principle that the walker describes structure,
 * while this module decides how to represent it as a template.
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
} from "./ir.js"
import { generateRegionMarkers } from "./html-constants.js"
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
      })
      // No HTML output for event handlers
      return inOpeningTag

    case "binding":
      // Record hole for two-way binding
      holes.push({
        path: event.path,
        kind: "binding",
        bindingType: event.bindingType,
        refSource: event.refSource,
        attributeName: event.attribute,
      })
      // Emit placeholder attribute
      htmlParts.push(` ${event.attribute}=""`)
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
      // Emit empty text placeholder (will be a text node in cloned DOM)
      // Using an empty string means no visible placeholder in HTML
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
