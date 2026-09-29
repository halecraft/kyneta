// delivery-conformance.test — runs the shared delivery suite against the two
// substrates that live in this package: plain and ephemeral.
//
// The Loro and Yjs backends run the same suite from their own packages. Between
// the four, the notification engine's contract is pinned on every substrate
// that ships, through every entry point: a local `batch()`, and a peer's
// write taken in by `merge` or by `resetFromEntirety`.
//
// Ephemeral was absent until a downstream report of a merge that delivered
// nothing. Its merge is a lattice join of a partial tree rather than a replay
// of ops, which is the path the other three never exercise here.

import { describe, expect, it } from "vitest"
import { createRef } from "../create-doc.js"
import { batch } from "../facade/batch.js"
import { subscribe } from "../facade/observe.js"
import { Schema } from "../schema.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import { plainSubstrateFactory } from "../substrates/plain.js"
import {
  DeliveryFixture,
  type DeliveryTestEnv,
  deliveryConformance,
} from "../testing/index.js"

/**
 * Two plain-substrate peers over the same schema. B starts from A's entirety
 * for each write, as the other substrates' peers do, so a write can name what
 * A already holds; the delta since B's start carries only what the write
 * produced.
 */
function createPlainEnv(): DeliveryTestEnv {
  const substrateA = plainSubstrateFactory.create(DeliveryFixture)
  const doc = createRef(DeliveryFixture, substrateA)

  return {
    doc,
    remoteWrite(fn) {
      const substrateB = plainSubstrateFactory.fromEntirety(
        substrateA.exportEntirety(),
        DeliveryFixture,
      )
      const docB = createRef(DeliveryFixture, substrateB) as any
      const before = substrateB.version()
      batch(docB, fn)
      const delta = substrateB.exportSince(before)
      // Guards against a vacuous pass: with no delta the merge would be a
      // no-op and every "one changeset" assertion would trivially hold.
      if (delta === null) throw new Error("exportSince produced no delta")
      return { delta, entirety: substrateB.exportEntirety() }
    },
  }
}

deliveryConformance(createPlainEnv, { label: "plain" })

/**
 * Two ephemeral-substrate peers over the same schema.
 *
 * A's merge is a lattice join rather than a replay of B's ops. The suite's
 * invariants still have to hold: what A's subscribers hear must name the
 * fields the join actually moved.
 */
function createEphemeralEnv(): DeliveryTestEnv {
  const substrateA = ephemeralSubstrateFactory.create(DeliveryFixture)
  const doc = createRef(DeliveryFixture, substrateA)

  return {
    doc,
    remoteWrite(fn) {
      const substrateB = ephemeralSubstrateFactory.fromEntirety(
        substrateA.exportEntirety(),
        DeliveryFixture,
      )
      const docB = createRef(DeliveryFixture, substrateB)
      const before = substrateB.version()
      batch(docB, fn)
      const delta = substrateB.exportSince(before)
      if (delta === null) throw new Error("exportSince produced no delta")
      return { delta, entirety: substrateB.exportEntirety() }
    },
  }
}

deliveryConformance(createEphemeralEnv, { label: "ephemeral" })

// ===========================================================================
// The example TECHNICAL.md has always used
// ===========================================================================

// Carries its own schema. The example turns on a list of structs, and
// `DeliveryFixture` holds only kinds all four substrates admit — `ephemeral`
// has no representation for a sequence.
const ExampleDoc = Schema.struct({
  top: Schema.number(),
  items: Schema.list(Schema.struct({ title: Schema.string() })),
})

describe("the documented delivery example", () => {
  // `packages/schema/TECHNICAL.md` has described this exact shape since the
  // descendant-delivery rewrite. Promoted to a test so the claim is anchored
  // to something that runs, rather than to prose that drifted from the code
  // for two major versions.
  it("one changeset to every level, each covering its own subtree", () => {
    const substrate = plainSubstrateFactory.create(ExampleDoc)
    // The example reads untyped, exercising the runtime surface rather than
    // the type surface.
    const doc = createRef(ExampleDoc, substrate) as any
    batch(doc, (d: any) => d.items.push({ title: "a" }))

    const counts: Record<string, number> = {}
    const ops: Record<string, number> = {}
    // Deliberately the facade `subscribe` — the deep channel.
    const watch = (name: string, ref: unknown) => {
      counts[name] = 0
      ops[name] = 0
      subscribe(ref, cs => {
        counts[name] = (counts[name] ?? 0) + 1
        ops[name] = (ops[name] ?? 0) + cs.changes.length
      })
    }
    watch("doc", doc)
    watch("items", doc.items)
    // `.at()` is `T | undefined` — the item was pushed above, so a miss here
    // means the push failed rather than that the assertion below is wrong.
    const item = doc.items.at(0)
    if (!item) throw new Error("expected items[0] to exist")
    watch("item", item)
    watch("title", item.title)

    batch(doc, d => {
      const draftItem = d.items.at(0)
      if (!draftItem) throw new Error("expected items[0] to exist")
      draftItem.title.set("b")
      d.top.set(1)
    })

    // The root's two ops are the title write and the top write; everything
    // below `items` sees only the title write.
    expect(counts).toEqual({ doc: 1, items: 1, item: 1, title: 1 })
    expect(ops.doc).toBe(2)
    expect(ops.items).toBe(1)
    expect(ops.item).toBe(1)
    expect(ops.title).toBe(1)
  })
})
