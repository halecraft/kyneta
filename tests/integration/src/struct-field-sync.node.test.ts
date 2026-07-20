/**
 * Cross-substrate regression for whole-value struct materialization.
 *
 * This matrix locks convergence of whole-value struct writes across json
 * (plain), loro, and yjs, via both incremental (`exportSince`) and full
 * (`exportEntirety`) sync.
 *
 * The failure mode it guards:
 * The whole-value materializer keys a nested struct's product-field leaves
 * literally while the reader resolves them by identity hash, so a `.nullable()`
 * sibling or a leaf write converges but the whole-struct `.set({...})` does
 * not. The shared `materializeValue` unfold keys every product-field boundary
 * once, for all substrates, so writer and reader agree by construction.
 */

import { loro } from "@kyneta/loro-schema"
import {
  createDoc,
  exportEntirety,
  exportSince,
  json,
  merge,
  Schema,
  version,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"

const Inner = Schema.struct({
  a: Schema.string().nullable(),
  b: Schema.string().nullable(),
})

const ReproSchema = Schema.struct({
  nullableStruct: Inner.nullable(),
  nonNullableStruct: Inner,
  tags: Schema.record(Inner),
  items: Schema.list(Inner),
})

const Media = Schema.discriminatedUnion("type", [
  Schema.struct({ type: Schema.string("text" as const), body: Schema.string() }),
  Schema.struct({ type: Schema.string("image" as const), url: Schema.string() }),
])
const UnionSchema = Schema.struct({ content: Media })

const VALUE = { a: "hello", b: "world" } as const

type Bind = (schema: any) => any

/** Fresh A/B pair sharing a synced structural baseline. */
function pair(bind: Bind, schema: any) {
  // Non-generic alias: passing `any` to `createDoc`'s generic signature makes
  // TS try to expand the recursive `DocRef<S, N>` type (TS2589). This test
  // works with dynamically-typed docs, so a plain `unknown → any` call is fine.
  const create = createDoc as unknown as (bound: unknown) => any
  const a = create(bind(schema))
  const b = create(bind(schema))
  merge(a, exportEntirety(b))
  merge(b, exportEntirety(a))
  return { a, b }
}

/** Ship B's write to A as an incremental delta (falls back to entirety). */
function syncDelta(a: any, b: any, write: () => void) {
  const before = version(b)
  write()
  const delta = exportSince(b, before)
  merge(a, delta ?? exportEntirety(b))
  return { deltaWasNull: delta === null }
}

function suite(name: string, bind: Bind) {
  describe(name, () => {
    it("CONTROL — nullable struct whole .set() converges", () => {
      const { a, b } = pair(bind, ReproSchema)
      syncDelta(a, b, () => b.nullableStruct.set(VALUE))
      expect(a.nullableStruct()).toEqual(VALUE)
    })

    it("non-nullable struct whole .set() converges (incremental)", () => {
      const { a, b } = pair(bind, ReproSchema)
      const { deltaWasNull } = syncDelta(a, b, () =>
        b.nonNullableStruct.set(VALUE),
      )
      expect(deltaWasNull).toBe(false)
      expect(a.nonNullableStruct()).toEqual(VALUE)
    })

    it("non-nullable struct whole .set() converges (full entirety)", () => {
      const { a, b } = pair(bind, ReproSchema)
      b.nonNullableStruct.set(VALUE)
      merge(a, exportEntirety(b))
      expect(a.nonNullableStruct()).toEqual(VALUE)
    })

    it("leaf write inside non-nullable struct converges", () => {
      const { a, b } = pair(bind, ReproSchema)
      syncDelta(a, b, () => b.nonNullableStruct.a.set("hello"))
      expect(a.nonNullableStruct()?.a).toBe("hello")
    })

    it("struct written into a record entry converges", () => {
      const { a, b } = pair(bind, ReproSchema)
      syncDelta(a, b, () => b.tags.set("k1", VALUE))
      expect(a.tags()?.k1).toEqual(VALUE)
    })

    it("struct pushed into a list converges", () => {
      const { a, b } = pair(bind, ReproSchema)
      syncDelta(a, b, () => b.items.push(VALUE))
      expect(a.items()?.[0]).toEqual(VALUE)
    })

    it("discriminated-union whole .set() converges", () => {
      const { a, b } = pair(bind, UnionSchema)
      syncDelta(a, b, () => b.content.set({ type: "text", body: "hi" }))
      expect(a.content()).toEqual({ type: "text", body: "hi" })
    })
  })
}

suite("json (plain)", json.bind.bind(json))
suite("loro", loro.bind.bind(loro))
suite("yjs", yjs.bind.bind(yjs))
