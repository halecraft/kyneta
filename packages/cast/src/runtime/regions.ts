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

import {
  type ChangeBase,
  isSequenceChange,
  type SequenceInstruction,
} from "@kyneta/schema"
import type {
  ConditionalRegionHandlers,
  ConditionalRegionOp,
  FilteredListRegionHandlers,
  FilterUpdateOp,
  ListRegionHandlers,
  ListRegionOp,
  Slot,
} from "../types.js"
import type { Scope } from "./scope.js"
import { subscribe } from "./subscribe.js"

// =============================================================================
// Anchor-Based Parent Resolution
// =============================================================================

/**
 * Resolve the current parent node from an anchor (comment marker).
 *
 * Tree-structural regions (list, conditional) must never cache a `parent`
 * reference across async boundaries (subscription callbacks). A comment
 * marker that starts inside a DocumentFragment will move to the real DOM
 * when the fragment is consumed by `insertBefore`. The marker's
 * `parentNode` is a live property that always reflects the current tree
 * state, so resolving it at operation time gives the correct parent.
 *
 * @param anchor - A comment marker node that serves as the region's anchor
 * @returns The current parent node of the anchor
 * @throws Error if the anchor has been detached (indicates a lifecycle bug)
 *
 * @internal
 */
function resolveParent(anchor: Node): Node {
  const parent = anchor.parentNode
  if (!parent) {
    throw new Error("Region anchor has been detached from the DOM")
  }
  return parent
}

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
  /**
   * Anchor node for lazy parent resolution in marker mode.
   *
   * In marker mode (comment or auto-promoted fragment mount point),
   * `anchor` is the opening comment marker. The parent is resolved
   * lazily via `resolveParent(anchor)` at each operation point, which
   * is essential when the marker starts inside a DocumentFragment.
   *
   * In container mode (element mount point), `anchor` is `null` — the
   * container element IS the stable parent and never becomes stale.
   */
  anchor: Node | null
  /**
   * Stable parent for container mode.
   *
   * In container mode (element mount point), `containerParent` is the
   * element itself. It is stable and never becomes stale.
   *
   * In marker mode, `containerParent` is `null` — the parent is resolved
   * lazily from `anchor` via `resolveParent()`.
   */
  containerParent: Node | null
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
 * Converts SequenceInstruction<T>[] into ListRegionOp[] for DOM manipulation.
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
  deltaOps: readonly SequenceInstruction<unknown>[],
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
// Filtered List Region - Functional Core (Pure Planning Function)
// =============================================================================

/**
 * Plan filter visibility updates by comparing current visibility against
 * the predicate for each item.
 *
 * This is a pure function that returns show/hide operations for items
 * whose visibility has changed. It follows the FC/IS pattern:
 * - This function (planFilterUpdate) is the Functional Core
 * - The caller applies the ops to the DOM (Imperative Shell)
 *
 * @param visibility - Current visibility state (index-aligned with listRef)
 * @param predicate - The filter predicate to evaluate
 * @param listRef - The list ref for accessing items
 * @returns Array of show/hide operations for items that changed
 *
 * @internal - Exported for testing
 */
