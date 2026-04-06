// schema — shared config document schema.
//
// Uses Loro CRDT for merge semantics. Every peer holds a full replica.
// When peers reconnect after a failure, the Exchange handshake merges
// their Loro documents — all writes converge, no data lost.

import { LoroSchema, loro } from "@kyneta/loro-schema"

export const ConfigSchema = LoroSchema.doc({
  darkMode:    LoroSchema.plain.boolean(),
  logLevel:    LoroSchema.plain.string(),
  region:      LoroSchema.plain.string(),
  maintenance: LoroSchema.plain.boolean(),
  maxRequests: LoroSchema.plain.number(),
  rateLimit:   LoroSchema.plain.number(),
  peers:       LoroSchema.record(LoroSchema.plain.boolean()),
})

export const ConfigDoc = loro.bind(ConfigSchema)