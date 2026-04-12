// JoinIndex — reactive join composing two secondary indexes.
//
// A JoinIndex<L, R> bridges two SecondaryIndex instances that share
// a common group-key space. The left index maps left-catalog keys to
// group keys; the right index maps right-catalog keys to group keys.
// The join connects left entries to right entries through their shared
// group keys.
//
// - lookup(leftKey)   → left entry's group keys → right entries in those groups
// - reverse(rightKey) → right entry's group keys → left entries in those groups
//
// The join maintains no state of its own — it delegates entirely to
// the two underlying indexes. It does re-emit their changefeed events
// so that a single subscription covers both sides of the join.

import type { Changeset } from "@kyneta/changefeed"
import { createChangefeed } from "@kyneta/changefeed"
import type { SchemaNode, Ref } from "@kyneta/schema"
import type { SecondaryIndex, SecondaryIndexChange } from "./secondary-index.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single result from a join traversal — the catalog key and
 * the live ref it points to on the far side of the join.
 */
export interface JoinResult<S extends SchemaNode> {
  readonly key: string
  readonly ref: Ref<S>
}

/**
 * Join-level changes are re-emitted from the underlying indexes.
 */
export type JoinIndexChange = SecondaryIndexChange

/**
 * A reactive join over two secondary indexes that share a common
 * group-key space.
 *
 * - `lookup(leftKey)` traverses left → group keys → right entries
 * - `reverse(rightKey)` traverses right → group keys → left entries
 * - `subscribe` delivers changes from both underlying indexes
 * - `dispose` tears down both underlying indexes
 */
export interface JoinIndex<L extends SchemaNode, R extends SchemaNode> {
  /** Traverse left → right: given a left catalog key, return matching right entries. */
  lookup(leftKey: string): JoinResult<R>[]
  /** Traverse right → left: given a right catalog key, return matching left entries. */
  reverse(rightKey: string): JoinResult<L>[]
  /** Subscribe to structural changes from both underlying indexes. */
  subscribe(cb: (changeset: Changeset<JoinIndexChange>) => void): () => void
  /** Dispose both underlying indexes and tear down all subscriptions. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a reactive join over two secondary indexes.
 *
 * The join does not maintain its own state — it delegates lookups
 * to the underlying indexes and re-emits their changefeed events.
 *
 * ```ts
 * const convIndex   = Index.byIdentity(convCatalog)
 * const threadIndex = Index.by(threadCatalog, (ref) => ref.conversationId)
 * const convThreads = join(convIndex, threadIndex)
 *
 * convThreads.lookup("conv:abc")   // all threads for conversation "conv:abc"
 * convThreads.reverse("t1")        // the conversation(s) that thread "t1" belongs to
 * ```
 */
export function join(
  leftIndex: SecondaryIndex<any>,
  rightIndex: SecondaryIndex<any>,
): JoinIndex<any, any> {
  // Changefeed for join-level events — re-emits from both underlying indexes.
  const [feed, emit] = createChangefeed<null, JoinIndexChange>(() => null)

  const unsubLeft = leftIndex.subscribe((cs: Changeset<SecondaryIndexChange>) => {
    emit(cs)
  })

  const unsubRight = rightIndex.subscribe((cs: Changeset<SecondaryIndexChange>) => {
    emit(cs)
  })

  return {
    lookup(leftKey: string): JoinResult<any>[] {
      // leftKey → group keys via left index → lookup each in right index
      const groupKeys = leftIndex.groupKeysFor(leftKey)
      const results: any[] = []
      for (const gk of groupKeys) {
        for (const entry of (rightIndex as any).lookup(gk)) {
          results.push({ key: entry.key, ref: entry.ref })
        }
      }
      return results
    },

    reverse(rightKey: string): JoinResult<any>[] {
      // rightKey → group keys via right index → lookup each in left index
      const groupKeys = rightIndex.groupKeysFor(rightKey)
      const results: any[] = []
      for (const gk of groupKeys) {
        for (const entry of (leftIndex as any).lookup(gk)) {
          results.push({ key: entry.key, ref: entry.ref })
        }
      }
      return results
    },

    subscribe(cb: (changeset: Changeset<JoinIndexChange>) => void): () => void {
      return feed.subscribe(cb)
    },

    dispose(): void {
      unsubLeft()
      unsubRight()
      leftIndex.dispose()
      rightIndex.dispose()
    },
  }
}