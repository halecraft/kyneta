// ephemeral-inflation — a local write must move the tree up the lattice.
//
// A state-based CRDT converges because peers only ever join states, and a join
// never loses information. That argument has a premise that is easy to miss:
// every *local* update must be inflationary too — the state after a write must
// sit at or above the state before it, `before ⊑ after`. Otherwise the writer
// holds a state that no join can produce, and a peer still holding `before`
// computes `before ⊔ after`, which is not `after`.
//
// A write overwrites the nodes it touches, and the join orders them by
// timestamp, breaking ties by presence and then value. So an overwrite is
// inflationary only when its stamp beats what it replaces. Stamped with the
// wall clock alone, it did not:
//
// - A same-millisecond rewrite ties, and loses the tie whenever the new tuple
//   ranks lower: a deletion against a live value, or a smaller value.
// - A clock behind a tuple this replica already merged loses outright, with
//   no coincidence required: a write causally after another loses to it.
//
// The writer then shows its own write and every other peer shows the tuple it
// replaced, and when anti-entropy runs back the other way the writer adopts
// the old tuple, so the write is undone. Every write is now stamped past what
// it replaces (`stampOver`), and these tests hold each write path to it.
//
// The first half pins the invariant on the pure core with literal stamps, one
// test per path that overwrites a leaf. The second half pins the symptom a
// user reported, end to end, with the clock frozen.

import { afterEach, describe, expect, it, vi } from "vitest"
import { own } from "../change.js"
import {
  batch,
  createRef,
  mapChange,
  type Ref,
  replaceChange,
  Schema,
  type SchemaNode,
} from "../index.js"
import { type Path, RawPath } from "../path.js"
import type { Substrate } from "../substrate.js"
import {
  ephemeralSubstrateFactory,
  type StateVersion,
} from "../substrates/ephemeral.js"
import {
  applyChangeToStateTree,
  type Container,
  encodeTree,
  type Horizon,
  type Live,
  mergeStateTree,
  type StateTree,
  type WriteStamp,
} from "../substrates/state-tree.js"

/** A tuple as a peer holds it; the install ordinal is fixed and unread here. */
const tup = (
  value: unknown,
  timestamp: number,
  deleted?: true,
): Live | Horizon =>
  deleted ? [null, timestamp, 1, true] : [value, timestamp, 1]

/** A write's stamp. The ordinal only has to be above a structural zero. */
const stamp = (notBefore: number): WriteStamp => ({ notBefore, installedAt: 1 })

/**
 * Sorted keys, no install ordinals: what replicates. Two trees that agree
 * here are the same state to every peer, whatever their bookkeeping.
 */
const canonical = (node: unknown): unknown => {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return node
  }
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(node as Record<string, unknown>).sort()) {
    sorted[key] = canonical((node as Record<string, unknown>)[key])
  }
  return sorted
}
const replicated = (tree: StateTree): unknown =>
  canonical(JSON.parse(encodeTree(tree)))

/**
 * Apply one local write to a copy of `before`, and return both sides of the
 * question: what the writer holds, and what a peer still holding `before`
 * holds once it receives the writer's state.
 *
 * The write is inflationary exactly when the two agree, because
 * `before ⊔ after = after` is the definition of `before ⊑ after`.
 */
function write(
  before: Container,
  path: Path,
  change: Parameters<typeof applyChangeToStateTree>[2],
  at: WriteStamp,
  schema: SchemaNode,
): { writer: unknown; peer: unknown; after: Container } {
  const after = structuredClone(before)
  applyChangeToStateTree(after, path, change, at, schema)
  const joined = mergeStateTree(
    structuredClone(before),
    structuredClone(after),
    1,
  ).tree
  return { writer: replicated(after), peer: replicated(joined), after }
}

// ---------------------------------------------------------------------------
// The core: every path that overwrites a leaf
// ---------------------------------------------------------------------------

