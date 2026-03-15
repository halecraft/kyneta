// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Schema
//
//   Defines the RecipeBookSchema exercising all four delta kinds:
//     - text:      LoroSchema.text()         → surgical character patches
//     - sequence:  Schema.list(...)           → O(k) list operations
//     - replace:   LoroSchema.plain.boolean() → whole-value swap
//     - increment: LoroSchema.counter()       → counter delta
//
// ═══════════════════════════════════════════════════════════════════════════

import { Schema, LoroSchema } from "@kyneta/schema"

export const RecipeBookSchema = LoroSchema.doc({
  title: LoroSchema.text(), // delta: text (surgical character patches)
  recipes: Schema.list(
    // delta: sequence (O(k) list ops)
    Schema.struct({
      name: LoroSchema.text(), // delta: text (within list items)
      vegetarian: LoroSchema.plain.boolean(), // delta: replace (whole-value swap)
      ingredients: Schema.list(
        // delta: sequence (nested list)
        LoroSchema.plain.string(),
      ),
    }),
  ),
  favorites: LoroSchema.counter(), // delta: increment
})