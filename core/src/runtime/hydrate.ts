/**
 * Hydration for SSR-Rendered DOM
 *
 * This module provides functionality to "hydrate" server-rendered HTML,
 * attaching Kinetic's reactive subscriptions to existing DOM nodes without
 * recreating them.
 *
 * Hydration process:
 * 1. Parse the existing DOM to find hydration markers
 * 2. Walk the DOM tree and match nodes to the expected structure
 * 3. Attach subscriptions to the adopted nodes
 * 4. Set up regions (list, conditional) based on markers
 *
 * @packageDocumentation
 */

import { HydrationMismatchError } from "../errors.js"
import type { Scope } from "./scope.js"
import { subscribe } from "./subscribe.js"

// =============================================================================
// Types
// =============================================================================

/**
 * Options for hydration.
 */
export interface HydrateOptions {
  /**
   * Whether to throw on hydration mismatches or attempt recovery.
   * @default true in development, false in production
   */
  strict?: boolean

  /**
   * Callback when a hydration mismatch is detected.
   * Useful for logging/debugging.
   */
  onMismatch?: (error: HydrationMismatchError) => void
}

/**
 * Result of hydration.
 */
export interface HydrateResult {
  /**
   * The root node that was hydrated.
   */
  node: Node

  /**
   * Whether hydration was successful without mismatches.
   */
  success: boolean

  /**
   * Any mismatches that occurred during hydration.
   */
  mismatches: HydrationMismatchError[]

  /**
   * Dispose function to clean up subscriptions.
   */
  dispose: () => void
}

/**
 * A hydration marker found in the DOM.
 */
interface HydrationMarker {
  /** The type of region (list, if) */
  type: string
  /** The unique marker ID */
  id: string
  /** The comment node */
  node: Comment
  /** Whether this is an opening or closing marker */
  isClosing: boolean
}

/**
 * State for tracking hydration of a specific region.
 */
interface RegionState {
  /** The opening marker */
  startMarker: Comment
  /** The closing marker (if found) */
  endMarker?: Comment
  /** Child nodes between markers */
  children: Node[]
  /** The region type */
  type: string
  /** The region ID */
  id: string
}

// =============================================================================
// Marker Parsing
// =============================================================================

/**
 * Regex to parse hydration markers.
 * Matches: kinetic:type:id or /kinetic:type
 */
const MARKER_REGEX = /^(\/?)kinetic:(\w+)(?::(\d+))?$/

/**
 * Parse a comment node to extract hydration marker info.
 *
 * @param node - The comment node to parse
 * @returns Marker info, or null if not a hydration marker
 */
export function parseMarker(node: Comment): HydrationMarker | null {
  const text = node.textContent?.trim()
  if (!text) return null

  const match = text.match(MARKER_REGEX)
  if (!match) return null

  const [, closingSlash, type, id] = match

  return {
    type,
    id: id ?? "",
    node,
    isClosing: closingSlash === "/",
  }
}

/**
 * Find all hydration markers in a container.
 *
 * @param container - The container to search
 * @returns Array of markers in document order
 */
export function findMarkers(container: Node): HydrationMarker[] {
  const markers: HydrationMarker[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_COMMENT)

  let node = walker.nextNode() as Comment | null
  while (node) {
    const marker = parseMarker(node)
    if (marker) {
      markers.push(marker)
    }
    node = walker.nextNode() as Comment | null
  }

  return markers
}

/**
 * Find matching regions from markers.
 *
 * @param markers - Array of markers
 * @returns Array of region states with matched start/end markers
 */
export function matchRegions(markers: HydrationMarker[]): RegionState[] {
  const regions: RegionState[] = []
  const stack: HydrationMarker[] = []

  for (const marker of markers) {
    if (marker.isClosing) {
      // Find matching opening marker
      const openIdx = stack.findIndex(
        m => m.type === marker.type && !m.isClosing,
      )
      if (openIdx >= 0) {
        const openMarker = stack.splice(openIdx, 1)[0]

        // Collect children between markers
        const children: Node[] = []
        let current: Node | null = openMarker.node.nextSibling
        while (current && current !== marker.node) {
          children.push(current)
          current = current.nextSibling
        }

        regions.push({
          startMarker: openMarker.node,
          endMarker: marker.node,
          children,
          type: marker.type,
          id: openMarker.id,
        })
      }
    } else {
      stack.push(marker)
    }
  }

  return regions
}

// =============================================================================
// DOM Walking
// =============================================================================

/**
 * Context for hydration walking.
 */
interface WalkContext {
  /** Current position in expected children */
  index: number
  /** The parent node being walked */
  parent: Node
  /** Collected mismatches */
  mismatches: HydrationMismatchError[]
  /** Hydration options */
  options: HydrateOptions
  /** The scope for subscriptions */
  scope: Scope
}

