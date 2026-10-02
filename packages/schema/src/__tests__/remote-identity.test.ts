// remote-identity — a change from elsewhere moves σ only where it touched.
//
// σ is brought up to date from λ where the change landed (`reconcileShadow`),
// so every σ object outside that part keeps its identity, and a list item a
// change did not touch keeps its address.

import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  deleted,
  exportEntirety,
  exportSince,
  json,
  merge,
  Schema,
  SUBSTRATE,
  substrateFromEntirety,
  version,
} from "../index.js"
import { RawPath } from "../path.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import { payload, wire } from "./ephemeral-fixtures.js"

/** σ: what the substrate's reader serves. */
const shadowOf = (substrate: {
  readonly reader: { read(path: RawPath): unknown }
}) => substrate.reader.read(RawPath.empty) as any

describe("ephemeral: a merge reprojects only what its join moved", () => {
  const Rows = Schema.struct({
    rows: Schema.record(Schema.struct({ x: Schema.number() })),
    room: Schema.struct({ a: Schema.number(), b: Schema.number() }).decay(1000),
  })

  it("leaves the record and every untouched row as they were", () => {
    const now = Date.now()
    const substrate = substrateFromEntirety(
      ephemeralSubstrateFactory,
      payload({
        rows: { r0: { x: wire(0, now) }, r1: { x: wire(1, now) } },
      }),
      Rows,
    )
    const before = shadowOf(substrate)
    const rows = before.rows
    const r0 = rows.r0

    substrate.merge(payload({ rows: { r1: { x: wire(9, now + 1) } } }))

    const after = shadowOf(substrate)
    expect(after.rows.r1).toEqual({ x: 9 })
    expect(after.rows).toBe(rows)
    expect(after.rows.r0).toBe(r0)
  })

  it("a merge under an expired container makes its other fields reappear", () => {
    const old = Date.now() - 10_000
    const substrate = substrateFromEntirety(
      ephemeralSubstrateFactory,
      payload({ room: { a: wire(1, old), b: wire(2, old) } }),
      Rows,
    )
    expect(shadowOf(substrate).room).toEqual({ a: 0, b: 0 })

    substrate.merge(payload({ room: { a: wire(5, Date.now()) } }))

    expect(shadowOf(substrate).room).toEqual({ a: 5, b: 2 })
  })
})

describe("plain: an adopted document keeps what it did not move", () => {
  const Doc = Schema.struct({
    items: Schema.list(Schema.struct({ name: Schema.string() })),
    rows: Schema.record(Schema.struct({ n: Schema.number() })),
  })

  it("an item inserted elsewhere leaves the held refs of the others alive", () => {
    const writer: any = createDoc(json.bind(Doc))
    batch(writer, (d: any) => {
      d.items.push({ name: "a" }, { name: "b" })
      d.rows.set("r0", { n: 0 })
    })
    const receiver: any = createDoc(json.bind(Doc))
    merge(receiver, exportEntirety(writer))

    const a = receiver.items.at(0)
    const b = receiver.items.at(1)
    const r0 = shadowOf(receiver[SUBSTRATE]).rows.r0

    batch(writer, (d: any) => d.items.insert(1, { name: "c" }))
    merge(receiver, exportEntirety(writer))

    expect(receiver.items()).toEqual([
      { name: "a" },
      { name: "c" },
      { name: "b" },
    ])
    expect(deleted(a)).toBe(false)
    expect(deleted(b)).toBe(false)
    expect(a.name()).toBe("a")
    expect(b.name()).toBe("b")
    expect(shadowOf(receiver[SUBSTRATE]).rows.r0).toBe(r0)
  })

  it("a delta merge leaves the record and every untouched row as they were", () => {
    const writer: any = createDoc(json.bind(Doc))
    batch(writer, (d: any) => {
      d.rows.set("r0", { n: 0 })
      d.rows.set("r1", { n: 1 })
    })
    const receiver: any = createDoc(json.bind(Doc))
    merge(receiver, exportEntirety(writer))
    const rows = shadowOf(receiver[SUBSTRATE]).rows
    const r0 = rows.r0

    const since = version(writer)
    batch(writer, (d: any) => d.rows.at("r1").n.set(5))
    const delta = exportSince(writer, since)
    expect(delta).not.toBeNull()
    if (delta === null) return
    merge(receiver, delta)

    const after = shadowOf(receiver[SUBSTRATE])
    expect(after.rows.r1).toEqual({ n: 5 })
    expect(after.rows).toBe(rows)
    expect(after.rows.r0).toBe(r0)
  })
})
