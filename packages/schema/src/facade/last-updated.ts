// facade/last-updated.ts — read the LWW timestamp from a state ref.
//
// Reads the write timestamps the `ephemeral` substrate keeps in its
// `StateTree`.

import { hasTransact, PATH, TRANSACT } from "../ref/write.js"
import { BACKING_DOC } from "../substrate.js"
import type { StateTree } from "../substrates/state-tree.js"
import { newestTimestamp, stateTreeAt } from "../substrates/state-tree.js"

/**
 * Reads the LWW timestamp for the given reference.
 *
 * This only works for references backed by the `ephemeral` substrate.
 * For any other substrate it returns `null`, and so it does for a path
 * nothing has been written to, and for a path inside a register, whose
 * fields share the register's one timestamp.
 *
 * A container's timestamp is its newest leaf's: the last time any part of it
 * changed.
 *
 * @param ref - A reference from an `ephemeral` document.
 * @returns The wall-clock timestamp in milliseconds, or `null`.
 */
export function lastUpdated(ref: unknown): number | null {
  if (!hasTransact(ref)) return null

  const ctx = ref[TRANSACT]
  if (!(BACKING_DOC in ctx)) return null

  const at = stateTreeAt(ctx[BACKING_DOC] as StateTree, ref[PATH])
  if (at.kind !== "node") return null

  // `0` means no leaf beneath: nothing has been written here.
  const newest = newestTimestamp(at.node)
  return newest === 0 ? null : newest
}
