// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Seed Data
//
//   Initial state used by the server to create the authoritative document.
//   Clients connecting via SSR receive the server's current state as a
//   substrate snapshot — they don't use SEED directly.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { RecipeBookSeed } from "./types.js"

export const SEED = {
  title: "My Recipe Book",
  recipes: [
    {
      name: "Pasta Carbonara",
      vegetarian: false,
      ingredients: [
        "spaghetti",
        "eggs",
        "guanciale",
        "pecorino",
        "black pepper",
      ],
    },
    {
      name: "Garden Stir Fry",
      vegetarian: true,
      ingredients: ["tofu", "broccoli", "bell pepper", "soy sauce", "rice"],
    },
  ],
  favorites: 0,
} satisfies RecipeBookSeed
