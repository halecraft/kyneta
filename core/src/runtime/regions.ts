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
  Slot,
  ListRegionHandlers,
  ListRegionOp,
} from "../types.js"
import type { Scope } from "./scope.js"
import { __subscribe } from "./subscribe.js"

// =============================================================================
// Fragment Handling Helper
// =============================================================================

/**
 * Claim a slot in the DOM for the given content.
 *
 * Handles three cases:
 * 1. **Regular element/text**: Inserted directly, tracked as single node
 * 2. **Single-element fragment**: First child tracked as single node (no overhead)
 * 3. **Multi-element fragment**: Start/end comment markers delimit the range
 *
 * The returned Slot guarantees the trackability invariant:
 * all inserted content can be reliably removed via releaseSlot().
 *
 * @param parent - The parent node to insert into
 * @param content - The node to insert (may be a DocumentFragment)
 * @param referenceNode - Insert before this node (or append if null)
 * @param slotKind - Optional compile-time hint for optimization
 * @returns Slot for reliable removal
 *
 * @internal - Exported for testing
 */
export function claimSlot(
  parent: Node,
  content: Node,
  referenceNode: Node | null,
  slotKind?: import("../types.js").SlotKind,
): Slot {
  // Fast path: if slotKind is provided, use it directly
  if (slotKind === "single") {
    // Compile-time analysis determined this is a single node
    if (
      content.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      content.childNodes.length === 1
    ) {
      const child = content.firstChild!
      parent.insertBefore(content, referenceNode)
      return { kind: "single", node: child }
    }
    parent.insertBefore(content, referenceNode)
    return { kind: "single", node: content }
  }

  if (slotKind === "range") {
    // Compile-time analysis determined this needs range markers
    if (content.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      const childCount = content.childNodes.length
      if (childCount === 0) {
        const placeholder = document.createTextNode("")
        parent.insertBefore(placeholder, referenceNode)
        return { kind: "single", node: placeholder }
      }
      const startMarker = document.createComment("kinetic:start")
      const endMarker = document.createComment("kinetic:end")
      parent.insertBefore(startMarker, referenceNode)
      parent.insertBefore(content, referenceNode)
      parent.insertBefore(endMarker, referenceNode)
      return { kind: "range", startMarker, endMarker }
    }
    // Fallback for non-fragment (shouldn't happen with correct slotKind)
    parent.insertBefore(content, referenceNode)
    return { kind: "single", node: content }
  }

  // Fallback: no slotKind hint, inspect at runtime
  if (content.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const childCount = content.childNodes.length

    if (childCount === 0) {
      // Empty fragment - create a placeholder text node
      const placeholder = document.createTextNode("")
      parent.insertBefore(placeholder, referenceNode)
      return { kind: "single", node: placeholder }
    } else if (childCount === 1) {
      // Single-element fragment - track the child directly (no overhead)
      const child = content.firstChild!
      parent.insertBefore(content, referenceNode)
      return { kind: "single", node: child }
    } else {
      // Multi-element fragment - use start/end markers
      const startMarker = document.createComment("kinetic:start")
      const endMarker = document.createComment("kinetic:end")

      // Insert: startMarker, then fragment contents, then endMarker
      parent.insertBefore(startMarker, referenceNode)
      parent.insertBefore(content, referenceNode) // Moves all children
      parent.insertBefore(endMarker, referenceNode)

      return { kind: "range", startMarker, endMarker }
    }
  } else {
    parent.insertBefore(content, referenceNode)
    return { kind: "single", node: content }
  }
}

/**
 * Release a slot, removing all its content from the DOM.
 *
 * For single nodes, removes the node directly.
 * For ranges, removes all nodes between the markers (inclusive).
 *
 * @param parent - The parent node containing the content
 * @param slot - The Slot to remove
 *
 * @internal - Exported for testing
 */
export function releaseSlot(parent: Node, slot: Slot): void {
  if (slot.kind === "single") {
    if (slot.node.parentNode === parent) {
      parent.removeChild(slot.node)
    }
  } else {
    // Remove all nodes from startMarker to endMarker (inclusive)
    const { startMarker, endMarker } = slot

    // Collect nodes to remove (can't remove while iterating)
    const nodesToRemove: Node[] = []
    let current: Node | null = startMarker

    while (current && current !== endMarker) {
      nodesToRemove.push(current)
      current = current.nextSibling
    }

    // Include the end marker
    if (endMarker.parentNode === parent) {
      nodesToRemove.push(endMarker)
    }

    // Remove all collected nodes
    for (const node of nodesToRemove) {
      if (node.parentNode === parent) {
        parent.removeChild(node)
      }
    }
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
  /** Slots for each item, in order */
  slots: Slot[]
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
    // For single nodes, use the node; for ranges, use the start marker
    const existingResult = state.slots[op.index]
    const referenceNode = existingResult
      ? existingResult.kind === "single"
        ? existingResult.node
        : existingResult.startMarker
      : null

    // Handle DocumentFragment: use helper to get Slot
    const slot = claimSlot(parent, node, referenceNode, handlers.slotKind)

    // Update state with the slot
    state.slots.splice(op.index, 0, slot)
    state.scopes.splice(op.index, 0, itemScope)
  } else if (op.kind === "delete") {
    const slot = state.slots[op.index]
    const scope = state.scopes[op.index]

    if (slot) {
      releaseSlot(parent, slot)
    }

    // Dispose the item's scope (cleans up subscriptions)
    if (scope) {
      scope.dispose()
    }

    // Update state
    state.slots.splice(op.index, 1)
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
    slots: [],
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
  /** The slot for current content */
  currentSlot: Slot | null
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
    if (state.currentSlot) {
      releaseSlot(parent, state.currentSlot)
    }
    if (state.currentScope) {
      state.currentScope.dispose()
    }
    state.currentSlot = null
    state.currentScope = null
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
      state.currentSlot = claimSlot(
        parent,
        node,
        referenceNode,
        handlers.slotKind,
      )
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
    currentSlot: null,
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
    const slot = claimSlot(parent, node, referenceNode, handlers.slotKind)

    // Register cleanup using releaseSlot for proper multi-element handling
    scope.onDispose(() => {
      releaseSlot(parent, slot)
    })
  }
}
