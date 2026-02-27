/**
 * Region management for lists and conditionals.
 *
 * Regions are DOM areas that update reactively based on Loro data:
 * - List regions: Render items from a LoroList, update via deltas
 * - Conditional regions: Show/hide content based on a condition
 *
 * @packageDocumentation
 */

import { loro } from "@loro-extended/change"
import type {
  Delta,
  LoroEventBatch,
  LoroList,
  LoroMovableList,
} from "loro-crdt"
import type { ConditionalRegionHandlers, ListRegionHandlers } from "../types.js"
import type { Scope } from "./scope.js"
import { __subscribe } from "./subscribe.js"

// =============================================================================
// List Region
// =============================================================================

/**
 * State for a list region.
 * @internal
 */
interface ListRegionState {
  /** The DOM nodes for each item, in order */
  nodes: Node[]
  /** Scopes for each item (for nested subscriptions) */
  scopes: Scope[]
  /** The parent scope */
  parentScope: Scope
}

/**
 * Create a delta-based list region.
 *
 * This subscribes to a Loro list and updates the DOM based on deltas.
 * When items are inserted/deleted, only the affected DOM nodes change.
 *
 * @param parent - The parent DOM node to insert items into
 * @param listRef - A ListRef or MovableListRef
 * @param handlers - Callbacks for creating/updating/moving items
 * @param scope - The scope that owns this region
 * @returns Cleanup function
 *
 * @internal - Called by compiled code
 */
export function __listRegion<T>(
  parent: Node,
  listRef: unknown,
  handlers: ListRegionHandlers<T>,
  scope: Scope,
): void {
  // Get the underlying Loro list
  const loroList = loro(listRef as Parameters<typeof loro>[0]) as
    | LoroList
    | LoroMovableList

  // Initialize state
  const state: ListRegionState = {
    nodes: [],
    scopes: [],
    parentScope: scope,
  }

  // Create initial items
  const initialItems = loroList.toArray() as T[]
  for (let i = 0; i < initialItems.length; i++) {
    const item = initialItems[i]
    const itemScope = scope.createChild()
    const node = handlers.create(item, i)
    state.nodes.push(node)
    state.scopes.push(itemScope)
    parent.appendChild(node)
  }

  // Subscribe to changes
  __subscribe(
    listRef,
    event => {
      handleListDelta(parent, state, handlers, event)
    },
    scope,
  )
}

/**
 * Handle a list delta event.
 * @internal
 */
function handleListDelta<T>(
  parent: Node,
  state: ListRegionState,
  handlers: ListRegionHandlers<T>,
  event: LoroEventBatch,
): void {
  for (const diff of event.events) {
    if (diff.diff.type !== "list") continue

    const deltas = diff.diff.diff as Delta<T[]>[]
    let index = 0

    for (const delta of deltas) {
      if (delta.retain !== undefined) {
        // Skip over retained items
        index += delta.retain
      } else if (delta.delete !== undefined) {
        // Delete items at current index
        for (let i = 0; i < delta.delete; i++) {
          deleteItemAt(parent, state, index)
        }
        // Don't advance index - next op is at same position
      } else if (delta.insert !== undefined) {
        // Insert items at current index
        const items = delta.insert as T[]
        for (let i = 0; i < items.length; i++) {
          insertItemAt(parent, state, handlers, items[i], index + i)
        }
        index += items.length
      }
    }
  }
}

/**
 * Insert an item at a specific index.
 * @internal
 */
function insertItemAt<T>(
  parent: Node,
  state: ListRegionState,
  handlers: ListRegionHandlers<T>,
  item: T,
  index: number,
): void {
  const itemScope = state.parentScope.createChild()
  const node = handlers.create(item, index)

  // Insert into DOM at correct position
  const referenceNode = state.nodes[index] || null
  parent.insertBefore(node, referenceNode)

  // Update state
  state.nodes.splice(index, 0, node)
  state.scopes.splice(index, 0, itemScope)
}

/**
 * Delete an item at a specific index.
 * @internal
 */
function deleteItemAt(
  parent: Node,
  state: ListRegionState,
  index: number,
): void {
  const node = state.nodes[index]
  const itemScope = state.scopes[index]

  // Remove from DOM
  if (node.parentNode === parent) {
    parent.removeChild(node)
  }

  // Dispose the item's scope (cleans up subscriptions)
  itemScope.dispose()

  // Update state
  state.nodes.splice(index, 1)
  state.scopes.splice(index, 1)
}