describe("a local write dominates every tuple it overwrites", () => {
  const Profile = Schema.struct({
    name: Schema.string(),
    other: Schema.string(),
    pos: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  })
  const name = RawPath.empty.field("name")
  const pos = RawPath.empty.field("pos")

  const profile = (nameTs: number): Container => ({
    name: tup("b", nameTs),
    other: tup("o", 900),
    pos: { x: tup(5, 500), y: tup(0, 500) },
  })

  it("a same-millisecond rewrite to a smaller value", () => {
    // "a" ranks below "b", so on a tie the join keeps "b".
    const { writer, peer } = write(
      profile(500),
      name,
      replaceChange(own("a")),
      stamp(500),
      Profile,
    )
    expect(peer).toEqual(writer)
  })

  it("a rewrite whose clock is behind the tuple it replaces", () => {
    // The replica merged "b" from a peer whose clock runs ahead. Writing over
    // it is causally later, whatever the wall clock says.
    const { writer, peer } = write(
      profile(500),
      name,
      replaceChange(own("z")),
      stamp(100),
      Profile,
    )
    expect(peer).toEqual(writer)
  })

  it("a whole-struct replace over newer fields", () => {
    const { writer, peer } = write(
      profile(500),
      pos,
      replaceChange(own({ x: 1, y: 1 })),
      stamp(100),
      Profile,
    )
    expect(peer).toEqual(writer)
  })

  it("a root replace over a newer field", () => {
    const { writer, peer } = write(
      profile(500),
      RawPath.empty,
      replaceChange(own({ name: "a", other: "o", pos: { x: 5, y: 0 } })),
      stamp(500),
      Profile,
    )
    expect(peer).toEqual(writer)
  })

  describe("a register", () => {
    const Shape = Schema.discriminatedUnion("kind", [
      Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
      Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
    ])
    const Doc = Schema.struct({ shape: Shape })

    it("a same-millisecond variant switch to a smaller serialisation", () => {
      // `{"kind":"circle"…` ranks below `{"kind":"square"…`.
      const { writer, peer } = write(
        { shape: tup({ kind: "square", side: 3 }, 500) },
        RawPath.empty.field("shape"),
        replaceChange(own({ kind: "circle", radius: 1 })),
        stamp(500),
        Doc,
      )
      expect(peer).toEqual(writer)
    })
  })

  describe("a record of scalars", () => {
    const Roster = Schema.struct({ peers: Schema.record(Schema.string()) })
    const peers = RawPath.empty.field("peers")

    it("a same-millisecond delete of a live entry", () => {
      // A tombstone loses a tie to a live tuple. This is the reported case.
      const { writer, peer } = write(
        { peers: { alice: tup("x", 500) } },
        peers,
        mapChange(undefined, ["alice"]),
        stamp(500),
        Roster,
      )
      expect(peer).toEqual(writer)
    })

    it("a set over an entry with a newer clock", () => {
      const { writer, peer } = write(
        { peers: { alice: tup("x", 500) } },
        peers,
        mapChange({ alice: "w" }),
        stamp(100),
        Roster,
      )
      expect(peer).toEqual(writer)
    })

    it("a whole-record replace that prunes a newer entry", () => {
      // The pruned key is tombstoned at the write's stamp, which a newer live
      // tuple beats.
      const { writer, peer } = write(
        { peers: { alice: tup("x", 500), bob: tup("y", 100) } },
        peers,
        replaceChange(own({ bob: "y" })),
        stamp(100),
        Roster,
      )
      expect(peer).toEqual(writer)
    })
  })

  describe("a record of structs", () => {
    const Roster = Schema.struct({
      peers: Schema.record(Schema.struct({ name: Schema.string() })),
    })
    const peers = RawPath.empty.field("peers")
    const before = (): Container => ({
      peers: { alice: { name: tup("x", 500) } },
    })

    it("a delete of an entry whose fields are newer", () => {
      // The deletion has to beat the newest leaf in the entry, since the
      // join prunes everything below it.
      const { writer, peer } = write(
        before(),
        peers,
        mapChange(undefined, ["alice"]),
        stamp(100),
        Roster,
      )
      expect(peer).toEqual(writer)
    })

    it("a set of an entry whose fields are newer", () => {
      const { writer, peer } = write(
        before(),
        peers,
        mapChange({ alice: { name: "a" } }),
        stamp(100),
        Roster,
      )
      expect(peer).toEqual(writer)
    })
  })

  describe("a record of records", () => {
    // Needs no clock trouble at all. A map `set` of a decomposed entry builds
    // a fresh subtree and assigns it over the old one, so an inner key the new
    // value omits is not tombstoned — it vanishes, and absence carries no
    // information under a key-unioning join. Any peer still holding it hands
    // it straight back.
    const Rooms = Schema.struct({
      rooms: Schema.record(Schema.record(Schema.number())),
    })

    it("a set of an entry that omits one of its keys", () => {
      const { writer, peer } = write(
        { rooms: { r1: { a: tup(1, 100), b: tup(2, 100) } } },
        RawPath.empty.field("rooms"),
        mapChange({ r1: { a: 1 } }),
        stamp(200),
        Rooms,
      )
      expect(peer).toEqual(writer)
    })
  })
})

