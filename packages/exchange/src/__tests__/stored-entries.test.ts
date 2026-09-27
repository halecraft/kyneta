// stored-entries — loading a document's stored entries does not depend on
// their order.
//
// Several instances append to one stream, and a compaction appends its whole
// document after records it did not delete, so a loader meets entries in an
// order no single writer chose. Every case here builds real entries the way
// the store program writes them (a whole document, then a delta after each
// write) and loads them in several orders.

import { loro, loroReplicaFactory } from "@kyneta/loro-schema"
import {
  createDoc,
  ephemeralReplicaFactory,
  exportEntirety,
  exportSince,
  json,
  plainReplicaFactory,
  type ReplicaFactoryLike,
  Schema,
  type Version,
  version,
} from "@kyneta/schema"
import { yjs, yjsReplicaFactory } from "@kyneta/yjs-schema"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type StoredEntry, takeStoredEntries } from "../stored-entries.js"

const LogSchema = Schema.struct({ log: Schema.text() })

afterEach(() => {
  vi.useRealTimers()
})

type LogDoc = {
  readonly log: { (): string; insert(index: number, text: string): void }
}

/**
 * Entries as the store program writes them: the whole document, then a delta
 * after each write in `texts`.
 */
function writeEntries(doc: LogDoc, texts: readonly string[]): StoredEntry[] {
  const entries: StoredEntry[] = [
    { payload: exportEntirety(doc), version: version(doc).serialize() },
  ]
  for (const text of texts) {
    const before = version(doc)
    doc.log.insert(doc.log().length, text)
    const payload = exportSince(doc, before)
    if (payload === null) throw new Error("expected a delta")
    entries.push({ payload, version: version(doc).serialize() })
  }
  return entries
}

/** A fixed set of orders: in order, reversed, and interleaved. */
function orders<T>(items: readonly T[]): T[][] {
  const evens = items.filter((_, i) => i % 2 === 0)
  const odds = items.filter((_, i) => i % 2 === 1)
  return [
    [...items],
    [...items].reverse(),
    [...odds, ...evens],
    [...evens.reverse(), ...odds],
  ]
}

/** Load `entries` into a fresh replica toward the latest stored lineage. */
function load(
  factory: ReplicaFactoryLike,
  entries: readonly StoredEntry[],
  lineage: string,
) {
  const replica = factory.createEmpty()
  const taken = takeStoredEntries(replica, factory, entries, lineage)
  return { replica, ...taken }
}

const BACKENDS = [
  {
    name: "yjs",
    factory: yjsReplicaFactory,
    open: (): LogDoc => createDoc(yjs.bind(LogSchema)),
  },
  {
    name: "loro",
    factory: loroReplicaFactory,
    open: (): LogDoc => createDoc(loro.bind(LogSchema)),
  },
  {
    name: "plain",
    factory: plainReplicaFactory,
    open: (): LogDoc => createDoc(json.bind(LogSchema)),
  },
] as const

for (const { name, factory, open } of BACKENDS) {
  describe(`takeStoredEntries (${name})`, () => {
    it("reaches the same version whatever the order", () => {
      const doc = open()
      const entries = writeEntries(doc, ["a", "b", "c", "d"])
      const lineage = version(doc).lineage
      for (const order of orders(entries)) {
        const { replica, stored, untaken } = load(factory, order, lineage)
        expect(replica.version().serialize()).toBe(version(doc).serialize())
        expect(stored).toBe(version(doc).serialize())
        expect(untaken).toEqual([])
      }
    })

    it("does not roll back to a whole document stored after newer entries", () => {
      // A compaction appends its whole document after records it did not
      // delete, which may be newer than it.
      const doc = open()
      const entries = writeEntries(doc, ["a", "b"])
      const compacted: StoredEntry = {
        payload: exportEntirety(doc),
        version: version(doc).serialize(),
      }
      entries.push(...writeEntries(doc, ["c"]).slice(1))
      const { replica } = load(
        factory,
        [...entries, compacted],
        version(doc).lineage,
      )
      expect(replica.version().serialize()).toBe(version(doc).serialize())
    })
  })
}

// ---------------------------------------------------------------------------
// Plain: one counter, and lineages
// ---------------------------------------------------------------------------

