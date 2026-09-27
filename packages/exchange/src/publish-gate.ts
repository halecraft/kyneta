// publish-gate — may a document's live state leave the process?
//
// With a store, an own operation leaves only once the store has confirmed it:
// a session that crashed after sending but before storing would reload
// without those operations and write new ones at the addresses they occupy.
// See §"Store-first" in packages/exchange/TECHNICAL.md.

import { reaches, type Version } from "@kyneta/schema"

/**
 * May this document's live state leave the process?
 *
 * Open when no own write is held, or when the store has confirmed a version
 * that reaches the last one the drain found own writes in.
 */
export function gateOpen(input: {
  /** The replica's version when the drain last found own writes; undefined when none is held. */
  readonly ownHigh: Version | undefined
  /** The version the store last confirmed; undefined when it has confirmed none. */
  readonly confirmed: Version | undefined
}): boolean {
  const { ownHigh, confirmed } = input
  if (ownHigh === undefined) return true
  return confirmed !== undefined && reaches(confirmed, ownHigh)
}
