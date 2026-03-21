/**
 * Generator-Based IR Walker
 *
 * This module provides a generator-based tree walker for the Kyneta IR.
 * It yields structural events that consumers can process to generate
 * different outputs (SSR HTML, template extraction, etc.).
 *
 * The walker follows the principle of separation of concerns:
 * - Walker describes structure (yields events)
 * - Consumers decide what to do with each event
 *
 * Benefits:
 * - Testability: collect events into array and assert
 * - Composability: filter, transform, or log events without modifying walker
 * - Single source of truth: SSR and template extraction share the same walk
 *
 * @packageDocumentation
 */

import {
  isDOMProducing,
  type AttributeNode,
  type BuilderNode,
  type ChildNode,
  type ConditionalNode,
  type ContentNode,
  type ElementNode,
  type EventHandlerNode,
  type LoopNode,
} from "./ir.js"
import { escapeHtml, VOID_ELEMENTS } from "./html-constants.js"

// =============================================================================
// Event Types
// =============================================================================

/**
 * Event emitted when an element tag opens.
 *
 * Consumers should emit the opening `<tag` (attributes come separately).
 */
export interface ElementStartEvent {
  type: "elementStart"
  /** The HTML tag name */
  tag: string
  /** Path from root to this element (indices into children arrays) */
  path: number[]
}

/**
 * Event emitted when an element tag closes.
 *
 * For void elements, this signals the end of the opening tag (`>`).
 * For other elements, this signals the closing tag (`</tag>`).
 */
export interface ElementEndEvent {
  type: "elementEnd"
  /** The HTML tag name */
  tag: string
  /** Whether this is a void element (no closing tag) */
  isVoid: boolean
}

/**
 * Event emitted for a static attribute (known at compile time).
 *
 * The value is already HTML-escaped.
 */
export interface StaticAttributeEvent {
  type: "staticAttribute"
  /** Attribute name */
  name: string
  /** Escaped attribute value */
  value: string
}

/**
 * Event emitted for a dynamic attribute (runtime value).
 */
export interface DynamicAttributeEvent {
  type: "dynamicAttribute"
  /** The attribute node from IR */
  attr: AttributeNode
  /** Path to the containing element */
  path: number[]
}

/**
 * Event emitted for an event handler.
 */
export interface EventHandlerEvent {
  type: "eventHandler"
  /** The event handler node from IR */
  handler: EventHandlerNode
  /** Path to the containing element */
  path: number[]
}

/**
 * Event emitted for static text content (known at compile time).
 *
 * The text is already HTML-escaped.
 */
export interface StaticTextEvent {
  type: "staticText"
  /** Escaped text content */
  text: string
}

/**
 * Event emitted for dynamic content (runtime value).
 */
export interface DynamicContentEvent {
  type: "dynamicContent"
  /** The content node from IR */
  node: ContentNode
  /** Path to this content position */
  path: number[]
}

/**
 * Event emitted for a region placeholder (list or conditional).
 *
 * Regions are mount points for dynamic content that the walker
 * doesn't descend into. Consumers decide how to represent them
 * (e.g., comment markers for SSR, holes for template extraction).
 */
export interface RegionPlaceholderEvent {
  type: "regionPlaceholder"
  /** The loop or conditional node from IR */
  node: LoopNode | ConditionalNode
  /** Path to this region */
  path: number[]
}

/**
 * Event emitted for a component placeholder.
 *
 * Components are opaque to the walker — they cannot be serialized as
 * HTML into a template.  Instead, consumers should emit a placeholder
 * (e.g., a comment node) and instantiate the component at runtime.
 */
export interface ComponentPlaceholderEvent {
  type: "componentPlaceholder"
  /** The element node with `factorySource` set */
  node: ElementNode
  /** Path to this component position */
  path: number[]
}



/**
 * Union of all walk events.
 */
export type WalkEvent =
  | ElementStartEvent
  | ElementEndEvent
  | StaticAttributeEvent
  | DynamicAttributeEvent
  | EventHandlerEvent
  | StaticTextEvent
  | DynamicContentEvent
  | RegionPlaceholderEvent
  | ComponentPlaceholderEvent

// =============================================================================
// Walker Implementation
// =============================================================================

