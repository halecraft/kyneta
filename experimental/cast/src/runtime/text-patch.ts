/**
 * Text Patching for Surgical DOM Updates
 *
 * This module provides functions for applying text deltas to DOM targets
 * using surgical APIs instead of full replacement.
 *
 * Two DOM targets are supported:
 * - **Text nodes**: `patchText` uses `insertData`/`deleteData`
 * - **Input elements**: `patchInputValue` uses `setRangeText("preserve")`
 *
 * The pure core (`textInstructionsToPatches` / `TextPatch`) that converts
 * cursor-based deltas to offset-based ops lives in `@kyneta/schema`.
 * This module provides the imperative shells that apply those ops to the DOM:
 * - `patchText` (imperative): applies ops to a DOM Text node
 * - `patchInputValue` (imperative): applies ops to an `<input>`/`<textarea>` value
 * - `textRegion` (imperative): subscribes to a TextRef and patches a Text node
 * - `inputTextRegion` (imperative): subscribes to a TextRef and patches an input value
 *
 * @packageDocumentation
 */

import type { ChangeBase, HasChangefeed } from "@kyneta/changefeed"
import {
  isTextChange,
  textInstructionsToPatches,
  type TextInstruction,
  type TextPatch,
} from "@kyneta/schema"
import type { Scope } from "./scope.js"
import { read, subscribe } from "./subscribe.js"

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
export function patchText(
  textNode: Text,
  ops: readonly TextInstruction[],
): void {
  const patchOps: TextPatch[] = textInstructionsToPatches(ops)

  for (const op of patchOps) {
    if (op.kind === "insert") {
      textNode.insertData(op.offset, op.text)
    } else {
      textNode.deleteData(op.offset, op.count)
    }
  }
}

// =============================================================================
// Input Value Patching (Imperative Shell)
// =============================================================================

/**
 * Apply text delta operations to an `<input>` or `<textarea>` element's value.
 *
 * Uses the surgical `setRangeText` API for O(k) updates where k is the
 * size of the change, rather than O(n) full replacement.
 *
 * The `selectMode` parameter controls cursor adjustment:
 * - `"preserve"` (default) — cursor shifts relative to edits happening
 *   elsewhere. Correct for **remote** edits.
 * - `"end"` — cursor moves to the end of the replacement range.
 *   Correct for **local** edits (typing, undo, redo).
 *
 * @param input - The input or textarea element to patch
 * @param ops - Array of text delta operations
 * @param selectMode - The `setRangeText` selectMode (default `"preserve"`)
 *
 * @example
 * ```typescript
 * const input = document.createElement("input")
 * input.value = "Hello"
 * patchInputValue(input, [{ retain: 5 }, { insert: " World" }])
 * // input.value === "Hello World"
 * ```
 */
export function patchInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  ops: readonly TextInstruction[],
  selectMode: "preserve" | "end" = "preserve",
): void {
  const patchOps: TextPatch[] = textInstructionsToPatches(ops)

  for (const op of patchOps) {
    if (op.kind === "insert") {
      input.setRangeText(op.text, op.offset, op.offset, selectMode)
    } else {
      input.setRangeText("", op.offset, op.offset + op.count, selectMode)
    }
  }
}

// =============================================================================
// Input Text Region (Subscription-Aware Input Value Updates)
// =============================================================================

/**
 * Subscribe to a TextRef and apply surgical text patches to an input element's value.
 *
 * This is the `<input>`/`<textarea>` analog of `textRegion`. It follows the
 * same pattern as all region functions:
 * 1. Set initial value
 * 2. Subscribe to changes
 * 3. Apply surgical patches for text deltas via `setRangeText`
 * 4. Fall back to full replacement for non-text deltas
 *
 * **Origin-driven selectMode dispatch:** The subscription dispatches
 * `setRangeText` selectMode based on `changeset.origin` (batch-level
 * provenance from the `Changeset` protocol):
 * - `origin === "local"` → `"end"` (cursor advances past inserts, stays at
 *   delete point). Correct for local typing, undo, and redo.
 * - anything else (`"import"`, `undefined`) → `"preserve"` (cursor shifts
 *   relative to remote edits). Correct for remote collaborator edits.
 *
 * @param input - The input or textarea element to manage
 * @param ref - The reactive text ref (must implement [CHANGEFEED])
 * @param scope - The scope for subscription cleanup
 *
 * @example
 * Generated code for `input({ value: doc.title.toString() })` where
 * `doc.title` is a TextRef with deltaKind "text":
 * ```typescript
 * const _input0 = document.createElement("input")
 * inputTextRegion(_input0, doc.title, scope)
 * ```
 */
export function inputTextRegion(
  input: HTMLInputElement | HTMLTextAreaElement,
  ref: unknown,
  scope: Scope,
): void {
  // Read initial state via the coalgebra observation morphism
  const changefeedRef = ref as HasChangefeed<string>
  const readValue = () => read(changefeedRef)

  // Set initial value
  input.value = readValue()

  // Subscribe to changes via the runtime subscribe() helper.
  // The helper unwraps Changeset batches and passes each individual
  // change to the handler, with changeset.origin as the second arg.
  subscribe(
    ref,
    (change: ChangeBase, origin?: string) => {
      if (isTextChange(change)) {
        // Origin-driven selectMode dispatch:
        // - local edits (typing, undo, redo) → "end" (cursor follows edit)
        // - remote/unknown edits → "preserve" (cursor stays relative)
        const mode = origin === "local" ? "end" : "preserve"
        // Surgical update — O(k) where k is the edit size
        patchInputValue(input, change.instructions, mode)
      } else {
        // Fallback for non-text changes (e.g., "replace") — O(n) full replacement
        input.value = readValue()
      }
    },
    scope,
  )
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
 * @param ref - The reactive text ref (must implement [CHANGEFEED])
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
  // Read initial state via the coalgebra observation morphism
  const changefeedRef = ref as HasChangefeed<string>
  const readValue = () => read(changefeedRef)

  // Set initial value
  textNode.textContent = readValue()

  // Subscribe to changes
  subscribe(
    ref,
    (change: ChangeBase) => {
      if (isTextChange(change)) {
        // Surgical update — O(k) where k is the edit size
        patchText(textNode, change.instructions)
      } else {
        // Fallback for non-text changes (e.g., "replace") — O(n) full replacement
        textNode.textContent = readValue()
      }
    },
    scope,
  )
}