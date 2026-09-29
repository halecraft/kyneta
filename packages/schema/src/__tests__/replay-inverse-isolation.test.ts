// replay-inverse-isolation.test — invariants protecting the abort path.
//
// Three regression guards against silent corruption of the
// inverse-compensation pipeline:
//
//   1. Merged ops do not record inverses. (If they did, the inverse
//      would land on whatever frame happened to be open next, and a
//      subsequent local abort would replay remote ops as a local revert.)
//
//   2. The undo-replay handler does not record inverses for its OWN
//      prepares. (If it did, abort would loop or corrupt state.)
//
//   3. The change-Writer log is cleared at every outermost release.
//      (If it weren't, batch()'s Op[] return value would accumulate
//      across consecutive blocks.)

import { describe, expect, it } from "vitest"
import {
  batch,
  createRef,
  exportSince,
  interpret,
  merge,
  observation,
  plainContext,
  plainSubstrateFactory,
  readable,
  Schema,
  writable,
} from "../index.js"
import type { SubstratePayload } from "../substrate.js"

function buildDoc<S extends ReturnType<typeof Schema.struct>>(
  schema: S,
  seed: Record<string, unknown>,
) {
  const store = { ...seed }
  const ctx = plainContext(schema, store)
  const doc = interpret(schema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { store, ctx, doc }
}

describe("merged ops do not record inverses", () => {
  it("a merge survives a subsequent local abort", () => {
    const schema = Schema.struct({
      remote: Schema.string(),
      local: Schema.string(),
    })
    const peer = plainSubstrateFactory.create(schema)
    const peerDoc = createRef(schema, peer)
    const substrate = plainSubstrateFactory.create(schema)
    const doc = createRef(schema, substrate)

    const v0 = peer.version()
    batch(peerDoc, d => d.remote.set("from-peer"))
    merge(doc, exportSince(peerDoc, v0) as SubstratePayload, {
      origin: "sync",
    })
    expect(doc.remote()).toBe("from-peer")

    // Now run a local batch() that throws. If the merge had leaked an
    // inverse onto any frame the next batch() opens, this abort would
    // also revert `remote`, silently undoing the sync. The local write
    // must revert; `remote` must not.
    expect(() => {
      batch(doc, d => {
        d.local.set("ephemeral")
        throw new Error("abort")
      })
    }).toThrow("abort")

    expect(doc.remote()).toBe("from-peer")
    expect(doc.local()).toBe("")
  })
})

describe("the undo-replay handler does not record its own inverses", () => {
  it("aborting a block with many ops terminates without state corruption", () => {
    const schema = Schema.struct({
      items: Schema.list(Schema.string()),
    })
    const { doc } = buildDoc(schema, { items: [] })

    // Push many ops then throw. If the abort path's compensating
    // prepares were re-recorded as inverses, the catch loop would
    // iterate over a growing inverse stack (either stack-overflowing,
    // running forever, or leaving the state corrupted).
    expect(() => {
      batch(doc, d => {
        for (let i = 0; i < 50; i++) d.items.push(String(i))
        throw new Error("abort")
      })
    }).toThrow("abort")

    expect(doc.items()).toEqual([])
  })
})

describe("the change-Writer log is cleared at every outermost release", () => {
  it("consecutive batch() blocks return only their own ops", () => {
    const schema = Schema.struct({
      a: Schema.number(),
      b: Schema.number(),
    })
    const { doc } = buildDoc(schema, { a: 0, b: 0 })

    const ops1 = batch(doc, d => d.a.set(1))
    const ops2 = batch(doc, d => d.b.set(2))

    expect(ops1).toHaveLength(1)
    expect(ops2).toHaveLength(1)
    // Second block's return must not include the first block's op.
    expect(ops2[0]?.change).toMatchObject({ type: "replace", value: 2 })
  })

  it("a failed (aborted) block does not leak into the next block's return value", () => {
    const schema = Schema.struct({ a: Schema.number(), b: Schema.number() })
    const { doc } = buildDoc(schema, { a: 0, b: 0 })

    expect(() => {
      batch(doc, d => {
        d.a.set(99)
        throw new Error("abort")
      })
    }).toThrow("abort")

    const ops = batch(doc, d => d.b.set(7))
    expect(ops).toHaveLength(1)
    expect(ops[0]?.change).toMatchObject({ type: "replace", value: 7 })
  })
})
