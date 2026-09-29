// read-cache — each coordinate's cached read, a slot on the coordinate trie.
//
// A node's `ref()` value is a function of its subtree, so it can be kept on
// the node until something in the subtree changes. A change at P changes the
// value of P and of every ancestor of P, and of whatever below P the change
// may have rewritten (`planSubtreeEffect`); every other coordinate keeps its
// read, so unchanged subtrees are shared from one read to the next.
//
// A read lives on the coordinate, not on a carrier, so every carrier at a
// coordinate reads the same value. A dropped node takes its read with it.

import type { ChangeBase } from "./change.js"
import { type CoordinateTrie, coordinatePath } from "./coordinate-trie.js"
import { type AddressedPath, RawPath } from "./path.js"
import { planSubtreeEffect } from "./subtree-effect.js"

/** The read cached at `path`, if any. Only objects are stored, so
 *  `undefined` is a miss. */
export function readAt(
  trie: CoordinateTrie,
  path: AddressedPath,
): object | undefined {
  return trie.node(path)?.read
}

/** Cache `read` at `path`, if the coordinate is in the trie and alive. */
export function storeRead(
  trie: CoordinateTrie,
  path: AddressedPath,
  read: object,
): void {
  const node = trie.node(path)
  if (node === undefined || node.address?.dead === true) return
  node.read = read
}

/**
 * Clear the reads a change at `path` made stale: on `path`'s ancestors and
 * on `path`, then within `planSubtreeEffect(change)`'s scope.
 */
export function invalidateReads(
  trie: CoordinateTrie,
  path: AddressedPath,
  change: ChangeBase,
): void {
  for (const node of trie.ancestors(path)) node.read = undefined
  for (const [, node] of trie.within(path, planSubtreeEffect(change))) {
    node.read = undefined
  }
}

/**
 * The number of coordinates holding a read in `ctx`'s trie.
 *
 * @internal Test-only. A deleted item's read leaving with its node has no
 * public symptom, only memory, so reading the structure is the only test that
 * can hold.
 */
export function __countCachedReads(ctx: object): number {
  const trie = coordinatePath(ctx, RawPath.empty).trie
  let count = trie.node(trie.root)?.read === undefined ? 0 : 1
  for (const [, node] of trie.below(trie.root)) {
    if (node.read !== undefined) count++
  }
  return count
}
