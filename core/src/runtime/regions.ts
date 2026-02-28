/**
 * Region management for lists and conditionals.
 *
 * Regions are DOM areas that update reactively based on Loro data:
 * - List regions: Render items from a LoroList, update via deltas
 * - Conditional regions: Show/hide content based on a condition
 *
 * ## List Region Architecture (Functional Core / Imperative Shell)
 *
 * The `__listRegion` runtime follows FC/IS pattern:
 *
 * **Functional Core** (pure, testable):
 * - `planInitialRender(listRef)` → `ListRegionOp<T>[]`
 * - `planDeltaOps(listRef, event)` → `ListRegionOp<T>[]`
 *
 * **Imperative Shell** (DOM manipulation):
 * - `executeOp(parent, state, handlers, op)` — applies single operation
 *
 * Both planning functions use `listRef.get(index)` to obtain refs, ensuring
 * handlers always receive `PlainValueRef<T>` for value shapes. This enables
 * the component pattern where refs are passed for two-way binding:
 *
 * ```typescript
 * for (const itemRef of doc.items) {
 *   TodoItem({ item: itemRef })  // Component can read AND write
 * }
 * ```
 *
 * @packageDocumentation
 */

import type { LoroEventBatch } from "loro-crdt"
import type {
  ConditionalRegionHandlers,
  ListRegionHandlers,
  ListRegionOp,
} from "../types.js"
import type { Scope } from "./scope.js"
import { __subscribe } from "./subscribe.js"

// =============================================================================
// List Region - Types
// =============================================================================

/**
 * Minimal interface for list delta events.
 *
 * This captures what `planDeltaOps` actually needs from a LoroEventBatch,
 * enabling proper typing for tests without requiring full LoroEventBatch mocks.
 *
 * @internal - Used for testing
 */
export interface ListDeltaEvent {
  events: Array<{
    diff: {
      type: string
      diff: Array<{ retain?: number; delete?: number; insert?: unknown[] }>
    }
  }>
}

/**
 * Minimal interface for list refs used by planning functions.
 * This allows testing without real ListRef instances.
 * @internal
 */
export interface ListRefLike<T> {
  /** Number of items in the list */
  readonly length: number
  /** Get item at index — returns ref for value shapes */
  get(index: number): T | undefined
}

/**
 * State for a list region.
 * @internal
 */
interface ListRegionState<T> {
  /** The DOM nodes for each item, in order */
  nodes: Node[]
  /** Scopes for each item (for nested subscriptions) */
  scopes: Scope[]
  /** The parent scope */
  parentScope: Scope
  /** The list ref for accessing items (needed for delta handling) */
  listRef: ListRefLike<T>
}

// =============================================================================
// List Region - Functional Core (Pure Planning Functions)
// =============================================================================

/**
 * Plan operations for initial render of a list region.
 *
 * This is a pure function that returns insert operations for all items
 * in the list. Uses `listRef.get(i)` to obtain refs (not raw values).
 *
 * @param listRef - The list ref to iterate over
 * @returns Array of insert operations
 *
 * @internal - Exported for testing
 */
export function planInitialRender<T>(
  listRef: ListRefLike<T>,
): ListRegionOp<T>[] {
  const ops: ListRegionOp<T>[] = []
  for (let i = 0; i < listRef.length; i++) {
    const item = listRef.get(i)
    if (item !== undefined) {
      ops.push({ kind: "insert", index: i, item })
    }
  }
  return ops
}

/**
 * Plan operations from a list delta event.
 *
 * This is a pure function that processes Loro delta events and returns
 * the corresponding list region operations. For inserts, it uses
 * `listRef.get(index)` to obtain refs (not the raw values from the delta).
 *
 * @param listRef - The list ref (already updated by Loro)
 * @param event - The Loro event batch
 * @returns Array of operations to apply
 *
 * @internal - Exported for testing
 */
