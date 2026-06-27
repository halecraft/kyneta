// state-decay — tests for `.decay(ms)` on the state substrate.
//
// Verifies:
// - Schema: `.decay(N)` sets `decayMs` and does not pollute base schemas.
// - Rejection: durable sync modes throw at `bind()` time if `.decay()` is present.
// - State Sweep: `tick(now)` updates the `PlainState` shadow to the structural
//   zero for expired fields, but `version()` does NOT increment and
//   `exportEntirety()` retains the original tuple.
// - Hashing: different `decayMs` values produce different schema hashes.

import { describe, expect, it } from "vitest"
import {
  bind,
  computeSchemaHash,
  ephemeral,
  interpret,
  json,
  observation,
  readable,
  Schema,
  SYNC_COLLABORATIVE,
  state,
  subscribe,
  writable,
} from "../index.js"
import { RawPath } from "../path.js"
import { stateSubstrateFactory } from "../substrates/state.js"
import type { StateTree } from "../substrates/state-tree.js"
import { extractPlainState } from "../substrates/state-tree.js"

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
    // because bind() runs validateSyncModeConstraints.
    expect(() =>
      bind({
        schema,
        factory: () => {
          // This factory is never reached — the validator throws first.
          throw new Error("should not reach factory")
        },
        syncMode: SYNC_COLLABORATIVE,
      }),
    ).toThrow(/decay/i)
  })

  it("state.bind allows .decay() (ephemeral)", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(2000),
    })

    expect(() => state.bind(schema)).not.toThrow()
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

  /**
   * Build a substrate pre-populated with an expired presence tuple,
   * then initialize its writable context (required for tick() to fire
   * the changefeed).
   */
  function makeDecayedSubstrate(now: number) {
    const substrate = stateSubstrateFactory.fromEntirety(
      {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({
          presence: ["online", 1000],
          name: ["alice", 1000],
        }),
      },
      PresenceSchema,
    )
    // Initialize the writable context — tick() needs it to fire the changefeed.
    substrate.context()
    return substrate
  }

  it("tick() reverts expired presence fields to structural zero", () => {
    const substrate = makeDecayedSubstrate(2001)

    // Verify the tree carries the expired timestamp.
    const entiretyBefore = JSON.parse(
      substrate.exportEntirety().data as string,
    ) as Record<string, unknown>
    expect((entiretyBefore.presence as unknown[])[0]).toBe("online")

    // Tick at now=2001: presence (T=1000, decayMs=1000) should decay.
    substrate.tick?.(2001)

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
    const substrate = makeDecayedSubstrate(2001)
    substrate.context() // ensure writable context is initialized
    const versionBefore = substrate.version()

    // Tick — even if something decays, the version must not change.
    substrate.tick?.(2001)

    const versionAfter = substrate.version()
    expect(versionAfter.serialize()).toBe(versionBefore.serialize())
  })

  it("tick() does NOT mutate exportEntirety() — the tree is untouched", () => {
    const substrate = makeDecayedSubstrate(5000)

    const entiretyBefore = substrate.exportEntirety().data as string

    // Tick well past the decay window.
    substrate.tick?.(5000)

    const entiretyAfter = substrate.exportEntirety().data as string
    expect(entiretyAfter).toBe(entiretyBefore)
  })

  it("tick() is a no-op when no decayMs is declared", () => {
    const NoDecaySchema = Schema.struct({
      presence: Schema.string(),
      name: Schema.string(),
    })

    const substrate = stateSubstrateFactory.fromEntirety(
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
    const substrate = stateSubstrateFactory.fromEntirety(
      {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify({
          server: {
            type: ["present", initialNow],
            peerId: ["peer-xyz", initialNow],
          },
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

  it("tick() fires the changefeed so local subscribers refresh", () => {
    const substrate = makeDecayedSubstrate(2001)

    // Build a full ref with changefeed (observation layer).
    const ref = interpret(PresenceSchema, substrate.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any

    // Subscribe to the ref's changefeed.
    let fired = false
    const unsub = subscribe(ref, () => {
      fired = true
    })

    // Tick — presence should decay and the changefeed should fire.
    substrate.tick?.(2001)

    expect(fired).toBe(true)
    unsub()
  })

  it("tick() fires with replay: true so the Exchange does NOT broadcast", () => {
    const substrate = makeDecayedSubstrate(2001)

    // Build a full ref with changefeed (observation layer).
    const ref = interpret(PresenceSchema, substrate.context())
      .with(readable)
      .with(writable)
      .with(observation)
      .done() as any

    // Capture the changeset to inspect the `replay` flag.
    let capturedChangeset: any
    const unsub = subscribe(ref, (changeset: any) => {
      capturedChangeset = changeset
    })

    // Tick — presence should decay.
    substrate.tick?.(2001)

    // The changeset must carry `replay: true` so the Exchange's
    // onDocChangeset hook skips notifyLocalChange (peer broadcast).
    expect(capturedChangeset).toBeDefined()
    expect(capturedChangeset.replay).toBe(true)

    unsub()
  })
})

// ---------------------------------------------------------------------------
// extractPlainState — schema-aware projection
// ---------------------------------------------------------------------------

describe("extractPlainState schema-aware projection", () => {
  it("masks expired tuples with structural zero when schema+now are provided", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(1000),
    })

    const tree: StateTree = {
      presence: ["online", 1000],
    }
    const target: Record<string, unknown> = {}

    const anyDecayed = extractPlainState(tree, target, schema, 2001)

    expect(anyDecayed).toBe(true)
    expect(target.presence).toBe("") // structural zero of a string
  })

  it("does not mask when within the decay window", () => {
    const schema = Schema.struct({
      presence: Schema.string().decay(1000),
    })

    const tree: StateTree = {
      presence: ["online", 1500],
    }
    const target: Record<string, unknown> = {}

    const anyDecayed = extractPlainState(tree, target, schema, 2001)

    expect(anyDecayed).toBe(false)
    expect(target.presence).toBe("online")
  })

  it("backward-compatible: no schema means no decay masking", () => {
    const tree: StateTree = {
      presence: ["online", 1000],
    }
    const target: Record<string, unknown> = {}

    // No schema, no now — behaves exactly as before the decay feature.
    const anyDecayed = extractPlainState(tree, target)

    expect(anyDecayed).toBe(false)
    expect(target.presence).toBe("online")
  })

  it("uses structural zero for the field's type, not just the scalar default", () => {
    const schema = Schema.struct({
      flag: Schema.boolean().decay(500),
    })

    const tree: StateTree = {
      flag: [true, 1000],
    }
    const target: Record<string, unknown> = {}

    extractPlainState(tree, target, schema, 2000)

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
        presence: ["online", 500],
        name: ["alice", 500],
      },
    }
    const target: Record<string, unknown> = {}

    const anyDecayed = extractPlainState(tree, target, schema, 2000)

    expect(anyDecayed).toBe(true)
    const user = target.user as Record<string, unknown>
    expect(user.presence).toBe("")
    expect(user.name).toBe("alice")
  })
})
