// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — IngredientItem Component
//
//   The simplest ComponentFactory<P> pattern: a leaf component that
//   receives plain values (not refs) via props. The parent reads from
//   the schema ref and passes the already-read string down.
//
//   This demonstrates that leaf-level components can be pure — they
//   don't need to know about the reactive system or schema refs.
//
//   Delta kind exercised: none directly (parent handles reactivity).
//   Context: jj:oolxnxmk
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/core/types/elements" />

import type { ComponentFactory, Element } from "@kyneta/core"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type IngredientItemProps = {
  /** The ingredient text (already read from the ref by the parent). */
  text: string
  /** Called when the user clicks the remove button. */
  onRemove: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A single ingredient list item.
 *
 * Renders the ingredient name with a remove button. This is a leaf
 * component — it receives plain values, not reactive refs. The parent
 * (`RecipeCard`) is responsible for reading from the schema ref and
 * passing the plain string here.
 *
 * The compiler recognizes this as a ComponentFactory via type-level
 * analysis (it checks that the return type is `Element`, i.e.
 * `(scope) => Node`) and creates a compiler-managed child scope
 * for subscription cleanup.
 *
 * We type the function as `(props: P) => Element` rather than
 * `ComponentFactory<P>` to avoid union-type call-site ambiguity
 * in strict TypeScript. The compiler detection works on the
 * resolved return type, not the type alias name.
 */
export const IngredientItem = (props: IngredientItemProps): Element => {
  return li({ class: "ingredient-item" }, () => {
    span(props.text)
    button({ class: "remove-btn", "aria-label": "Remove ingredient", onClick: props.onRemove }, "×")
  })
}
