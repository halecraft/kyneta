// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Schema
//
//   Defines the RecipeBookSchema exercising all four delta kinds:
//     - text:      Schema.annotated("text")    → surgical character patches
//     - sequence:  Schema.list(...)             → O(k) list operations
//     - replace:   Schema.boolean()             → whole-value swap
//     - increment: Schema.annotated("counter")  → counter delta
//
// ═══════════════════════════════════════════════════════════════════════════

import { Schema } from "@kyneta/schema"

export const RecipeSchema = Schema.struct({
  name: Schema.annotated("text"), // delta: text (within list items)
  vegetarian: Schema.boolean(), // delta: replace (whole-value swap)
  ingredients: Schema.list(
    // delta: sequence (nested list)
    Schema.string(),
  ),
})

export const RecipeBookSchema = Schema.doc({
  title: Schema.annotated("text"), // delta: text (surgical character patches)
  recipes: Schema.list(
    // delta: sequence (O(k) list ops)
    RecipeSchema,
  ),
  favorites: Schema.annotated("counter"), // delta: increment
})