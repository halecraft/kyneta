// text-adapter — textarea ↔ TextRef binding.
//
// Two pure functions (functional core) and one imperative shell:
//
//   diffText(oldText, newText, cursorHint) → TextChange
//     Compares two strings to find the single contiguous edit, using
//     the cursor position to disambiguate ambiguous diffs within runs
//     of identical characters.
//
//   transformSelection(selStart, selEnd, instructions) → { start, end }
//     Rebases a selection range through a set of text instructions,
//     preserving cursor position across remote edits.
//
//   attach(element, textRef, options?) → detach
//     Binds an HTMLInputElement or HTMLTextAreaElement to a TextRef.
//     Local edits flow into the CRDT via change(); remote edits are
//     surgically applied via setRangeText() with selection rebasing.
//     IME composition is handled; undo is intercepted by default.
//
// No React imports — this module is framework-agnostic.

import { CHANGEFEED, type Changeset } from "@kyneta/changefeed"
import {
  change,
  isTextChange,
  textChange,
  textInstructionsToPatches,
  transformIndex,
  type TextChange,
  type TextInstruction,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// TextRefLike — structural type for what attach() needs
// ---------------------------------------------------------------------------

/**
 * Structural type capturing the surface of a text `Ref<TextSchema>` that
 * the adapter consumes:
 *
 * - Callable: `ref()` returns the current string value.
 * - `[CHANGEFEED]`: subscribe to remote changes.
 * - `insert` / `delete` / `update`: mutation methods used inside `change()`.
 *
 * Any `Ref<TextSchema>` from the standard interpreter stack satisfies this.
 */
export type TextRefLike = ((...args: any[]) => string) & {
  readonly [CHANGEFEED]: import("@kyneta/changefeed").ChangefeedProtocol<
    string,
    TextChange
  >
  insert(index: number, content: string): void
  delete(index: number, length: number): void
  update(content: string): void
}

// ===========================================================================
// Functional Core
// ===========================================================================

// ---------------------------------------------------------------------------
// diffText — single contiguous edit detection
// ---------------------------------------------------------------------------

/**
 * Compare two strings and produce a `TextChange` describing the single
 * contiguous edit that transforms `oldText` into `newText`.
 *
 * The `cursorHint` parameter (typically `element.selectionStart` after
 * the input event) disambiguates when the edit falls within a run of
 * identical characters. For example, inserting `'a'` into `"aaa"` is
 * ambiguous — the cursor tells us *where* the insertion happened.
 *
 * Algorithm:
 * 1. Scan from the left for a common prefix, bounded by `cursorHint`
 *    so the edit is placed at or before the cursor.
 * 2. Scan from the right for a common suffix, not overlapping the prefix.
 * 3. The region between prefix and suffix is the edit range.
 *
 * @param oldText  - The text before the edit (from `textRef()`).
 * @param newText  - The text after the edit (from `element.value`).
 * @param cursorHint - `element.selectionStart` after the input event.
 * @returns A `TextChange` with retain/delete/insert instructions.
 */
export function diffText(
  oldText: string,
  newText: string,
  cursorHint: number,
): TextChange {
  if (oldText === newText) return textChange([])

  const oldLen = oldText.length
  const newLen = newText.length

  // Common prefix, bounded by cursorHint to disambiguate within identical runs.
  let prefixLen = 0
  const maxPrefix = Math.min(oldLen, newLen, cursorHint)
  while (prefixLen < maxPrefix && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++
  }

  // Common suffix, not overlapping with prefix.
  let suffixLen = 0
  const maxSuffix = Math.min(oldLen - prefixLen, newLen - prefixLen)
  while (
    suffixLen < maxSuffix &&
    oldText[oldLen - 1 - suffixLen] === newText[newLen - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const deleteLen = oldLen - prefixLen - suffixLen
  const insertText = newText.slice(prefixLen, newLen - suffixLen)

  const instructions: TextInstruction[] = []
  if (prefixLen > 0) instructions.push({ retain: prefixLen })
  if (deleteLen > 0) instructions.push({ delete: deleteLen })
  if (insertText.length > 0) instructions.push({ insert: insertText })

  return textChange(instructions)
}

// ---------------------------------------------------------------------------
// transformSelection — rebase a selection range through instructions
// ---------------------------------------------------------------------------

/**
 * Rebase a selection range through a set of text instructions.
 *
 * Both endpoints use right-affinity (`"right"` side in `transformIndex`),
 * meaning insertions *at* the cursor push the cursor rightward — the
 * natural behavior for observing a remote collaborator's typing.
 *
 * @param selStart     - Selection start offset.
 * @param selEnd       - Selection end offset.
 * @param instructions - The text instructions to transform through.
 * @returns The rebased `{ start, end }` offsets.
 */
export function transformSelection(
  selStart: number,
  selEnd: number,
  instructions: readonly TextInstruction[],
): { start: number; end: number } {
  return {
    start: transformIndex(selStart, "right", instructions),
    end: transformIndex(selEnd, "right", instructions),
  }
}

// ===========================================================================
// Imperative Shell
// ===========================================================================

// ---------------------------------------------------------------------------
// attach — bind an element to a TextRef
// ---------------------------------------------------------------------------

/** Options for {@link attach}. */
export interface AttachOptions {
  /**
   * Undo handling strategy.
   *
   * - `"prevent"` (default): intercept Cmd/Ctrl+Z and `historyUndo`/
   *   `historyRedo` input types. The CRDT's own undo stack (when wired)
   *   should handle undo instead of the browser's built-in mechanism,
   *   which operates on DOM state that diverges from CRDT state.
   * - `"browser"`: allow native undo/redo (useful for simple forms
   *   where CRDT undo is not wired).
   */
  undo?: "prevent" | "browser"
}

/**
 * Bind an `<input>` or `<textarea>` element to a text ref.
 *
 * Establishes a bidirectional binding:
 *
 * **Local → CRDT**: On `input` events, diffs the element's value against
 * the ref's current string and applies the delta via `change()` with
 * `{ origin: "local" }` for echo suppression.
 *
 * **CRDT → Element**: Subscribes to the ref's changefeed. Remote changes
 * (those without `origin === "local"`) are applied surgically via
 * `setRangeText()`, preserving the user's selection. The selection is
 * rebased through the remote instructions to maintain cursor position.
 *
 * **IME**: Composition events are tracked. During composition, input
 * events are suppressed; the final committed text is captured on
 * `compositionend`.
 *
 * **Undo**: By default, native undo/redo is intercepted to prevent
 * DOM state from diverging from CRDT state. See {@link AttachOptions.undo}.
 *
 * @param element  - The input or textarea element to bind.
 * @param textRef  - A text ref satisfying {@link TextRefLike}.
 * @param options  - Optional configuration.
 * @returns A detach function that removes all listeners and unsubscribes.
 */
export function attach(
  element: HTMLInputElement | HTMLTextAreaElement,
  textRef: TextRefLike,
  options?: AttachOptions,
): () => void {
  const undoMode = options?.undo ?? "prevent"
  let composing = false

  // -----------------------------------------------------------------------
  // 1. Initial state projection
  // -----------------------------------------------------------------------

  element.value = textRef()

  // -----------------------------------------------------------------------
  // 2. Remote change subscription
  // -----------------------------------------------------------------------

  const cf = textRef[CHANGEFEED]
  const unsubscribe = cf.subscribe((changeset: Changeset) => {
    // Echo suppression — skip changesets we produced.
    if (changeset.origin === "local") return

    for (const c of changeset.changes) {
      if (isTextChange(c)) {
        const selStart = element.selectionStart ?? 0
        const selEnd = element.selectionEnd ?? 0

        // Apply surgical patches via setRangeText to preserve undo stack
        // and avoid full-value replacement flicker.
        const patches = textInstructionsToPatches(c.instructions)
        for (const patch of patches) {
          if (patch.kind === "insert") {
            element.setRangeText(
              patch.text,
              patch.offset,
              patch.offset,
              "preserve",
            )
          } else {
            element.setRangeText(
              "",
              patch.offset,
              patch.offset + patch.count,
              "preserve",
            )
          }
        }

        // Rebase the user's selection through the remote edit.
        const rebased = transformSelection(selStart, selEnd, c.instructions)
        element.selectionStart = rebased.start
        element.selectionEnd = rebased.end
      } else {
        // Non-text change (e.g., full replace via .update()) — fall back
        // to wholesale value replacement.
        element.value = textRef()
      }
    }
  })

  // -----------------------------------------------------------------------
  // 3. Local edit capture
  // -----------------------------------------------------------------------

  const onInput = (): void => {
    if (composing) return

    const oldText = textRef()
    const newText = element.value
    if (oldText === newText) return

    const cursor = element.selectionStart ?? newText.length
    const delta = diffText(oldText, newText, cursor)
    if (delta.instructions.length === 0) return

    // Extract the edit position and content from the instruction stream.
    // diffText always produces at most: retain? + delete? + insert?
    let offset = 0
    let deleteCount = 0
    let insertText = ""
    for (const op of delta.instructions) {
      if ("retain" in op) offset = op.retain
      else if ("delete" in op) deleteCount = op.delete
      else if ("insert" in op) insertText = op.insert
    }

    // Apply via change() with origin for echo suppression.
    change(
      textRef as any,
      (ref: any) => {
        if (deleteCount > 0) ref.delete(offset, deleteCount)
        if (insertText) ref.insert(offset, insertText)
      },
      { origin: "local" },
    )
  }

  element.addEventListener("input", onInput)

  // -----------------------------------------------------------------------
  // 4. IME composition handling
  // -----------------------------------------------------------------------

  const onCompositionStart = (): void => {
    composing = true
  }

  const onCompositionEnd = (): void => {
    composing = false
    // Process the final committed text from the IME.
    onInput()
  }

  element.addEventListener("compositionstart", onCompositionStart)
  element.addEventListener("compositionend", onCompositionEnd)

  // -----------------------------------------------------------------------
  // 5. Undo interception
  // -----------------------------------------------------------------------

  const onKeyDown = (e: Event): void => {
    if (undoMode === "browser") return
    const ke = e as KeyboardEvent
    const mod = ke.metaKey || ke.ctrlKey
    if (mod && (ke.key === "z" || ke.key === "Z")) {
      e.preventDefault()
    }
  }

  const onBeforeInput = (e: Event): void => {
    if (undoMode === "browser") return
    const inputEvent = e as InputEvent
    if (
      inputEvent.inputType === "historyUndo" ||
      inputEvent.inputType === "historyRedo"
    ) {
      e.preventDefault()
    }
  }

  element.addEventListener("keydown", onKeyDown)
  element.addEventListener("beforeinput", onBeforeInput)

  // -----------------------------------------------------------------------
  // 6. Detach
  // -----------------------------------------------------------------------

  return () => {
    unsubscribe()
    element.removeEventListener("input", onInput)
    element.removeEventListener("compositionstart", onCompositionStart)
    element.removeEventListener("compositionend", onCompositionEnd)
    element.removeEventListener("keydown", onKeyDown)
    element.removeEventListener("beforeinput", onBeforeInput)
  }
}