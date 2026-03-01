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
 *
 * @packageDocumentation
 */

import type { TextDeltaOp } from "@loro-extended/reactive"

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
