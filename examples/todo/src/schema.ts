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

import { LoroSchema, Schema, type Ref } from "@kyneta/schema"

export const TodoSchema = LoroSchema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

/** Use Loro for collaborative, realtime, shared state (WASM, ~1mb) */
import { bindLoro } from "@kyneta/loro-schema"
export const TodoDoc = bindLoro(TodoSchema)

/** Or, pick Yjs--it works just the same via kyneta/schema! (JS, ~300kb) */
// import { bindYjs } from "@kyneta/yjs-schema"
// export const TodoDoc = bindYjs(TodoSchema)

/** Full-stack ref type: read + write + transact + changefeed. */
export type TodoDocRef = Ref<typeof TodoSchema>
