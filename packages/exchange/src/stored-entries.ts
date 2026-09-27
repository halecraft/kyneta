// stored-entries — taking a document's stored entries into a replica, in any
// order.
//
// Several instances may append to one document's stream, and a compaction
// appends its whole document after records it did not delete, so the order a
// loader meets entries in is one no single writer chose. Loading therefore
// decides per entry, against the versions involved, never by position.

import {
  DEFAULT_LINEAGE,
  latestLineage,
  type ReplicaFactoryLike,
  type ReplicaLike,
  reaches,
  type SubstratePayload,
  supersedes,
  type Version,
} from "@kyneta/schema"

/** A stored entry: a payload, and the version it was stored at. */
export type StoredEntry = {
  readonly payload: SubstratePayload
  readonly version: string
}

/** What taking stored entries in found. */
export type TakenEntries = {
  /**
   * The version of what is stored that the replica now holds: the join of
   * the entries it reaches. `undefined` when it reaches none.
   */
  readonly stored: string | undefined
  /** The versions of entries it could not take in. */
  readonly untaken: readonly string[]
}

/**
 * The lineage the stored entries lead to: the latest among them. What a
 * replica with nothing of its own loads toward.
 */
export function latestStoredLineage(
  factory: ReplicaFactoryLike,
  entries: Iterable<StoredEntry>,
): string {
  const lineages: string[] = []
  for (const entry of entries) {
    try {
      lineages.push(factory.parseVersion(entry.version).lineage)
    } catch {
      // A version that does not parse names no lineage; the load reports it.
    }
  }
  return latestLineage(lineages)
}

/**
 * Take a document's stored entries into `replica`, in any order, toward
 * `lineage`.
 *
 * Each entry is classified against `lineage`:
 * - of `lineage`, or of genesis, which every lineage continues: taken in;
 * - of a lineage `lineage` supersedes: skipped. It is dead history, not a
 *   failed read;
 * - of a lineage that supersedes `lineage`: untaken. Only a compaction meets
 *   one, and a crossing is the network's to make.
 *
 * An entry the replica already reaches is skipped, so a whole document stored
 * after newer entries never rolls the replica back. A whole document it does
 * not reach is taken with `resetFromEntirety`; a delta, with `merge`. A delta
 * that does not continue what is loaded is held and retried after each entry
 * that is taken; what is still held at the end is untaken.
 *
 * `stored` joins only the entries the replica reaches. A plain version is one
 * counter: counting an entry past a gap would claim the store holds positions
 * it does not, and the next own write there would be confirmed without being
 * stored.
 *
 * A history-free replica's versions are private counters that neither compare
 * nor join, so its entries are merged in order, and `stored` is the last
 * entry's version.
 */
export function takeStoredEntries(
  replica: ReplicaLike,
  factory: ReplicaFactoryLike,
  entries: Iterable<StoredEntry>,
  lineage: string,
): TakenEntries {
  const untaken: string[] = []

  if (factory.historyFree) {
    let last: string | undefined
    for (const entry of entries) {
      last = entry.version
      try {
        replica.merge(entry.payload, { origin: "sync" })
      } catch {
        untaken.push(entry.version)
      }
    }
    return { stored: last, untaken }
  }

  let held: { entry: StoredEntry; version: Version }[] = []
  for (const entry of entries) {
    let version: Version
    try {
      version = factory.parseVersion(entry.version)
    } catch {
      untaken.push(entry.version)
      continue
    }
    const of = version.lineage
    if (of === lineage || of === DEFAULT_LINEAGE) {
      held.push({ entry, version })
    } else if (lineage !== DEFAULT_LINEAGE && supersedes(lineage, of)) {
      // Dead history: skipped, and a compaction may delete it.
    } else {
      untaken.push(entry.version)
    }
  }

  const reached: Version[] = []
  let progressed = true
  while (progressed && held.length > 0) {
    progressed = false
    const stillHeld: typeof held = []
    for (const candidate of held) {
      const { entry, version } = candidate
      if (reaches(replica.version(), version)) {
        reached.push(version)
        continue
      }
      try {
        if (entry.payload.kind === "entirety") {
          replica.resetFromEntirety(entry.payload, { origin: "sync" })
        } else {
          replica.merge(entry.payload, { origin: "sync" })
        }
      } catch {
        stillHeld.push(candidate)
        continue
      }
      if (reaches(replica.version(), version)) {
        reached.push(version)
        progressed = true
      } else {
        stillHeld.push(candidate)
      }
    }
    held = stillHeld
  }
  for (const { entry } of held) untaken.push(entry.version)

  const [first, ...rest] = reached
  const stored = rest.reduce<Version | undefined>(
    (joined, version) => joined?.join(version),
    first,
  )
  return { stored: stored?.serialize(), untaken }
}
