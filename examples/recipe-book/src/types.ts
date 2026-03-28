// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Types
//
//   Typed document aliases derived from RecipeBookSchema.
//   These are used throughout the app for type-safe document access.
//
// ═══════════════════════════════════════════════════════════════════════════

import type { Plain, Ref } from "@kyneta/schema/basic"
import type { RecipeBookSchema } from "./schema.js"

/** Full-stack ref type: read + write + transact + changefeed. */
export type RecipeBookDoc = Ref<typeof RecipeBookSchema>

/** Plain JS snapshot type (the "just data" shape). */
export type RecipeBookSnapshot = Plain<typeof RecipeBookSchema>


