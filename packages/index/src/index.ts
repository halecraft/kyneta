// @kyneta/index — Catalog, secondary indexes, and reactive joins
// over document collections.
//
// Provides:
// - Catalog<S>: a reactive keyed collection of refs from any source
// - SecondaryIndex<S>: reactive grouping by foreign key
// - JoinIndex<L, R>: reactive join composing two secondary indexes

import type { SchemaNode } from "@kyneta/schema"
import type { SecondaryIndex } from "./secondary-index.js"
import type { JoinIndex } from "./join-index.js"
import { join } from "./join-index.js"
import { Index as BaseIndex, type IndexStatic as BaseIndexStatic } from "./secondary-index.js"

// ---------------------------------------------------------------------------
// Augmented IndexStatic — BaseIndexStatic + join
// ---------------------------------------------------------------------------

export interface IndexStatic extends BaseIndexStatic {
  /** Reactive join composing two secondary indexes over a shared group-key space. */
  join<L extends SchemaNode, R extends SchemaNode>(
    leftIndex: SecondaryIndex<L>,
    rightIndex: SecondaryIndex<R>,
  ): JoinIndex<L, R>
}

/**
 * Secondary index and join constructors.
 *
 * ```ts
 * // Scalar FK grouping
 * const byAuthor = Index.by(catalog, (ref) => ref.authorId)
 *
 * // Record fan-out grouping
 * const byTag = Index.byKeys(catalog, (ref) => ref.tags)
 *
 * // Identity index
 * const byId = Index.byIdentity(catalog)
 *
 * // Reactive join
 * const joined = Index.join(leftIndex, rightIndex)
 * ```
 */
export const Index: IndexStatic = { ...(BaseIndex as any), join } as unknown as IndexStatic

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

// Catalog — reactive keyed collection of refs
export {
  Catalog,
  diffKeys,
  type CatalogChange,
  type CatalogHandle,
  type CatalogMapping,
  type DisposableCatalog,
  type WritableCatalog,
} from "./catalog.js"

// SecondaryIndex — reactive grouping over a catalog
export {
  regroupEntry,
  type IndexEntry,
  type SecondaryIndex,
  type SecondaryIndexChange,
} from "./secondary-index.js"

// JoinIndex — reactive join composing two secondary indexes
export {
  type JoinIndex,
  type JoinIndexChange,
  type JoinResult,
} from "./join-index.js"