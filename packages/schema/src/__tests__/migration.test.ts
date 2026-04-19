// migration — comprehensive tests for Phase 1 & Phase 2 of the migration system.
//
// Phase 1: deriveIdentity, deriveTier, deriveStepTier, Migration
// namespace constructors, deriveManifest, deriveSchemaBinding, and
// nested migration chains.
//
// Phase 2: Schema API (.migrated(), .epoch(), .migrationBase()),
// struct.json() migration support, and bind() with migrations.

import { describe, expect, it } from "vitest"
import {
  bind,
  deriveIdentity,
  deriveManifest,
  deriveSchemaBinding,
  deriveStepTier,
  deriveTier,
  getMigrationChain,
  type IdentityManifest,
  KIND,
  Migration,
  type MigrationChain,
  type MigrationPrimitive,
  type MigrationTier,
  type ProductSchema,
  plainSubstrateFactory,
  Schema,
  snapshotManifest,
  validateChain,
} from "../index.js"

// ===========================================================================
// deriveIdentity
// ===========================================================================

describe("deriveIdentity", () => {
  it("produces stable, deterministic 128-bit hashes (32 hex chars)", () => {
    const id1 = deriveIdentity("title", 1)
    const id2 = deriveIdentity("title", 1)
    expect(id1).toBe(id2)
    expect(id1).toHaveLength(32)
    expect(id1).toMatch(/^[0-9a-f]{32}$/)
  })

  it("distinguishes different generations (destroy+recreate)", () => {
    const gen1 = deriveIdentity("title", 1)
    const gen2 = deriveIdentity("title", 2)
    expect(gen1).not.toBe(gen2)
  })

  it("distinguishes different paths", () => {
    const idTitle = deriveIdentity("title", 1)
    const idCount = deriveIdentity("count", 1)
    expect(idTitle).not.toBe(idCount)
  })
})

// ===========================================================================
// deriveTier
// ===========================================================================

describe("deriveTier", () => {
  const cases: Array<[string, MigrationPrimitive, MigrationTier]> = [
    ["add", Migration.add("x"), "T0"],
    ["addVariant", Migration.addVariant("x", "tag"), "T0"],
    ["widenConstraint", Migration.widenConstraint("x", [1, 2, 3]), "T0"],
    ["addNullable", Migration.addNullable("x"), "T0"],
    ["rename", Migration.rename("a", "b"), "T1a"],
    ["move", Migration.move("a", "b"), "T1a"],
    ["renameVariant", Migration.renameVariant("x", "a", "b"), "T1a"],
    ["renameDiscriminant", Migration.renameDiscriminant("x", "type"), "T1a"],
    ["retype", Migration.retype("x"), "T3"],
    ["transform (no proofs)", Migration.transform("x", v => v), "T3"],
  ]

  it.each(cases)("%s → %s", (_name, primitive, expectedTier) => {
    expect(deriveTier(primitive)).toBe(expectedTier)
  })

  it("transform with all proofs promotes to T1a", () => {
    const prim = Migration.transform(
      "x",
      v => v,
      v => v,
      {
        idempotent: true,
        crdtHomomorphism: true,
        bijective: true,
      },
    )
    expect(deriveTier(prim)).toBe("T1a")
  })

  // T2 primitives require .drop() to unwrap
  it.each([
    ["remove", Migration.remove("x", Schema.string()).drop().primitive],
    [
      "removeVariant",
      Migration.removeVariant("x", "tag", Schema.string()).drop().primitive,
    ],
    ["narrowConstraint", Migration.narrowConstraint("x", [1]).drop().primitive],
    ["dropNullable", Migration.dropNullable("x").drop().primitive],
  ] as const)("%s → T2", (_name, primitive) => {
    expect(deriveTier(primitive)).toBe("T2")
  })
})

// ===========================================================================
// Migration namespace (constructors)
// ===========================================================================

