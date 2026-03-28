// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Initial Content
//
//   Populates the server's authoritative document with initial recipes.
//   Uses change() to apply real operations that produce version history
//   and sync correctly to peers.
//
//   This replaces the previous SEED constant, which pre-populated the
//   store at construction time without producing operations — invisible
//   to the sync protocol.
//
// ═══════════════════════════════════════════════════════════════════════════

import { change } from "@kyneta/schema/basic"
import type { RecipeBookDoc } from "./types.js"

/**
 * Apply initial content to a recipe book document.
 *
 * Must be called after document construction. Produces real operations
 * that increment the version and sync to peers.
 */
export function applyInitialContent(doc: RecipeBookDoc): void {
  change(doc, (d) => {
    d.title.insert(0, "My Recipe Book")
  })

  change(doc, (d) => {
    d.recipes.push({
      name: "Pasta Carbonara",
      vegetarian: false,
      ingredients: [
        "spaghetti",
        "eggs",
        "guanciale",
        "pecorino",
        "black pepper",
      ],
    })
  })

  change(doc, (d) => {
    d.recipes.push({
      name: "Garden Stir Fry",
      vegetarian: true,
      ingredients: ["tofu", "broccoli", "bell pepper", "soy sauce", "rice"],
    })
  })
}