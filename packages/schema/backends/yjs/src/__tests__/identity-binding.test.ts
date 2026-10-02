// identity-binding — the standalone factory keys a schema's containers as
// `yjs.bind` does, migration chain included. Keyed apart, two documents of
// one schema could not exchange data.

import {
  createRef,
  createSubstrate,
  Migration,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type * as Y from "yjs"
import { yjs } from "../bind-yjs.js"
import { yjsSubstrateFactory } from "../substrate.js"

const Migrated = Schema.struct({ postalCode: Schema.text() }).migrated(
  Migration.rename("zip", "postalCode"),
)

/** The root containers `substrate`'s document holds once `postalCode` is written. */
function rootKeys(
  substrate: ReturnType<typeof createSubstrate>,
): readonly string[] {
  const doc: any = createRef(Migrated, substrate)
  doc.postalCode.insert(0, "02139")
  const root = (unwrap(doc) as Y.Doc).getMap("root")
  return [...root.keys()].sort()
}

describe("a migrated schema's containers", () => {
  it("are keyed alike through the standalone factory and through yjs.bind", () => {
    const bound = yjs.bind(Migrated)
    const viaBind = rootKeys(
      createSubstrate(
        bound.factory({ peerId: "p", binding: bound.identityBinding }),
        Migrated,
      ),
    )
    const standalone = rootKeys(createSubstrate(yjsSubstrateFactory, Migrated))
    expect(standalone).toEqual(viaBind)
  })
})
