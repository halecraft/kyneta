// delivery.test — runs the shared delivery conformance suite against Yjs.
//
// The notification engine lives in @kyneta/schema and every substrate routes
// through it, so this is not re-testing schema's logic. What it pins is that
// Yjs's event bridge feeds that engine the same way the plain substrate does
// — in particular for an incoming merge, which is announced through
// announce(ctx, ops, origin) with an op list that
// expandMapOpsToLeaves may have spread across many paths.

import { batch, createRef } from "@kyneta/schema"
import {
  type DeliveryDoc,
  DeliveryFixture,
  type DeliveryTestEnv,
  deliveryConformance,
} from "@kyneta/schema/testing"
import { yjs } from "../bind-yjs.js"

function createYjsEnv(): DeliveryTestEnv {
  const bound = yjs.bind(DeliveryFixture)

  const factoryA = bound.factory({
    peerId: "alice",
    binding: bound.identityBinding,
  })
  const factoryB = bound.factory({
    peerId: "bob",
    binding: bound.identityBinding,
  })

  const substrateA = factoryA.create(DeliveryFixture)
  // `createRef` is deliberately untyped ("opaque — cast at call site"), so
  // this annotation is the one place the fixture's type is asserted. Keeping it
  // here rather than on DeliveryTestEnv means the shared suite is checked.
  const doc: DeliveryDoc = createRef(DeliveryFixture, substrateA)

  return {
    doc,
    remoteMerge(fn) {
      // Seed B from A first so both peers agree on container identity before
      // the remote write. Without it the merge carries container creation as
      // well as the write — a noisier payload that tests something else.
      const substrateB = factoryB.create(DeliveryFixture)
      substrateB.merge(substrateA.exportEntirety(), { origin: "sync" })

      const docB: DeliveryDoc = createRef(DeliveryFixture, substrateB)
      const before = substrateB.version()
      batch(docB, fn)
      const delta = substrateB.exportSince(before)
      // Guards against a vacuous pass: with no delta the merge is a no-op and
      // every "one changeset" assertion would hold trivially.
      if (delta === null) throw new Error("exportSince produced no delta")
      substrateA.merge(delta, { origin: "sync" })
    },
  }
}

deliveryConformance(createYjsEnv, { label: "yjs" })
