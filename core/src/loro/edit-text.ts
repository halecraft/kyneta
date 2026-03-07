/**
 * Operation-aware write direction for `<input>` / `<textarea>` elements.
 *
 * `editText(ref)` returns a `beforeinput` event handler that translates DOM
 * editing operations into typed-ref `insert()` / `delete()` calls with
 * auto-commit. This is the write-direction complement to `inputTextRegion`
 * (the read direction).
 *
 * The handler calls `e.preventDefault()` for all handled input types, then
 * mutates the TextRef. The synchronous commit fires the `inputTextRegion`
 * subscription, which applies the delta back to the DOM via
 * `setRangeText("preserve")` — preserving cursor position automatically.
 *
 * **Deliberate divergences from `hooks-core/create-text-hooks/input-handlers.ts`:**
 * - `calculateNewCursor` is NOT duplicated — `setRangeText("preserve")` handles
 *   cursor positioning natively via the `inputTextRegion` subscription
 * - `handleDeleteForward` uses `ref.length` for bounds check instead of
 *   `input.value.length`, because `e.preventDefault()` means the input value
 *   hasn't been updated yet
 * - The `input` field is removed from the context type (not needed — cursor
 *   management is handled by `setRangeText`)
 * - `insertFromComposition` is included (missing from hooks-core)
 *
 * @see {@link inputTextRegion} for the read direction
 * @see `packages/hooks-core/src/create-text-hooks/input-handlers.ts` — reference origin
 *
 * @packageDocumentation
 */

import type { TextRef } from "@loro-extended/change"

// =============================================================================
// Types
// =============================================================================

/**
 * Context passed to input handlers containing all necessary information
 * to process an input event.
 *
 * Unlike `hooks-core/InputContext`, this does NOT include the input element —
 * cursor management is handled by `setRangeText("preserve")` on the read side.
 */
interface InputContext {
  /** The TextRef to modify */
  readonly ref: TextRef
  /** Selection start position (clamped to ref.length) */
  readonly start: number
  /** Selection end position (clamped to ref.length) */
  readonly end: number
  /** Data from the input event (text to insert, if any) */
  readonly data: string | null
  /** The original input event */
  readonly event: InputEvent
}

/**
 * Handler function for a specific input type.
 */
type InputHandler = (ctx: InputContext) => void

// =============================================================================
// Input Handlers (Strategy Pattern)
// =============================================================================

/**
 * Handles text insertion (typing, paste, drop, composition end).
 */
function handleInsertText(ctx: InputContext): void {
  const { ref, start, end, data } = ctx
  // Delete selected text first, then insert
  if (start !== end) {
    ref.delete(start, end - start)
  }
  if (data) {
    ref.insert(start, data)
  }
}

/**
 * Handles line break insertion (Enter key).
 */
function handleInsertLineBreak(ctx: InputContext): void {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  }
  ref.insert(start, "\n")
}

/**
 * Handles backward deletion (Backspace key).
 */
function handleDeleteBackward(ctx: InputContext): void {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  } else if (start > 0) {
    ref.delete(start - 1, 1)
  }
}

/**
 * Handles forward deletion (Delete key).
 *
 * Uses `ref.length` for bounds check instead of `input.value.length` because
 * `e.preventDefault()` means the input value hasn't been updated yet.
 */
function handleDeleteForward(ctx: InputContext): void {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  } else if (start < ref.length) {
    ref.delete(start, 1)
  }
}

/**
 * Handles selection deletion (Cut operation).
 */
function handleDeleteSelection(ctx: InputContext): void {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  }
}

/**
 * Handles word/line deletions using `getTargetRanges()`.
 *
 * For word/line deletions, the browser computes the deletion boundaries.
 * `getTargetRanges()` provides these as `StaticRange` objects. For `<input>`
 * elements, it may return an empty array in some browsers, in which case
 * we fall back to the selection.
 */
function handleDeleteByRange(ctx: InputContext): void {
  const { ref, start, end, event } = ctx
  const ranges = event.getTargetRanges()
  if (ranges.length > 0) {
    const range = ranges[0]
    const deleteStart = range.startOffset
    const deleteEnd = range.endOffset
    if (deleteEnd > deleteStart) {
      ref.delete(deleteStart, deleteEnd - deleteStart)
    }
  } else if (start !== end) {
    // Fallback: delete selection
    ref.delete(start, end - start)
  }
}

/**
 * Map of `inputType` → handler function.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/InputEvent/inputType
 */
const inputHandlers: Record<string, InputHandler> = {
  // Text insertion
  insertText: handleInsertText,
  insertFromPaste: handleInsertText,
  insertFromDrop: handleInsertText,
  insertFromComposition: handleInsertText,

  // Line breaks
  insertLineBreak: handleInsertLineBreak,
  insertParagraph: handleInsertLineBreak,

  // Simple deletions
  deleteContentBackward: handleDeleteBackward,
  deleteContentForward: handleDeleteForward,
  deleteByCut: handleDeleteSelection,

  // Word/line deletions (use getTargetRanges)
  deleteWordBackward: handleDeleteByRange,
  deleteWordForward: handleDeleteByRange,
  deleteSoftLineBackward: handleDeleteByRange,
  deleteSoftLineForward: handleDeleteByRange,
  deleteHardLineBackward: handleDeleteByRange,
  deleteHardLineForward: handleDeleteByRange,
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create a `beforeinput` event handler that translates DOM editing operations
 * into CRDT operations on a TextRef.
 *
 * Returns a handler function suitable for `onBeforeInput`. The handler:
 * 1. Skips IME composition events (`e.isComposing === true`)
 * 2. Passes through `historyUndo` / `historyRedo` (doesn't `preventDefault`)
 * 3. Calls `e.preventDefault()` for all other handled input types
 * 4. Reads `selectionStart`/`selectionEnd` from the target, clamped to `ref.length`
 * 5. Dispatches to the appropriate handler based on `e.inputType`
 * 6. The typed ref's `commitIfAuto()` fires synchronously, which triggers the
 *    `inputTextRegion` subscription to update the DOM via `setRangeText("preserve")`
 *
 * @param ref - The TextRef to write to
 * @returns A `beforeinput` event handler
 *
 * @example
 * ```ts
 * import { editText } from "@loro-extended/kinetic"
 *
 * // In a Kinetic template:
 * input({
 *   value: doc.title.toString(),
 *   onBeforeInput: editText(doc.title),
 * })
 * ```
 */
export function editText(ref: TextRef): (e: InputEvent) => void {
  return (e: InputEvent) => {
    // Skip IME composition — let the browser manage intermediate state.
    // The final composition result arrives as insertFromComposition with
    // isComposing === false.
    if (e.isComposing) {
      return
    }

    const { inputType } = e

    // Pass through undo/redo — let the browser (or Loro's undo manager) handle it
    if (inputType === "historyUndo" || inputType === "historyRedo") {
      return
    }

    const handler = inputHandlers[inputType]
    if (!handler) {
      // Unknown input type — let the browser handle it
      return
    }

    // Prevent default browser handling — we'll update the DOM ourselves
    // via the inputTextRegion subscription chain
    e.preventDefault()

    // Read selection from the input element
    const target = e.target as HTMLInputElement | HTMLTextAreaElement
    const len = ref.length
    const start = Math.min(target.selectionStart ?? 0, len)
    const end = Math.min(target.selectionEnd ?? 0, len)

    handler({
      ref,
      start,
      end,
      data: e.data,
      event: e,
    })
  }
}