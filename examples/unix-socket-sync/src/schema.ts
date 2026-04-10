// schema — shared config document schema.
//
// Uses Loro CRDT for merge semantics. Every peer holds a full replica.
// When peers reconnect after a failure, the Exchange handshake merges
// their Loro documents — all writes converge, no data lost.

import { Schema, loro } from "@kyneta/loro-schema"

export const ConfigSchema = Schema.struct({
  darkMode:    Schema.boolean(),
  logLevel:    Schema.string(),
  region:      Schema.string(),
  maintenance: Schema.boolean(),
  maxRequests: Schema.number(),
  rateLimit:   Schema.number(),
  peers:       Schema.record(Schema.boolean()),
})

export const ConfigDoc = loro.bind(ConfigSchema)