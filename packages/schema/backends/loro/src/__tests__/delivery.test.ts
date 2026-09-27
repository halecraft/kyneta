// delivery.test — runs the shared delivery conformance suite against Loro.
//
// The notification engine lives in @kyneta/schema and every substrate routes
// through it, so this is not re-testing schema's logic. What it pins is that
// Loro's event bridge feeds that engine the same way the plain substrate does,
// for what it takes in from a peer and for a write made on the LoroDoc
// directly. Both are announced through ctx.announce, with an op list that
// expandMapOpsToLeaves may have spread across many paths.

import { batch, createRef, unwrap } from "@kyneta/schema"
import {
  type DeliveryDoc,
  DeliveryFixture,
  type DeliveryTestEnv,
  deliveryConformance,
} from "@kyneta/schema/testing"
import { LoroDoc } from "loro-crdt"
import { loro } from "../bind-loro.js"
import { createLoroSubstrate } from "../substrate.js"

function createLoroEnv(): DeliveryTestEnv {
  const bound = loro.bind(DeliveryFixture)

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
    remoteWrite(fn) {
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
      return { delta, entirety: substrateB.exportEntirety() }
    },
    nativeWrite(fn) {
      // A second substrate over the same native document writes through its
      // own bracket, so to `doc`'s bridge the commit is a native local
      // write it did not make, as an editor binding's is. This reuses the
      // schema's identity-keyed paths instead of spelling them out natively.
      const native = unwrap(doc)
      if (!(native instanceof LoroDoc)) throw new Error("expected a LoroDoc")
      const other: DeliveryDoc = createRef(
        DeliveryFixture,
        createLoroSubstrate(native, DeliveryFixture, bound.identityBinding),
      )
      batch(other, fn)
    },
    pendingNativeWrite() {
      // A container outside the schema: the write is a local operation all
      // the same, and nothing commits it.
      const native = unwrap(doc)
      if (!(native instanceof LoroDoc)) throw new Error("expected a LoroDoc")
      native.getText("pending").insert(0, "x")
    },
  }
}

deliveryConformance(createLoroEnv, { label: "loro" })