export function planDeltaOps<T>(
  listRef: ListRefLike<T>,
  event: ListDeltaEvent | LoroEventBatch,
): ListRegionOp<T>[] {
  const ops: ListRegionOp<T>[] = []

  for (const diff of event.events) {
    if (diff.diff.type !== "list") continue

    const deltas = diff.diff.diff as Array<{
      retain?: number
      delete?: number
      insert?: unknown[]
    }>
    let index = 0

    for (const delta of deltas) {
      if (delta.retain !== undefined) {
        // Skip over retained items
        index += delta.retain
      } else if (delta.delete !== undefined) {
        // Delete items at current index
        // Note: We generate delete ops in order, but execution must
        // delete from the same index repeatedly (not advancing)
        for (let i = 0; i < delta.delete; i++) {
          ops.push({ kind: "delete", index })
        }
        // Don't advance index - next op is at same position
      } else if (delta.insert !== undefined) {
        // Insert items at current index
        // IMPORTANT: Use listRef.get() to get refs, NOT the raw delta values
        const insertCount = (delta.insert as unknown[]).length
        for (let i = 0; i < insertCount; i++) {
          const item = listRef.get(index + i)
          if (item !== undefined) {
            ops.push({ kind: "insert", index: index + i, item })
          }
        }
        index += insertCount
      }
    }
  }

  return ops
}

// =============================================================================
// List Region - Imperative Shell (DOM Manipulation)
// =============================================================================

/**
 * Execute a single list region operation against the DOM.
 *
 * This is the imperative shell that performs actual DOM manipulation.
 * It handles both insert and delete operations.
 *
 * @param parent - The parent DOM node
 * @param state - The list region state (mutated)
 * @param handlers - The user-provided handlers
 * @param op - The operation to execute
 *
 * @internal
 */
function executeOp<T>(
  parent: Node,
  state: ListRegionState<T>,
  handlers: ListRegionHandlers<T>,
  op: ListRegionOp<T>,
): void {
  if (op.kind === "insert") {
    const itemScope = state.parentScope.createChild()
    const node = handlers.create(op.item, op.index)

    // Insert into DOM at correct position
    const referenceNode = state.nodes[op.index] || null
    parent.insertBefore(node, referenceNode)

    // Update state
    state.nodes.splice(op.index, 0, node)
    state.scopes.splice(op.index, 0, itemScope)
  } else if (op.kind === "delete") {
    const node = state.nodes[op.index]
    const itemScope = state.scopes[op.index]

    // Remove from DOM
    if (node && node.parentNode === parent) {
      parent.removeChild(node)
    }

    // Dispose the item's scope (cleans up subscriptions)
    if (itemScope) {
      itemScope.dispose()
    }

    // Update state
    state.nodes.splice(op.index, 1)
    state.scopes.splice(op.index, 1)
  }
}

/**
 * Execute a batch of operations.
 *
 * @param parent - The parent DOM node
 * @param state - The list region state (mutated)
 * @param handlers - The user-provided handlers
 * @param ops - The operations to execute
 *
 * @internal
 */
function executeOps<T>(
  parent: Node,
  state: ListRegionState<T>,
  handlers: ListRegionHandlers<T>,
  ops: ListRegionOp<T>[],
): void {
  for (const op of ops) {
    executeOp(parent, state, handlers, op)
  }
}

// =============================================================================
// List Region - Public API
// =============================================================================

/**
 * Create a delta-based list region.
 *
 * This subscribes to a Loro list and updates the DOM based on deltas.
 * When items are inserted/deleted, only the affected DOM nodes change.
 *
 * The handlers receive refs (not raw values) for value shapes, enabling
 * two-way binding patterns like:
 *
 * ```typescript
 * for (const itemRef of doc.todos) {
 *   const item = itemRef.get()  // Read current value
 *   li({ onClick: () => itemRef.set(item.toUpperCase()) }, item)
 * }
 * ```
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
  // Cast to ListRefLike - the listRef must have .length and .get()
  const typedListRef = listRef as ListRefLike<T>

  // Initialize state with listRef stored for delta handling
  const state: ListRegionState<T> = {
    nodes: [],
    scopes: [],
    parentScope: scope,
    listRef: typedListRef,
  }

  // Plan and execute initial render
  const initialOps = planInitialRender(typedListRef)
  executeOps(parent, state, handlers, initialOps)

  // Subscribe to changes
  __subscribe(
    listRef,
    event => {
      // Plan and execute delta operations
      const deltaOps = planDeltaOps(state.listRef, event)
      executeOps(parent, state, handlers, deltaOps)
    },
    scope,
  )
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
