// ═══════════════════════════════════════════════════════════════════════════
//
//   Prisma Counter — Schema
//
//   A single collaborative counter backed by Loro's native Counter CRDT.
//
//   Schema.counter() is a convergent counter — concurrent increments
//   from multiple peers are merged additively. No conflicts, no lost
//   increments. The counter starts at 0 and counts up/down via
//   .increment(n).
//
//   Bound to Loro — the only CRDT substrate with a native Counter type.
//   Yjs has no equivalent (you'd need a custom Y.Map wrapper).
//
// ═══════════════════════════════════════════════════════════════════════════

import { Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"

export const CounterSchema = Schema.struct({
  count: Schema.counter(),
})

/** Use Loro for the convergent counter CRDT */
export const CounterDoc = loro.bind(CounterSchema)
