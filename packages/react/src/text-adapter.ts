// text-adapter — textarea ↔ TextRef binding.
//
// One pure function (functional core) and one imperative shell:
//
//   transformSelection(selStart, selEnd, instructions) → { start, end }
//     Rebases a selection range through a set of text instructions,
//     preserving cursor position across remote edits.
//
//   attach(element, textRef, options?) → detach
//     Binds an HTMLInputElement or HTMLTextAreaElement to a TextRef.
//     Local edits flow into the CRDT via batch(); remote edits are
//     surgically applied via setRangeText() with selection rebasing.
//     IME composition is handled. Undo and redo go to an `UndoTarget` (an
//     undo stack from `@kyneta/exchange`) when one is given, and are
//     otherwise swallowed by default. With
//     `options.refusal`, the element is read-only while the text refuses
//     edits, and stays bound. A local edit becomes a `TextChange` through
//     `diffText` from `@kyneta/schema`.
//
// No React imports — this module is framework-agnostic.

import {
  CHANGEFEED,
  type Changeset,
  type HasChangefeed,
} from "@kyneta/changefeed"
import {
  batch,
  type CommitOptions,
  diffText,
  isTextChange,
  singleEdit,
  type TextInstruction,
  type TextRef,
  textInstructionsToPatches,
  transformIndex,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// TextRefLike — structural type for what attach() needs
// ---------------------------------------------------------------------------

/**
 * Structural type capturing the surface of a text `Ref<TextSchema>` that
 * the adapter consumes — composed from the canonical pieces rather than
 * re-declared:
 *
 * - `() => string`: call the ref to read the current string value.
 * - `TextRef`: the `insert` / `delete` / `update` mutation methods — the
 *   single source of truth, imported from `@kyneta/schema`.
 * - `HasChangefeed`: the `[CHANGEFEED]` surface to subscribe to changes.
 *   This is the *loose* `ChangefeedProtocol<unknown, ChangeBase>` that every
 *   interpreted ref actually carries (the changefeed generics are erased by
 *   `Wrap`), so any `Ref<TextSchema>` satisfies this without a cast; `attach`
 *   recovers the text-ness at runtime by narrowing with `isTextChange`.
 */
export type TextRefLike = (() => string) & TextRef & HasChangefeed

// ===========================================================================
// Functional Core
// ===========================================================================

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

/**
 * Where undo goes. An `UndoStack` from `@kyneta/exchange` is one; the adapter
 * names only what it calls, and so stays free of the exchange.
 */
export interface UndoTarget {
  /** Run a keystroke's write, joining the typing step before it or not. */
  typing(fn: () => void): void
  undo(options?: CommitOptions): Promise<boolean>
  redo(options?: CommitOptions): Promise<boolean>
}

/** Options for {@link attach}. */
export interface AttachOptions {
  /**
   * Where undo and redo go.
   *
   * - An {@link UndoTarget}: Cmd/Ctrl+Z and `historyUndo` undo through it,
   *   Cmd/Ctrl+Shift+Z, Ctrl+Y and `historyRedo` redo, and typing is written
   *   through its `typing`. After an undo or redo the caret sits at the edit.
   * - `"prevent"` (default): swallow them. The browser's own undo works on
   *   the element's value, which the document can move under it.
   * - `"browser"`: let the browser undo, for a text nobody else edits.
   */
  undo?: UndoTarget | "prevent" | "browser"

  /**
   * Why the text refuses edits, or `undefined` when it does not. While its
   * current value is defined the element is read-only; the binding stays, so
   * remote changes still arrive. `@kyneta/react`'s `useText` passes
   * `writeRefusalFeed(textRef)` from `@kyneta/exchange`.
   */
  refusal?: HasChangefeed<unknown>
}

/**
 * Bind an `<input>` or `<textarea>` element to a text ref.
 *
 * Establishes a bidirectional binding:
 *
 * **Local → CRDT**: On `input` events, diffs the element's value against
 * the ref's current string and applies the delta via `batch()`, tagged
 * with a per-`attach()` identity-typed source token for echo suppression.
 *
 * **CRDT → Element**: Subscribes to the ref's changefeed. Changesets whose
 * `source` matches this binding's own token are skipped (they're echoes of
 * our own writes). All other changesets are applied surgically via
 * `setRangeText()`, preserving the user's selection. The selection is
 * rebased through the remote instructions to maintain cursor position.
 *
 * **IME**: Composition events are tracked. During composition, input
 * events are suppressed; the final committed text is captured on
 * `compositionend`.
 *
 * **Undo**: Undo and redo go where {@link AttachOptions.undo} says: an undo
 * stack, nowhere (the default), or the browser.
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
  const undo = options?.undo ?? "prevent"
  const target = typeof undo === "string" ? undefined : undo
  let composing = false

  // Read-only while refused, on top of whatever the element was already.
  const ownReadOnly = element.readOnly
  const refusal = options?.refusal?.[CHANGEFEED]
  const refused = (): boolean =>
    refusal !== undefined && refusal.current !== undefined
  const showRefusal = (): void => {
    element.readOnly = ownReadOnly || refused()
  }
  showRefusal()
  const stopRefusal = refusal?.subscribe(showRefusal) ?? (() => {})

  // Per-attach() identity-typed echo token. Minted fresh per binding so
  // composed adapters / multiple textareas on the same ref don't collide.
  const ownSource = Symbol("text-adapter:echo")
  // The token of undos and redos this binding asks for: patched in like a
  // remote edit, then the caret goes to the edit.
  const undoSource = Symbol("text-adapter:undo")

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
    if (changeset.source === ownSource) return
    const undone = changeset.source === undoSource

    for (const c of changeset.changes) {
      if (isTextChange(c)) {
        const selStart = element.selectionStart ?? 0
        const selEnd = element.selectionEnd ?? 0

        // Apply surgical patches via setRangeText, which keeps the
        // selection and avoids replacing the whole value.
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

        const last = patches.at(-1)
        if (undone && last !== undefined) {
          // An undo or redo this element asked for: the caret goes to it.
          const caret =
            last.kind === "insert"
              ? last.offset + last.text.length
              : last.offset
          element.selectionStart = caret
          element.selectionEnd = caret
        } else {
          // Rebase the user's selection through the remote edit.
          const rebased = transformSelection(selStart, selEnd, c.instructions)
          element.selectionStart = rebased.start
          element.selectionEnd = rebased.end
        }
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
    // An edit that reached a refused element (programmatically, or before
    // the refusal arrived) would throw in `batch`; put the model's text back
    // instead, so element and model never disagree.
    if (refused()) {
      element.value = oldText
      return
    }

    const cursor = element.selectionStart ?? newText.length
    const edit = singleEdit(diffText(oldText, newText, cursor).instructions)
    if (edit === undefined) return

    // Apply via batch() tagged with our source token so the resulting
    // echo through cf.subscribe() can be identified and skipped.
    const write = () =>
      batch(
        textRef,
        (ref: any) => {
          if (edit.deleted > 0) ref.delete(edit.index, edit.deleted)
          if (edit.inserted) ref.insert(edit.index, edit.inserted)
        },
        { source: ownSource },
      )
    if (target === undefined) write()
    else target.typing(write)
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
  // 5. Undo
  // -----------------------------------------------------------------------

  const history = (direction: "undo" | "redo"): void => {
    if (target === undefined) return
    const run = direction === "undo" ? target.undo : target.redo
    void run.call(target, { source: undoSource })
  }

  const onKeyDown = (e: Event): void => {
    if (undo === "browser") return
    const ke = e as KeyboardEvent
    if (!(ke.metaKey || ke.ctrlKey)) return
    const key = ke.key.toLowerCase()
    const redo = (key === "z" && ke.shiftKey) || (key === "y" && ke.ctrlKey)
    if (key !== "z" && !redo) return
    e.preventDefault()
    history(redo ? "redo" : "undo")
  }

  const onBeforeInput = (e: Event): void => {
    if (undo === "browser") return
    const { inputType } = e as InputEvent
    if (inputType !== "historyUndo" && inputType !== "historyRedo") return
    e.preventDefault()
    history(inputType === "historyUndo" ? "undo" : "redo")
  }

  element.addEventListener("keydown", onKeyDown)
  element.addEventListener("beforeinput", onBeforeInput)

  // -----------------------------------------------------------------------
  // 6. Detach
  // -----------------------------------------------------------------------

  return () => {
    unsubscribe()
    stopRefusal()
    element.readOnly = ownReadOnly
    element.removeEventListener("input", onInput)
    element.removeEventListener("compositionstart", onCompositionStart)
    element.removeEventListener("compositionend", onCompositionEnd)
    element.removeEventListener("keydown", onKeyDown)
    element.removeEventListener("beforeinput", onBeforeInput)
  }
}

/**
 * Bind `element` to `textRef` once `loaded` resolves.
 *
 * Until then the element is read-only: text typed into a document that has not
 * loaded would be written over state nobody has seen, and on a plain document
 * the write is refused outright. On resolution the element's own `readOnly` is
 * restored and {@link attach} binds it, showing the loaded text. On rejection
 * (the load failed) the element stays read-only.
 *
 * Takes a promise rather than a document, so the adapter needs no knowledge
 * of stores: a caller passes whatever says the document has loaded.
 *
 * The returned function cancels a bind that has not happened yet, restores
 * `readOnly`, and detaches a binding that has.
 */
export function attachWhenLoaded(
  element: HTMLInputElement | HTMLTextAreaElement,
  textRef: TextRefLike,
  loaded: Promise<void>,
  options?: AttachOptions,
): () => void {
  const ownReadOnly = element.readOnly
  element.readOnly = true
  let state: "waiting" | "failed" | "disposed" | { detach: () => void } =
    "waiting"

  loaded.then(
    () => {
      if (state !== "waiting") return
      element.readOnly = ownReadOnly
      state = { detach: attach(element, textRef, options) }
    },
    () => {
      if (state === "waiting") state = "failed"
    },
  )

  return () => {
    if (typeof state === "object") state.detach()
    else element.readOnly = ownReadOnly
    state = "disposed"
  }
}
