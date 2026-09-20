// projection-conformance.test — runs the shared projection suite against the
// `ephemeral` substrate.
//
// The Loro and Yjs backends run the same suite from their own packages.
// `plain` does not participate: σ is the document there, so Π is the identity.

import { createRef } from "../create-doc.js"
import { batch } from "../facade/batch.js"
import { RawPath } from "../path.js"
import type { PlainState } from "../reader.js"
import { Schema } from "../schema.js"
import { BACKING_DOC, hasBackingDoc } from "../substrate.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import { extractPlainState, type StateTree } from "../substrates/state-tree.js"
import {
  type ProjectionTestEnv,
  projectionConformance,
} from "../testing/index.js"

// Every kind the StateTree admits: scalars, a nested struct, a record of
// scalars, a record of structs, a sum, and both json-boundary shapes. A kind
// it refuses cannot appear, because `createStateSubstrate` now rejects the
// schema outright.
//
// Deleting a record's last key is deliberately absent, and it is the one write
// known to break the law: `applyChange` leaves `{}` in σ, while
// `extractPlainState` drops a container whose every leaf is tombstoned, so the
// two disagree until the next merge or tick re-projects. Document reads hide
// it, because the readable layer supplies a record's structural zero for a
// missing key. Adding the step here turns this suite red.
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

// Fixed rather than `Date.now()`. `extractPlainState` masks a leaf older than
// its `decayMs`, so a moving clock could make the two projections differ for a
// reason that has nothing to do with the law under test.
const NOW = 1_700_000_000_000

function createEphemeralEnv(): ProjectionTestEnv {
  const substrate = ephemeralSubstrateFactory.create(Fixture)
  // biome-ignore lint/suspicious/noExplicitAny: the suite exercises the
  // runtime surface, not the type surface.
  const doc = createRef(Fixture, substrate) as any

  return {
    writes: [
      {
        name: "scalar and nested struct",
        apply: () =>
          // biome-ignore lint/suspicious/noExplicitAny: see above
          batch(doc, (d: any) => {
            d.top.set(1)
            d.outer.x.set(2)
            d.outer.y.set("two")
          }),
      },
      {
        name: "record of scalars",
        // biome-ignore lint/suspicious/noExplicitAny: see above
        apply: () => batch(doc, (d: any) => d.entries.set("k", 3)),
      },
      {
        name: "record of structs",
        // biome-ignore lint/suspicious/noExplicitAny: see above
        apply: () =>
          batch(doc, (d: any) => d.peers.set("alice", { name: "A" })),
      },
      {
        name: "sum variant switch",
        apply: () =>
          // biome-ignore lint/suspicious/noExplicitAny: see above
          batch(doc, (d: any) => d.shape.set({ kind: "square", side: 4 })),
      },
      {
        name: "json blob",
        apply: () =>
          // biome-ignore lint/suspicious/noExplicitAny: see above
          batch(doc, (d: any) => d.blob.set({ label: "L", count: 5 })),
      },
      {
        // A `.json()`-wrapped list carries the sequence API, not `.set()` —
        // the wrap changes how it is stored, not how it is written.
        name: "json list push",
        // biome-ignore lint/suspicious/noExplicitAny: see above
        apply: () => batch(doc, (d: any) => d.tags.push("t")),
      },
    ],

    shadow: () => substrate.reader.read(RawPath.empty),

    reproject: () => {
      if (!hasBackingDoc<StateTree>(substrate)) {
        throw new Error("the ephemeral substrate exposes its tree")
      }
      const target: PlainState = {}
      extractPlainState(substrate[BACKING_DOC], target, Fixture, NOW)
      return target
    },
  }
}

projectionConformance(createEphemeralEnv, { label: "ephemeral" })