/**
 * Walk an IR tree and yield structural events.
 *
 * This is the main entry point for walking BuilderNode or ElementNode trees.
 * It yields events in document order (depth-first pre-order traversal).
 *
 * @param node - The root node to walk (BuilderNode or ElementNode)
 * @yields WalkEvent for each structural element encountered
 *
 * @example
 * ```typescript
 * const events = [...walkIR(builderNode)]
 * for (const event of events) {
 *   switch (event.type) {
 *     case "elementStart": // ...
 *     case "staticText": // ...
 *   }
 * }
 * ```
 */
export function* walkIR(
  node: BuilderNode | ElementNode,
): Generator<WalkEvent, void, undefined> {
  // Mutable path stack - we copy when yielding events that need paths
  const pathStack: number[] = []

  if (node.kind === "builder") {
    yield* walkBuilder(node, pathStack)
  } else {
    yield* walkElement(node, pathStack)
  }
}

/**
 * Walk a builder node.
 *
 * A builder represents the root of a component/element factory.
 * It has props (attributes), event handlers, and children.
 */
function* walkBuilder(
  node: BuilderNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  // Emit element start
  yield {
    type: "elementStart",
    tag: node.factoryName,
    path: [...pathStack],
  }

  // Emit attributes from props
  for (const prop of node.props) {
    yield* walkAttribute(prop, pathStack)
  }

  // Emit event handlers
  for (const handler of node.eventHandlers) {
    yield {
      type: "eventHandler",
      handler,
      path: [...pathStack],
    }
  }

  const isVoid = VOID_ELEMENTS.has(node.factoryName)

  // Emit element end (after attributes, before children for non-void)
  // For void elements, this closes the tag
  if (isVoid) {
    yield {
      type: "elementEnd",
      tag: node.factoryName,
      isVoid: true,
    }
    return
  }

  // Walk children
  // Use a DOM-positional index (skipping non-DOM-producing nodes like
  // statements) so that paths match actual DOM child positions in the
  // cloned template.
  let domIndex = 0
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (!isDOMProducing(child)) {
      continue // Non-DOM nodes don't produce DOM — skip
    }
    pathStack.push(domIndex)
    yield* walkChild(child, pathStack)
    pathStack.pop()
    domIndex++
  }

  // Emit closing tag
  yield {
    type: "elementEnd",
    tag: node.factoryName,
    isVoid: false,
  }
}

/**
 * Walk an element node.
 *
 * If the element has `factorySource` (it's a component invocation),
 * yield a single `componentPlaceholder` event instead of walking
 * it as HTML.  Components are opaque at the template level — they
 * are instantiated at runtime, not serialized into innerHTML.
 */
function* walkElement(
  node: ElementNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  // Components cannot be serialized into a template — emit placeholder
  if (node.factorySource) {
    yield {
      type: "componentPlaceholder",
      node,
      path: [...pathStack],
    }
    return
  }

  // Emit element start
  yield {
    type: "elementStart",
    tag: node.tag,
    path: [...pathStack],
  }

  // Emit attributes
  for (const attr of node.attributes) {
    yield* walkAttribute(attr, pathStack)
  }

  // Emit event handlers
  for (const handler of node.eventHandlers) {
    yield {
      type: "eventHandler",
      handler,
      path: [...pathStack],
    }
  }

  const isVoid = VOID_ELEMENTS.has(node.tag)

  if (isVoid) {
    yield {
      type: "elementEnd",
      tag: node.tag,
      isVoid: true,
    }
    return
  }

  // Walk children
  // Use a DOM-positional index (skipping non-DOM-producing nodes like
  // statements) so that paths match actual DOM child positions in the
  // cloned template.
  let domIndex = 0
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]
    if (!isDOMProducing(child)) {
      continue // Non-DOM nodes don't produce DOM — skip
    }
    pathStack.push(domIndex)
    yield* walkChild(child, pathStack)
    pathStack.pop()
    domIndex++
  }

  // Emit closing tag
  yield {
    type: "elementEnd",
    tag: node.tag,
    isVoid: false,
  }
}

/**
 * Walk an attribute node.
 *
 * Emits either a staticAttribute or dynamicAttribute event
 * depending on the attribute's binding time.
 */
function* walkAttribute(
  attr: AttributeNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  if (attr.value.bindingTime === "literal") {
    // Static attribute - extract value from JSON and escape
    const rawValue = JSON.parse(attr.value.source)
    yield {
      type: "staticAttribute",
      name: attr.name,
      value: escapeHtml(String(rawValue)),
    }
  } else {
    // Dynamic attribute
    yield {
      type: "dynamicAttribute",
      attr,
      path: [...pathStack],
    }
  }
}

