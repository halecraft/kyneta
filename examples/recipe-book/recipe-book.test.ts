// ═══════════════════════════════════════════════════════════════════════════
//
//   Recipe Book — Integration Tests
//
//   Validates the schema → facade → changefeed → sync pipeline without DOM.
//   Tests the facade basics (createDoc, change, applyChanges) and sync
//   primitives (version, delta, round-trip replication).
//
// ═══════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from "vitest"
import { hasChangefeed } from "@kyneta/schema"
import type { Changeset, Op } from "@kyneta/schema"

import { RecipeBookSchema } from "./src/schema.js"
import { SEED } from "./src/seed.js"
import {
  createDoc,
  change,
  applyChanges,
  subscribe,
  version,
  delta,
} from "./src/facade.js"

// ---------------------------------------------------------------------------
// Helper: create a doc from the shared seed
// ---------------------------------------------------------------------------

function makeDoc() {
  return createDoc(RecipeBookSchema, { ...SEED })
}

// ---------------------------------------------------------------------------
// Facade basics
// ---------------------------------------------------------------------------

describe("facade basics", () => {
  it("createDoc returns callable refs with [CHANGEFEED]", () => {
    const doc = makeDoc()

    // Root is callable — returns snapshot
    expect(typeof doc).toBe("function")
    const snapshot = (doc as any)()
    expect(snapshot.title).toBe("My Recipe Book")
    expect(snapshot.recipes).toHaveLength(2)
    expect(snapshot.favorites).toBe(0)

    // Refs have CHANGEFEED
    expect(hasChangefeed(doc)).toBe(true)
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasChangefeed(doc.recipes)).toBe(true)
    expect(hasChangefeed(doc.favorites)).toBe(true)
  })

  it("text mutation via change() captures ops", () => {
    const doc = makeDoc()
    const ops = change(doc, (d) => {
      d.title.insert(0, "★ ")
    })

    expect(ops.length).toBeGreaterThan(0)
    expect(ops[0].change.type).toBe("text")
    // Verify mutation applied
    expect((doc.title as any)()).toBe("★ My Recipe Book")
  })

  it("list push via change() captures ops", () => {
    const doc = makeDoc()
    const ops = change(doc, (d) => {
      d.recipes.push({
        name: "New Recipe",
        vegetarian: false,
        ingredients: ["flour"],
      } as any)
    })

    expect(ops.length).toBeGreaterThan(0)
    expect(ops[0].change.type).toBe("sequence")
    expect(doc.recipes.length).toBe(3)
  })

  it("counter increment via change() captures ops", () => {
    const doc = makeDoc()
    const ops = change(doc, (d) => {
      d.favorites.increment(1)
    })

    expect(ops.length).toBeGreaterThan(0)
    expect(ops[0].change.type).toBe("increment")
    expect((doc.favorites as any)()).toBe(1)
  })

  it("boolean set via change() captures ops", () => {
    const doc = makeDoc()
    const recipe = doc.recipes.at(0)!
    expect((recipe.vegetarian as any)()).toBe(false)

    const ops = change(doc, () => {
      recipe.vegetarian.set(true)
    })

    expect(ops.length).toBeGreaterThan(0)
    expect(ops[0].change.type).toBe("replace")
    expect((recipe.vegetarian as any)()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sync primitives
// ---------------------------------------------------------------------------

describe("sync primitives", () => {
  it("version(doc) starts at 0 for a seed-created doc", () => {
    const doc = makeDoc()
    expect(version(doc)).toBe(0)
  })

  it("version(doc) increments on each change() call", () => {
    const doc = makeDoc()
    expect(version(doc)).toBe(0)

    change(doc, (d) => d.title.insert(0, "A"))
    expect(version(doc)).toBe(1)

    change(doc, (d) => d.favorites.increment(1))
    expect(version(doc)).toBe(2)

    change(doc, (d) => d.recipes.push({ name: "X", vegetarian: false, ingredients: [] } as any))
    expect(version(doc)).toBe(3)
  })

  it("version(doc) increments on applyChanges() call", () => {
    const docA = makeDoc()
    const docB = makeDoc()

    const ops = change(docA, (d) => d.title.insert(0, "Hi "))
    expect(version(docA)).toBe(1)

    applyChanges(docB, ops)
    expect(version(docB)).toBe(1)
  })

  it("delta(doc, 0) returns all operations since creation", () => {
    const doc = makeDoc()

    change(doc, (d) => d.title.insert(0, "A"))
    change(doc, (d) => d.favorites.increment(1))

    const allOps = delta(doc, 0)
    expect(allOps.length).toBeGreaterThanOrEqual(2)
    // Should contain both a text change and an increment change
    const types = allOps.map((op) => op.change.type)
    expect(types).toContain("text")
    expect(types).toContain("increment")
  })

  it("delta(doc, version(doc)) returns [] (up to date)", () => {
    const doc = makeDoc()

    change(doc, (d) => d.title.insert(0, "A"))
    change(doc, (d) => d.favorites.increment(1))

    const noOps = delta(doc, version(doc))
    expect(noOps).toEqual([])
  })

  it("round-trip: change(docA) → ops → applyChanges(docB) → snapshots match", () => {
    const docA = makeDoc()
    const docB = makeDoc()

    // Perform several mutations on docA
    change(docA, (d) => d.title.insert(0, "★ "))
    change(docA, (d) => d.favorites.increment(3))
    change(docA, (d) => {
      d.recipes.at(0)!.vegetarian.set(true)
    })

    // Get all ops and apply to docB
    const ops = delta(docA, 0)
    applyChanges(docB, ops, { origin: "sync" })

    // Snapshots should match
    const snapshotA = (docA as any)()
    const snapshotB = (docB as any)()
    expect(snapshotB).toEqual(snapshotA)
  })

  it("applyChanges fires changefeed notifications with origin 'sync'", () => {
    const docA = makeDoc()
    const docB = makeDoc()

    // Subscribe to docB's tree changefeed
    const received: Changeset<Op>[] = []
    subscribe(docB, (changeset: Changeset<Op>) => {
      received.push(changeset)
    })

    // Mutate docA and get ops
    const ops = change(docA, (d) => d.title.insert(0, "Hi "))

    // Apply to docB with origin "sync"
    applyChanges(docB, ops, { origin: "sync" })

    // Verify notifications fired with correct origin
    expect(received.length).toBeGreaterThan(0)
    // At least one changeset should have origin "sync"
    const syncChangesets = received.filter((cs) => cs.origin === "sync")
    expect(syncChangesets.length).toBeGreaterThan(0)
  })
})