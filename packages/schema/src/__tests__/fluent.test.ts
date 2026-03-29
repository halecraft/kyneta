import { describe, expect, expectTypeOf, it } from "vitest"
import type {
  Changeset,
  Interpreter,
  InterpreterLayer,
  Op,
  RawSegment,
  RefContext,
  WritableContext,
} from "../index.js"
import {
  bottomInterpreter,
  CHANGEFEED,
  changefeed,
  hasChangefeed,
  hasComposedChangefeed,
  hasTransact,
  interpret,
  LoroSchema,
  plainContext,
  plainStoreReader,
  rawKey,
  readable,
  RawPath,
  Schema,
  TRANSACT,
  withCaching,
  withNavigation,
  withReadable,
  withWritable,
  writable,
} from "../index.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const pointSchema = Schema.doc({
  x: Schema.number(),
  y: Schema.number(),
})

const chatDocSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: LoroSchema.text(),
    }),
  ),
  settings: LoroSchema.plain.struct({
    darkMode: LoroSchema.plain.boolean(),
    fontSize: LoroSchema.plain.number(),
  }),
  metadata: Schema.record(LoroSchema.plain.any()),
})

// ===========================================================================
// Fluent API — basic functionality
// ===========================================================================

describe("fluent: interpret(schema, ctx).with(...).done()", () => {
  it("readable layer produces callable refs with caching identity", () => {
    const store = {
      title: "Hello",
      count: 0,
      messages: [{ author: "Alice", body: "Hi" }],
      settings: { darkMode: false, fontSize: 14 },
      metadata: {},
    }
    const ctx: RefContext = { store: plainStoreReader(store) }
    const doc = interpret(chatDocSchema, ctx).with(readable).done() as any

    // Callable
    expect(doc.title()).toBe("Hello")
    expect(doc.settings.darkMode()).toBe(false)

    // Caching identity preserved
    expect(doc.settings).toBe(doc.settings)
    expect(doc.messages.at(0)).toBe(doc.messages.at(0))

    // No mutation or observation (partial stack)
    expect(doc.title.set).toBeUndefined()
    expect(hasTransact(doc.title)).toBe(false)
    expect(hasChangefeed(doc.title)).toBe(false)
  })

  it("readable + writable produces mutable refs without observation", () => {
    const store = { x: 0, y: 0 }
    const ctx = plainContext(store)
    const doc = interpret(pointSchema, ctx).with(readable).with(writable).done()

    doc.x.set(42)
    expect(store.x).toBe(42)
    expect(doc.x()).toBe(42)
    expect(hasTransact(doc.x)).toBe(true)
    expect(hasChangefeed(doc.x)).toBe(false)
  })

  it("full stack produces read/write/observe surface on complex schema", () => {
    const store = {
      title: "Hello",
      count: 0,
      messages: [{ author: "Alice", body: "Hi" }],
      settings: { darkMode: false, fontSize: 14 },
      metadata: { version: 1 },
    }
    const ctx = plainContext(store)

    const doc = interpret(chatDocSchema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // Readable
    expect(doc.title()).toBe("Hello")
    expect(doc.count()).toBe(0)
    expect(doc.settings.darkMode()).toBe(false)
    expect(doc.messages.length).toBe(1)

    // Writable
    doc.title.insert(5, " World")
    expect(doc.title()).toBe("Hello World")
    doc.count.increment(3)
    expect(doc.count()).toBe(3)

    // Observable — leaf and composite
    expect(hasChangefeed(doc.title)).toBe(true)
    expect(hasComposedChangefeed(doc.settings)).toBe(true)
    expect(hasComposedChangefeed(doc.messages)).toBe(true)

    // subscribeTree works
    const events: Op[] = []
    ;(doc.settings as any)[CHANGEFEED].subscribeTree(
      (changeset: Changeset<Op>) => {
        for (const event of changeset.changes) events.push(event)
      },
    )
    doc.settings.darkMode.set(true)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect((events[0]?.path.segments[0] as RawSegment & { key: string }).key).toBe("darkMode")
  })
})

// ===========================================================================
// Transaction integration
// ===========================================================================

describe("fluent: transactions", () => {
  it("buffering, commit, and changefeed notification work through fluent-built refs", () => {
    const store = { x: 0, y: 0 }
    const ctx = plainContext(store)
    const doc = interpret(pointSchema, ctx)
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // TRANSACT points to the correct context
    expect(doc.x[TRANSACT]).toBe(ctx)

    const changes: unknown[] = []
    ;(doc.x as any)[CHANGEFEED].subscribe((c: unknown) => changes.push(c))

    ctx.beginTransaction()
    doc.x.set(10)
    doc.y.set(20)

    // Buffered — store unchanged, no notifications
    expect(store.x).toBe(0)
    expect(store.y).toBe(0)
    expect(changes).toHaveLength(0)

    ctx.commit()
    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    // Exactly 1 changeset delivered at commit time (batched)
    expect(changes).toHaveLength(1)
  })
})

// ===========================================================================
// Builder immutability — branching
// ===========================================================================

describe("fluent: builder branching", () => {
  it("two branches from the same builder produce independent results", () => {
    const store1 = { x: 0, y: 0 }
    const ctx1 = plainContext(store1)

    // Create a base builder and branch it
    const base = interpret(pointSchema, ctx1).with(readable)

    // Branch A: readable only (no mutation)
    const readOnly = base.done() as any

    // Branch B: readable + writable (has mutation)
    const store2 = { x: 0, y: 0 }
    const ctx2 = plainContext(store2)
    const mutable = interpret(pointSchema, ctx2)
      .with(readable)
      .with(writable)
      .done()

    // Read-only branch must NOT have gained .set() from the writable branch
    expect(readOnly.x.set).toBeUndefined()

    // Writable branch works independently
    mutable.x.set(42)
    expect(store2.x).toBe(42)

    // Original base can still be used for another branch
    const readOnly2 = base.done() as any
    expect(readOnly2.x()).toBe(0)
    expect(readOnly2.x.set).toBeUndefined()
  })
})

// ===========================================================================
// Custom user-defined layer
// ===========================================================================

describe("fluent: custom layer", () => {
  it("user-defined InterpreterLayer works with the builder", () => {
    // A trivial custom layer that attaches a non-enumerable `_tagged`
    // property to every scalar ref. Proves the extension point works.
    const TAG = Symbol("custom-tag")

    const tagging: InterpreterLayer<RefContext, RefContext> = {
      name: "tagging",
      transform(
        base: Interpreter<RefContext, any>,
      ): Interpreter<RefContext, any> {
        return {
          ...base,
          scalar(ctx, path, schema) {
            const result = base.scalar(ctx, path, schema)
            if (
              (result && typeof result === "object") ||
              typeof result === "function"
            ) {
              Object.defineProperty(result, TAG, {
                value: path.segments
                  .map(s => String(s.resolve()))
                  .join("."),
                enumerable: false,
              })
            }
            return result
          },
        }
      },
    }

    const store = { x: 10, y: 20 }
    const ctx: RefContext = { store: plainStoreReader(store) }
    const doc = interpret(pointSchema, ctx)
      .with(readable)
      .with(tagging)
      .done() as any

    // Base readable behavior preserved
    expect(doc.x()).toBe(10)
    expect(doc.y()).toBe(20)

    // Custom tag attached
    expect(doc.x[TAG]).toBe("x")
    expect(doc.y[TAG]).toBe("y")

    // Tag is non-enumerable
    expect(Object.keys(doc.x)).not.toContain(TAG)
  })
})

// ===========================================================================
// Error handling
// ===========================================================================

describe("fluent: error handling", () => {
  it(".done() with no layers throws", () => {
    const store = { x: 0 }
    const ctx: RefContext = { store: plainStoreReader(store) }
    const builder = interpret(pointSchema, ctx)
    expect(() => builder.done()).toThrow(/no layers added/i)
  })
})

// ===========================================================================
// Three-arg interpret backward compatibility (regression)
// ===========================================================================

describe("fluent: three-arg interpret regression", () => {
  it("interpret(schema, interpreter, ctx) still works", () => {
    const store = { x: 10, y: 20 }
    const ctx = plainContext(store)
    const interp = withWritable(
      withCaching(withReadable(withNavigation(bottomInterpreter))),
    )
    const doc = interpret(pointSchema, interp, ctx) as any

    expect(doc.x()).toBe(10)
    doc.x.set(42)
    expect(store.x).toBe(42)
  })

  it("interpret(schema, interpreter, ctx, path) still works", () => {
    const innerSchema = Schema.struct({
      a: Schema.number(),
    })
    const store = { nested: { a: 99 } }
    const ctx: RefContext = { store: plainStoreReader(store) }
    const interp = withCaching(withReadable(withNavigation(bottomInterpreter)))
    const doc = interpret(innerSchema, interp, ctx, new RawPath([
      rawKey("nested"),
    ])) as any

    expect(doc.a()).toBe(99)
  })
})

// ===========================================================================
// Type-level tests (only non-trivial ones)
// ===========================================================================

describe("fluent: type-level", () => {
  it("layer types constrain context flow", () => {
    // readable: RefContext → RefContext
    expectTypeOf(readable).toMatchTypeOf<
      InterpreterLayer<RefContext, RefContext>
    >()
    // writable: RefContext → WritableContext (widens)
    expectTypeOf(writable).toMatchTypeOf<
      InterpreterLayer<RefContext, WritableContext>
    >()
    // changefeed: WritableContext → WritableContext (requires writable first)
    expectTypeOf(changefeed).toMatchTypeOf<
      InterpreterLayer<WritableContext, WritableContext>
    >()
  })
})