/**
 * Get the next non-whitespace element node.
 *
 * Skips text nodes that are only whitespace (common in pretty-printed HTML).
 *
 * @param node - Starting node
 * @returns Next element node, or null
 */
export function nextElementNode(node: Node | null): Element | null {
  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      return node as Element
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim()
      if (text) {
        // Non-empty text node - not what we're looking for
        return null
      }
    }
    node = node.nextSibling
  }
  return null
}

/**
 * Compare an existing DOM element to expected properties.
 *
 * @param existing - The existing DOM element
 * @param expectedTag - Expected tag name
 * @param expectedAttrs - Expected attributes (optional)
 * @returns true if they match
 */
export function elementMatches(
  existing: Element,
  expectedTag: string,
  expectedAttrs?: Record<string, string>,
): boolean {
  // Check tag name
  if (existing.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
    return false
  }

  // Check attributes if provided
  if (expectedAttrs) {
    for (const [name, value] of Object.entries(expectedAttrs)) {
      if (existing.getAttribute(name) !== value) {
        return false
      }
    }
  }

  return true
}

// =============================================================================
// Hydration Handlers
// =============================================================================

/**
 * Handler for hydrating a list region.
 */
export interface ListHydrationHandler<T> {
  /**
   * Get the current items from the data source.
   */
  getItems: () => T[]

  /**
   * Hydrate a single item node.
   * Called for each existing child in the list region.
   *
   * @param node - The existing DOM node
   * @param item - The corresponding data item
   * @param index - The item index
   * @param scope - Scope for subscriptions
   */
  hydrateItem: (node: Node, item: T, index: number, scope: Scope) => void

  /**
   * Subscribe to list changes for future updates.
   * Called after initial hydration.
   *
   * @param ref - The list ref to subscribe to
   * @param scope - Scope for the subscription
   */
  subscribe?: (ref: unknown, scope: Scope) => void
}

/**
 * Handler for hydrating a conditional region.
 */
export interface ConditionalHydrationHandler {
  /**
   * Get the current condition value.
   */
  getCondition: () => boolean

  /**
   * The ref to subscribe to for condition changes.
   */
  conditionRef: unknown

  /**
   * Hydrate the "true" branch content.
   */
  hydrateTrue?: (node: Node, scope: Scope) => void

  /**
   * Hydrate the "false" branch content.
   */
  hydrateFalse?: (node: Node, scope: Scope) => void
}

/**
 * Hydrate a list region.
 *
 * @param region - The region state from marker matching
 * @param handler - Handlers for the list items
 * @param scope - Scope for subscriptions
 */
export function hydrateListRegion<T>(
  region: RegionState,
  handler: ListHydrationHandler<T>,
  scope: Scope,
): void {
  const items = handler.getItems()
  const children = region.children.filter(n => n.nodeType === Node.ELEMENT_NODE)

  // Hydrate each existing child with its corresponding item
  const minLength = Math.min(items.length, children.length)
  for (let i = 0; i < minLength; i++) {
    const itemScope = scope.createChild()
    handler.hydrateItem(children[i], items[i], i, itemScope)
  }

  // Note: If items.length !== children.length, we have a mismatch
  // In strict mode this should throw, in non-strict we continue
  // Future updates will handle adding/removing nodes

  // Set up subscription for future updates if provided
  if (handler.subscribe) {
    // The handler should set up the appropriate subscription
    // This is typically done by the compiled code
  }
}

/**
 * Hydrate a conditional region.
 *
 * @param region - The region state from marker matching
 * @param handler - Handlers for the branches
 * @param scope - Scope for subscriptions
 */
export function hydrateConditionalRegion(
  region: RegionState,
  handler: ConditionalHydrationHandler,
  scope: Scope,
): void {
  const condition = handler.getCondition()
  const contentNode = region.children[0]

  if (condition && handler.hydrateTrue && contentNode) {
    handler.hydrateTrue(contentNode, scope)
  } else if (!condition && handler.hydrateFalse && contentNode) {
    handler.hydrateFalse(contentNode, scope)
  }

  // Subscribe to condition changes
  subscribe(
    handler.conditionRef,
    () => {
      // On condition change, the region needs to swap content
      // This is handled by the conditional region runtime
      // The hydration just sets up the initial state
    },
    scope,
  )
}

// =============================================================================
// Main Hydration API
// =============================================================================

