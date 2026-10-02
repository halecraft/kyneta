// dispose — a Yjs substrate releases its Y.Doc, and a document nothing holds
// is collected.

import {
  batch,
  createDoc,
  createRef,
  createSubstrate,
  DocumentClosedError,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { collectGarbage, disposeConformance } from "@kyneta/schema/testing"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs } from "../bind-yjs.js"
import {
  createYjsSubstrate,
  DELETE_CLOCK,
  yjsSubstrateFactory,
} from "../substrate.js"

disposeConformance(
  { factory: yjsSubstrateFactory, nativePositions: true },
  { label: "yjs" },
)

const schema = Schema.struct({ title: Schema.text(), n: Schema.number() })

describe("yjs release", () => {
  it("a standalone document nothing holds is collected, with its Y.Doc", async () => {
    const make = () => {
      const doc = createDoc(yjs.bind(schema))
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

  it("after dispose, a held ref no longer reaches its Y.Doc", async () => {
    const make = () => {
      const substrate = createSubstrate(yjsSubstrateFactory, schema)
      const doc: any = createRef(schema, substrate)
      doc.title.insert(0, "kept")
      const native = new WeakRef(unwrap(doc) as Y.Doc)
      substrate.dispose("destroyed")
      return { doc, native }
    }
    const { doc, native } = make()
    await collectGarbage()
    expect(native.deref()).toBeUndefined()
    expect(doc.title()).toBe("kept")
  })

  it("a bring-your-own Y.Doc keeps its delete clock when one of two substrates over it is disposed", () => {
    const native = new Y.Doc()
    const first = createYjsSubstrate(native, schema)
    const second = createYjsSubstrate(native, schema)
    const doc: any = createRef(schema, second)
    createRef(schema, first)
    first.dispose("disposed")
    native.getMap("root").set("n", 1)
    const before = second.version()
    native.getMap("root").delete("n")
    expect(second.version().compare(before)).toBe("ahead")
    expect(native.getText(DELETE_CLOCK).toString()).toBe("")
    expect(() => unwrap(createRef(schema, first))).toThrow(DocumentClosedError)
    expect(doc.n()).toBe(0)
  })
})
