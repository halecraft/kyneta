// ephemeral-decay — tests for `.decay(ms)` on the `ephemeral` substrate.
//
// Verifies:
// - Schema: `.decay(N)` sets `decayMs` and does not pollute base schemas.
// - Rejection: durable sync modes throw at `bind()` time if `.decay()` is present.
// - State Sweep: `tick(now)` updates the `PlainState` shadow to the structural
//   zero for expired fields, but `version()` does NOT increment and
//   `exportEntirety()` retains the original tuple.
// - Hashing: different `decayMs` values produce different schema hashes.

import type { Changeset } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import type { Op, WritableContext } from "../index.js"
import {
  bind,
  computeSchemaHash,
  ephemeral,
  interpret,
  json,
  observation,
  plainReplicaFactory,
  readable,
  Schema,
  SYNC_COLLABORATIVE,
  subscribe,
  writable,
} from "../index.js"
import { RawPath } from "../path.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import type { StateTree } from "../substrates/state-tree.js"
import { projectStateTree } from "../substrates/state-tree.js"

// ---------------------------------------------------------------------------
// Schema DSL
// ---------------------------------------------------------------------------

describe(".decay(ms) schema DSL", () => {
  it("sets decayMs on the cloned schema", () => {
    const base = Schema.string()
    const decayed = base.decay(2000)

    expect((base as { decayMs?: number }).decayMs).toBeUndefined()
    expect((decayed as { decayMs?: number }).decayMs).toBe(2000)
  })

  it("does not mutate the base schema", () => {
    const base = Schema.string()
    const _ = base.decay(5000)

    // The base must remain decay-free — schemas are values, not builders.
    expect((base as { decayMs?: number }).decayMs).toBeUndefined()
  })

  it("chains with .nullable()", () => {
    const schema = Schema.string().nullable().decay(1000)
    expect((schema as { decayMs?: number }).decayMs).toBe(1000)
  })

  it("works on product fields", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(3000),
      name: Schema.string(),
    })

    const presenceField = schema.fields.presence as {
      decayMs?: number
    }
    const nameField = schema.fields.name as { decayMs?: number }

    expect(presenceField.decayMs).toBe(3000)
    expect(nameField.decayMs).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Hashing — decayMs is NOT part of the hash (it's a local projection)
// ---------------------------------------------------------------------------

describe("schema hash excludes decayMs", () => {
  it("produces the same hash regardless of decayMs value", () => {
    const noDecay = Schema.string()
    const decay1 = Schema.string().decay(1000)
    const decay2 = Schema.string().decay(2000)

    const h0 = computeSchemaHash(noDecay)
    const h1 = computeSchemaHash(decay1)
    const h2 = computeSchemaHash(decay2)

    // Decay is a local projection policy, not a structural property.
    // Two schemas that differ only in decayMs are structurally identical
    // and fully inter-mergeable — so they must share the same hash.
    expect(h1).toBe(h0)
    expect(h2).toBe(h0)
    expect(h1).toBe(h2)
  })

  it("produces the same hash for nested decay", () => {
    const noDecay = Schema.struct({ x: Schema.string() })
    const withDecay = Schema.struct({
      x: Schema.string().decay(1000),
    })

    expect(computeSchemaHash(withDecay)).toBe(computeSchemaHash(noDecay))
  })
})

// ---------------------------------------------------------------------------
// Durable substrate rejection
// ---------------------------------------------------------------------------

describe("durable substrate rejects .decay()", () => {
  it("json.bind throws if .decay() is present on a field", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(2000),
    })

    expect(() => json.bind(schema)).toThrow(/decay/i)
  })

  it("SYNC_COLLABORATIVE binding throws if .decay() is present", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(2000),
    })

    // Constructing a binding with SYNC_COLLABORATIVE directly should throw
    // because bind() runs validateEphemeralSchema.
    expect(() =>
      bind({
        schema,
        factory: () => {
          // This factory is never reached — the validator throws first.
          throw new Error("should not reach factory")
        },
        replicaType: plainReplicaFactory.replicaType,
        syncMode: SYNC_COLLABORATIVE,
      }),
    ).toThrow(/decay/i)
  })

  it("ephemeral.bind allows .decay()", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(2000),
    })

    expect(() => ephemeral.bind(schema)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// State substrate tick() — the decay sweep
// ---------------------------------------------------------------------------

describe("state substrate tick() decay sweep", () => {
  // A schema with a decaying presence field and a stable name field.
  const PresenceSchema = Schema.struct({
    presence: Schema.string().decay(1000),
    name: Schema.string(),
  })

  const DECAY_MS = 1000

  /**
   * A substrate whose `presence` tuple is still live at `base`.
   *
   * Freshness is the point. The substrate projects σ once at construction
   * against the wall clock, so a fixture stamped with a small fixed time is
   * born already masked — and a later tick then re-states a transition that
   * has already happened, which is not what any of these tests mean to
   * exercise. Seeding at `base` makes a tick past `base + DECAY_MS` the
   * moment the field actually expires.
   */
  function makeSubstrate(base: number) {
    const substrate = ephemeralSubstrateFactory.fromEntirety(
      {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({
          presence: ["online", base],
          name: ["alice", base],
        }),
      },
      PresenceSchema,
    )
    // Initialize the writable context — tick() needs it to fire the changefeed.
    substrate.context()
    return substrate
  }

  /** A full ref over `substrate`, with the changefeed wired. */
  function makeRef(substrate: { context: () => WritableContext }) {
    return interpret(PresenceSchema, substrate.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done()
  }

  it("tick() reverts expired presence fields to structural zero", () => {
    const base = Date.now()
    const substrate = makeSubstrate(base)

    // Verify the tree carries the original value.
    const entiretyBefore = JSON.parse(
      substrate.exportEntirety().data as string,
    ) as Record<string, unknown>
    expect((entiretyBefore.presence as unknown[])[0]).toBe("online")

    // Tick past the decay window: presence should decay.
    substrate.tick?.(base + DECAY_MS + 1)

    // Read the shadow via the reader. The shadow's `presence` should now
    // be the structural zero for a string ("").
    const presencePath = RawPath.empty.field("presence")
    const shadowPresence = substrate.reader.read(presencePath)
    expect(shadowPresence).toBe("")

    // The name field must NOT decay — it has no decayMs.
    const namePath = RawPath.empty.field("name")
    const shadowName = substrate.reader.read(namePath)
    expect(shadowName).toBe("alice")
  })

  it("tick() does NOT bump the version clock", () => {
    const base = Date.now()
    const substrate = makeSubstrate(base)
    const versionBefore = substrate.version()

    // Tick — even if something decays, the version must not change.
    substrate.tick?.(base + DECAY_MS + 1)

    const versionAfter = substrate.version()
    expect(versionAfter.serialize()).toBe(versionBefore.serialize())
  })

  it("tick() does NOT mutate exportEntirety() — the tree is untouched", () => {
    const base = Date.now()
    const substrate = makeSubstrate(base)

    const entiretyBefore = substrate.exportEntirety().data as string

    // Tick well past the decay window.
    substrate.tick?.(base + DECAY_MS * 4)

    const entiretyAfter = substrate.exportEntirety().data as string
    expect(entiretyAfter).toBe(entiretyBefore)
  })

  it("tick() is a no-op when no decayMs is declared", () => {
    const NoDecaySchema = Schema.struct({
      presence: Schema.string(),
      name: Schema.string(),
    })

    const substrate = ephemeralSubstrateFactory.fromEntirety(
      {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({
          presence: ["online", 1000],
          name: ["alice", 1000],
        }),
      },
      NoDecaySchema,
    )
    substrate.context()

    const versionBefore = substrate.version()

    // Tick far into the future — nothing should change.
    substrate.tick?.(1_000_000)

    expect(substrate.version().serialize()).toBe(versionBefore.serialize())
  })

  // ---------------------------------------------------------------------------
  // Container Decay
  // ---------------------------------------------------------------------------

  it("tick() decays a discriminated union container to its structural zero", () => {
    const TopologySchema = Schema.struct({
      server: Schema.discriminatedUnion("type", [
        Schema.struct({
          type: Schema.string("absent"),
        }),
        Schema.struct({
          type: Schema.string("present"),
          peerId: Schema.string(),
        }),
      ]).decay(2000),
    })

    const initialNow = Date.now()
    const substrate = ephemeralSubstrateFactory.fromEntirety(
      {
        kind: "entirety",
        encoding: "json",
        // A sum is an atomic register: one tuple holding the whole variant.
        data: JSON.stringify({
          server: [{ type: "present", peerId: "peer-xyz" }, initialNow],
        }),
      },
      TopologySchema,
    )
    substrate.context()

    // Read initial shadow: should be "present" variant.
    const shadowType = substrate.reader.read(
      RawPath.empty.field("server").field("type"),
    )
    const shadowPeerId = substrate.reader.read(
      RawPath.empty.field("server").field("peerId"),
    )
    expect(shadowType).toBe("present")
    expect(shadowPeerId).toBe("peer-xyz")

    // Tick at now = initialNow + 3000 (past the 2000ms decay window).
    // Container should decay to structural zero ("absent" variant).
    substrate.tick?.(initialNow + 3000)

    const newShadowServer = substrate.reader.read(RawPath.empty.field("server"))
    expect(newShadowServer).toEqual({ type: "absent" })
  })

  // ---------------------------------------------------------------------------
  // Changefeed notification + peer broadcast suppression
  // ---------------------------------------------------------------------------

  it("a decay is announced once, at the moment the field expires", () => {
    // A tick announces the fields its re-projection *moved*, not the fields
    // it masked. Masking stays true on every tick from expiry onwards, so an
    // announcement keyed on it would wake every subscriber on every
    // heartbeat, for as long as one peer stays gone.
    const base = Date.now()
    const substrate = makeSubstrate(base)
    const ref = makeRef(substrate)

    let fired = 0
    const unsub = subscribe(ref, () => {
      fired++
    })

    substrate.tick?.(base + DECAY_MS - 1)
    expect(fired).toBe(0)

    substrate.tick?.(base + DECAY_MS + 1)
    expect(fired).toBe(1)

    substrate.tick?.(base + DECAY_MS + 2)
    substrate.tick?.(base + DECAY_MS * 10)
    expect(fired).toBe(1)

    unsub()
  })

  it("a decay is not a local update, so the Exchange does not broadcast it", () => {
    // Decay is a local projection of state every peer can compute for
    // itself. Broadcasting it would clobber a slower peer's still-valid
    // value with a synthesized "absent". What leaves the process follows the
    // local-update signal, so the tick must not raise it, although it does
    // announce a change.
    const base = Date.now()
    const substrate = makeSubstrate(base)
    const ref = makeRef(substrate)

    let localUpdates = 0
    substrate.subscribeLocalUpdates(() => {
      localUpdates++
    })
    let captured: Changeset<Op> | undefined
    const unsub = subscribe(ref, (changeset: Changeset<Op>) => {
      captured = changeset
    })

    substrate.tick?.(base + DECAY_MS + 1)

    expect(captured).toBeDefined()
    expect(localUpdates).toBe(0)
    unsub()
  })

  it("a read taken before a tick reflects the expired fields after it", () => {
    const base = Date.now()
    const substrate = makeSubstrate(base)
    const ref = makeRef(substrate)
    const before = ref()
    expect(before).toEqual({ presence: "online", name: "alice" })

    substrate.tick?.(base + DECAY_MS + 1)

    const after = ref()
    expect(after).not.toBe(before)
    expect(after.presence).toBe("")
    expect(after.name).toBe("alice")
    expect(after).toEqual(substrate.reader.read(RawPath.empty))
  })

  it("a decay's changeset is marked replay: no writer here authored it", () => {
    const base = Date.now()
    const substrate = makeSubstrate(base)
    const ref = makeRef(substrate)

    let captured: Changeset<Op> | undefined
    const unsub = subscribe(ref, (changeset: Changeset<Op>) => {
      captured = changeset
    })

    substrate.tick?.(base + DECAY_MS + 1)

    expect(captured?.replay).toBe(true)
    unsub()
  })

  it("a decay's changeset payload does not alias the live shadow", () => {
    // The shadow is re-projected in place, container objects and all, so an
    // op that handed out a shadow subtree would be rewritten underneath a
    // subscriber the next time that subtree moved.
    const RosterSchema = Schema.struct({
      peers: Schema.struct({
        alice: Schema.string().decay(DECAY_MS),
        bob: Schema.string(),
      }),
    })
    const base = Date.now()
    const substrate = ephemeralSubstrateFactory.fromEntirety(
      {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({
          peers: { alice: ["online", base], bob: ["online", base] },
        }),
      },
      RosterSchema,
    )
    const ref = interpret(RosterSchema, substrate.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const seen: Changeset<Op>[] = []
    const unsub = subscribe(ref, (changeset: Changeset<Op>) => {
      seen.push(changeset)
    })

    substrate.tick?.(base + DECAY_MS + 1)
    const decayChangeset = seen[0]
    const asDelivered = JSON.stringify(decayChangeset?.changes)
    expect(asDelivered).toContain("peers")

    // Alice comes back: σ is re-projected over the same container object.
    substrate.merge({
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({
        peers: {
          alice: ["online", base + DECAY_MS + 2],
          bob: ["online", base],
        },
      }),
    })

    // What the first subscriber received still says what it said.
    expect(JSON.stringify(decayChangeset?.changes)).toBe(asDelivered)
    unsub()
  })
})

// ---------------------------------------------------------------------------
// projectStateTree: decay applied through the fold
// ---------------------------------------------------------------------------

describe("projectStateTree applies decay", () => {
  it("masks an expired tuple with its structural zero", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(1000),
    })

    const tree: StateTree = {
      presence: ["online", 1000, 1],
    }
    const target = projectStateTree(tree, schema, 2001)

    expect(target.presence).toBe("") // structural zero of a string
  })

  it("does not mask when within the decay window", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(1000),
    })

    const tree: StateTree = {
      presence: ["online", 1500, 1],
    }
    const target = projectStateTree(tree, schema, 2001)

    expect(target.presence).toBe("online")
  })

  it("uses structural zero for the field's type, not just the scalar default", () => {
    const schema = Schema.struct({
      flag: Schema.boolean().decay(500),
    })

    const tree: StateTree = {
      flag: [true, 1000, 1],
    }
    const target = projectStateTree(tree, schema, 2000)

    // Structural zero of boolean is `false`.
    expect(target.flag).toBe(false)
  })

  it("recurses into nested products", () => {
    const schema = Schema.struct({
      user: Schema.struct({
        presence: Schema.string().decay(1000),
        name: Schema.string(),
      }),
    })

    const tree: StateTree = {
      user: {
        presence: ["online", 500, 1],
        name: ["alice", 500, 1],
      },
    }
    const target = projectStateTree(tree, schema, 2000)

    const user = target.user as Record<string, unknown>
    expect(user.presence).toBe("")
    expect(user.name).toBe("alice")
  })
})

