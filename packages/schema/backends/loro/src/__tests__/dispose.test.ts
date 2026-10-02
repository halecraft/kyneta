// dispose — a Loro substrate releases its LoroDoc, and a document nothing
// holds is collected with or without `dispose`.

import {
  batch,
  createDoc,
  createRef,
  DocumentClosedError,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { collectGarbage, disposeConformance } from "@kyneta/schema/testing"
import { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"
import { createLoroSubstrate, loroSubstrateFactory } from "../substrate.js"

disposeConformance(
  { factory: loroSubstrateFactory, nativePositions: true },
  { label: "loro" },
)

const schema = Schema.struct({ title: Schema.text(), n: Schema.number() })

/** Count `free` calls on a document, without changing what it does. */
function countFrees(doc: LoroDoc): { readonly count: () => number } {
  let frees = 0
  const free = doc.free.bind(doc)
  doc.free = () => {
    frees++
    free()
  }
  return { count: () => frees }
}

describe("loro release", () => {
  it("a standalone document nothing holds is collected, with its LoroDoc, without dispose", async () => {
    const make = () => {
      const doc = createDoc(loro.bind(schema))
      batch(doc, d => {
        d.title.insert(0, "hello")
        d.n.set(1)
      })
      return { ref: new WeakRef(doc), native: new WeakRef(unwrap(doc)) }
    }
    const held = make()
    await collectGarbage()
    expect(held.ref.deref()).toBeUndefined()
    expect(held.native.deref()).toBeUndefined()
  })

  it("a bring-your-own LoroDoc survives the substrate's dispose, and stays usable", () => {
    const native = new LoroDoc()
    const frees = countFrees(native)
    const substrate = createLoroSubstrate(native, schema)
    const doc: any = createRef(schema, substrate)
    doc.title.insert(0, "mine")
    substrate.dispose("disposed")
    expect(frees.count()).toBe(0)
    expect(() => doc.title.insert(0, "x")).toThrow(DocumentClosedError)
    native.getText("title").insert(0, "still ")
    native.commit()
    expect(native.getText("title").toString()).toBe("still mine")
    // The substrate no longer hears the document.
    expect(doc.title()).toBe("mine")
  })

  it("a replica passed to upgrade frees nothing when disposed, and the substrate frees the document once", () => {
    const replica = loroSubstrateFactory.replica.createEmpty()
    const native = unwrapReplica(replica)
    const frees = countFrees(native)
    const substrate = loroSubstrateFactory.upgrade(replica, schema)
    replica.dispose("disposed")
    expect(frees.count()).toBe(0)
    expect(() => replica.version()).toThrow(DocumentClosedError)
    substrate.dispose("destroyed")
    substrate.dispose("destroyed")
    expect(frees.count()).toBe(1)
  })
})

function unwrapReplica(replica: object): LoroDoc {
  return (replica as { [key: symbol]: LoroDoc })[
    Symbol.for("kyneta:backingDoc")
  ]
}

describe("loro event bridge", () => {
  it("keeps hearing its document across a collection", async () => {
    const native = new LoroDoc()
    const doc: any = createRef(schema, createLoroSubstrate(native, schema))
    await collectGarbage()
    native.getText("title").insert(0, "native")
    native.commit()
    expect(doc.title()).toBe("native")
  })
})