describe("Migration namespace", () => {
  it(".drop() returns { primitive, dropped: true }", () => {
    const droppable = Migration.remove("x", Schema.string())
    const result = droppable.drop()
    expect(result.dropped).toBe(true)
    expect(result.primitive).toBe(droppable.primitive)
  })

  it("all four T2 constructors produce Droppables", () => {
    const d1 = Migration.remove("x", Schema.string())
    const d2 = Migration.removeVariant("x", "t", Schema.string())
    const d3 = Migration.narrowConstraint("x", [1])
    const d4 = Migration.dropNullable("x")

    for (const d of [d1, d2, d3, d4]) {
      expect(d.primitive).toBeDefined()
      expect(typeof d.drop).toBe("function")
      const dropped = d.drop()
      expect(dropped.dropped).toBe(true)
    }
  })
})

// ===========================================================================
// deriveManifest
// ===========================================================================

describe("deriveManifest", () => {
  it("empty chain → trivial manifest (every path maps to self, gen 1)", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.number(),
    })
    const chain: MigrationChain = { base: null, entries: [] }
    const manifest = deriveManifest(schema, chain)

    expect(manifest.title).toEqual({ originPath: "title", generation: 1 })
    expect(manifest.count).toEqual({ originPath: "count", generation: 1 })
  })

  it("rename: chain with rename(a, b) traces b back to origin a", () => {
    const schema = Schema.struct({ b: Schema.string() })
    const chain: MigrationChain = {
      base: null,
      entries: [
        {
          kind: "migration",
          primitives: [Migration.rename("a", "b")],
          tier: "T1a",
        },
      ],
    }
    const manifest = deriveManifest(schema, chain)

    expect(manifest.b).toEqual({ originPath: "a", generation: 1 })
  })

  it("remove then add: second x has generation 2", () => {
    const schema = Schema.struct({
      x: Schema.string(),
      y: Schema.number(),
    })
    const chain: MigrationChain = {
      base: null,
      entries: [
        {
          kind: "migration",
          primitives: [Migration.remove("x", Schema.string()).drop()],
          tier: "T2",
        },
        {
          kind: "migration",
          primitives: [Migration.add("x")],
          tier: "T0",
        },
      ],
    }
    const manifest = deriveManifest(schema, chain)

    expect(manifest.x).toEqual({ originPath: "x", generation: 2 })
    expect(manifest.y).toEqual({ originPath: "y", generation: 1 })
  })

  it("migrationBase + further steps: preserves base origins through rename", () => {
    const schema = Schema.struct({ b: Schema.string() })
    const chain: MigrationChain = {
      base: { a: { originPath: "original", generation: 3 } },
      entries: [
        {
          kind: "migration",
          primitives: [Migration.rename("a", "b")],
          tier: "T1a",
        },
      ],
    }
    const manifest = deriveManifest(schema, chain)

    expect(manifest.b).toEqual({ originPath: "original", generation: 3 })
  })

  it("epoch resets identities: surviving paths get fresh origins", () => {
    const schema = Schema.struct({ b: Schema.string() })
    const chain: MigrationChain = {
      base: null,
      entries: [
        {
          kind: "migration",
          primitives: [Migration.rename("a", "b")],
          tier: "T1a",
        },
        {
          kind: "epoch",
          primitives: [],
        },
      ],
    }
    const manifest = deriveManifest(schema, chain)

    // After epoch, `b` gets a fresh origin — the rename's lineage is discarded.
    // The generation increments beyond what existed before the epoch.
    expect(manifest.b.originPath).toBe("b")
    expect(manifest.b.generation).toBeGreaterThan(1)
  })
})

// ===========================================================================
// deriveSchemaBinding
// ===========================================================================

describe("deriveSchemaBinding", () => {
  it("trivial binding: every path maps to deriveIdentity(path, 1)", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.number(),
    })
    const manifest: IdentityManifest = {
      title: { originPath: "title", generation: 1 },
      count: { originPath: "count", generation: 1 },
    }
    const binding = deriveSchemaBinding(schema, manifest)

    const expectedTitle = deriveIdentity("title", 1)
    const expectedCount = deriveIdentity("count", 1)
    expect(binding.forward.get("title")).toBe(expectedTitle)
    expect(binding.forward.get("count")).toBe(expectedCount)
  })

  it("forward and inverse maps are consistent", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.number(),
    })
    const manifest: IdentityManifest = {
      title: { originPath: "title", generation: 1 },
      count: { originPath: "count", generation: 1 },
    }
    const binding = deriveSchemaBinding(schema, manifest)

    for (const [path, identity] of binding.forward) {
      expect(binding.inverse.get(identity)).toBe(path)
    }
    for (const [identity, path] of binding.inverse) {
      expect(binding.forward.get(path)).toBe(identity)
    }
  })
})

