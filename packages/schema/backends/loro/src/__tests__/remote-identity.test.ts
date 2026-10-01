// remote-identity — a merged change moves σ only where its ops touched.
//
// The event bridge reconciles σ at the paths the merged ops name
// (`reconcileShadow`), so every σ object outside them keeps its identity.

import {
  batch,
  createDoc,
  exportEntirety,
  exportSince,
  merge,
  RawPath,
  Schema,
  SUBSTRATE,
  version,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { loro } from "../index.js"

const Doc = Schema.struct({
  rows: Schema.record(
    Schema.struct({ body: Schema.text(), n: Schema.number() }),
  ),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})

/** σ: what the substrate's reader serves. */
const shadowOf = (doc: any) => doc[SUBSTRATE].reader.read(RawPath.empty)

function pair() {
  const writer: any = createDoc(loro.bind(Doc))
  batch(writer, (d: any) => {
    d.rows.set("r0", { body: "", n: 0 })
    d.rows.set("r1", { body: "", n: 1 })
    d.items.push({ name: "a" }, { name: "b" })
  })
  const receiver: any = createDoc(loro.bind(Doc))
  merge(receiver, exportEntirety(writer))
  /** Apply `write` on the writer, and merge its delta into the receiver. */
  const sync = (write: (d: any) => void) => {
    const since = version(writer)
    batch(writer, write)
    const delta = exportSince(writer, since)
    if (delta === null) throw new Error("no delta")
    merge(receiver, delta)
  }
  return { receiver, sync }
}

describe("Loro: a merge moves σ only where its ops touched", () => {
  it("a text write into one row leaves the record and the other rows as they were", () => {
    const { receiver, sync } = pair()
    const before = shadowOf(receiver)
    const rows = before.rows
    const r0 = rows.r0
    const held = receiver.rows.at("r0")
    const heldRead = held()

    sync((d: any) => d.rows.at("r1").body.insert(0, "x"))

    const after = shadowOf(receiver)
    expect(after.rows.r1.body).toBe("x")
    expect(after.rows).toBe(rows)
    expect(after.rows.r0).toBe(r0)
    expect(held()).toBe(heldRead)
  })

  it("an insert into a list leaves the other items as they were", () => {
    const { receiver, sync } = pair()
    const items = shadowOf(receiver).items
    const [a, b] = items

    sync((d: any) => d.items.insert(1, { name: "c" }))

    const after = shadowOf(receiver)
    expect(after.items.map((item: { name: string }) => item.name)).toEqual([
      "a",
      "c",
      "b",
    ])
    expect(after.items[0]).toBe(a)
    expect(after.items[2]).toBe(b)
  })
})
