// identity-binding — the standalone factory keys a schema's containers as
// `loro.bind` does, migration chain included. Keyed apart, two documents of
// one schema could not exchange data.

import {
  createRef,
  createSubstrate,
  Migration,
  Schema,
  unwrap,
} from "@kyneta/schema"
import type { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"
import { loroSubstrateFactory } from "../substrate.js"

const Migrated = Schema.struct({ postalCode: Schema.text() }).migrated(
  Migration.rename("zip", "postalCode"),
)

/** The root containers `substrate`'s document holds once `postalCode` is written. */
function rootKeys(
  substrate: ReturnType<typeof createSubstrate>,
): readonly string[] {
  const doc: any = createRef(Migrated, substrate)
  doc.postalCode.insert(0, "02139")
  return Object.keys((unwrap(doc) as LoroDoc).toJSON()).sort()
}

describe("a migrated schema's containers", () => {
  it("are keyed alike through the standalone factory and through loro.bind", () => {
    const bound = loro.bind(Migrated)
    const viaBind = rootKeys(
      createSubstrate(
        bound.factory({ peerId: "p", binding: bound.identityBinding }),
        Migrated,
      ),
    )
    const standalone = rootKeys(createSubstrate(loroSubstrateFactory, Migrated))
    expect(standalone).toEqual(viaBind)
  })
})