// ===========================================================================
// Nested migration chain
// ===========================================================================

describe("nested migration chain", () => {
  it("inner struct chain propagates through deriveSchemaBinding on outer struct", () => {
    const innerSchema = Schema.struct({
      postalCode: Schema.string(),
    }).migrated(Migration.rename("zip", "postalCode"))

    const outerSchema = Schema.struct({
      address: innerSchema,
    })

    // Confirm the inner schema has a migration chain
    const innerChain = getMigrationChain(innerSchema)
    if (innerChain === null) throw new Error("expected innerChain")
    expect(innerChain.entries).toHaveLength(1)

    // Derive the inner manifest to verify the rename
    const innerManifest = deriveManifest(innerSchema, innerChain)
    expect(innerManifest.postalCode).toEqual({
      originPath: "zip",
      generation: 1,
    })

    // Derive the outer binding — nested chain's rename should produce
    // an identity at absolute path `address.postalCode` with origin `address.zip`.
    const outerManifest: IdentityManifest = {
      address: { originPath: "address", generation: 1 },
    }
    const binding = deriveSchemaBinding(outerSchema, outerManifest)

    // The nested field's identity should be derived from the absolute origin path
    const expectedIdentity = deriveIdentity("address.zip", 1)
    expect(binding.forward.get("address.postalCode")).toBe(expectedIdentity)
    expect(binding.inverse.get(expectedIdentity)).toBe("address.postalCode")
  })
})

// ===========================================================================
// deriveStepTier
// ===========================================================================

describe("deriveStepTier", () => {
  it("step with only T0 primitives → T0", () => {
    const tier = deriveStepTier([
      Migration.add("x"),
      Migration.addNullable("y"),
    ])
    expect(tier).toBe("T0")
  })

  it("step with T0 + T1a primitives → T1a (max)", () => {
    const tier = deriveStepTier([
      Migration.add("x"),
      Migration.rename("a", "b"),
    ])
    expect(tier).toBe("T1a")
  })

  it("step with T0 + T2 → T2", () => {
    const tier = deriveStepTier([
      Migration.add("x"),
      Migration.remove("y", Schema.string()).drop(),
    ])
    expect(tier).toBe("T2")
  })
})

// ===========================================================================
// Phase 2 — Schema API: .migrated()
// ===========================================================================

describe("Schema API: .migrated()", () => {
  it(".migrated(Migration.add('field')) returns a ProductSchema", () => {
    const base = Schema.struct({ x: Schema.string() })
    const result = base.migrated(Migration.add("field"))

    expect(result[KIND]).toBe("product")
    expect(result.fields).toBeDefined()
  })

  it("chained .migrated().migrated() accumulates steps in order", () => {
    const result = Schema.struct({ c: Schema.string() })
      .migrated(Migration.rename("a", "b"))
      .migrated(Migration.rename("b", "c"))

    const chain = getMigrationChain(result)
    if (chain === null) throw new Error("expected chain")
    expect(chain.entries).toHaveLength(2)
    expect(chain.entries[0].kind).toBe("migration")
    expect(chain.entries[1].kind).toBe("migration")
  })

  it(".migrated() with no arguments throws", () => {
    const base = Schema.struct({ x: Schema.string() })
    expect(() => (base as any).migrated()).toThrow()
  })
})

// ===========================================================================
// Phase 2 — Schema API: .epoch()
// ===========================================================================

describe("Schema API: .epoch()", () => {
  it(".epoch() with zero primitives records a bare epoch", () => {
    const result = Schema.struct({ x: Schema.string() }).epoch()

    const chain = getMigrationChain(result)
    if (chain === null) throw new Error("expected chain")
    expect(chain.entries).toHaveLength(1)
    expect(chain.entries[0].kind).toBe("epoch")
    expect(chain.entries[0].primitives).toHaveLength(0)
  })

  it(".epoch(Migration.retype('field')) records the retype within the epoch", () => {
    const result = Schema.struct({ field: Schema.string() }).epoch(
      Migration.retype("field"),
    )

    const chain = getMigrationChain(result)
    if (chain === null) throw new Error("expected chain")
    expect(chain.entries).toHaveLength(1)

    const entry = chain.entries[0]
    if (entry.kind !== "epoch") throw new Error("expected epoch entry")
    expect(entry.primitives).toHaveLength(1)
    expect(entry.primitives[0].kind).toBe("retype")
  })
})