/**
 * Walk a child node.
 *
 * Dispatches to the appropriate walker based on node kind.
 */
function* walkChild(
  node: ChildNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  switch (node.kind) {
    case "element":
      yield* walkElement(node, pathStack)
      break

    case "content":
      yield* walkContent(node, pathStack)
      break

    case "loop":
      yield* walkLoop(node, pathStack)
      break

    case "conditional":
      yield* walkConditional(node, pathStack)
      break

    case "statement":
    case "binding":
      // Statements and bindings don't produce walk events — they're
      // handled specially by consumers that need to preserve them
      break
  }
}

/**
 * Walk a content node.
 *
 * Emits either staticText or dynamicContent depending on binding time.
 */
function* walkContent(
  node: ContentNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  if (node.bindingTime === "literal") {
    // Static text - extract from JSON and escape
    const rawValue = JSON.parse(node.source)
    yield {
      type: "staticText",
      text: escapeHtml(String(rawValue)),
    }
  } else {
    // Dynamic content
    yield {
      type: "dynamicContent",
      node,
      path: [...pathStack],
    }
  }
}

/**
 * Walk a loop node.
 *
 * For reactive loops, emit a region placeholder.
 * For render-time loops, emit a region placeholder as well (the consumer
 * decides how to handle static vs reactive loops).
 */
function* walkLoop(
  node: LoopNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  yield {
    type: "regionPlaceholder",
    node,
    path: [...pathStack],
  }
}

/**
 * Walk a conditional node.
 *
 * For reactive conditionals, emit a region placeholder.
 * For render-time conditionals, emit a region placeholder as well.
 */
function* walkConditional(
  node: ConditionalNode,
  pathStack: number[],
): Generator<WalkEvent, void, undefined> {
  yield {
    type: "regionPlaceholder",
    node,
    path: [...pathStack],
  }
}

// =============================================================================
// Body Walking Helpers (for SSR codegen)
// =============================================================================

/**
 * Walk the body of a loop node.
 *
 * This is a helper for SSR codegen that needs to walk inside loop bodies
 * to generate `.map()` expressions. The walker's main `walkIR` function
 * emits `regionPlaceholder` events for loops; consumers that need to
 * generate loop body code can use this helper.
 *
 * @param node - The loop node
 * @yields WalkEvent for each element in the loop body
 */
export function* walkLoopBody(
  node: LoopNode,
): Generator<WalkEvent, void, undefined> {
  const pathStack: number[] = []
  for (let i = 0; i < node.body.length; i++) {
    pathStack.push(i)
    yield* walkChild(node.body[i], pathStack)
    pathStack.pop()
  }
}

/**
 * Walk a conditional branch body.
 *
 * This is a helper for SSR codegen that needs to walk inside conditional
 * branches to generate ternary/IIFE expressions. The walker's main `walkIR`
 * function emits `regionPlaceholder` events for conditionals; consumers
 * that need to generate branch body code can use this helper.
 *
 * @param body - The branch body (array of child nodes)
 * @yields WalkEvent for each element in the branch
 */
export function* walkBranchBody(
  body: ChildNode[],
): Generator<WalkEvent, void, undefined> {
  const pathStack: number[] = []
  for (let i = 0; i < body.length; i++) {
    pathStack.push(i)
    yield* walkChild(body[i], pathStack)
    pathStack.pop()
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Collect all events from walking a node into an array.
 *
 * Useful for testing and debugging.
 *
 * @param node - The root node to walk
 * @returns Array of all walk events
 */
export function collectEvents(node: BuilderNode | ElementNode): WalkEvent[] {
  return [...walkIR(node)]
}

/**
 * Count events by type.
 *
 * Useful for testing and analysis.
 *
 * @param events - Array of walk events
 * @returns Map of event type to count
 */
export function countEventTypes(
  events: WalkEvent[],
): Map<WalkEvent["type"], number> {
  const counts = new Map<WalkEvent["type"], number>()
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  }
  return counts
}

/**
 * Filter events to only those with paths (element-related events).
 *
 * @param events - Array of walk events
 * @returns Events that have path information
 */
export function eventsWithPaths(
  events: WalkEvent[],
): Array<WalkEvent & { path: number[] }> {
  return events.filter(
    (e): e is WalkEvent & { path: number[] } => "path" in e && e.path != null,
  )
}