// =============================================================================
// Conditional Region
// =============================================================================

/**
 * State for a conditional region.
 * @internal
 */
interface ConditionalRegionState {
  /** Current branch: true = "then", false = "else", null = neither */
  currentBranch: boolean | null
  /** The current DOM node */
  currentNode: Node | null
  /** Scope for the current branch */
  currentScope: Scope | null
  /** The parent scope */
  parentScope: Scope
}

/**
 * Create a conditional region.
 *
 * This subscribes to a condition and swaps DOM content when it changes.
 *
 * @param marker - A comment node marking the position
 * @param conditionRef - A ref that provides the condition value
 * @param getCondition - Function to evaluate the condition
 * @param handlers - Callbacks for creating branches
 * @param scope - The scope that owns this region
 *
 * @internal - Called by compiled code
 */
export function __conditionalRegion(
  marker: Comment,
  conditionRef: unknown,
  getCondition: () => boolean,
  handlers: ConditionalRegionHandlers,
  scope: Scope,
): void {
  const parent = marker.parentNode
  if (!parent) {
    throw new Error("Conditional region marker must have a parent node")
  }

  const state: ConditionalRegionState = {
    currentBranch: null,
    currentNode: null,
    currentScope: null,
    parentScope: scope,
  }

  // Evaluate and render initial state
  updateConditionalRegion(parent, marker, state, getCondition, handlers)

  // Subscribe to changes
  __subscribe(
    conditionRef,
    () => {
      updateConditionalRegion(parent, marker, state, getCondition, handlers)
    },
    scope,
  )
}

/**
 * Update a conditional region based on current condition.
 * @internal
 */
function updateConditionalRegion(
  parent: Node,
  marker: Comment,
  state: ConditionalRegionState,
  getCondition: () => boolean,
  handlers: ConditionalRegionHandlers,
): void {
  const condition = getCondition()

  // No change needed
  if (condition === state.currentBranch) {
    return
  }

  // Clean up old branch
  if (state.currentNode && state.currentNode.parentNode === parent) {
    parent.removeChild(state.currentNode)
  }
  if (state.currentScope) {
    state.currentScope.dispose()
    state.currentScope = null
  }
  state.currentNode = null
  state.currentBranch = null

  // Create new branch
  if (condition && handlers.whenTrue) {
    state.currentScope = state.parentScope.createChild()
    state.currentNode = handlers.whenTrue()
    state.currentBranch = true
    // Insert after marker
    if (marker.nextSibling) {
      parent.insertBefore(state.currentNode, marker.nextSibling)
    } else {
      parent.appendChild(state.currentNode)
    }
  } else if (!condition && handlers.whenFalse) {
    state.currentScope = state.parentScope.createChild()
    state.currentNode = handlers.whenFalse()
    state.currentBranch = false
    // Insert after marker
    if (marker.nextSibling) {
      parent.insertBefore(state.currentNode, marker.nextSibling)
    } else {
      parent.appendChild(state.currentNode)
    }
  }
}

/**
 * Create a simple conditional region that doesn't need a ref subscription.
 * Used for static conditions evaluated once.
 *
 * @param marker - A comment node marking the position
 * @param condition - The condition value
 * @param handlers - Callbacks for creating branches
 * @param scope - The scope that owns this region
 *
 * @internal - Called by compiled code
 */
export function __staticConditionalRegion(
  marker: Comment,
  condition: boolean,
  handlers: ConditionalRegionHandlers,
  scope: Scope,
): void {
  const parent = marker.parentNode
  if (!parent) {
    throw new Error("Conditional region marker must have a parent node")
  }

  let node: Node | null = null

  if (condition && handlers.whenTrue) {
    node = handlers.whenTrue()
  } else if (!condition && handlers.whenFalse) {
    node = handlers.whenFalse()
  }

  if (node) {
    // Insert after marker
    if (marker.nextSibling) {
      parent.insertBefore(node, marker.nextSibling)
    } else {
      parent.appendChild(node)
    }

    // Register cleanup
    scope.onDispose(() => {
      if (node?.parentNode) {
        node.parentNode.removeChild(node)
      }
    })
  }
}
