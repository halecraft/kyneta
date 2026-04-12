// @kyneta/index — DBSP-grounded reactive indexing over keyed collections.
//
// Three-layer architecture:
//   Source (consumer-stateless delta producer)
//   → Collection (stateful ℐ integration, is a Changefeed)
//   → Index (derived grouping / join)
//
// All operators compute on ℤ-sets internally. At the Collection boundary,
// ℤ-set deltas are projected into added/removed events compatible with
// the Changeset<C> envelope.

import type { SecondaryIndex } from "./index-impl.js"
import type { JoinIndex } from "./join.js"
import type { Collection } from "./collection.js"
import type { KeySpec } from "./key-spec.js"
import { by } from "./index-impl.js"
import { join } from "./join.js"

// ---------------------------------------------------------------------------
// Index namespace — typed facade
// ---------------------------------------------------------------------------

export interface IndexStatic {
  /** Group collection entries by derived key(s). Identity grouping when no keySpec. */
  by<V>(collection: Collection<V>, keySpec?: KeySpec<V>): SecondaryIndex<V>
  /** Reactive join composing two secondary indexes over a shared group-key space. */
  join<L, R>(
    leftIndex: SecondaryIndex<L>,
    rightIndex: SecondaryIndex<R>,
  ): JoinIndex<L, R>
}

export const Index: IndexStatic = { by, join } as IndexStatic

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

// ZSet — the abelian group
export {
  type ZSet,
  zero,
  single,
  add,
  negate,
  isEmpty,
  positive,
  fromKeys,
  entries,
  toAdded,
  toRemoved,
} from "./zset.js"

// Source — consumer-stateless delta producer
export {
  Source,
  type SourceEvent,
  type SourceHandle,
  type SourceMapping,
  type ExchangeSourceHandle,
} from "./source.js"

// Collection — the ℐ operator
export {
  Collection,
  type CollectionChange,
} from "./collection.js"

// SecondaryIndex — the Gₚ (grouping) operator
export {
  type SecondaryIndex,
  type IndexChange,
} from "./index-impl.js"

// JoinIndex — the bilinear operator
export {
  type JoinIndex,
} from "./join.js"

// KeySpec — key extraction helpers
export {
  type KeySpec,
  field,
  keys,
} from "./key-spec.js"