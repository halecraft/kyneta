// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — Schema
//
//   Collaborative todo list with CRDT text fields.
//
//   Each todo's `text` is Schema.text() — a character-level CRDT that
//   merges concurrent edits from multiple users. Two people can edit
//   the same todo item simultaneously and both changes are preserved.
//
//   Contrast with Schema.string(), which is last-writer-wins: if two
//   users edit the same string at the same time, one edit is lost.
//
//   Bound to Yjs — one-line swap to Loro:
//     import { loro } from "@kyneta/loro-schema"
//     export const TodoDoc = loro.bind(TodoSchema)
//
// ═══════════════════════════════════════════════════════════════════════════

import { Schema } from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"

export const TodoSchema = Schema.struct({
  todos: Schema.list(
    Schema.struct({
      text: Schema.text(),
      done: Schema.boolean(),
    }),
  ),
})

/** Use Yjs for collaborative, realtime, shared state */
export const TodoDoc = yjs.bind(TodoSchema)