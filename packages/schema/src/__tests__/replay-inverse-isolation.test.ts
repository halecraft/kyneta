// replay-inverse-isolation.test — invariants protecting the abort path.
//
// Three regression guards against silent corruption of the
// inverse-compensation pipeline:
//
//   1. Replay batches do not record inverses. (If they did, the inverse
//      would land on whatever frame happened to be open next, and a
//      subsequent local abort would replay remote ops as a local revert.)
//
//   2. The undo-replay handler does not record inverses for its OWN
//      prepares. (If it did, abort would loop or corrupt state.)
//
//   3. The change-Writer log is cleared at every outermost release.
//      (If it weren't, change()'s Op[] return value would accumulate
//      across consecutive blocks.)

import { describe, expect, it } from "vitest"
import { replaceChange } from "../change.js"
import {
  change,
  executeBatch,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  writable,
} from "../index.js"
import { RawPath } from "../path.js"

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

describe("replay batches do not record inverses", () => {
  it("a remote-sync replay survives a subsequent local abort", () => {
    const schema = Schema.struct({
      remote: Schema.string(),
      local: Schema.string(),
    })
    const { ctx, doc } = buildDoc(schema, { remote: "", local: "" })

    // Simulate a replay batch landing (as a substrate event bridge would
    // dispatch one). On the replay path, executeBatch bypasses runBatch
    // and calls ctx.prepare directly with options.replay = true.
    executeBatch(
      ctx,
      [
        {
          path: RawPath.empty.field("remote"),
          change: replaceChange("from-peer"),
        },
      ],
      { origin: "sync", replay: true },
    )

    expect(doc.remote()).toBe("from-peer")

    // Now run a local change() that throws. If the replay above had
    // leaked an inverse onto any frame the next change() opens, this
    // abort would also revert `remote` — silently undoing the remote
    // sync. The local "local" write must revert; "remote" must not.
    expect(() => {
      change(doc, d => {
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
      change(doc, d => {
        for (let i = 0; i < 50; i++) d.items.push(String(i))
        throw new Error("abort")
      })
    }).toThrow("abort")

    expect(doc.items()).toEqual([])
  })
})

describe("the change-Writer log is cleared at every outermost release", () => {
  it("consecutive change() blocks return only their own ops", () => {
    const schema = Schema.struct({
      a: Schema.number(),
      b: Schema.number(),
    })
    const { doc } = buildDoc(schema, { a: 0, b: 0 })

    const ops1 = change(doc, d => d.a.set(1))
    const ops2 = change(doc, d => d.b.set(2))

    expect(ops1).toHaveLength(1)
    expect(ops2).toHaveLength(1)
    // Second block's return must not include the first block's op.
    expect(ops2[0]?.change).toMatchObject({ type: "replace", value: 2 })
  })

  it("a failed (aborted) block does not leak into the next block's return value", () => {
    const schema = Schema.struct({ a: Schema.number(), b: Schema.number() })
    const { doc } = buildDoc(schema, { a: 0, b: 0 })

    expect(() => {
      change(doc, d => {
        d.a.set(99)
        throw new Error("abort")
      })
    }).toThrow("abort")

    const ops = change(doc, d => d.b.set(7))
    expect(ops).toHaveLength(1)
    expect(ops[0]?.change).toMatchObject({ type: "replace", value: 7 })
  })
})
