// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — App
//
//   This is a minimal smoke-test version that validates the SSR pipeline:
//   Vite ssrLoadModule → Kyneta plugin (HTML target) → rendered HTML.
//
//   Phase 3 replaces this with the real application using schema refs,
//   components, and the full delta-kind spectrum.
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/core/types/elements" />

/**
 * Create the app element.
 *
 * This is a pure builder function that does not own the document lifecycle.
 * Server and client both call it with their own doc instance.
 *
 * @param _doc - The document (null for Phase 1 smoke test)
 * @returns An Element (DOM target) or render function (HTML target)
 */
export function createApp(_doc: unknown) {
  // The Kyneta compiler detects `div(...)` as a builder call via the
  // ELEMENT_FACTORIES set and replaces it with:
  //   - DOM target: a template-cloned DOM factory `(scope) => Node`
  //   - HTML target: an accumulator `() => { let _html = ""; ... return _html }`
  //
  // The `div`, `h1`, and `p` identifiers are recognized by name — no import
  // needed. The compiler replaces the entire call expression before runtime.
  return div(() => {
    h1("Recipe Book")
    p("Loading...")
  })
}

