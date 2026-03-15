// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Seed Data
//
//   Shared initial state used by both server and client.
//   Both call createDoc(RecipeBookSchema, SEED) to start from the same
//   genesis state at version 0.
//
// ═══════════════════════════════════════════════════════════════════════════

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
      ingredients: [
        "tofu",
        "broccoli",
        "bell pepper",
        "soy sauce",
        "rice",
      ],
    },
  ],
  favorites: 0,
} satisfies Record<string, unknown>