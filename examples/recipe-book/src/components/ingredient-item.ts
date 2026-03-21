// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — IngredientItem Component
//
//   A leaf component that receives plain values (not refs) via props.
//   The parent reads from the schema ref and passes the already-read
//   string down along with an onEdit callback for inline editing.
//
//   This demonstrates that leaf-level components can be pure — they
//   don't need to know about the reactive system or schema refs.
//   Editing is handled by forwarding input events back to the parent
//   via the onEdit callback, which applies the change() mutation.
//
//   Delta kind exercised: none directly (parent handles reactivity).
//   Context: jj:oolxnxmk
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/core/types/elements" />

import type { Element } from "@kyneta/core"

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type IngredientItemProps = {
  /** The ingredient value (already read from the ref by the parent). */
  value: string
  /** Called when the user edits the ingredient text inline. */
  onEdit: (newValue: string) => void
  /** Called when the user clicks the remove button. */
  onRemove: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A single ingredient list item with inline editing.
 *
 * Renders the ingredient name as an editable input with a remove button.
 * This is a leaf component — it receives plain values, not reactive refs.
 * The parent (`RecipeCard`) is responsible for reading from the schema ref
 * and passing the plain string here, as well as handling the onEdit
 * callback to mutate the underlying schema ref via change().
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
    input({
      type: "text",
      class: "ingredient-input",
      value: props.value,
      onInput: (e: InputEvent) => {
        props.onEdit((e.target as HTMLInputElement).value)
      },
    })
    button({ class: "remove-btn", "aria-label": "Remove ingredient", onClick: props.onRemove }, "×")
  })
}