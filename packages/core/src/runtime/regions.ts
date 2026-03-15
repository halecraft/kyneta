/**
 * Region management for lists and conditionals.
 *
 * Regions are DOM areas that update reactively based on data changes:
 * - List regions: Render items from a sequence ref, update via deltas
 * - Conditional regions: Show/hide content based on a condition
 *
 * ## List Region Architecture (Functional Core / Imperative Shell)
 *
 * The `listRegion` runtime follows FC/IS pattern:
 *
 * **Functional Core** (pure, testable):
 * - `planInitialRender(listRef)` → `ListRegionOp<T>[]`
 * - `planDeltaOps(listRef, deltaOps)` → `ListRegionOp<T>[]`
 *
 * **Imperative Shell** (DOM manipulation):
 * - `executeOp(parent, state, handlers, op)` — applies single operation
 *
 * Both planning functions use `listRef.at(index)` to obtain refs, ensuring
 * handlers always receive refs for value shapes. This enables the component
 * pattern where refs are passed for two-way binding:
 *
 * ```typescript
 * for (const itemRef of doc.items) {
 *   TodoItem({ item: itemRef })  // Component can read AND write
 * }
 * ```
 *
 * @packageDocumentation
 */

import { isSequenceChange, type ChangeBase, type SequenceChange, type SequenceChangeOp } from "@kyneta/schema"
import type {
  ConditionalRegionHandlers,
  ConditionalRegionOp,
  ListRegionHandlers,
  ListRegionOp,
  Slot,
} from "../types.js"
import type { Scope } from "./scope.js"
import { subscribe } from "./subscribe.js"

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
 * **Runtime vs compile-time slot kind:** The compile-time `slotKind` hint
 * is an optimization that lets the runtime skip inspection. However, the
 * runtime may produce a slot of a *different* kind than the hint when the
 * hint is overly conservative. For example, `slotKind: "range"` with a
 * fragment containing 0 or 1 children will produce a `"single"` slot
 * (empty placeholder or direct child tracking). This is intentional —
 * the runtime always produces the **minimal** slot representation, and
 * the compile-time hint is a fast-path for the common case. The fallback
 * path (no hint) inspects at runtime and produces identical results.
 *
 * @param parent - The parent node to insert into
 * @param content - The node to insert (may be a DocumentFragment)
 * @param referenceNode - Insert before this node (or append if null)
 * @param slotKind - Optional compile-time hint for optimization.
 *   When provided, dispatches directly without runtime inspection.
 *   May produce a different slot kind than hinted (see above).
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
      content.childNodes.length === 1 &&
      content.firstChild
    ) {
      const child = content.firstChild
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
      const startMarker = document.createComment("kyneta:start")
      const endMarker = document.createComment("kyneta:end")
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
    } else if (childCount === 1 && content.firstChild) {
      // Single-element fragment - track the child directly (no overhead)
      const child = content.firstChild
      parent.insertBefore(content, referenceNode)
      return { kind: "single", node: child }
    } else {
      // Multi-element fragment - use start/end markers
      const startMarker = document.createComment("kyneta:start")
      const endMarker = document.createComment("kyneta:end")

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
 * Minimal interface for list refs used by planning functions.
 * This allows testing without real ListRef instances.
 * @internal
 */
export interface ListRefLike<T> {
  /** Number of items in the list */
  readonly length: number
  /** Get ref at index — returns ref for value shapes */
  at(index: number): T | undefined
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
  /** Scopes for each item (for nested subscriptions). Null when item is static (no reactive content). */
  scopes: (Scope | null)[]
  /** The list ref for accessing items (needed for delta handling) */
  listRef: ListRefLike<T>
  /**
   * Closing marker for template-cloning path.
   *
   * When `listRegion` receives a comment node (the opening marker from
   * template cloning), `endMarker` is the closing `<!--/kyneta:list-->`
   * comment. Items are inserted *before* this marker so they stay between
   * the opening and closing comments.
   *
   * When `listRegion` receives a container element (createElement path),
   * `endMarker` is `null` — items append at the end of the container.
   */
  endMarker: Node | null
}

// =============================================================================
// List Region - Functional Core (Pure Planning Functions)
// =============================================================================

/**
 * Plan operations for initial render of a list region.
 *
 * This is a pure function that returns insert operations for all items
 * in the list. Uses `listRef.at(i)` to obtain refs (not raw values).
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
    const item = listRef.at(i)
    if (item !== undefined) {
      ops.push({ kind: "insert", index: i, item })
    }
  }
  return ops
}

/**
 * Plan operations based on sequence change ops from a SequenceChange.
 *
 * Converts SequenceChangeOp<T>[] into ListRegionOp[] for DOM manipulation.
 * For inserts, it uses `listRef.at(index)` to obtain refs from the live
 * ref tree — the plain values in the change ops are NOT passed to handlers.
 * This preserves the two-layer model: changes carry data (for step/pure
 * computation), the runtime uses the ref tree (for DOM).
 *
 * Emits batch operations when count > 1 for better DOM performance:
 * - batch-insert: One DocumentFragment insertion instead of N insertBefore calls
 * - batch-delete: One Range.deleteContents() instead of N removeChild calls
 *
 * @param listRef - The sequence ref (already updated by the source)
 * @param deltaOps - The sequence change operations from a SequenceChange
 * @returns Array of operations to apply
 *
 * @internal - Exported for testing
 */
export function planDeltaOps<T>(
  listRef: ListRefLike<T>,
  deltaOps: readonly SequenceChangeOp<unknown>[],
): ListRegionOp<T>[] {
  const ops: ListRegionOp<T>[] = []
  let index = 0

  for (const delta of deltaOps) {
    if ("retain" in delta) {
      // Skip over retained items
      index += delta.retain
    } else if ("delete" in delta) {
      const deleteCount = delta.delete
      if (deleteCount > 1) {
        // Batch delete: one Range operation instead of N removeChild calls
        ops.push({ kind: "batch-delete", index, count: deleteCount })
      } else {
        // Single delete
        ops.push({ kind: "delete", index })
      }
      // Don't advance index - next op is at same position
    } else if ("insert" in delta) {
      // insert carries readonly T[] — use .length as count, then look up
      // refs from the live ref tree via listRef.at(index)
      const insertCount = delta.insert.length
      if (insertCount > 1) {
        // Batch insert: one DocumentFragment insertion instead of N insertBefore calls
        // Note: batch-insert carries count, not items. Executor calls listRef.at()
        ops.push({ kind: "batch-insert", index, count: insertCount })
      } else {
        // Single insert: use listRef.at() to get ref
        const item = listRef.at(index)
        if (item !== undefined) {
          ops.push({ kind: "insert", index, item })
        }
      }
      index += insertCount
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
  // When isReactive is explicitly false, skip scope allocation for items.
  // Default to true (conservative) when not specified.
  const needsScope = handlers.isReactive !== false

  if (op.kind === "insert") {
    const itemScope = needsScope ? state.parentScope.createChild() : null
    const node = handlers.create(op.item, op.index)

    // Insert into DOM at correct position
    // For single nodes, use the node; for ranges, use the start marker
    const existingResult = state.slots[op.index]
    const referenceNode = existingResult
      ? existingResult.kind === "single"
        ? existingResult.node
        : existingResult.startMarker
      : state.endMarker

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
  } else if (op.kind === "batch-insert") {
    // Batch insert: create all items, collect into DocumentFragment, single DOM insertion
    const fragment = document.createDocumentFragment()
    const newSlots: Slot[] = []

    const newScopes: (Scope | null)[] = []

    for (let i = 0; i < op.count; i++) {
      const item = state.listRef.at(op.index + i)
      if (item === undefined) continue

      const itemScope = needsScope ? state.parentScope.createChild() : null
      const node = handlers.create(item, op.index + i)

      // For batch insert, we always use single-node slots within the fragment
      // The fragment itself handles the batching
      if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        // Fragment returned by handler - extract its children
        const child = node.firstChild
        if (child && node.childNodes.length === 1) {
          fragment.appendChild(node) // Moves the child
          newSlots.push({ kind: "single", node: child })
        } else if (node.childNodes.length > 1) {
          // Multi-child fragment - need range markers
          const startMarker = document.createComment("kyneta:item")
          const endMarker = document.createComment("/kyneta:item")
          fragment.appendChild(startMarker)
          fragment.appendChild(node) // Moves all children
          fragment.appendChild(endMarker)
          newSlots.push({ kind: "range", startMarker, endMarker })
        }
      } else {
        fragment.appendChild(node)
        newSlots.push({ kind: "single", node })
      }
      newScopes.push(itemScope)
    }

    // Single DOM insertion for all items
    const existingResult = state.slots[op.index]
    const referenceNode = existingResult
      ? existingResult.kind === "single"
        ? existingResult.node
        : existingResult.startMarker
      : state.endMarker
    parent.insertBefore(fragment, referenceNode)

    // Update state with single splice
    state.slots.splice(op.index, 0, ...newSlots)
    state.scopes.splice(op.index, 0, ...newScopes)
  } else if (op.kind === "batch-delete") {
    // Batch delete: use Range API for contiguous slot removal
    const startIndex = op.index
    const endIndex = op.index + op.count - 1

    // Get the range boundaries from slots
    const startSlot = state.slots[startIndex]
    const endSlot = state.slots[endIndex]

    if (startSlot && endSlot) {
      // Use Range API for efficient batch removal
      const range = document.createRange()

      // Set start before the first slot
      if (startSlot.kind === "single") {
        range.setStartBefore(startSlot.node)
      } else {
        range.setStartBefore(startSlot.startMarker)
      }

      // Set end after the last slot
      if (endSlot.kind === "single") {
        range.setEndAfter(endSlot.node)
      } else {
        range.setEndAfter(endSlot.endMarker)
      }

      // Single DOM operation to delete all content
      range.deleteContents()
    }

    // Dispose all scopes in the range
    for (let i = 0; i < op.count; i++) {
      const scope = state.scopes[op.index + i]
      if (scope) {
        scope.dispose()
      }
    }

    // Update state with single splice
    state.slots.splice(op.index, op.count)
    state.scopes.splice(op.index, op.count)
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
export function listRegion<T>(
  mountPoint: Node,
  listRef: unknown,
  handlers: ListRegionHandlers<T>,
  scope: Scope,
): void {
  // Resolve the mount point into (parent, endMarker).
  //
  // Two codegen paths produce different mount points:
  //   - createElement path: mountPoint is the container element (e.g. <ul>).
  //     Items append at the end → endMarker = null.
  //   - Template-cloning path: mountPoint is the opening comment marker
  //     (e.g. <!--kyneta:list:N-->). Its nextSibling is the closing marker
  //     (<!--/kyneta:list-->). Items insert before the closing marker so
  //     they stay between the paired comments.
  //
  // This is structurally identical to how conditionalRegion derives its
  // parent from marker.parentNode — the same anchoring pattern for lists.
  let parent: Node
  let endMarker: Node | null

  if (mountPoint.nodeType === Node.COMMENT_NODE) {
    parent = mountPoint.parentNode!
    endMarker = mountPoint.nextSibling // the <!--/kyneta:list--> closing marker
  } else {
    parent = mountPoint
    endMarker = null
  }

  // Cast to ListRefLike - the listRef must have .length and .at()
  const typedListRef = listRef as ListRefLike<T>

  // Initialize state with listRef stored for delta handling
  const state: ListRegionState<T> = {
    slots: [],
    scopes: [],
    parentScope: scope,
    listRef: typedListRef,
    endMarker,
  }

  // Plan and execute initial render
  const initialOps = planInitialRender(typedListRef)
  executeOps(parent, state, handlers, initialOps)

  // Subscribe to changes
  subscribe(
    listRef,
    (change: ChangeBase) => {
      // Only process sequence changes — other change types trigger full re-render
      if (isSequenceChange(change)) {
        const regionOps = planDeltaOps(
          state.listRef,
          change.ops,
        )
        executeOps(parent, state, handlers, regionOps)
      } else {
        // Fallback: non-sequence change (e.g., "replace") — full re-render
        // Clear existing items
        for (let i = state.slots.length - 1; i >= 0; i--) {
          const slot = state.slots[i]
          const itemScope = state.scopes[i]
          if (slot) releaseSlot(parent, slot)
          if (itemScope) itemScope.dispose()
        }
        state.slots = []
        state.scopes = []
        // Re-render all items
        const newOps = planInitialRender(state.listRef)
        executeOps(parent, state, handlers, newOps)
      }
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
export function conditionalRegion(
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
  subscribe(
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
