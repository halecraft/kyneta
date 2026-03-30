// ═══════════════════════════════════════════════════════════════════════════
//
//   Todo React — Schema
//
//   Same collaborative todo schema as the Cast-based todo example,
//   but bound to Yjs instead of Loro — proving substrate agnosticism.
//
//   One-line swap:
//     Cast todo:  import { bindLoro } from "@kyneta/loro-schema"
//     React todo: import { bindYjs }  from "@kyneta/yjs-schema"
//
// ═══════════════════════════════════════════════════════════════════════════

import { Schema } from "@kyneta/schema"
import { bindYjs } from "@kyneta/yjs-schema"

export const TodoSchema = Schema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

/** Use Yjs for collaborative, realtime, shared state (pure JS, ~300kb) */
export const TodoDoc = bindYjs(TodoSchema)