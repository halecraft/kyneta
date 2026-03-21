// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — RecipeCard Component
//
//   A mid-complexity ComponentFactory<P> demonstrating nested reactive
//   regions with schema refs passed as props. This component exercises
//   three of the four delta kinds in a single card:
//
//     - text:     recipe name displayed via bare text ref → textRegion
//     - sequence: ingredients list via for...of → listRegion
//     - replace:  vegetarian badge via if → conditionalRegion
//
//   The component receives a schema ref for the entire recipe struct,
//   navigates into its fields, and lets the compiler wire up the
//   appropriate region types based on [CHANGEFEED] detection.
//
//   Mutations use change() from the facade — the subscription-based
//   sync in main.ts automatically forwards local mutations over
//   WebSocket without any transport coupling in the component.
//
//   Context: jj:oolxnxmk
//
// ═══════════════════════════════════════════════════════════════════════════

/// <reference types="@kyneta/core/types/elements" />

import type { Element } from "@kyneta/core"
import type { Ref } from "@kyneta/schema"
import { change } from "../facade.js"
import { IngredientItem } from "./ingredient-item.js"

// ---------------------------------------------------------------------------
// Schema type for a single recipe (the element type of the recipes list)
// ---------------------------------------------------------------------------

// Extract the struct schema from the list's element type.
// RecipeBookSchema.fields.recipes is Schema.list(Schema.struct({ ... })),
// so we need the inner item schema. We define it manually to match:
import { RecipeSchema } from "../schema.js"

// The ref type for a single recipe in the list.
type RecipeRef = Ref<typeof RecipeSchema>

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type RecipeCardProps = {
  /** The reactive ref for a single recipe struct. */
  recipe: RecipeRef
  /** Called when the user wants to remove this recipe from the list. */
  onRemove: () => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A recipe card showing name, vegetarian status, and ingredients.
 *
 * Demonstrates three delta kinds in one component:
 *   1. `recipe.name` (Schema.annotated("text")) → the compiler detects [CHANGEFEED]
 *      with deltaKind "text" and emits textRegion for surgical character
 *      updates in the DOM.
 *   2. `for...of recipe.ingredients` → the compiler detects the sequence
 *      ref and emits listRegion for O(k) list mutations.
 *   3. `if (recipe.vegetarian())` → the compiler detects the boolean ref
 *      and emits conditionalRegion for branch swapping.
 *
 * The compiler recognizes this as a ComponentFactory via type-level
 * analysis (it checks that the return type is `Element`, i.e.
 * `(scope) => Node`) and creates a compiler-managed child scope.
 * When this card is removed from the DOM (e.g., recipe deleted from
 * the list), the scope is disposed, unsubscribing all reactive
 * regions automatically.
 *
 * We type the function as `(props: P) => Element` rather than
 * `ComponentFactory<P>` to avoid union-type call-site ambiguity
 * in strict TypeScript. The compiler detection works on the
 * resolved return type, not the type alias name.
 */
export const RecipeCard = (props: RecipeCardProps): Element => {
  const { recipe, onRemove } = props

  return article({ class: "recipe-card" }, () => {
    // ─── Recipe Header ───────────────────────────────────────────────
    // The recipe name is rendered as an editable input. We read the
    // current value with recipe.name() (valueRegion) and update it
    // on input via recipe.name.update(). Using the read value (a
    // string) avoids triggering inputTextRegion and the cursor bug
    // that comes with passing a bare text ref to an input element.
    header({ class: "recipe-header" }, () => {
      input({
        type: "text",
        class: "recipe-name-input",
        value: recipe.name(),
        onInput: (e: InputEvent) => {
          change(recipe, () => {
            recipe.name.update((e.target as HTMLInputElement).value)
          })
        },
      })

      // ─── Vegetarian Badge (delta: replace → conditionalRegion) ───
      // The compiler detects that recipe.vegetarian has [CHANGEFEED]
      // and emits conditionalRegion. When the boolean value changes,
      // the badge element is inserted or removed from the DOM.
      if (recipe.vegetarian()) {
        span({ class: "badge vegetarian" }, "🌱 Vegetarian")
      }

      button({ class: "remove-btn", "aria-label": "Remove recipe", onClick: onRemove }, "×")
    })

    // ─── Ingredients List (delta: sequence → listRegion) ──────────
    // for...of over a schema sequence ref triggers the compiler's
    // listRegion codegen. Each push/insert/delete on the list ref
    // produces O(1) DOM mutations (insertBefore / removeChild).
    h3("Ingredients")
    ul({ class: "ingredient-list" }, () => {
      for (const ingredient of recipe.ingredients) {
        // Each ingredient is a Schema.string() ref.
        // We read its value and pass the plain string to IngredientItem,
        // along with an onEdit callback to update the ref on input.
        IngredientItem({
          value: ingredient(),
          onEdit: (newValue) => {
            change(recipe, () => {
              ingredient.set(newValue)
            })
          },
          onRemove: () => {
            // Remove this ingredient from the recipe's ingredient list.
            // Find the index of this ingredient ref in the list.
            const idx = [...recipe.ingredients].indexOf(ingredient)
            if (idx >= 0) {
              change(recipe, () => {
                recipe.ingredients.delete(idx, 1)
              })
            }
          },
        })
      }
    })

    // ─── Ingredient Controls ──────────────────────────────────────
    footer({ class: "recipe-footer" }, () => {
      button(
        {
          class: "add-btn",
          onClick: () => {
            change(recipe, () => {
              recipe.ingredients.push("")
            })
          },
        },
        "+ Ingredient",
      )

      button(
        {
          class: "toggle-btn",
          onClick: () => {
            change(recipe, () => {
              recipe.vegetarian.set(!recipe.vegetarian())
            })
          },
        },
        () => {
          // Dynamic button text based on current vegetarian state
          if (recipe.vegetarian()) {
            span("Mark Non-Vegetarian")
          } else {
            span("Mark Vegetarian")
          }
        },
      )
    })
  })
}
