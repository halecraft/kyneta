// projection-conformance.test — runs the shared projection suite against the
// `ephemeral` substrate.
//
// The Loro and Yjs backends run the same suite from their own packages.
// `plain` does not participate: σ is the document there, so Π is the identity.

import { mapChange } from "../change.js"
import { createRef } from "../create-doc.js"
import { applyChanges, batch } from "../facade/batch.js"
import { RawPath } from "../path.js"
import { Schema } from "../schema.js"
import { BACKING_DOC, hasBackingDoc } from "../substrate.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import { projectStateTree, type StateTree } from "../substrates/state-tree.js"
import {
  type ProjectionTestEnv,
  projectionConformance,
} from "../testing/index.js"

// Every kind the StateTree admits: scalars, a nested struct, a record of
// scalars, a record of structs, a sum, and both json-boundary shapes. A kind
// it refuses cannot appear, because `createStateSubstrate` now rejects the
// schema outright.
//
// Deleting a record's last key is included deliberately. A record is a
// declared field of the root product, so it projects as `{}` when emptied
// rather than dropping out — dropping is for keys that were written, not for
// fields the schema declares. The law caught this disagreement before
// `keySpace` existed to state the rule.
const Fixture = Schema.struct({
  top: Schema.number(),
  outer: Schema.struct({ x: Schema.number(), y: Schema.string() }),
  entries: Schema.record(Schema.number()),
  peers: Schema.record(Schema.struct({ name: Schema.string() })),
  shape: Schema.discriminatedUnion("kind", [
    Schema.struct({ kind: Schema.string("circle"), radius: Schema.number() }),
    Schema.struct({ kind: Schema.string("square"), side: Schema.number() }),
  ]),
  blob: Schema.struct.json({ label: Schema.string(), count: Schema.number() }),
  tags: Schema.list.json(Schema.string()),
})

// Fixed rather than `Date.now()`. `projectStateTree` masks a leaf older than
// its `decayMs`, so a moving clock could make the two projections differ for a
// reason that has nothing to do with the law under test.
const NOW = 1_700_000_000_000

function createEphemeralEnv(): ProjectionTestEnv {
  const substrate = ephemeralSubstrateFactory.create(Fixture)
  // Untyped on purpose: the suite exercises the runtime surface, not the
  // type surface.
  const doc = createRef(Fixture, substrate) as any

  return {
    writes: [
      {
        name: "scalar and nested struct",
        apply: () =>
          batch(doc, (d: any) => {
            d.top.set(1)
            d.outer.x.set(2)
            d.outer.y.set("two")
          }),
      },
      {
        name: "record of scalars",
        apply: () => batch(doc, (d: any) => d.entries.set("k", 3)),
      },
      {
        name: "record of structs",
        apply: () =>
          batch(doc, (d: any) => d.peers.set("alice", { name: "A" })),
      },
      {
        name: "sum variant switch",
        apply: () =>
          batch(doc, (d: any) => d.shape.set({ kind: "square", side: 4 })),
      },
      {
        name: "json blob",
        apply: () =>
          batch(doc, (d: any) => d.blob.set({ label: "L", count: 5 })),
      },
      {
        // A `.json()`-wrapped list carries the sequence API, not `.set()` —
        // the wrap changes how it is stored, not how it is written.
        name: "json list push",
        apply: () => batch(doc, (d: any) => d.tags.push("t")),
      },
      {
        name: "record entry delete (last key)",
        apply: () => batch(doc, (d: any) => d.entries.delete("k")),
      },
      {
        name: "record set, cleared and set again in one batch",
        apply: () =>
          batch(doc, (d: any) => {
            d.entries.set("a", 1)
            d.entries.clear()
            d.entries.set("b", 2)
          }),
      },
      {
        name: "record change naming a key in both delete and set",
        apply: () =>
          applyChanges(doc, [
            {
              path: RawPath.empty.field("entries"),
              change: mapChange({ b: 5 }, ["b"]),
            },
          ]),
      },
    ],

    shadow: () => substrate.reader.read(RawPath.empty),

    reproject: () => {
      if (!hasBackingDoc<StateTree>(substrate)) {
        throw new Error("the ephemeral substrate exposes its tree")
      }
      return projectStateTree(substrate[BACKING_DOC], Fixture, NOW)
    },
  }
}

projectionConformance(createEphemeralEnv, { label: "ephemeral" })
