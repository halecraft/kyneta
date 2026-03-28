// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo — Schema
//
//   Defines the collaborative todo document schema using LoroSchema
//   (Loro CRDT-backed) and binds it with causal merge strategy.
//
//   No `id` field in the todo struct — Cast's listRegion uses index-based
//   tracking (structural position in the CRDT list), not key-based
//   reconciliation. The CRDT list handles conflict-free concurrent
//   inserts/deletes natively.
//
// ═══════════════════════════════════════════════════════════════════════════

import { LoroSchema, Schema } from "@kyneta/schema"
import { bindLoro } from "@kyneta/loro-schema"
import type { Ref } from "@kyneta/schema"

export const TodoSchema = LoroSchema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

/** BoundSchema: Loro substrate + causal merge strategy. */
export const TodoDoc = bindLoro(TodoSchema)

/** Full-stack ref type: read + write + transact + changefeed. */
export type TodoDocRef = Ref<typeof TodoSchema>