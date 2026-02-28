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
  ConditionalRegionOp,
  ListRegionHandlers,
  ListRegionOp,
  TrackedNode,
} from "../types.js"
import type { Scope } from "./scope.js"
import { __subscribe } from "./subscribe.js"

// =============================================================================
// Fragment Handling Helper
// =============================================================================

/**
 * Insert a node into the DOM and return a TrackedNode for later removal.
 *
 * When a DocumentFragment is inserted, its children are moved to the parent
 * and the fragment becomes empty with no parentNode. This helper handles that
 * case by tracking the first child instead of the empty fragment.
 *
 * The returned TrackedNode guarantees the invariant:
 * "The referenced node is a direct child of the parent it was inserted into."
 *
 * @param parent - The parent node to insert into
 * @param content - The node to insert (may be a DocumentFragment)
 * @param referenceNode - Insert before this node (or append if null)
 * @returns TrackedNode for reliable removal
 *
 * @internal
 */
function insertAndTrack(
  parent: Node,
  content: Node,
  referenceNode: Node | null,
): TrackedNode {
  if (content.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    // For fragments, track the first child (which will become a direct child of parent)
    // Note: This assumes single-element fragments. For multi-element, we'd need
    // a more complex tracking strategy (e.g., start/end markers).
    const firstChild = content.firstChild
    if (!firstChild) {
      // Empty fragment - create a placeholder text node
      const placeholder = document.createTextNode("")
      parent.insertBefore(placeholder, referenceNode)
      return { node: placeholder }
    } else {
      // Insert the fragment (moves children to parent)
      parent.insertBefore(content, referenceNode)
      // Track the first child that was moved
      return { node: firstChild }
    }
  } else {
    parent.insertBefore(content, referenceNode)
    return { node: content }
  }
}

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
 * Base state shared by all region types.
 *
 * Regions (list, conditional) manage DOM content that updates reactively.
 * They all need a parent scope for creating child scopes during rendering.
 *
 * @internal
 */
interface RegionStateBase {
  /** The parent scope that owns this region */
  parentScope: Scope
}

/**
 * State for a list region.
 * @internal
 */
interface ListRegionState<T> extends RegionStateBase {
  /** Tracked nodes for each item, in order */
  nodes: TrackedNode[]
  /** Scopes for each item (for nested subscriptions) */
  scopes: Scope[]
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
    const referenceNode = state.nodes[op.index]?.node || null

    // Handle DocumentFragment: use helper to get the actual tracked node
    const trackedNode = insertAndTrack(parent, node, referenceNode)

    // Update state with the actual tracked node (not the empty fragment)
    state.nodes.splice(op.index, 0, trackedNode)
    state.scopes.splice(op.index, 0, itemScope)
  } else if (op.kind === "delete") {
    const tracked = state.nodes[op.index]
    const itemScope = state.scopes[op.index]

    // Remove from DOM
    if (tracked && tracked.node.parentNode === parent) {
      parent.removeChild(tracked.node)
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
interface ConditionalRegionState extends RegionStateBase {
  /** Current branch: "true" = then, "false" = else, null = neither */
  currentBranch: "true" | "false" | null
  /** The tracked node for current content */
  currentNode: TrackedNode | null
  /** Scope for the current branch */
  currentScope: Scope | null
}

// =============================================================================
// Conditional Region - Functional Core (Pure Planning Function)
// =============================================================================

/**
 * Plan the operation needed to update a conditional region.
 *
 * This is a pure function that determines what DOM operation is needed
 * based on the current state and new condition. It follows the FC/IS pattern:
 * - This function (planConditionalUpdate) is the Functional Core
 * - executeConditionalOp is the Imperative Shell
 *
 * @param currentBranch - The currently rendered branch ("true", "false", or null)
 * @param newCondition - The new condition value
 * @param hasWhenFalse - Whether a whenFalse handler exists
 * @returns The operation to perform
 *
 * @internal - Exported for testing
 */
export function planConditionalUpdate(
  currentBranch: "true" | "false" | null,
  newCondition: boolean,
  hasWhenFalse: boolean,
): ConditionalRegionOp {
  const targetBranch: "true" | "false" | null = newCondition
    ? "true"
    : hasWhenFalse
      ? "false"
      : null

  // No change needed
  if (currentBranch === targetBranch) {
    return { kind: "noop" }
  }

  // From nothing to something
  if (currentBranch === null && targetBranch !== null) {
    return { kind: "insert", branch: targetBranch }
  }

  // From something to nothing
  if (currentBranch !== null && targetBranch === null) {
    return { kind: "delete" }
  }

  // From one branch to another
  if (currentBranch !== null && targetBranch !== null) {
    return { kind: "swap", toBranch: targetBranch }
  }

  // Should never reach here, but TypeScript needs this
  return { kind: "noop" }
}

// =============================================================================
// Conditional Region - Imperative Shell (DOM Manipulation)
// =============================================================================

/**
 * Execute a conditional region operation against the DOM.
 *
 * This is the imperative shell that performs actual DOM manipulation.
 * It receives operations from planConditionalUpdate().
 *
 * @param parent - The parent DOM node
 * @param marker - The comment marker for positioning
 * @param state - The conditional region state (mutated)
 * @param handlers - The user-provided handlers
 * @param op - The operation to execute
 *
 * @internal
 */
function executeConditionalOp(
  parent: Node,
  marker: Comment,
  state: ConditionalRegionState,
  handlers: ConditionalRegionHandlers,
  op: ConditionalRegionOp,
): void {
  if (op.kind === "noop") {
    return
  }

  // Clean up current content (for delete and swap)
  if (op.kind === "delete" || op.kind === "swap") {
    if (state.currentNode && state.currentNode.node.parentNode === parent) {
      parent.removeChild(state.currentNode.node)
    }
    if (state.currentScope) {
      state.currentScope.dispose()
      state.currentScope = null
    }
    state.currentNode = null
    state.currentBranch = null
  }

  // Insert new content (for insert and swap)
  if (op.kind === "insert" || op.kind === "swap") {
    const branch = op.kind === "insert" ? op.branch : op.toBranch
    const handler = branch === "true" ? handlers.whenTrue : handlers.whenFalse

    if (handler) {
      state.currentScope = state.parentScope.createChild()
      const node = handler()
      state.currentBranch = branch
      const referenceNode = marker.nextSibling
      state.currentNode = insertAndTrack(parent, node, referenceNode)
    }
  }
}

// =============================================================================
// Conditional Region - Public API
// =============================================================================

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
 *
 * This function orchestrates the FC/IS pattern:
 * 1. Evaluates the condition
 * 2. Plans the update (pure)
 * 3. Executes the operation (imperative)
 *
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

  // Plan the update (pure) - currentBranch is already "true" | "false" | null
  const op = planConditionalUpdate(
    state.currentBranch,
    condition,
    handlers.whenFalse !== undefined,
  )

  // Execute the operation (imperative)
  executeConditionalOp(parent, marker, state, handlers, op)
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
    // Insert after marker, handling DocumentFragment
    const referenceNode = marker.nextSibling
    const trackedNode = insertAndTrack(parent, node, referenceNode)

    // Register cleanup using the tracked node (not the potentially empty fragment)
    scope.onDispose(() => {
      if (trackedNode.node.parentNode) {
        trackedNode.node.parentNode.removeChild(trackedNode.node)
      }
    })
  }
}
