/**
 * Text Patching for Surgical DOM Updates
 *
 * This module provides functions for applying text deltas to DOM Text nodes
 * using the surgical `insertData`/`deleteData` APIs instead of full `textContent`
 * replacement.
 *
 * Follows the Functional Core / Imperative Shell pattern:
 * - `planTextPatch` (pure): converts cursor-based deltas to offset-based ops
 * - `patchText` (imperative): applies ops to a DOM Text node
 * - `textRegion` (imperative): subscribes to a TextRef and applies surgical patches
 *
 * @packageDocumentation
 */

import type { ReactiveDelta, TextDeltaOp } from "@loro-extended/reactive"
import type { Scope } from "./scope.js"
import { subscribe } from "./subscribe.js"

// =============================================================================
// Types
// =============================================================================

/**
 * Offset-based patch operation for DOM Text nodes.
 *
 * These operations use absolute offsets and can be applied directly via
 * `Text.insertData()` and `Text.deleteData()`.
 */
export type TextPatchOp =
  | { kind: "insert"; offset: number; text: string }
  | { kind: "delete"; offset: number; count: number }

/**
 * Minimal interface for text refs used by textRegion.
 *
 * This allows the runtime to remain Loro-agnostic — any type with
 * a `get()` method returning a string works (TextRef, custom text reactives, etc.).
 *
 * @internal
 */
export interface TextRefLike {
  /** Get the current text value */
  get(): string
}

// =============================================================================
// Functional Core (Pure)
// =============================================================================

/**
 * Convert cursor-based text delta ops to offset-based patch ops.
 *
 * Text deltas use a cursor model where operations are applied left-to-right:
 * - `retain: n` advances the cursor by n characters
 * - `insert: s` inserts string s at the cursor position
 * - `delete: n` deletes n characters starting at the cursor position
 *
 * This function converts to absolute offset-based operations that can be
 * applied directly to DOM Text nodes via `insertData`/`deleteData`.
 *
 * @param ops - Array of text delta operations
 * @returns Array of offset-based patch operations
 *
 * @example
 * ```typescript
 * // Insert " World" after "Hello"
 * planTextPatch([{ retain: 5 }, { insert: " World" }])
 * // → [{ kind: "insert", offset: 5, text: " World" }]
 *
 * // Delete 3 characters starting at position 2
 * planTextPatch([{ retain: 2 }, { delete: 3 }])
 * // → [{ kind: "delete", offset: 2, count: 3 }]
 * ```
 */
export function planTextPatch(ops: TextDeltaOp[]): TextPatchOp[] {
  const result: TextPatchOp[] = []
  let cursor = 0

  for (const op of ops) {
    if ("retain" in op) {
      // Advance cursor without emitting an operation
      cursor += op.retain
    } else if ("insert" in op) {
      // Emit insert at current cursor position
      result.push({ kind: "insert", offset: cursor, text: op.insert })
      // Cursor advances past the inserted text
      cursor += op.insert.length
    } else if ("delete" in op) {
      // Emit delete at current cursor position
      result.push({ kind: "delete", offset: cursor, count: op.delete })
      // Cursor does NOT advance on delete — subsequent ops apply at same position
    }
  }

  return result
}

// =============================================================================
// Imperative Shell (DOM)
// =============================================================================

/**
 * Apply text delta operations to a DOM Text node.
 *
 * Uses the surgical `insertData`/`deleteData` APIs for O(k) updates
 * where k is the size of the change, rather than O(n) full replacement.
 *
 * @param textNode - The DOM Text node to patch
 * @param ops - Array of text delta operations
 *
 * @example
 * ```typescript
 * const text = document.createTextNode("Hello")
 * patchText(text, [{ retain: 5 }, { insert: " World" }])
 * // text.textContent === "Hello World"
 * ```
 */
export function patchText(textNode: Text, ops: TextDeltaOp[]): void {
  const patchOps = planTextPatch(ops)

  for (const op of patchOps) {
    if (op.kind === "insert") {
      textNode.insertData(op.offset, op.text)
    } else {
      textNode.deleteData(op.offset, op.count)
    }
  }
}

// =============================================================================
// Text Region (Subscription-Aware DOM Updates)
// =============================================================================

/**
 * Subscribe to a TextRef and apply surgical text patches to a DOM Text node.
 *
 * This is the runtime function that generated code calls for direct TextRef reads.
 * It follows the same pattern as `listRegion` and `conditionalRegion`:
 * 1. Set initial value
 * 2. Subscribe to changes
 * 3. Apply surgical patches for text deltas, fall back to full replacement otherwise
 *
 * @param textNode - The DOM Text node to manage
 * @param ref - The reactive text ref (must have a `get()` method)
 * @param scope - The scope for subscription cleanup
 *
 * @example
 * Generated code for `{doc.title.get()}` where `doc.title` is a TextRef:
 * ```typescript
 * const _text0 = document.createTextNode("")
 * parent.appendChild(_text0)
 * textRegion(_text0, doc.title, scope)
 * ```
 */
export function textRegion(textNode: Text, ref: unknown, scope: Scope): void {
  // Cast to TextRefLike — the ref must have .get()
  const typedRef = ref as TextRefLike

  // Set initial value
  textNode.textContent = typedRef.get()

  // Subscribe to changes
  subscribe(
    ref,
    (delta: ReactiveDelta) => {
      if (delta.type === "text") {
        // Surgical update — O(k) where k is the edit size
        patchText(textNode, delta.ops)
      } else {
        // Fallback for non-text deltas (e.g., "replace") — O(n) full replacement
        textNode.textContent = typedRef.get()
      }
    },
    scope,
  )
}
