// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Toolbar Component
//
//   A ComponentFactory<P> demonstrating the boundary between document
//   state (synced via WebSocket) and local UI state (not synced).
//
//   The toolbar receives both kinds of state via props:
//     - `doc` — the full RecipeBookDoc for accessing synced state
//       (favorites counter) and performing mutations (add recipe)
//     - `filterText` — a LocalRef<string> created by the parent for
//       filtering recipes by name (local-only, not synced)
//     - `veggieOnly` — a LocalRef<boolean> created by the parent for
//       filtering to vegetarian recipes only (local-only, not synced)
//
//   This pattern — parent creates LocalRefs, child provides UI controls,
//   parent uses the refs for filtering — demonstrates that state() can
//   be created at any level and shared via props.
//
//   Delta kind exercised: increment (favorites counter via doc.favorites).
//   Context: jj:oolxnxmk
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/core/types/elements" />
/// <reference types="@kyneta/core/types/reactive-view" />

import type { Element, LocalRef } from "@kyneta/core"
import { change } from "../facade.js"
import type { RecipeBookDoc } from "../types.js"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type ToolbarProps = {
  /** The reactive document ref — used for favorites counter and adding recipes. */
  doc: RecipeBookDoc
  /** Local filter text state (created by parent, shared for recipe filtering). */
  filterText: LocalRef<string>
  /** Local veggie-only toggle state (created by parent, shared for filtering). */
  veggieOnly: LocalRef<boolean>
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Application toolbar with search, filter, favorites, and add-recipe controls.
 *
 * Demonstrates the schema/local-state boundary:
 *   - `filterText` and `veggieOnly` are LocalRef<T> — local UI state that
 *     is NOT synced across tabs. Each user has their own filter settings.
 *   - `doc.favorites` is a schema counter ref — synced via WebSocket.
 *     Incrementing in one tab is visible in all other tabs.
 *
 * The compiler recognizes this as a ComponentFactory via type-level
 * analysis (it checks that the return type is `Element`, i.e.
 * `(scope) => Node`) and creates a compiler-managed child scope.
 * LocalRef values participate in the [CHANGEFEED] protocol just like
 * schema refs, so the compiler emits valueRegion / conditionalRegion
 * for them automatically.
 *
 * We type the function as `(props: P) => Element` rather than
 * `ComponentFactory<P>` to avoid union-type call-site ambiguity
 * in strict TypeScript. The compiler detection works on the
 * resolved return type, not the type alias name.
 */
export const Toolbar = (props: ToolbarProps): Element => {
  const { doc, filterText, veggieOnly } = props

  return nav({ class: "toolbar" }, () => {
    // ─── Search Filter (local state, not synced) ─────────────────
    // The filterText LocalRef is created by createApp and passed here
    // via props. Typing in this input updates filterText, which the
    // parent's for...of loop uses to filter the recipe list. Because
    // it's a LocalRef (not a schema ref), changes stay local — each
    // browser tab has its own independent filter.
    div({ class: "toolbar-section search" }, () => {
      label("Search: ")
      input({
        type: "text",
        placeholder: "Filter recipes...",
        onInput: (e: InputEvent) => {
          filterText.set((e.target as HTMLInputElement).value)
        },
      })
    })

    // ─── Veggie-Only Toggle (local state, not synced) ────────────
    // Same pattern as filterText — a LocalRef<boolean> shared between
    // the Toolbar (provides the toggle button) and createApp (uses
    // the value to filter the recipe list).
    div({ class: "toolbar-section filter" }, () => {
      button(
        {
          class: "toggle-btn",
          onClick: () => veggieOnly.set(!veggieOnly()),
        },
        () => {
          // Dynamic button text reacts to the LocalRef value.
          // The compiler detects veggieOnly has [CHANGEFEED] and
          // emits the appropriate reactive region. Bare ref access —
          // the compiler auto-inserts `()` reads.
          if (veggieOnly) {
            span("🌱 Veggie Only: ON")
          } else {
            span("🌱 Veggie Only: OFF")
          }
        },
      )
    })

    // ─── Favorites Counter (document state, synced) ──────────────
    // doc.favorites is a Schema.annotated("counter") ref. The compiler
    // detects [CHANGEFEED] with deltaKind "increment" and emits
    // valueRegion. When any tab increments the counter, all tabs
    // see the updated value via WebSocket sync.
    div({ class: "toolbar-section favorites" }, () => {
      span("❤️ Favorites: ")
      span(doc.favorites)

      button(
        {
          class: "fav-btn",
          "aria-label": "Increment favorites",
          onClick: () => {
            change(doc, () => {
              doc.favorites.increment(1)
            })
          },
        },
        "+",
      )

      button(
        {
          class: "fav-btn",
          "aria-label": "Decrement favorites",
          onClick: () => {
            change(doc, () => {
              doc.favorites.increment(-1)
            })
          },
        },
        "−",
      )
    })

    // ─── Add Recipe Button (document state, synced) ──────────────
    // Pushing a new recipe to the list is a sequence mutation on
    // doc.recipes. The subscription-based sync in main.ts forwards
    // this change to other tabs automatically.
    div({ class: "toolbar-section actions" }, () => {
      button(
        {
          class: "add-btn",
          onClick: () => {
            change(doc, () => {
              doc.recipes.push({
                name: "New Recipe",
                vegetarian: false,
                ingredients: ["ingredient 1"],
              })
            })
          },
        },
        "+ New Recipe",
      )
    })
  })
}
