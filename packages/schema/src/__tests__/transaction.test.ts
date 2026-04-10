import { describe, expect, it } from "vitest"
import {
  hasTransact,
  interpret,
  observation,
  plainContext,
  readable,
  Schema,
  TRANSACT,
  writable,
} from "../index.js"

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const pointSchema = Schema.struct({
  x: Schema.number(),
  y: Schema.number(),
})

function createPointDoc(seed: Record<string, unknown> = { x: 0, y: 0 }) {
  const store = { ...seed }
  const ctx = plainContext(store)
  const doc = interpret(pointSchema, ctx).with(readable).with(writable).done()
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Core transaction lifecycle
// ---------------------------------------------------------------------------

describe("transaction: lifecycle", () => {
  it("dispatch applies immediately outside a transaction", () => {
    const { store, doc } = createPointDoc()

    doc.x.set(42)
    expect(store.x).toBe(42)
  })

  it("beginTransaction buffers, commit applies atomically", () => {
    const { store, ctx, doc } = createPointDoc()

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)

    // Buffered — store unchanged
    expect(store.x).toBe(0)
    expect(store.y).toBe(0)

    // Commit applies and returns the flushed entries
    const flushed = ctx.commit()
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed).toHaveLength(2)
    expect(flushed[0]?.change.type).toBe("replace")
  })

  it("abort discards buffered changes", () => {
    const { store, ctx, doc } = createPointDoc()

    ctx.beginTransaction()
    doc.x.set(999)
    ctx.abort()

    expect(store.x).toBe(0)

    // Back to auto-commit after abort
    doc.y.set(42)
    expect(store.y).toBe(42)
  })

  it("multiple transaction cycles work in sequence", () => {
    const { store, ctx, doc } = createPointDoc()

    ctx.beginTransaction()
    doc.x.set(10)
    ctx.abort()
    expect(store.x).toBe(0)

    ctx.beginTransaction()
    doc.x.set(42)
    ctx.commit()
    expect(store.x).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Error guards
// ---------------------------------------------------------------------------

describe("transaction: error guards", () => {
  it("nested beginTransaction throws without corrupting the active transaction", () => {
    const { store, ctx, doc } = createPointDoc()

    ctx.beginTransaction()
    doc.x.set(10)
    expect(() => ctx.beginTransaction()).toThrow(/already in a transaction/i)

    // Original transaction is still active and committable
    ctx.commit()
    expect(store.x).toBe(10)
  })

  it("commit without beginTransaction throws", () => {
    const { ctx } = createPointDoc()
    expect(() => ctx.commit()).toThrow(/no active transaction/i)
  })

  it("abort without beginTransaction throws", () => {
    const { ctx } = createPointDoc()
    expect(() => ctx.abort()).toThrow(/no active transaction/i)
  })
})

// ---------------------------------------------------------------------------
// inTransaction observable state
// ---------------------------------------------------------------------------

describe("transaction: inTransaction", () => {
  it("false by default", () => {
    const { ctx } = createPointDoc()
    expect(ctx.inTransaction).toBe(false)
  })

  it("true after beginTransaction", () => {
    const { ctx } = createPointDoc()
    ctx.beginTransaction()
    expect(ctx.inTransaction).toBe(true)
  })

  it("false after commit", () => {
    const { ctx, doc } = createPointDoc()
    ctx.beginTransaction()
    doc.x.set(10)
    ctx.commit()
    expect(ctx.inTransaction).toBe(false)
  })

  it("false after abort", () => {
    const { ctx, doc } = createPointDoc()
    ctx.beginTransaction()
    doc.x.set(10)
    ctx.abort()
    expect(ctx.inTransaction).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// TRANSACT symbol identity
// ---------------------------------------------------------------------------

describe("transaction: TRANSACT symbol", () => {
  it("TRANSACT is the expected Symbol.for string", () => {
    expect(TRANSACT).toBe(Symbol.for("kyneta:transact"))
  })

  it("hasTransact returns true for objects with TRANSACT", () => {
    const obj = { [TRANSACT]: {} }
    expect(hasTransact(obj)).toBe(true)
  })

  it("hasTransact returns false for plain objects", () => {
    expect(hasTransact({})).toBe(false)
    expect(hasTransact(null)).toBe(false)
    expect(hasTransact(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dispatch wrappability — the critical invariant
// ---------------------------------------------------------------------------
//
// commit() must replay through ctx.dispatch (the object property), NOT the
// closure-captured dispatch function. This is what enables layers like
// withChangefeed to intercept replay and fire subscriber notifications.
//
// This invariant was a real bug during development — if commit() calls the
// closure variable directly, subscribers silently stop receiving events at
// commit time. Now commit() uses executeBatch which calls prepare + flush.

describe("transaction: commit delivers batched changefeed notifications", () => {
  it("changefeed subscribers receive exactly one Changeset at commit time", () => {
    const store = { x: 0, y: 0 }
    const ctx = plainContext(store)
    const doc = interpret(pointSchema, ctx)
      .with(readable)
      .with(writable)
      .with(observation)
      .done()

    const CF_SYM = Symbol.for("kyneta:changefeed")
    const xChangesets: unknown[] = []
    ;(doc.x as any)[CF_SYM].subscribe((cs: unknown) => xChangesets.push(cs))

    ctx.beginTransaction()
    doc.x.set(10)
    // No notifications during buffering — store is unchanged
    expect(xChangesets).toHaveLength(0)

    ctx.commit()
    // Exactly 1 changeset delivered at commit time (batched)
    expect(xChangesets).toHaveLength(1)
    expect(store.x).toBe(10)
    const cs = xChangesets[0] as { changes: { type: string }[] }
    expect(cs.changes).toHaveLength(1)
    expect(cs.changes[0]?.type).toBe("replace")
  })
})
