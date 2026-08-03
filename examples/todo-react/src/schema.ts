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

export const TodoItemSchema = Schema.struct({
  id: Schema.string(),
  text: Schema.text(),
  done: Schema.boolean(),
})

export const TodoSchema = Schema.struct({
  // A last-writer-wins scalar, and therefore safe to seed: if two peers both
  // initialize this document at once they write the same value, and LWW
  // converges on it. Seeding a list (`todos.push(...)`) would NOT be safe the
  // same way — positional inserts from two peers duplicate rather than merge.
  // See "Writing a concurrency-safe seed" in @kyneta/exchange's README.
  title: Schema.string(),
  todos: Schema.list(TodoItemSchema),
})

/** Use Yjs for collaborative, realtime, shared state */
export const TodoDoc = yjs.bind(TodoSchema)
