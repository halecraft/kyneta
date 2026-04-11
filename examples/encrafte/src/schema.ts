// ═══════════════════════════════════════════════════════════════════════════
//
//   Encrafte — Schema
//
//   Minimal schema that proves Exchange sync works and is structurally
//   ready for the conversation-tree feature.
//
//   ThreadDoc is a Loro-backed concurrent CRDT document. All encrafte
//   documents use concurrent merge — no single authority, p2p-capable
//   from day one.
//
//   Messages use Schema.string() for content (not Schema.text()) because
//   individual messages are not collaboratively edited — they are appended
//   whole. The thread's message list is the concurrent structure.
//
// ═══════════════════════════════════════════════════════════════════════════

import { loro } from "@kyneta/loro-schema"
import { Schema } from "@kyneta/schema"

export const ThreadSchema = Schema.struct({
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      content: Schema.string(),
      timestamp: Schema.number(),
    }),
  ),
})

export const ThreadDoc = loro.bind(ThreadSchema)
