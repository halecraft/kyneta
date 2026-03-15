// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — App
//
//   The main application factory composing all components into a single
//   view that exercises the full delta-kind spectrum:
//
//     1. text      — recipe book title (surgical character patches)
//     2. sequence  — recipe list + ingredient lists (O(k) list ops)
//     3. replace   — vegetarian badge (whole-value swap → conditional)
//     4. increment — favorites counter (counter delta)
//
//   This function also demonstrates the boundary between document state
//   (synced via WebSocket) and local UI state (per-tab, not synced).
//
//   Architecture:
//     createApp(doc) is a pure builder function. It does NOT own the
//     document lifecycle, call mount(), or manage WebSocket. Server and
//     client both call it with their own doc instance:
//       - Server: passes the authoritative doc for SSR
//       - Client: passes the locally-created doc for hydration + live updates
//
//   Context: jj:oolxnxmk
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/core/types/elements" />

// ─── 1. Imports & Doc Type ───────────────────────────────────────────────
//
// The app imports its typed document alias, the facade's change() for
// mutations, state() for local UI state, and the three components.
// Module organization mirrors a real app: schema types, facade functions,
// framework primitives, and component modules each have their own import.

import type { RecipeBookDoc } from "./types.js"
import { state } from "@kyneta/core"
import { change } from "./facade.js"
import { RecipeCard } from "./components/recipe-card.js"
import { Toolbar } from "./components/toolbar.js"

// ═══════════════════════════════════════════════════════════════════════════
//
//   createApp — the application factory
//
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create the recipe book application element.
 *
 * @param doc - The RecipeBookDoc (schema ref). Server passes its
 *   authoritative doc; client passes the locally-created doc.
 * @returns An Element (DOM target) or render function (HTML target),
 *   depending on the compiler's codegen target.
 */
export function createApp(doc: RecipeBookDoc) {
  // ─── 2. Local UI State ─────────────────────────────────────────────
  //
  // state() creates a LocalRef<T> — a callable reactive value that
  // participates in the [CHANGEFEED] protocol just like schema refs.
  // The compiler detects LocalRefs the same way it detects schema refs
  // and emits the appropriate reactive regions.
  //
  // These are LOCAL state — not synced via WebSocket. Each browser tab
  // has its own independent filter settings. This is the motivated
  // boundary: filter preferences are per-user-session, not shared
  // document state.
  //
  // We create them here (in createApp, not inside Toolbar) because
  // BOTH the Toolbar (provides UI controls) and the recipe list loop
  // (uses them for filtering) need access. Sharing via props is
  // explicit and type-safe.

  const filterText = state("")
  const veggieOnly = state(false)

  // ─── 3. The App Builder ────────────────────────────────────────────
  //
  // The top-level div(...) is a builder call. The Kyneta compiler
  // detects it via the ELEMENT_FACTORIES set and transforms it:
  //   - DOM target: template-cloned DOM factory (scope) => Node
  //   - HTML target: accumulator () => { let _html = ""; ... return _html }
  //
  // Inside the builder body, the compiler analyzes each expression:
  //   - h1(doc.title) → detects doc.title has [CHANGEFEED] with
  //     deltaKind "text" → emits textRegion for surgical updates
  //   - for...of doc.recipes → detects sequence ref → emits listRegion
  //   - if (...) → detects reactive condition → emits conditionalRegion
  //   - span(doc.favorites) → detects counter ref → emits valueRegion

  return div({ class: "recipe-book" }, () => {
    // ─── App Header ────────────────────────────────────────────────
    // doc.title is a LoroSchema.text() ref. Placing it as a child of
    // h1 triggers the compiler's reactive detection: it sees
    // [CHANGEFEED] with deltaKind "text" and emits textRegion, which
    // applies surgical insertData/deleteData on the DOM text node.
    // Edits in one tab appear character-by-character in other tabs.
    header({ class: "app-header" }, () => {
      h1(doc.title)
    })

    // ─── Toolbar ───────────────────────────────────────────────────
    // The Toolbar component receives both document state (doc) and
    // local state (filterText, veggieOnly) via props. It provides
    // UI controls for search, filtering, favorites, and adding recipes.
    //
    // The compiler recognizes Toolbar as a ComponentFactory<P> via
    // type-level analysis and creates a compiler-managed child scope.
    Toolbar({ doc, filterText, veggieOnly })

    // ─── Recipe List (delta: sequence → listRegion) ────────────────
    // for...of over doc.recipes triggers the compiler's listRegion
    // codegen. Each push/insert/delete on the list ref produces
    // O(1) DOM mutations per operation.
    //
    // The filter logic uses the local state refs: filterText() and
    // veggieOnly() are read (callable refs) to get current values.
    // When these LocalRefs change, the compiler's reactive detection
    // ensures the list re-evaluates the filter condition.
    main({ class: "recipe-list" }, () => {
      for (const recipe of doc.recipes) {
        // ─── Filter Logic ────────────────────────────────────────
        // Filter by name (case-insensitive substring match) and
        // by vegetarian status. Both filterText and veggieOnly are
        // LocalRef<T> values — calling them reads the current value.
        const nameMatch = recipe.name().toLowerCase().includes(
          filterText().toLowerCase(),
        )
        const veggieMatch = !veggieOnly() || recipe.vegetarian()

        if (nameMatch && veggieMatch) {
          // Each RecipeCard receives the recipe struct ref and an
          // onRemove callback. The component navigates into the
          // ref's fields (recipe.name, recipe.ingredients, etc.)
          // and the compiler wires up the appropriate region types.
          RecipeCard({
            recipe,
            onRemove: () => {
              // Find the index of this recipe in the list and remove it.
              // We iterate to find the matching ref — this is O(n) but
              // the list is small and deletion is infrequent.
              const idx = [...doc.recipes].indexOf(recipe)
              if (idx >= 0) {
                change(doc, () => {
                  doc.recipes.delete(idx, 1)
                })
              }
            },
          })
        }
      }

      // ─── Empty State (conditional) ─────────────────────────────
      // When the recipe list is empty (or fully filtered out), show
      // a helpful message. The compiler detects the reactive condition
      // and emits conditionalRegion.
      if (doc.recipes.length === 0) {
        p({ class: "empty-state" }, "No recipes yet. Click \"+ New Recipe\" to get started!")
      }
    })
  })
}