// ---------------------------------------------------------------------------
// What the fix must not disturb
// ---------------------------------------------------------------------------

describe("the wall clock stays a floor, and stays per-leaf", () => {
  const Profile = Schema.struct({
    name: Schema.string(),
    other: Schema.string(),
  })
  const name = RawPath.empty.field("name")

  it("a write already past what it overwrites keeps its stamp exactly", () => {
    const { after } = write(
      { name: tup("b", 100), other: tup("o", 900) },
      name,
      replaceChange(own("a")),
      stamp(500),
      Profile,
    )
    expect((after as Record<string, Live>).name[1]).toBe(500)
  })

  it("does not borrow time from a sibling it did not overwrite", () => {
    // Decay measures from a leaf's timestamp. Pushing a write past the newest
    // leaf anywhere in the document, rather than past the one it replaces,
    // would postpone that leaf's expiry by however far ahead the newest is.
    const { after } = write(
      { name: tup("b", 500), other: tup("o", 900) },
      name,
      replaceChange(own("a")),
      stamp(100),
      Profile,
    )
    expect((after as Record<string, Live>).name[1]).toBeLessThan(900)
    expect((after as Record<string, Live>).other).toEqual(tup("o", 900))
  })
})

// ---------------------------------------------------------------------------
// End to end: two peers, a frozen clock
// ---------------------------------------------------------------------------

const Roster = Schema.struct({ peers: Schema.record(Schema.string()) })

interface Peer {
  readonly substrate: Substrate<StateVersion>
  readonly doc: Ref<typeof Roster>
}

function peer(): Peer {
  const substrate = ephemeralSubstrateFactory.create(Roster)
  return { substrate, doc: createRef(Roster, substrate) as Ref<typeof Roster> }
}

/**
 * A one-way delta link, as the exchange runs it: each call ships whatever
 * `from` has installed since the previous call.
 */
function link(from: Peer, to: Peer): () => void {
  let cursor = from.substrate.baseVersion()
  return () => {
    const payload = from.substrate.exportSince(cursor)
    if (payload === null) throw new Error("same incarnation; must be served")
    cursor = from.substrate.version()
    to.substrate.merge(payload)
  }
}

/**
 * The fingerprint the exchange compares to decide two peers agree. Optional on
 * `Substrate`, so absence is refused rather than letting two `undefined`s
 * compare equal.
 */
function digestOf(p: Peer): string {
  const digest = p.substrate.digest?.()
  if (digest === undefined) throw new Error("ephemeral must digest")
  return digest
}

function expectConverged(a: Peer, b: Peer, expected: Record<string, string>) {
  expect(a.doc.peers()).toEqual(expected)
  expect(b.doc.peers()).toEqual(expected)
  expect(digestOf(a)).toBe(digestOf(b))
}