/**
 * Hydrate a server-rendered container.
 *
 * This attaches Kinetic's reactive system to existing DOM nodes
 * without recreating them, enabling seamless SSR-to-client transitions.
 *
 * @param container - The container element with server-rendered content
 * @param hydrateRoot - Function to hydrate the root element
 * @param scope - The root scope for subscriptions
 * @param options - Hydration options
 * @returns Hydration result
 *
 * @example
 * ```ts
 * import { hydrate } from "@loro-extended/kinetic"
 *
 * const container = document.getElementById("root")!
 * const scope = new Scope("root")
 *
 * const result = hydrate(
 *   container,
 *   (node, scope) => {
 *     // Hydrate the app structure
 *     hydrateApp(node, doc, scope)
 *   },
 *   scope
 * )
 *
 * if (!result.success) {
 *   console.warn("Hydration mismatches:", result.mismatches)
 * }
 * ```
 */
export function hydrate(
  container: Element,
  hydrateRoot: (node: Node, scope: Scope) => void,
  scope: Scope,
  options: HydrateOptions = {},
): HydrateResult {
  const mismatches: HydrationMismatchError[] = []

  // Default strict mode based on environment
  const strict =
    options.strict ??
    (typeof process !== "undefined" && process.env?.NODE_ENV === "development")

  const effectiveOptions: HydrateOptions = {
    ...options,
    strict,
    onMismatch: error => {
      mismatches.push(error)
      options.onMismatch?.(error)
    },
  }

  try {
    // Find the root node (first element child)
    const rootNode = container.firstElementChild
    if (!rootNode) {
      throw new HydrationMismatchError(
        "element children",
        "empty container",
        "hydration root",
      )
    }

    // Call the hydration function
    hydrateRoot(rootNode, scope)

    return {
      node: rootNode,
      success: mismatches.length === 0,
      mismatches,
      dispose: () => scope.dispose(),
    }
  } catch (error) {
    if (error instanceof HydrationMismatchError) {
      // Call the onMismatch callback if provided
      if (options.onMismatch) {
        options.onMismatch(error)
      }

      // Re-throw in strict mode
      if (effectiveOptions.strict) {
        throw error
      }

      return {
        node: container.firstChild ?? container,
        success: false,
        mismatches: [...mismatches, error],
        dispose: () => scope.dispose(),
      }
    }
    throw error
  }
}

/**
 * Create a hydration-aware mount function.
 *
 * This returns a function that either hydrates existing content
 * or does a fresh render, depending on whether SSR content exists.
 *
 * @param renderFresh - Function to render fresh content
 * @param hydrateExisting - Function to hydrate existing content
 * @returns Mount function that handles both cases
 */
export function createHydratableMount(
  renderFresh: (container: Element, scope: Scope) => Node,
  hydrateExisting: (container: Element, scope: Scope) => HydrateResult,
): (container: Element, scope: Scope) => { node: Node; dispose: () => void } {
  return (container: Element, scope: Scope) => {
    // Check if container has existing content (SSR)
    if (container.firstElementChild) {
      const result = hydrateExisting(container, scope)
      return {
        node: result.node,
        dispose: result.dispose,
      }
    }

    // Fresh render
    const node = renderFresh(container, scope)
    container.appendChild(node)
    return {
      node,
      dispose: () => {
        scope.dispose()
        if (node.parentNode === container) {
          container.removeChild(node)
        }
      },
    }
  }
}

/**
 * Adopt an existing DOM node without recreation.
 *
 * This is used during hydration to "claim" an existing node
 * rather than creating a new one.
 *
 * @param existing - The existing DOM node
 * @param expectedTag - Expected tag name for validation
 * @returns The adopted node, or throws on mismatch
 */
export function adoptNode(existing: Node, expectedTag: string): Element {
  if (existing.nodeType !== Node.ELEMENT_NODE) {
    throw new HydrationMismatchError(
      "element node",
      `node type ${existing.nodeType}`,
      "adoptNode",
    )
  }

  const element = existing as Element
  if (element.tagName.toLowerCase() !== expectedTag.toLowerCase()) {
    throw new HydrationMismatchError(
      `<${expectedTag}>`,
      `<${element.tagName.toLowerCase()}>`,
      "adoptNode",
    )
  }

  return element
}

/**
 * Adopt an existing text node.
 *
 * @param existing - The existing DOM node
 * @param expectedText - Expected text content (optional)
 * @returns The adopted text node
 */
export function adoptTextNode(existing: Node, expectedText?: string): Text {
  if (existing.nodeType !== Node.TEXT_NODE) {
    throw new HydrationMismatchError(
      "text node",
      `node type ${existing.nodeType}`,
      "adoptTextNode",
    )
  }

  const text = existing as Text

  // If expected text is provided, validate it
  // Note: We don't throw on text mismatch by default since whitespace can differ
  if (expectedText !== undefined && text.textContent !== expectedText) {
    // Just update the text to match
    text.textContent = expectedText
  }

  return text
}
