// use-text — collaborative plain-text binding for <input> and <textarea>.
//
// useText(textRef, options?) returns a React ref callback. When the callback
// receives a non-null element, it calls attach() to set up bidirectional
// binding. When it receives null (unmount), it calls the detach function.
//
// The hook does NOT cause re-renders on text changes. The textarea is an
// uncontrolled element managed imperatively by the adapter. For reading
// the text value reactively (e.g. character count), use useValue(textRef).

import { useCallback, useRef } from "react"
import { attach, type AttachOptions, type TextRefLike } from "./text-adapter.js"

// ---------------------------------------------------------------------------
// UseTextOptions
// ---------------------------------------------------------------------------

export interface UseTextOptions {
  /**
   * Undo behavior. Default: `"prevent"` (intercepts Cmd+Z / Ctrl+Z).
   * Set to `"browser"` for single-user scenarios where native undo is desired.
   */
  undo?: "prevent" | "browser"
}

// ---------------------------------------------------------------------------
// useText
// ---------------------------------------------------------------------------

/**
 * Bind a collaborative text ref to an `<input>` or `<textarea>`.
 *
 * Returns a React ref callback. Pass it as the `ref` prop on the element:
 *
 * ```tsx
 * function Editor({ doc }: { doc: Ref<MySchema> }) {
 *   const textRef = useText(doc.title)
 *   return <textarea ref={textRef} />
 * }
 * ```
 *
 * The binding is model-as-source-of-truth:
 * - Local edits are captured on `input` events, diffed against the model,
 *   and applied via `change(textRef, fn, { origin: "local" })`.
 * - Remote changes are applied surgically via `setRangeText` with cursor
 *   preservation. Echo suppression filters local-origin changesets.
 * - IME composition is handled safely (deferred to `compositionend`).
 * - Browser undo is intercepted by default (overridable via `options.undo`).
 *
 * The hook does **not** trigger re-renders on text changes. The textarea
 * is an uncontrolled element managed imperatively. For reactive reads
 * (e.g., character count display), use `useValue(textRef)` separately.
 *
 * @param textRef - A text ref from the interpreted document.
 * @param options - Optional configuration.
 * @returns A ref callback for the target element.
 */
export function useText(
  textRef: TextRefLike,
  options?: UseTextOptions,
): React.RefCallback<HTMLInputElement | HTMLTextAreaElement> {
  const detachRef = useRef<(() => void) | null>(null)

  // Stable undo value for dependency tracking
  const undo = options?.undo

  return useCallback(
    (element: HTMLInputElement | HTMLTextAreaElement | null) => {
      // Detach previous binding
      if (detachRef.current) {
        detachRef.current()
        detachRef.current = null
      }

      // Attach new binding
      if (element) {
        detachRef.current = attach(element, textRef, { undo })
      }
    },
    [textRef, undo],
  )
}