// ===========================================================================
// Phase 2 — Schema API: .migrationBase()
// ===========================================================================

describe("Schema API: .migrationBase()", () => {
  it(".migrationBase(manifest).migrated(...) correctly sets the chain base", () => {
    const manifest: IdentityManifest = {
      a: { originPath: "original", generation: 3 },
    }
    const result = Schema.struct({ b: Schema.string() })
      .migrationBase(manifest)
      .migrated(Migration.rename("a", "b"))

    const chain = getMigrationChain(result)
    if (chain === null) throw new Error("expected chain")
    expect(chain.base).toEqual(manifest)
    expect(chain.entries).toHaveLength(1)
  })

  it(".migrationBase(...) after .migrated(...) throws", () => {
    const manifest: IdentityManifest = {
      x: { originPath: "x", generation: 1 },
    }
    const migrated = Schema.struct({ x: Schema.string() }).migrated(
      Migration.add("y"),
    )

    expect(() => migrated.migrationBase(manifest)).toThrow()
  })
})

// ===========================================================================
// Phase 2 — Schema API: struct.json() migration support
// ===========================================================================

describe("Schema API: struct.json() migration support", () => {
  it("struct.json() product has migration methods and .migrated() works", () => {
    const result = Schema.struct
      .json({ x: Schema.string() })
      .migrated(Migration.rename("old", "x"))

    const chain = getMigrationChain(result)
    if (chain === null) throw new Error("expected chain")
    expect(chain.entries).toHaveLength(1)
  })

  it("the returned value still satisfies ProductSchema shape", () => {
    const result = Schema.struct
      .json({ x: Schema.string() })
      .migrated(Migration.rename("old", "x"))

    expect(result[KIND]).toBe("product")
    expect(result.fields).toBeDefined()
    expect(result.fields.x).toBeDefined()
  })
})

// ===========================================================================
// Phase 2 — bind() with migrations
// ===========================================================================

describe("bind() with migrations", () => {
  it("bind() on a migrated schema produces a BoundSchema with identityBinding entries", () => {
    const s = Schema.struct({ b: Schema.string() }).migrated(
      Migration.rename("a", "b"),
    )

    const bound = bind({
      schema: s,
      factory: () => plainSubstrateFactory,
      strategy: "authoritative",
    })

    expect(bound.identityBinding.forward.size).toBeGreaterThan(0)
    expect(typeof bound.identityBinding.forward.get("b")).toBe("string")
    const bIdentity = bound.identityBinding.forward.get("b")
    if (bIdentity === undefined) throw new Error("expected identity for 'b'")
    expect(bound.identityBinding.inverse.get(bIdentity)).toBe("b")
    expect(bound.migrationChain).not.toBeNull()
    expect(bound.supportedHashes.has(bound.schemaHash)).toBe(true)
  })

  it("bind() on a non-migrated schema produces a trivial identity binding", () => {
    const s = Schema.struct({ title: Schema.string() })

    const bound = bind({
      schema: s,
      factory: () => plainSubstrateFactory,
      strategy: "authoritative",
    })

    expect(bound.identityBinding.forward.size).toBe(1)
    expect(bound.identityBinding.forward.has("title")).toBe(true)
    expect(bound.supportedHashes.size).toBe(1)
    expect(bound.migrationChain).toBeNull()
  })

  it("identity from rename migration matches deriveIdentity('a', 1)", () => {
    const s = Schema.struct({ b: Schema.string() }).migrated(
      Migration.rename("a", "b"),
    )

    const bound = bind({
      schema: s,
      factory: () => plainSubstrateFactory,
      strategy: "authoritative",
    })

    expect(bound.identityBinding.forward.get("b")).toBe(deriveIdentity("a", 1))
  })
})

// ===========================================================================
// Phase 5 — snapshotManifest
// ===========================================================================

