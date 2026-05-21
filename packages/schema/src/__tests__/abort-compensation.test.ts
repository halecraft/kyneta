// abort-compensation.test — pin atomic abort via inverse compensation.
//
// When the outermost change() block throws, the bracket replays this
// frame's recorded inverses LIFO inside the same commit. External
// observers see one batched event with net-zero delta and one Changeset
// with `aborted: true`.

import type { Changeset } from "@kyneta/changefeed"
import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  change,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"

function buildDoc<S extends ReturnType<typeof Schema.struct>>(
  schema: S,
  seed: Record<string, unknown>,
) {
  const store = { ...seed }
  const ctx = plainContext(store)
  const doc = interpret(schema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { store, ctx, doc }
}

describe("abort compensation: outermost throw restores state", () => {
  it("scalar writes revert on throw", () => {
    const schema = Schema.struct({
      a: Schema.number(),
      b: Schema.string(),
    })
    const { doc, store } = buildDoc(schema, { a: 0, b: "" })

    expect(() => {
      change(doc, d => {
        d.a.set(42)
        d.b.set("hello")
        throw new Error("user threw")
      })
    }).toThrow("user threw")

    // State reverted
    expect(doc.a()).toBe(0)
    expect(doc.b()).toBe("")
    expect(store).toEqual({ a: 0, b: "" })
  })

  it("mixed change types revert on throw (set + push + delete)", () => {
    const schema = Schema.struct({
      count: Schema.number(),
      items: Schema.list(Schema.string()),
      meta: Schema.record(Schema.number()),
    })
    const { doc } = buildDoc(schema, {
      count: 5,
      items: ["x"],
      meta: { v: 1 },
    })

    expect(() => {
      change(doc, d => {
        d.count.set(99)
        d.items.push("y")
        d.meta.set("v", 100)
        throw new Error("boom")
      })
    }).toThrow("boom")

    expect(doc.count()).toBe(5)
    expect(doc.items()).toEqual(["x"])
    expect(doc.meta()).toEqual({ v: 1 })
  })

  it("subscriber receives one Changeset with aborted: true containing forward+inverse", () => {
    const schema = Schema.struct({ a: Schema.number() })
    const { doc } = buildDoc(schema, { a: 0 })

    const seen: Changeset[] = []
    doc.a[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    expect(() => {
      change(doc, d => {
        d.a.set(1)
        d.a.set(2)
        throw new Error("abort it")
      })
    }).toThrow("abort it")

    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
    // Forward (2 sets) + inverse (2 inverses replayed) = 4 ops
    expect(seen[0]?.changes.length).toBeGreaterThanOrEqual(2)
    expect(doc.a()).toBe(0)
  })
})

describe("abort compensation: re-entrant aborts", () => {
  it("inner throws and outer catches and swallows → outer Changeset is NOT aborted", () => {
    const schema = Schema.struct({
      outer: Schema.string(),
      inner: Schema.string(),
    })
    const { doc } = buildDoc(schema, { outer: "", inner: "" })

    const seen: Changeset[] = []
    doc.outer[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    change(doc, d => {
      d.outer.set("outer-write")
      try {
        change(d, dd => {
          dd.inner.set("will-be-reverted")
          throw new Error("inner-throw")
        })
      } catch {
        // Outer absorbs the inner abort
      }
      // Outer continues, writes more
      d.outer.set("outer-survives")
    })

    // The outermost Changeset is NOT aborted (outer succeeded)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBeFalsy()

    // Net state: inner reverted, outer's writes survived
    expect(doc.inner()).toBe("")
    expect(doc.outer()).toBe("outer-survives")
  })

  it("inner throws and outer rethrows → outermost Changeset is aborted", () => {
    const schema = Schema.struct({
      outer: Schema.string(),
      inner: Schema.string(),
    })
    const { doc } = buildDoc(schema, { outer: "", inner: "" })

    const seen: Changeset[] = []
    doc.outer[CHANGEFEED].subscribe((cs: Changeset) => seen.push(cs))

    expect(() => {
      change(doc, d => {
        d.outer.set("outer-1")
        change(d, dd => {
          dd.inner.set("inner")
          throw new Error("inner-throw")
        })
        // outer doesn't catch — error propagates
      })
    }).toThrow("inner-throw")

    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
    // Both outer and inner ops reverted
    expect(doc.outer()).toBe("")
    expect(doc.inner()).toBe("")
  })
})

describe("abort compensation: change() return value on throw is moot", () => {
  it("change() doesn't return an Op[] when fn throws (the throw propagates)", () => {
    const schema = Schema.struct({ count: Schema.number() })
    const { doc } = buildDoc(schema, { count: 0 })

    let result: unknown = "not-set"
    try {
      result = change(doc, d => {
        d.count.set(1)
        throw new Error("abort")
      })
    } catch {
      // expected
    }
    // result was never assigned — change() rethrew before returning
    expect(result).toBe("not-set")
    expect(doc.count()).toBe(0)
  })
})
