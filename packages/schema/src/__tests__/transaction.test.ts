import { describe, expect, it } from "vitest"
import {
  Schema,
  LoroSchema,
  interpret,
  bottomInterpreter,
  withReadable,
  withCaching,
  withWritable,
  createWritableContext,
  enrich,
  withChangefeed,
  TRANSACT,
  hasTransact,
} from "../index.js"
import type { Readable, Writable } from "../index.js"

const writableInterpreter = withWritable(withCaching(withReadable(bottomInterpreter)))

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

const pointSchema = Schema.doc({
  x: Schema.number(),
  y: Schema.number(),
})

function createPointDoc(seed: Record<string, unknown> = { x: 0, y: 0 }) {
  const store = { ...seed }
  const ctx = createWritableContext(store)
  const doc = interpret(pointSchema, writableInterpreter, ctx) as any
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
    expect(flushed[0]!.change.type).toBe("replace")
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
// commit time.

describe("transaction: commit replays through wrappable ctx.dispatch", () => {
  it("changefeed subscribers fire at commit time via dispatch replay", () => {
    const store = { x: 0, y: 0 }
    const ctx = createWritableContext(store)
    const enriched = enrich(writableInterpreter, withChangefeed)
    const doc = interpret(pointSchema, enriched, ctx) as unknown as Readable<
      typeof pointSchema
    > &
      Writable<typeof pointSchema>

    const CF_SYM = Symbol.for("kyneta:changefeed")
    const xChanges: unknown[] = []
    ;(doc.x as any)[CF_SYM].subscribe((c: unknown) => xChanges.push(c))

    ctx.beginTransaction()
    doc.x.set(10)
    // Transitional withChangefeed fires eagerly during buffer — record count
    const countAfterBuffer = xChanges.length

    ctx.commit()
    // Commit replays through ctx.dispatch (the wrapped property),
    // so the changefeed notification wrapper fires again
    expect(xChanges.length).toBeGreaterThan(countAfterBuffer)
    expect(store.x).toBe(10)
    expect((xChanges[xChanges.length - 1] as { type: string }).type).toBe("replace")
  })
})