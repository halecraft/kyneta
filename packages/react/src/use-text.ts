// use-text — collaborative plain-text binding for <input> and <textarea>.
//
// useText(textRef, options?) returns a React ref callback. When the callback
// receives a non-null element, it binds it: at once with attach() if the
// document has loaded, otherwise with attachWhenLoaded(), which keeps the
// element read-only until the load completes. When it receives null
// (unmount), it calls the detach function.
//
// The hook does NOT cause re-renders on text changes. The textarea is an
// uncontrolled element managed imperatively by the adapter. For reading
// the text value reactively (e.g. character count), use useValue(textRef).

import { hydrated, whenHydrated } from "@kyneta/exchange"
import { useCallback, useRef } from "react"
import { attach, attachWhenLoaded, type TextRefLike } from "./text-adapter.js"

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
 * The element is bound once its document has loaded, and is read-only until
 * then: text typed before the load would be written over state not yet seen.
 *
 * The binding is model-as-source-of-truth:
 * - Local edits are captured on `input` events, diffed against the model,
 *   and applied via `batch(textRef, fn, { source: ownToken })` where
 *   `ownToken` is a per-binding identity-typed echo token.
 * - Remote changes are applied surgically via `setRangeText` with cursor
 *   preservation. Echo suppression skips changesets whose `source`
 *   matches the binding's own token.
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

      // Attach new binding. Checking `hydrated` first binds a loaded document
      // on this render, with no read-only phase.
      if (element) {
        detachRef.current = hydrated(textRef)
          ? attach(element, textRef, { undo })
          : attachWhenLoaded(element, textRef, whenHydrated(textRef), { undo })
      }
    },
    [textRef, undo],
  )
}