describe("snapshotManifest", () => {
  it("on a schema with three .migrated() steps: snapshot equals deriveManifest output", () => {
    const schema = Schema.struct({
      c: Schema.string(),
      y: Schema.number(),
    })
      .migrated(Migration.rename("a", "b"))
      .migrated(Migration.rename("b", "c"))
      .migrated(Migration.add("y"))

    const snapshot = snapshotManifest(schema)

    // Compare with deriveManifest directly
    const chain = getMigrationChain(schema)
    if (chain === null) throw new Error("expected chain")
    const expected = deriveManifest(schema as unknown as ProductSchema, chain)

    expect(snapshot).toEqual(expected)
    // Verify specific lineage: c traces back to a
    expect(snapshot.c).toEqual({ originPath: "a", generation: 1 })
    // y was added, so its origin is itself
    expect(snapshot.y).toEqual({ originPath: "y", generation: 1 })
  })

  it("on a schema with no chain: returns trivial manifest", () => {
    const schema = Schema.struct({
      title: Schema.text(),
      count: Schema.number(),
    })

    const snapshot = snapshotManifest(schema)

    expect(snapshot.title).toEqual({ originPath: "title", generation: 1 })
    expect(snapshot.count).toEqual({ originPath: "count", generation: 1 })
    expect(Object.keys(snapshot).sort()).toEqual(["count", "title"])
  })
})

// ===========================================================================
// Phase 5 — validateChain
// ===========================================================================

describe("validateChain", () => {
  it("well-formed chain: returns { valid: true }", () => {
    const schema = Schema.struct({
      b: Schema.string(),
      y: Schema.number(),
    })
      .migrated(Migration.rename("a", "b"))
      .migrated(Migration.add("y"))

    const result = validateChain(schema)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("no migration chain: returns { valid: true }", () => {
    const schema = Schema.struct({ x: Schema.string() })
    const result = validateChain(schema)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it("rename to existing path: returns errors", () => {
    // Start with {a, b} via migrationBase, then rename a→b — collision on b.
    const schema = Schema.struct({ b: Schema.string() })
      .migrationBase({
        a: { originPath: "a", generation: 1 },
        b: { originPath: "b", generation: 1 },
      })
      .migrated(Migration.rename("a", "b"))

    const result = validateChain(schema)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(
      result.errors.some(
        e => e.includes("rename") && e.includes("target path already exists"),
      ),
    ).toBe(true)
  })

  it("remove of nonexistent path: returns errors", () => {
    // Start with {x} via migrationBase, then remove "ghost" — doesn't exist.
    const schema = Schema.struct({ x: Schema.string() })
      .migrationBase({
        x: { originPath: "x", generation: 1 },
      })
      .migrated(Migration.remove("ghost", Schema.string()).drop())

    const result = validateChain(schema)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(
      result.errors.some(
        e => e.includes("remove") && e.includes("does not exist"),
      ),
    ).toBe(true)
  })

  it("add to existing path: returns errors", () => {
    // Start with {x} via migrationBase, then add "x" — already exists.
    const schema = Schema.struct({ x: Schema.string() })
      .migrationBase({
        x: { originPath: "x", generation: 1 },
      })
      .migrated(Migration.add("x"))

    const result = validateChain(schema)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(
      result.errors.some(
        e => e.includes("add") && e.includes("already exists"),
      ),
    ).toBe(true)
  })

  it("rename from nonexistent path: returns errors", () => {
    // Start with {b} via migrationBase, then rename ghost→b — source doesn't exist.
    const schema = Schema.struct({ b: Schema.string() })
      .migrationBase({
        b: { originPath: "b", generation: 1 },
      })
      .migrated(Migration.rename("ghost", "b"))

    const result = validateChain(schema)
    expect(result.valid).toBe(false)
    expect(
      result.errors.some(
        e => e.includes("rename") && e.includes("source path does not exist"),
      ),
    ).toBe(true)
  })

  it("well-formed chain with migrationBase: returns { valid: true }", () => {
    const manifest: IdentityManifest = {
      a: { originPath: "original", generation: 3 },
    }
    const schema = Schema.struct({ b: Schema.string() })
      .migrationBase(manifest)
      .migrated(Migration.rename("a", "b"))

    const result = validateChain(schema)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })
})