export function planFilterUpdate<T>(
  visibility: boolean[],
  predicate: (item: T, index: number) => boolean,
  listRef: ListRefLike<T>,
): FilterUpdateOp[] {
  const ops: FilterUpdateOp[] = []
  for (let i = 0; i < listRef.length; i++) {
    const item = listRef.at(i)
    if (item === undefined) continue
    const shouldBeVisible = predicate(item, i)
    if (shouldBeVisible && !visibility[i]) {
      ops.push({ kind: "show", index: i })
    } else if (!shouldBeVisible && visibility[i]) {
      ops.push({ kind: "hide", index: i })
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
    const node = handlers.create(op.item, op.index, itemScope ?? state.parentScope)

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
      const node = handlers.create(item, op.index + i, itemScope ?? state.parentScope)

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
  // Resolve the mount point into (anchor | containerParent, endMarker).
  //
  // Three codegen paths produce different mount points:
  //
  //   1. **Container mode** (createElement path): mountPoint is the container
  //      element (e.g. <ul>). Items append at the end. The element is a
  //      stable parent — it never moves between DOM trees.
  //
  //   2. **Marker mode** (template-cloning path): mountPoint is the opening
  //      comment marker (e.g. <!--kyneta:list:N-->). Its nextSibling is the
  //      closing marker (<!--/kyneta:list-->). Items insert before the
  //      closing marker so they stay between the paired comments.
  //      Parent is resolved lazily via resolveParent(anchor).
  //
  //   3. **Fragment auto-promotion** (new): mountPoint is a DocumentFragment.
  //      This happens when a listRegion is emitted inside a handler body
  //      that uses generateBodyWithFragment (e.g., a list inside a list's
  //      create callback). Auto-create paired comment markers inside the
  //      fragment and proceed in marker mode. After fragment consumption,
  //      the markers (and items) move to the real parent.
  //
  // The anchor-based resolution principle: tree-structural regions must
  // resolve `parent` from their anchor node at operation time, never at
  // construction time. This is essential for DocumentFragment safety.
  let anchor: Node | null
  let containerParent: Node | null
  let endMarker: Node | null

  if (mountPoint.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    // Fragment auto-promotion: create paired markers inside the fragment
    // and switch to marker mode. After the fragment is consumed by
    // insertBefore, the markers move to the real DOM parent.
    const openMarker = document.createComment("kyneta:list")
    const closeMarker = document.createComment("/kyneta:list")
    mountPoint.appendChild(openMarker)
    mountPoint.appendChild(closeMarker)
    anchor = openMarker
    containerParent = null
    endMarker = closeMarker
  } else if (mountPoint.nodeType === Node.COMMENT_NODE) {
    // Marker mode: the opening marker is the anchor. Parent is resolved
    // lazily via resolveParent(anchor) at each operation point.
    anchor = mountPoint
    containerParent = null
    endMarker = mountPoint.nextSibling // the <!--/kyneta:list--> closing marker
  } else {
    // Container mode: the element IS the stable parent. No anchor needed.
    anchor = null
    containerParent = mountPoint
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
    anchor,
    containerParent,
  }

  // Resolve the parent for the current operation. In container mode this
  // is the stable element; in marker mode it's resolved lazily from the
  // anchor (which may be in a fragment at initial render time, and in the
  // real DOM at subscription callback time).
  const resolveListParent = (): Node => {
    if (state.containerParent) return state.containerParent
    return resolveParent(state.anchor!)
  }

  // Plan and execute initial render
  const initialOps = planInitialRender(typedListRef)
  executeOps(resolveListParent(), state, handlers, initialOps)

  // Subscribe to changes
  subscribe(
    listRef,
    (change: ChangeBase) => {
      const parent = resolveListParent()
      // Only process sequence changes — other change types trigger full re-render
      if (isSequenceChange(change)) {
        const regionOps = planDeltaOps(state.listRef, change.instructions)
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
// Filtered List Region
// =============================================================================

/**
 * State for a filtered list region.
 *
 * Extends the base list region concept with a parallel `visibility` array
 * that tracks which items pass the filter predicate. All arrays are
 * index-aligned with the list ref — `slots[i]`, `scopes[i]`, and
 * `visibility[i]` all correspond to `listRef.at(i)`.
 *
 * Items that fail the predicate have `slots[i] = null` and `scopes[i] = null`
 * but still occupy their index position, keeping alignment intact.
 *
 * @internal
 */
interface FilteredListState<T> extends RegionStateBase {
  /** Slots for each item (null when item is hidden by filter) */
  slots: (Slot | null)[]
  /** Scopes for each item (null when hidden or when isReactive is false) */
  scopes: (Scope | null)[]
  /** The list ref for accessing items */
  listRef: ListRefLike<T>
  /** Closing marker for the list region */
  endMarker: Node | null
  /** Anchor node for lazy parent resolution (marker mode) */
  anchor: Node | null
  /** Stable parent for container mode */
  containerParent: Node | null
  /** Whether each item passes the filter predicate (index-aligned with listRef) */
  visibility: boolean[]
  /**
   * Per-item subscription cleanup functions.
   * `itemUnsubs[i]` is the array of unsubscribe functions for the item deps
   * of source item `i`. When the item is deleted, these are called to clean up.
   * Managed separately from `scopes` because item subscriptions may exist
   * even when the item is hidden (we still need to know when to show it).
   */
  itemUnsubs: (() => void)[][]
}

/**
 * Find the reference node for inserting content at source index `i`.
 *
 * Scans forward from index `i` through the slots array to find the next
 * visible item's DOM anchor. Returns the endMarker if no visible item
 * exists after index `i`.
 *
 * @internal
 */
function findReferenceNode(
  state: FilteredListState<unknown>,
  sourceIndex: number,
): Node | null {
  for (let j = sourceIndex + 1; j < state.slots.length; j++) {
    const slot = state.slots[j]
    if (slot) {
      return slot.kind === "single" ? slot.node : slot.startMarker
    }
  }
  return state.endMarker
}

/**
 * Resolve the parent node for a filtered list region.
 *
 * @internal
 */
function resolveFilteredListParent(state: FilteredListState<unknown>): Node {
  if (state.containerParent) return state.containerParent
  return resolveParent(state.anchor!)
}

/**
 * Show an item that was previously hidden (or newly inserted as visible).
 *
 * Calls the create handler, inserts the content into the DOM at the correct
 * position (before the next visible item or endMarker), and updates state.
 *
 * @internal
 */
function showItem<T>(
  parent: Node,
  state: FilteredListState<T>,
  handlers: FilteredListRegionHandlers<T>,
  index: number,
): void {
  const item = state.listRef.at(index)
  if (item === undefined) return

  const needsScope = handlers.isReactive !== false
  const itemScope = needsScope ? state.parentScope.createChild() : null
  const node = handlers.create(item, index, itemScope ?? state.parentScope)

  const referenceNode = findReferenceNode(state, index)
  const slot = claimSlot(parent, node, referenceNode, handlers.slotKind)

  state.slots[index] = slot
  state.scopes[index] = itemScope
  state.visibility[index] = true
}

/**
 * Hide an item that was previously visible.
 *
 * Removes the content from the DOM and disposes its scope, but keeps
 * the index position occupied (slots[i] = null, visibility[i] = false).
 *
 * @internal
 */
function hideItem<T>(
  parent: Node,
  state: FilteredListState<T>,
  index: number,
): void {
  const slot = state.slots[index]
  if (slot) {
    releaseSlot(parent, slot)
  }
  const scope = state.scopes[index]
  if (scope) {
    scope.dispose()
  }
  state.slots[index] = null
  state.scopes[index] = null
  state.visibility[index] = false
}

/**
 * Execute filter update operations (show/hide) against the DOM.
 *
 * @internal
 */
function executeFilterOps<T>(
  parent: Node,
  state: FilteredListState<T>,
  handlers: FilteredListRegionHandlers<T>,
  ops: FilterUpdateOp[],
): void {
  for (const op of ops) {
    if (op.kind === "show") {
      showItem(parent, state, handlers, op.index)
    } else {
      hideItem(parent, state, op.index)
    }
  }
}

/**
 * Set up per-item subscriptions for a single item's deps.
 *
 * Subscribes to each ref returned by `handlers.itemRefs(item)`. When any
 * item dep fires, re-evaluates the predicate for this item only and
 * shows/hides it if visibility changed.
 *
 * Returns an array of unsubscribe functions for cleanup when the item
 * is deleted from the list.
 *
 * @internal
 */
function setupItemSubscriptions<T>(
  state: FilteredListState<T>,
  handlers: FilteredListRegionHandlers<T>,
  sourceIndex: number,
  scope: Scope,
): (() => void)[] {
  const item = state.listRef.at(sourceIndex)
  if (item === undefined) return []

  const refs = handlers.itemRefs(item)
  const unsubs: (() => void)[] = []

  for (const ref of refs) {
    // We use scope.onDispose to track these, but also return unsub functions
    // so we can clean up when the item is deleted (before scope disposal).
    // Using a child scope per item so disposal is scoped correctly.
    const itemScope = state.scopes[sourceIndex]
    const targetScope = itemScope ?? scope

    subscribe(
      ref,
      () => {
        // The sourceIndex is captured by closure. We need to verify it's still
        // valid (the item hasn't been deleted and re-inserted at a different index).
        // For now, the closure captures the correct index at subscription time.
        const currentItem = state.listRef.at(sourceIndex)
        if (currentItem === undefined) return

        const shouldBeVisible = handlers.predicate(currentItem, sourceIndex)
        const isVisible = state.visibility[sourceIndex]

        if (shouldBeVisible && !isVisible) {
          const parent = resolveFilteredListParent(state)
          showItem(parent, state, handlers, sourceIndex)
        } else if (!shouldBeVisible && isVisible) {
          const parent = resolveFilteredListParent(state)
          hideItem(parent, state, sourceIndex)
        }
      },
      targetScope,
    )
  }

  return unsubs
}

/**
 * Create a filtered list region.
 *
 * This is an optimized variant of `listRegion` for the filter pattern:
 * a reactive loop whose body is a single `if` with no `else`, wrapping
 * all DOM content. Instead of nesting `conditionalRegion` inside
 * `listRegion` (which has the fragment parent problem and fires N
 * subscription callbacks per external dep change), this function
 * separates three subscription layers:
 *
 * 1. **Structural**: subscribes to the list ref for insert/delete/replace.
 * 2. **External**: one subscription per external dep. On change,
 *    re-evaluates the predicate for ALL items (O(n)).
 * 3. **Item**: per-item subscriptions to leaf refs. On change,
 *    re-evaluates the predicate for THAT item only (O(1)).
 *
 * @param mountPoint - Container element, comment marker, or DocumentFragment
 * @param listRef - The reactive list ref to iterate
 * @param handlers - Handlers with predicate, create, externalRefs, itemRefs
 * @param scope - The scope that owns this region
 *
 * @internal - Called by compiled code
 */
export function filteredListRegion<T>(
  mountPoint: Node,
  listRef: unknown,
  handlers: FilteredListRegionHandlers<T>,
  scope: Scope,
): void {
  // Resolve mount point using the same three-mode pattern as listRegion
  let anchor: Node | null
  let containerParent: Node | null
  let endMarker: Node | null

  if (mountPoint.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    const openMarker = document.createComment("kyneta:list")
    const closeMarker = document.createComment("/kyneta:list")
    mountPoint.appendChild(openMarker)
    mountPoint.appendChild(closeMarker)
    anchor = openMarker
    containerParent = null
    endMarker = closeMarker
  } else if (mountPoint.nodeType === Node.COMMENT_NODE) {
    anchor = mountPoint
    containerParent = null
    endMarker = mountPoint.nextSibling
  } else {
    anchor = null
    containerParent = mountPoint
    endMarker = null
  }

  const typedListRef = listRef as ListRefLike<T>

  const state: FilteredListState<T> = {
    slots: [],
    scopes: [],
    parentScope: scope,
    listRef: typedListRef,
    endMarker,
    anchor,
    containerParent,
    visibility: [],
    itemUnsubs: [],
  }

  // --- Initial render ---
  // Evaluate predicate for each item and render only visible ones.
  const parent = resolveFilteredListParent(state)
  for (let i = 0; i < typedListRef.length; i++) {
    const item = typedListRef.at(i)
    if (item === undefined) continue

    const visible = handlers.predicate(item, i)
    state.visibility.push(visible)

    if (visible) {
      showItem(parent, state, handlers, i)
    } else {
      state.slots.push(null)
      state.scopes.push(null)
    }

    // Set up per-item subscriptions (even for hidden items — we need to
    // know when they become visible)
    state.itemUnsubs.push(
      setupItemSubscriptions(state, handlers, i, scope),
    )
  }

  // --- Structural subscription (Layer 1) ---
  subscribe(
    listRef,
    (change: ChangeBase) => {
      const parent = resolveFilteredListParent(state)

      if (isSequenceChange(change)) {
        // Process structural delta ops. We handle insert/delete manually
        // rather than delegating to executeOps, because we need to evaluate
        // the predicate for new items and manage visibility state.
        let index = 0
        for (const delta of change.instructions) {
          if ("retain" in delta) {
            index += delta.retain
          } else if ("delete" in delta) {
            const count = delta.delete
            for (let d = 0; d < count; d++) {
              // Clean up item subscriptions
              const unsubs = state.itemUnsubs[index]
              if (unsubs) {
                for (const unsub of unsubs) unsub()
              }
              // If visible, remove from DOM
              if (state.visibility[index]) {
                hideItem(parent, state, index)
              }
              // Remove from all state arrays
              state.slots.splice(index, 1)
              state.scopes.splice(index, 1)
              state.visibility.splice(index, 1)
              state.itemUnsubs.splice(index, 1)
              // Don't advance index — next item slides into this position
            }
          } else if ("insert" in delta) {
            const insertCount = delta.insert.length
            for (let ins = 0; ins < insertCount; ins++) {
              const insertIndex = index + ins
              const item = state.listRef.at(insertIndex)
              if (item === undefined) continue

              const visible = handlers.predicate(item, insertIndex)

              // Splice into state arrays at the correct position
              state.visibility.splice(insertIndex, 0, visible)
              state.slots.splice(insertIndex, 0, null)
              state.scopes.splice(insertIndex, 0, null)
              state.itemUnsubs.splice(
                insertIndex,
                0,
                setupItemSubscriptions(state, handlers, insertIndex, scope),
              )

              if (visible) {
                showItem(parent, state, handlers, insertIndex)
              }
            }
            index += insertCount
          }
        }
      } else {
        // Fallback: non-sequence change — full re-render
        // Clean up everything
        for (let i = state.slots.length - 1; i >= 0; i--) {
          const unsubs = state.itemUnsubs[i]
          if (unsubs) {
            for (const unsub of unsubs) unsub()
          }
          if (state.visibility[i]) {
            hideItem(parent, state, i)
          }
        }
        state.slots = []
        state.scopes = []
        state.visibility = []
        state.itemUnsubs = []

        // Re-render all items with predicate evaluation
        for (let i = 0; i < state.listRef.length; i++) {
          const item = state.listRef.at(i)
          if (item === undefined) continue

          const visible = handlers.predicate(item, i)
          state.visibility.push(visible)

          if (visible) {
            showItem(parent, state, handlers, i)
          } else {
            state.slots.push(null)
            state.scopes.push(null)
          }

          state.itemUnsubs.push(
            setupItemSubscriptions(state, handlers, i, scope),
          )
        }
      }
    },
    scope,
  )

  // --- External subscription (Layer 2) ---
  // One subscription per external dep, owned by the parent scope.
  // When any external ref changes, re-evaluate predicate for ALL items.
  for (const ref of handlers.externalRefs) {
    subscribe(
      ref,
      () => {
        const parent = resolveFilteredListParent(state)
        const ops = planFilterUpdate(
          state.visibility,
          handlers.predicate,
          state.listRef,
        )
        executeFilterOps(parent, state, handlers, ops)
      },
      scope,
    )
  }
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
 * This subscribes to one or more reactive refs and swaps DOM content
 * when the condition changes. Mirrors `valueRegion`'s multi-ref pattern:
 * each ref in the array gets its own subscription, and any change from
 * any ref triggers re-evaluation of `getCondition()`.
 *
 * @param marker - A comment node marking the position
 * @param conditionRefs - Array of reactive refs that the condition depends on
 * @param getCondition - Function to evaluate the condition
 * @param handlers - Callbacks for creating branches
 * @param scope - The scope that owns this region
 *
 * @internal - Called by compiled code
 */
export function conditionalRegion(
  marker: Comment,
  conditionRefs: unknown[],
  getCondition: () => boolean,
  handlers: ConditionalRegionHandlers,
  scope: Scope,
): void {
  // Validate that the marker has a parent at construction time.
  // We do NOT cache the parent — it is resolved lazily from the marker
  // at each operation point via resolveParent(). This is essential when
  // the marker starts inside a DocumentFragment (e.g., inside a list
  // create handler's fragment body): after fragment consumption, the
  // marker moves to the real DOM parent, and the cached reference would
  // be stale.
  if (!marker.parentNode) {
    throw new Error("Conditional region marker must have a parent node")
  }

  const state: ConditionalRegionState = {
    currentBranch: null,
    currentSlot: null,
    currentScope: null,
    parentScope: scope,
  }

  // Evaluate and render initial state
  // At this point the marker may be in a fragment — resolveParent gives
  // the fragment, which is correct for building initial content inside it.
  updateConditionalRegion(marker, state, getCondition, handlers)

  // Subscribe to all condition refs (mirrors valueRegion's multi-ref pattern)
  for (const ref of conditionRefs) {
    subscribe(
      ref,
      () => {
        // At subscription callback time, the marker has been moved to the
        // real DOM (fragment consumed). resolveParent gives the real parent.
        updateConditionalRegion(marker, state, getCondition, handlers)
      },
      scope,
    )
  }
}

/**
 * Update a conditional region based on current condition.
 *
 * This function orchestrates the FC/IS pattern:
 * 1. Resolves the current parent from the anchor (lazy, never cached)
 * 2. Evaluates the condition
 * 3. Plans the update (pure)
 * 4. Executes the operation (imperative)
 *
 * @internal
 */
function updateConditionalRegion(
  marker: Comment,
  state: ConditionalRegionState,
  getCondition: () => boolean,
  handlers: ConditionalRegionHandlers,
): void {
  const parent = resolveParent(marker)
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
