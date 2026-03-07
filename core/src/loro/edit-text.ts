/**
 * Operation-aware write direction for `<input>` / `<textarea>` elements.
 *
 * `editText(ref)` returns a `beforeinput` event handler that translates DOM
 * editing operations into typed-ref `insert()` / `delete()` calls with
 * auto-commit. This is the write-direction complement to `inputTextRegion`
 * (the read direction).
 *
 * The handler uses a "try to handle, then prevent default only on success"
 * pattern. Each handler returns `true` if it performed the CRDT mutation
 * (caller should `preventDefault`), or `false` if it could not (caller
 * should let the browser handle it natively).
 *
 * For word/line deletions where `getTargetRanges()` returns empty and the
 * cursor is collapsed (common for `<input>` elements), the handler returns
 * `false`. The browser performs the deletion natively, and a one-shot
 * `input` event listener reconciles the CRDT from the resulting DOM state
 * using `ref.update()` (Loro's Myers' diff).
 *
 * The synchronous commit fires the `inputTextRegion` subscription, which
 * applies the delta back to the DOM via `setRangeText("end")` for local
 * edits — advancing the cursor past the inserted text (or to the deletion
 * point for deletes). Remote edits use `setRangeText("preserve")` to shift
 * the cursor relative to the edit.
 *
 * **Deliberate divergences from `hooks-core/create-text-hooks/input-handlers.ts`:**
 * - `calculateNewCursor` is NOT duplicated — `setRangeText("end")` handles
 *   cursor positioning natively via the `inputTextRegion` subscription
 * - `handleDeleteForward` uses `ref.length` for bounds check instead of
 *   `input.value.length`, because `e.preventDefault()` means the input value
 *   hasn't been updated yet
 * - The `input` field is removed from the context type (not needed — cursor
 *   management is handled by `setRangeText`)
 * - `insertFromComposition` is included (missing from hooks-core)
 * - Word/line delete fallback: when `getTargetRanges()` fails, the browser
 *   handles the deletion natively and the CRDT is reconciled via `input`
 *   event (hooks-core has the same silent-failure bug but is not fixed here)
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
 *
 * Returns `true` if the handler performed the CRDT mutation (caller should
 * `preventDefault`), or `false` if it could not compute the mutation (caller
 * should let the browser handle the operation natively).
 */
type InputHandler = (ctx: InputContext) => boolean

// =============================================================================
// Input Handlers (Strategy Pattern)
// =============================================================================

/**
 * Handles text insertion (typing, paste, drop, composition end).
 */
function handleInsertText(ctx: InputContext): boolean {
  const { ref, start, end, data } = ctx
  // Delete selected text first, then insert
  if (start !== end) {
    ref.delete(start, end - start)
  }
  if (data) {
    ref.insert(start, data)
  }
  return true
}

/**
 * Handles line break insertion (Enter key).
 */
function handleInsertLineBreak(ctx: InputContext): boolean {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  }
  ref.insert(start, "\n")
  return true
}

/**
 * Handles backward deletion (Backspace key).
 */
function handleDeleteBackward(ctx: InputContext): boolean {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  } else if (start > 0) {
    ref.delete(start - 1, 1)
  }
  return true
}

/**
 * Handles forward deletion (Delete key).
 *
 * Uses `ref.length` for bounds check instead of `input.value.length` because
 * `e.preventDefault()` means the input value hasn't been updated yet.
 */
function handleDeleteForward(ctx: InputContext): boolean {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  } else if (start < ref.length) {
    ref.delete(start, 1)
  }
  return true
}

/**
 * Handles selection deletion (Cut operation).
 */
function handleDeleteSelection(ctx: InputContext): boolean {
  const { ref, start, end } = ctx
  if (start !== end) {
    ref.delete(start, end - start)
  }
  return true
}

/**
 * Handles word/line deletions using `getTargetRanges()`.
 *
 * For word/line deletions, the browser computes the deletion boundaries.
 * `getTargetRanges()` provides these as `StaticRange` objects. For `<input>`
 * elements, many browsers return an empty array.
 *
 * Returns `false` when `getTargetRanges()` returns empty and the cursor is
 * collapsed — signaling that the handler could not compute the deletion
 * boundaries. The caller will let the browser handle it natively and
 * reconcile via a one-shot `input` event listener.
 */
function handleDeleteByRange(ctx: InputContext): boolean {
  const { ref, start, end, event } = ctx
  const ranges = event.getTargetRanges()
  if (ranges.length > 0) {
    const range = ranges[0]
    const deleteStart = range.startOffset
    const deleteEnd = range.endOffset
    if (deleteEnd > deleteStart) {
      ref.delete(deleteStart, deleteEnd - deleteStart)
    }
    return true
  } else if (start !== end) {
    // Fallback: delete selection
    ref.delete(start, end - start)
    return true
  }
  // Cannot compute deletion boundaries — signal passthrough
  return false
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
 * 3. Dispatches to the appropriate handler based on `e.inputType`
 * 4. Calls `e.preventDefault()` only if the handler successfully performed
 *    the CRDT mutation
 * 5. When a handler cannot compute the mutation (e.g., word/line delete with
 *    empty `getTargetRanges()` and collapsed cursor), lets the browser handle
 *    it natively and reconciles the CRDT from the DOM via a one-shot `input`
 *    event listener using `ref.update()` (Loro's Myers' diff)
 * 6. The typed ref's `commitIfAuto()` fires synchronously, which triggers the
 *    `inputTextRegion` subscription to update the DOM via `setRangeText("end")`
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

    // Read selection from the input element
    const target = e.target as HTMLInputElement | HTMLTextAreaElement
    const len = ref.length
    const start = Math.min(target.selectionStart ?? 0, len)
    const end = Math.min(target.selectionEnd ?? 0, len)

    const handled = handler({
      ref,
      start,
      end,
      data: e.data,
      event: e,
    })

    if (handled) {
      // Handler performed the CRDT mutation — suppress the browser's
      // default action. The DOM will be updated by the inputTextRegion
      // subscription chain (fired synchronously by commitIfAuto).
      //
      // This ordering is safe: during `beforeinput`, the browser has not
      // yet applied the default action. The spec guarantees the browser
      // waits for all listeners to complete before checking
      // `defaultPrevented`.
      e.preventDefault()
    } else {
      // Handler could not compute the mutation (e.g., word/line delete
      // with empty getTargetRanges() and collapsed cursor). Let the
      // browser perform the operation natively, then reconcile the CRDT
      // from the resulting DOM state.
      //
      // The one-shot `input` event listener fires after the browser has
      // applied the change. `ref.update()` uses Loro's Myers' diff to
      // compute minimal character-level CRDT operations from old→new.
      // This is the same pattern hooks-core uses for IME composition
      // reconciliation.
      //
      // { once: true } ensures automatic removal — no listener leak.
      target.addEventListener(
        "input",
        () => {
          ref.update(target.value)
        },
        { once: true },
      )
    }
  }
}