// ---------------------------------------------------------------------------
// Where `.decay()` may sit
// ---------------------------------------------------------------------------
//
// Decay works per leaf tuple: it compares one stored timestamp against `now`.
// A sum variant or a `.json()` blob is stored as ONE tuple holding the whole
// value, so a field inside it has no timestamp of its own and cannot age out on
// its own. Before this rule such a binding succeeded and the decay never fired
// — no throw, no log, just a field that stayed put. These cases are what keep
// that from being reachable again.

describe("decay placement relative to an opaque boundary", () => {
  it("is legal ON a sum — the whole variant decays together", () => {
    const schema = Schema.struct({
      opt: Schema.struct({ a: Schema.number() }).nullable().decay(1000),
    })
    expect(() => ephemeral.bind(schema)).not.toThrow()
  })

  it("is legal ON a .json() node", () => {
    const schema = Schema.struct({
      blob: Schema.struct.json({ a: Schema.number() }).decay(1000),
    })
    expect(() => ephemeral.bind(schema)).not.toThrow()
  })

  it("is rejected INSIDE a sum variant", () => {
    const schema = Schema.struct({
      opt: Schema.struct({ a: Schema.number().decay(1000) }).nullable(),
    })
    expect(() => ephemeral.bind(schema)).toThrow(/one register with a single/)
  })

  it("is rejected INSIDE a .json() blob", () => {
    const schema = Schema.struct({
      blob: Schema.struct.json({ a: Schema.number().decay(1000) }),
    })
    expect(() => ephemeral.bind(schema)).toThrow(/one register with a single/)
  })

  it("is rejected on a record item nested inside a .json() blob", () => {
    // The flag propagates through every level below the boundary, so this needs
    // no special branch. Asserted rather than assumed, because "it falls out of
    // the recursion" is exactly the kind of claim that turns out to be wrong.
    const schema = Schema.struct({
      blob: Schema.struct.json({
        m: Schema.record(Schema.number().decay(1000)),
      }),
    })
    expect(() => ephemeral.bind(schema)).toThrow(/one register with a single/)
  })

  it("names the fix rather than only the prohibition", () => {
    const schema = Schema.struct({
      opt: Schema.struct({ a: Schema.number().decay(1000) }).nullable(),
    })
    expect(() => ephemeral.bind(schema)).toThrow(
      /Move \.decay\(\) onto the sum/,
    )
  })

  it("reports the durable rule first when a schema breaks both", () => {
    // Independent problems: fixing either leaves the other. Leading with the
    // boundary message would tell someone to move an annotation when their real
    // problem is that `json` supports no decay anywhere.
    const schema = Schema.struct({
      opt: Schema.struct({ a: Schema.number().decay(1000) }).nullable(),
    })
    expect(() => json.bind(schema)).toThrow(/do not support \.decay\(\)/)
  })
})
