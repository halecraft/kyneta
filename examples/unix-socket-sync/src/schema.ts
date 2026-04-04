// schema — shared config document schema.
//
// Uses Loro CRDT for merge semantics. Every peer holds a full replica.
// When peers reconnect after a failure, the Exchange handshake merges
// their Loro documents — all writes converge, no data lost.

import { Schema } from "@kyneta/schema"
import { LoroSchema, bindLoro } from "@kyneta/loro-schema"

export const ConfigSchema = LoroSchema.doc({
  darkMode:    Schema.boolean(),
  logLevel:    Schema.string(),
  region:      Schema.string(),
  maintenance: Schema.boolean(),
  maxRequests: Schema.number(),
  rateLimit:   Schema.number(),
  peers:       LoroSchema.record(Schema.boolean()),
})

export const ConfigDoc = bindLoro(ConfigSchema)