describe("a writer's later write wins everywhere", () => {
  afterEach(() => vi.restoreAllMocks())

  it("set then delete in one millisecond, synced between", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000)
    const a = peer()
    const b = peer()
    const aToB = link(a, b)

    batch(a.doc, d => d.peers.set("alice", "x"))
    aToB()
    batch(a.doc, d => d.peers.delete("alice"))
    aToB()

    expectConverged(a, b, {})
  })

  it("set then set in one millisecond, synced between", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000)
    const a = peer()
    const b = peer()
    const aToB = link(a, b)

    batch(a.doc, d => d.peers.set("alice", "b"))
    aToB()
    batch(a.doc, d => d.peers.set("alice", "a"))
    aToB()

    expectConverged(a, b, { alice: "a" })
  })

  it("an overwrite from a clock behind the write it replaces", () => {
    // A saw B's write before making its own, so its own is causally later —
    // the wall clocks disagreeing about that is not A's problem to inherit.
    const now = vi.spyOn(Date, "now")
    const a = peer()
    const b = peer()
    const aToB = link(a, b)
    const bToA = link(b, a)

    now.mockReturnValue(2000)
    batch(b.doc, d => d.peers.set("alice", "fromB"))
    bToA()

    now.mockReturnValue(1000)
    batch(a.doc, d => d.peers.set("alice", "fromA"))
    aToB()

    expectConverged(a, b, { alice: "fromA" })
  })

  it("delete then re-add in one millisecond, synced between", () => {
    // Pinned because it is what "break ties toward tombstones" would break:
    // that trades the set-then-delete case for this one rather than fixing
    // the cause.
    vi.spyOn(Date, "now").mockReturnValue(1000)
    const a = peer()
    const b = peer()
    const aToB = link(a, b)

    batch(a.doc, d => d.peers.set("alice", "x"))
    batch(a.doc, d => d.peers.delete("alice"))
    aToB()
    batch(a.doc, d => d.peers.set("alice", "y"))
    aToB()

    expectConverged(a, b, { alice: "y" })
  })
})

describe("a write is stamped at or above every horizon over it", () => {
  afterEach(() => vi.restoreAllMocks())

  it("survives a horizon set by a peer whose clock runs ahead", () => {
    // B replaces r1 at 5000; A, whose clock reads 1000, then writes into it.
    // Stamped 1000, A's write would sit below B's horizon and the next prune
    // would drop it, on A and everywhere else.
    const Rooms = Schema.struct({
      rooms: Schema.record(Schema.record(Schema.number())),
    })
    const now = vi.spyOn(Date, "now")
    const a = { substrate: ephemeralSubstrateFactory.create(Rooms) }
    const b = { substrate: ephemeralSubstrateFactory.create(Rooms) }
    const docA: any = createRef(Rooms, a.substrate)
    const docB: any = createRef(Rooms, b.substrate)

    now.mockReturnValue(5000)
    batch(docB, (d: any) => d.rooms.set("r1", { x: 9 }))
    a.substrate.merge(b.substrate.exportEntirety())
    now.mockReturnValue(1000)
    batch(docA, (d: any) => d.rooms.at("r1").set("a", 1))
    b.substrate.merge(a.substrate.exportEntirety())

    expect(docA.rooms()).toEqual({ r1: { x: 9, a: 1 } })
    expect(docB.rooms()).toEqual({ r1: { x: 9, a: 1 } })
  })
})

describe("one change names a key once", () => {
  it("a delete and a set of the same key carry exactly the wall-clock stamp", () => {
    // `mapChangeEffects` makes the key a set. Applying the delete and then the
    // set would stamp it twice, and the second stamp would land past the
    // first rather than at the wall clock.
    const Roster = Schema.struct({ peers: Schema.record(Schema.number()) })
    const tree: Container = { peers: { alice: tup(1, 100) } }
    applyChangeToStateTree(
      tree,
      RawPath.empty.field("peers"),
      mapChange({ alice: 2 }, ["alice"]),
      stamp(500),
      Roster,
    )
    expect((tree.peers as Record<string, Live>).alice).toEqual(tup(2, 500))
  })
})