describe("takeStoredEntries (plain)", () => {
  const plainDoc = (at: number): LogDoc => {
    vi.setSystemTime(at)
    return createDoc(json.bind(LogSchema))
  }

  it("holds a delta ahead of its predecessor, then applies it", () => {
    const doc = plainDoc(1_000)
    const [whole, d1, d2, d3] = writeEntries(doc, ["a", "b", "c"])
    if (!whole || !d1 || !d2 || !d3) throw new Error("expected four entries")
    const { replica, untaken } = load(
      plainReplicaFactory,
      [d3, d2, whole, d1],
      version(doc).lineage,
    )
    expect(replica.version().serialize()).toBe(version(doc).serialize())
    expect(untaken).toEqual([])
  })

  it("counts only what it reaches: a gap leaves the rest untaken", () => {
    // L:1–3 and L:5–6 stored, 4 missing. Counting 5–6 would claim the store
    // holds positions it does not, and the next own write at 4 would be
    // confirmed without being stored.
    const doc = plainDoc(1_000)
    const entries = writeEntries(doc, ["1", "2", "3", "4", "5", "6"])
    const lineage = version(doc).lineage
    const without4 = entries.filter(e => e.version !== `${lineage}:4`)
    const { stored, untaken } = load(plainReplicaFactory, without4, lineage)
    expect(stored).toBe(`${lineage}:3`)
    expect(untaken).toEqual([`${lineage}:5`, `${lineage}:6`])
  })

  it("ends in the later lineage of a stream that crossed one, in any order", () => {
    const old = plainDoc(1_000)
    const oldEntries = writeEntries(old, ["old-1", "old-2"])
    const current = plainDoc(2_000)
    const newEntries = writeEntries(current, ["new-1", "new-2"])
    const latest = version(current).lineage

    for (const order of orders([...oldEntries, ...newEntries])) {
      const { replica, stored, untaken } = load(
        plainReplicaFactory,
        order,
        latest,
      )
      expect(replica.version().serialize()).toBe(version(current).serialize())
      expect(stored).toBe(version(current).serialize())
      // The old lineage is dead history: skipped, not untaken.
      expect(untaken).toEqual([])
    }
  })

  it("skips every stored entry of a lineage its own supersedes", () => {
    // A compaction by a replica that has already crossed to a newer lineage.
    const old = plainDoc(1_000)
    const oldEntries = writeEntries(old, ["old"])
    const live = plainDoc(2_000)
    live.log.insert(0, "live")
    const replica = plainReplicaFactory.fromEntirety(exportEntirety(live))

    const { untaken } = takeStoredEntries(
      replica,
      plainReplicaFactory,
      oldEntries,
      version(live).lineage,
    )
    expect(untaken).toEqual([])
    expect(replica.version().serialize()).toBe(version(live).serialize())
  })

  it("leaves untaken what a lineage superseding its own stored", () => {
    // Another instance over the same storage crossed first. A compaction must
    // not cross for it: that is the network's to decide.
    const live = plainDoc(1_000)
    live.log.insert(0, "live")
    const replica = plainReplicaFactory.fromEntirety(exportEntirety(live))
    const later = plainDoc(2_000)
    const laterEntries = writeEntries(later, ["later"])

    const { untaken } = takeStoredEntries(
      replica,
      plainReplicaFactory,
      laterEntries,
      version(live).lineage,
    )
    expect(untaken).toEqual(
      laterEntries
        .map(e => e.version)
        .filter(v => v.startsWith(version(later).lineage)),
    )
    expect(replica.version().lineage).toBe(version(live).lineage)
  })

  it("reports an entry that never continues as untaken", () => {
    const doc = plainDoc(1_000)
    const entries = writeEntries(doc, ["a", "b", "c"])
    const last = entries.at(-1)
    if (last === undefined) throw new Error("expected entries")
    const { untaken, stored } = load(
      plainReplicaFactory,
      [last],
      version(doc).lineage,
    )
    expect(untaken).toEqual([last.version])
    expect(stored).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The stored version
// ---------------------------------------------------------------------------

describe("the stored version", () => {
  it("joins two concurrent CRDT entries, in either order", () => {
    const bound = loro.bind(LogSchema)
    const a = createDoc(bound) as LogDoc
    const b = createDoc(bound) as LogDoc
    const [aWhole, aDelta] = writeEntries(a, ["a"])
    const [, bDelta] = writeEntries(b, ["b"])
    if (!aWhole || !aDelta || !bDelta) throw new Error("expected entries")
    const joined: Version = version(a).join(version(b))

    for (const order of [
      [aWhole, aDelta, bDelta],
      [bDelta, aDelta, aWhole],
    ]) {
      const { stored } = load(loroReplicaFactory, order, "kyneta.genesis")
      if (stored === undefined) throw new Error("expected a stored version")
      // Compared, not serialized: the encoding orders peers as they came.
      expect(loroReplicaFactory.parseVersion(stored).compare(joined)).toBe(
        "equal",
      )
    }
  })

  it("is the last entry's for a history-free replica", () => {
    const entries: StoredEntry[] = [
      {
        payload: ephemeralReplicaFactory.createEmpty().exportEntirety(),
        version: "first",
      },
      {
        payload: ephemeralReplicaFactory.createEmpty().exportEntirety(),
        version: "last",
      },
    ]
    const { stored } = load(ephemeralReplicaFactory, entries, "kyneta.genesis")
    expect(stored).toBe("last")
  })
})
