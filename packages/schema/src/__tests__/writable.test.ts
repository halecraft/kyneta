import { describe, expect, it } from "vitest"
import type {
  ChangeBase,
  Path,
  StateCell,
  SubstratePayload,
  SubstratePrepare,
  WritableContext,
} from "../index.js"
import {
  applyChange,
  applyChanges,
  batch,
  buildWritableContext,
  createRef,
  exportSince,
  hasTransact,
  invert,
  merge,
  plainReader,
  plainSubstrateFactory,
  RawPath,
  replaceChange,
  Schema,
  subscribe,
  TRANSACT,
} from "../index.js"
import { contextOver, refOver } from "./stack.js"

// ===========================================================================
// Composed stacks
// ===========================================================================

// ===========================================================================
// Base grammar tests — Schema only, no annotations
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixture: pure structural schema (no annotations)
// ---------------------------------------------------------------------------

const structuralDocSchema = Schema.struct({
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

function createStructuralDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx = contextOver(structuralDocSchema, store)
  const doc = refOver(structuralDocSchema, ctx)
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Product lazy getters
// ---------------------------------------------------------------------------

describe("writable: product lazy getters", () => {
  it("returns the same ref on repeated access (referential identity)", () => {
    const { doc } = createStructuralDoc()
    const a = doc.settings
    const b = doc.settings
    expect(a).toBe(b)
  })

  it("accessing one field does NOT force siblings", () => {
    const store = {
      settings: { darkMode: true, fontSize: 16 },
      metadata: { version: 1 },
    }
    const ctx = contextOver(structuralDocSchema, store)
    const doc = refOver(structuralDocSchema, ctx)

    // Access settings — metadata should not be forced
    const settings = doc.settings
    expect(settings.darkMode()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Namespace isolation
// ---------------------------------------------------------------------------

describe("writable: namespace isolation", () => {
  it("Object.keys returns only schema property names for products", () => {
    const { doc } = createStructuralDoc()
    const keys = Object.keys(doc)
    expect(keys).toEqual(["settings", "metadata"])
  })

  it("schema property names are accessible via 'in' operator", () => {
    const { doc } = createStructuralDoc()
    expect("settings" in doc).toBe(true)
    expect("metadata" in doc).toBe(true)
  })

  it("non-schema string keys are not own properties", () => {
    const { doc } = createStructuralDoc()
    expect(Object.hasOwn(doc, "toString")).toBe(false)
    expect(Object.hasOwn(doc, "constructor")).toBe(false)
    expect(Object.hasOwn(doc, "nonexistent")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Scalar dispatch (self-path ReplaceChange)
// ---------------------------------------------------------------------------

describe("writable: scalar dispatch", () => {
  it(".set() writes to the backing store at the correct path", () => {
    const { store, doc } = createStructuralDoc()
    doc.settings.darkMode.set(true)
    expect(store.settings.darkMode).toBe(true)
  })

  it("ref() reads live from the backing store", () => {
    const { store, doc } = createStructuralDoc()
    ;(store.settings as Record<string, unknown>).fontSize = 20
    expect(doc.settings.fontSize()).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// Product .set() — atomic subtree replacement
// ---------------------------------------------------------------------------

describe("writable: product .set()", () => {
  it(".set(plainObject) writes entire object to store", () => {
    const { store, doc } = createStructuralDoc()
    doc.settings.set({ darkMode: true, fontSize: 24 })
    expect(store.settings).toEqual({ darkMode: true, fontSize: 24 })
  })

  it(".set() is non-enumerable (doesn't appear in Object.keys)", () => {
    const { doc } = createStructuralDoc()
    const keys = Object.keys(doc.settings)
    expect(keys).toEqual(["darkMode", "fontSize"])
    expect(keys).not.toContain("set")
  })

  it("individual field refs still work after product .set()", () => {
    const { doc } = createStructuralDoc()
    doc.settings.set({ darkMode: true, fontSize: 24 })
    expect(doc.settings.darkMode()).toBe(true)
    expect(doc.settings.fontSize()).toBe(24)
    // Leaf .set() still works after product .set()
    doc.settings.darkMode.set(false)
    expect(doc.settings.darkMode()).toBe(false)
  })

  it(".set() inside batch() applies eagerly; delivers one batched Op[]", () => {
    const store = {
      settings: { darkMode: false, fontSize: 14 },
      metadata: { version: 1 },
    }
    const ctx = contextOver(structuralDocSchema, store)
    const doc = refOver(structuralDocSchema, ctx)

    const flushed = batch(doc, d => {
      d.settings.set({ darkMode: true, fontSize: 20 })
      // Eager-σ: read-your-writes inside the block
      expect(store.settings).toEqual({ darkMode: true, fontSize: 20 })
    })

    expect(store.settings).toEqual({ darkMode: true, fontSize: 20 })
    expect(flushed.length).toBe(1)
    expect(flushed[0].change.type).toBe("replace")
  })
})

// ---------------------------------------------------------------------------
// Portable refs
// ---------------------------------------------------------------------------

describe("writable: portable refs", () => {
  it("extracted scalar ref works outside the tree", () => {
    const { doc } = createStructuralDoc()
    const ref = doc.settings.fontSize
    // ref works independently
    ref.set(24)
    expect(ref()).toBe(24)
  })
})

// ---------------------------------------------------------------------------
// Map via Proxy
// ---------------------------------------------------------------------------

describe("writable: map ref", () => {
  it(".at(key) returns a callable child ref", () => {
    const { doc } = createStructuralDoc()
    const versionRef = doc.metadata.at("version")
    expect(versionRef?.()).toBe(1)
  })

  it(".keys() returns the store's dynamic keys", () => {
    const { doc } = createStructuralDoc()
    expect(doc.metadata.keys()).toEqual(["version"])
  })

  it(".has(key) checks store keys", () => {
    const { doc } = createStructuralDoc()
    expect(doc.metadata.has("version")).toBe(true)
    expect(doc.metadata.has("nonexistent")).toBe(false)
  })

  it(".set(key, value) dispatches change and updates store", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.set("newKey", "newValue")
    expect((store.metadata as Record<string, unknown>).newKey).toBe("newValue")
  })

  it(".delete(key) dispatches change and removes from store", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.delete("version")
    expect("version" in (store.metadata as Record<string, unknown>)).toBe(false)
  })

  it(".clear() removes all keys from the store", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.set("a", 1)
    doc.metadata.set("b", 2)
    doc.metadata.clear()
    expect(Object.keys(store.metadata as Record<string, unknown>)).toEqual([])
    expect(doc.metadata.size).toBe(0)
    expect(doc.metadata.keys()).toEqual([])
  })

  it("after .set(), .at() returns the new value", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    expect(doc.metadata.at("color")?.()).toBe("red")
  })

  it(".get() and .set() are symmetric: .set(k, v) then .get(k) returns v", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    expect(doc.metadata.get("color")).toBe("red")
  })

  it(".get(key) returns plain value after mutation (not a function)", () => {
    const { doc } = createStructuralDoc()
    doc.metadata.set("color", "red")
    const val = doc.metadata.get("color")
    expect(typeof val).not.toBe("function")
    expect(val).toBe("red")
  })

  it("after .delete(), .has() returns false", () => {
    const { doc } = createStructuralDoc()
    expect(doc.metadata.has("version")).toBe(true)
    doc.metadata.delete("version")
    expect(doc.metadata.has("version")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Batched mode
// ---------------------------------------------------------------------------

describe("writable: batch() blocks", () => {
  it("actions apply eagerly inside batch(); one batched Op[] returned", () => {
    const store = { x: 0, y: 0 }
    const schema = Schema.struct({
      x: Schema.number(),
      y: Schema.number(),
    })
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    const flushed = batch(doc, d => {
      d.x.set(10)
      d.y.set(20)
    })

    expect(store.x).toBe(10)
    expect(store.y).toBe(20)
    expect(flushed.length).toBe(2)
  })

  it("dispatch applies immediately outside any batch() block (auto-commit)", () => {
    const store = { x: 0 }
    const schema = Schema.struct({ x: Schema.number() })
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    doc.x.set(42)
    expect(store.x).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Discriminated sum dispatch
// ---------------------------------------------------------------------------

describe("writable: discriminated sum", () => {
  const schema = Schema.struct({
    item: Schema.discriminatedUnion("type", [
      Schema.struct({ type: Schema.string("text"), body: Schema.string() }),
      Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
    ]),
  })

  it("dispatches to the correct variant based on store discriminant", () => {
    const store = { item: { type: "image", url: "pic.png" } }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    // Should produce the "image" variant ref with a .url field
    expect((doc as any).item.url()).toBe("pic.png")
  })

  it("falls back to first variant when discriminant is missing", () => {
    const store = { item: {} }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    // First variant is "text" which has a .body field
    expect(typeof (doc as any).item.body).toBe("function")
  })

  it("falls back to first variant when store value is not an object", () => {
    const store = { item: 42 }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    expect(typeof (doc as any).item.body).toBe("function")
  })

  it(".set() switches variant and re-dispatches cached field", () => {
    const store = { item: { type: "text", body: "hello" } }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    expect((doc as any).item.type).toBe("text")
    expect((doc as any).item.body()).toBe("hello")

    ;(doc as any).item.set({ type: "image", url: "pic.png" })

    expect((doc as any).item.type).toBe("image")
    expect((doc as any).item.url()).toBe("pic.png")
  })
})

// ---------------------------------------------------------------------------
// Nullable (positional sum) dispatch
// ---------------------------------------------------------------------------

describe("writable: nullable (positional sum)", () => {
  const schema = Schema.struct({
    bio: Schema.string().nullable(),
  })

  it("null store value dispatches to the null variant", () => {
    const store = { bio: null }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    // The null variant is a scalar ref whose () returns null
    expect(doc.bio()).toBe(null)
  })

  it("non-null store value dispatches to the inner variant", () => {
    const store = { bio: "Hello world" }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    expect(doc.bio()).toBe("Hello world")
  })

  it("mutation on the inner ref works", () => {
    const store = { bio: "old" }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx)

    ;(doc.bio as any).set("new")
    expect(store.bio).toBe("new")
  })
})

// ===========================================================================
// Annotated tests — annotation-specific behavior
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixture: annotated document schema (with annotations)
// ---------------------------------------------------------------------------

const annotatedDocSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  messages: Schema.list(
    Schema.struct({
      author: Schema.string(),
      body: Schema.text(),
    }),
  ),
  settings: Schema.struct({
    darkMode: Schema.boolean(),
    fontSize: Schema.number(),
  }),
  metadata: Schema.record(Schema.any()),
})

function createAnnotatedDoc(storeOverrides: Record<string, unknown> = {}) {
  const store = {
    title: "Hello",
    count: 0,
    messages: [{ author: "Alice", body: "Hi" }],
    settings: { darkMode: false, fontSize: 14 },
    metadata: { version: 1 },
    ...storeOverrides,
  }
  const ctx = contextOver(annotatedDocSchema, store)
  const doc = refOver(annotatedDocSchema, ctx)
  return { store, ctx, doc }
}

// ---------------------------------------------------------------------------
// Text ref (annotation-specific)
// ---------------------------------------------------------------------------

describe("writable: text ref", () => {
  it("ref() returns the current string", () => {
    const { doc } = createAnnotatedDoc()
    expect(doc.title()).toBe("Hello")
  })

  it(".insert() applies a text action to the store", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.title.insert(5, " World")
    expect(store.title).toBe("Hello World")
  })

  it(".delete() removes characters from the store", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.title.delete(0, 2)
    expect(store.title).toBe("llo")
  })

  it(".update() replaces the entire string", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.title.update("New Title")
    expect(store.title).toBe("New Title")
  })
})

// ---------------------------------------------------------------------------
// Counter ref (annotation-specific)
// ---------------------------------------------------------------------------

describe("writable: counter ref", () => {
  it("ref() returns the current value", () => {
    const { doc } = createAnnotatedDoc()
    expect(doc.count()).toBe(0)
  })

  it(".increment() adds to the value", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.count.increment(5)
    expect(store.count).toBe(5)
  })

  it(".decrement() subtracts from the value", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.count.decrement(3)
    expect(store.count).toBe(-3)
  })

  it(".increment() with no arg defaults to 1", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.count.increment()
    expect(store.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Sequence ref (using annotated fixture for list-of-structs)
// ---------------------------------------------------------------------------

describe("writable: sequence ref", () => {
  it(".length reflects the store array length", () => {
    const { doc } = createAnnotatedDoc()
    expect(doc.messages.length).toBe(1)
  })

  it(".at(i) returns a child ref for the item at index i", () => {
    const { doc } = createAnnotatedDoc()
    const msg = doc.messages.at(0) as any
    expect(msg.author()).toBe("Alice")
  })

  it(".push() appends items and updates the store", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    expect((store.messages as unknown[]).length).toBe(2)
  })

  it(".delete() removes items from the store", () => {
    const { store, doc } = createAnnotatedDoc()
    doc.messages.delete(0)
    expect((store.messages as unknown[]).length).toBe(0)
  })

  it(".get(i) returns the plain value directly after .push()", () => {
    const { doc } = createAnnotatedDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const val = doc.messages.get(1)
    expect(typeof val).not.toBe("function")
    expect(val).toEqual({ author: "Bob", body: "Hey" })
  })
})

// ---------------------------------------------------------------------------
// Annotation-driven behavior — API shape depends on annotation tag
// ---------------------------------------------------------------------------

describe("writable: annotation-driven behavior", () => {
  it("annotated text writable has .insert() and .delete()", () => {
    const { doc } = createAnnotatedDoc()
    expect(typeof doc.title.insert).toBe("function")
    expect(typeof doc.title.delete).toBe("function")
    expect(typeof doc.title.update).toBe("function")
    // Callable — no .get()
    expect(typeof doc.title).toBe("function")
  })

  it("Schema.string() writable has .set() and is callable", () => {
    const { doc } = createAnnotatedDoc()
    const msg = doc.messages.at(0) as any
    expect(typeof msg.author).toBe("function")
    expect(typeof msg.author.set).toBe("function")
    // Should NOT have text-specific methods
    expect(
      (msg.author as unknown as Record<string, unknown>).insert,
    ).toBeUndefined()
  })

  it("annotated counter writable has .increment() and .decrement()", () => {
    const { doc } = createAnnotatedDoc()
    expect(typeof doc.count.increment).toBe("function")
    expect(typeof doc.count.decrement).toBe("function")
    // Callable — no .get()
    expect(typeof doc.count).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Portable refs (annotation-specific: TextRef works outside the tree)
// ---------------------------------------------------------------------------

describe("writable: portable refs (annotated)", () => {
  it("extracted text ref works outside the tree", () => {
    const { doc } = createAnnotatedDoc()
    const ref = doc.title
    ref.insert(ref().length, " World")
    expect(ref()).toBe("Hello World")
  })
})

// ---------------------------------------------------------------------------
// Mutation + read integration
// ---------------------------------------------------------------------------

// ===========================================================================
// Invalidate-before-dispatch (the core timing fix)
// ===========================================================================

describe("writable: invalidate-before-dispatch", () => {
  const listSchema = Schema.struct({
    items: Schema.list(Schema.struct({ name: Schema.string() })),
  })

  function createCachedListDoc(items: Array<{ name: string }>) {
    const store = { items }
    const ctx = contextOver(listSchema, store)
    const doc = refOver(listSchema, ctx)
    return { doc, store, ctx }
  }

  it("after push(), .at(newIndex) returns correct child immediately", () => {
    const { doc } = createCachedListDoc([{ name: "a" }])
    // Populate cache
    expect(doc.items.at(0)?.name()).toBe("a")
    // Push a new item
    doc.items.push({ name: "b" })
    // New index should be immediately accessible
    expect(doc.items.at(1)?.name()).toBe("b")
    // Existing ref is preserved
    expect(doc.items.at(0)?.name()).toBe("a")
  })

  it("after insert(1, item) on 3-item list, shifted indices read correct values", () => {
    const { doc } = createCachedListDoc([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ])
    // Populate cache for all items
    const refA = doc.items.at(0)
    const _refB = doc.items.at(1)
    const _refC = doc.items.at(2)

    // Insert at index 1
    doc.items.insert(1, { name: "x" })

    // index 0: unchanged (below insert point)
    expect(doc.items.at(0)).toBe(refA)
    expect(doc.items.at(0)?.name()).toBe("a")
    // All indices at or above the insert point read correct values
    expect(doc.items.at(1)?.name()).toBe("x")
    expect(doc.items.at(2)?.name()).toBe("b")
    expect(doc.items.at(3)?.name()).toBe("c")
  })

  it("after delete(0, 1), evicted refs read correct values", () => {
    const { doc } = createCachedListDoc([
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ])
    // Populate cache
    const _refA = doc.items.at(0)
    const _refB = doc.items.at(1)
    const _refC = doc.items.at(2)

    // Delete first item
    doc.items.delete(0, 1)

    // All indices are evicted and re-created with correct paths
    expect(doc.items.at(0)?.name()).toBe("b")
    expect(doc.items.at(1)?.name()).toBe("c")

    // Store is correctly updated
    expect(doc.items.length).toBe(2)
    expect(doc.items()).toEqual([{ name: "b" }, { name: "c" }])
  })
})

// ===========================================================================
// Mutation + read integration
// ===========================================================================

describe("writable: mutation + read integration", () => {
  it("ref() reflects value after .set()", () => {
    const { doc } = createStructuralDoc()
    doc.settings.darkMode.set(true)
    expect(doc.settings.darkMode()).toBe(true)
  })

  it("ref() reflects value after .insert()", () => {
    const { doc } = createAnnotatedDoc()
    doc.title.insert(5, " World")
    expect(doc.title()).toBe("Hello World")
  })

  it("ref() reflects value after .increment()", () => {
    const { doc } = createAnnotatedDoc()
    doc.count.increment(10)
    expect(doc.count()).toBe(10)
  })

  it("sequence ref() reflects new items after .push()", () => {
    const { doc } = createAnnotatedDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const arr = doc.messages()
    expect(Array.isArray(arr)).toBe(true)
    expect((arr as unknown[]).length).toBe(2)
  })

  it("sequence cache invalidation: after .push(), .at(newIndex) returns correct child", () => {
    const { doc } = createAnnotatedDoc()
    doc.messages.push({ author: "Bob", body: "Hey" })
    const msg = doc.messages.at(1) as any
    expect(msg.author()).toBe("Bob")
  })

  it("product ref() returns the updated snapshot after .set()", () => {
    const { doc, store } = createStructuralDoc()
    // Mutate via the writable API
    doc.settings.set({ darkMode: true, fontSize: 20 })

    // ref() returns the updated snapshot
    const snap = doc.settings()
    expect(snap).toEqual({ darkMode: true, fontSize: 20 })

    // The snapshot is frozen, and stays the read until the next write
    expect(() => {
      // @ts-expect-error — a read is readonly, and frozen at runtime too
      snap.darkMode = false
    }).toThrow(TypeError)
    expect((store.settings as any).darkMode).toBe(true)
    expect(doc.settings()).toBe(snap)
  })

  it("map mutation: .set(key, value) dispatches change", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.set("newKey", "newValue")
    expect((store.metadata as Record<string, unknown>).newKey).toBe("newValue")
  })

  it("map mutation: .delete(key) dispatches change", () => {
    const { store, doc } = createStructuralDoc()
    doc.metadata.delete("version")
    expect("version" in (store.metadata as Record<string, unknown>)).toBe(false)
  })
})

// ===========================================================================
// TRANSACT attachment — every ref carries [TRANSACT]
// ===========================================================================

describe("writable: TRANSACT attachment", () => {
  it("scalar ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createStructuralDoc()
    expect(doc.settings.darkMode[TRANSACT]).toBe(ctx)
  })

  it("product ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createStructuralDoc()
    expect(doc.settings[TRANSACT]).toBe(ctx)
  })

  it("sequence ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createAnnotatedDoc()
    expect(doc.messages[TRANSACT]).toBe(ctx)
  })

  it("map ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createStructuralDoc()
    expect(doc.metadata[TRANSACT]).toBe(ctx)
  })
  it("text annotated ref has [TRANSACT] pointing to ctx", () => {
    const { ctx, doc } = createAnnotatedDoc()
    expect(doc.title[TRANSACT]).toBe(ctx)
  })
})

// ===========================================================================
// Compensation loop
// ===========================================================================

describe("writable: compensation loop", () => {
  const schema = Schema.struct({ count: Schema.counter() })

  /**
   * A substrate whose first write succeeds and whose second throws `failure`.
   * A compensation throws `compensationFailure`, when given. `prepared`
   * lists each call's change and whether it carried a recorder.
   */
  function failingDoc(failure: unknown, compensationFailure?: unknown) {
    const prepared: { type: string; amount: unknown; forward: boolean }[] = []
    let writes = 0
    const substrate: SubstratePrepare = {
      reader: plainReader({ current: { count: 0 } }),
      prepare: (_path, change, recordInverse) => {
        prepared.push({
          type: change.type,
          amount: (change as { amount?: unknown }).amount,
          forward: recordInverse !== null,
        })
        if (recordInverse === null) {
          if (compensationFailure !== undefined) throw compensationFailure
          return
        }
        recordInverse({ type: "increment", amount: -1 } as ChangeBase)
        writes++
        if (writes === 2) throw failure
      },
      afterBatch: () => {},
    }
    const ctx = buildWritableContext(substrate, schema)
    const doc = refOver(schema, ctx) as any
    return { doc, prepared }
  }

  const twoWrites = (d: any) => {
    d.count.increment(1)
    d.count.increment(1)
  }

  it("compensates only the writes the substrate applied, not the one that threw", () => {
    const failure = new Error("Substrate prepare failed")
    const { doc, prepared } = failingDoc(failure)
    expect(() => batch(doc, twoWrites)).toThrow(failure)
    expect(prepared).toEqual([
      { type: "increment", amount: 1, forward: true },
      { type: "increment", amount: 1, forward: true },
      { type: "increment", amount: -1, forward: false },
    ])
  })

  it("surfaces the original error via Error.cause when compensation fails", () => {
    const failure = new Error("Substrate prepare failed")
    const compensationFailure = new Error("Substrate compensation failed")
    const { doc } = failingDoc(failure, compensationFailure)
    try {
      batch(doc, twoWrites)
      expect.fail("Should have thrown")
    } catch (e: any) {
      expect(e).toBe(compensationFailure)
      expect(e.cause).toBe(failure)
    }
  })

  it("surfaces the original error via Error.cause when compensation throws a string (WASM)", () => {
    const failure = new Error("Substrate prepare failed")
    const { doc } = failingDoc(failure, "Index out of bound")
    try {
      batch(doc, twoWrites)
      expect.fail("Should have thrown")
    } catch (e: any) {
      expect(e).toBeInstanceOf(Error)
      expect(e.message).toBe("Index out of bound")
      expect(e.cause).toBe(failure)
    }
  })

  it("refuses a substrate that records no inverse for a write", () => {
    const substrate: SubstratePrepare = {
      reader: plainReader({ current: { count: 0 } }),
      prepare: () => {},
      afterBatch: () => {},
    }
    const ctx = buildWritableContext(substrate, schema)
    const doc = refOver(schema, ctx) as any
    expect(() => doc.count.increment(1)).toThrow("exactly one inverse")
  })
})

describe("writable: announcements never reach the substrate", () => {
  it("an announced batch is delivered without calling prepare or afterBatch", () => {
    const schema = Schema.struct({ title: Schema.string() })
    const store = { title: "" }
    const calls = { prepare: 0, afterBatch: 0 }
    const stub = {
      reader: plainReader({ current: store }),
      prepare: () => {
        calls.prepare++
      },
      afterBatch: () => {
        calls.afterBatch++
      },
    }
    const ctx = buildWritableContext(stub, schema)
    const doc = refOver(schema, ctx) as any
    const replays: unknown[] = []
    subscribe(doc, cs => replays.push({ replay: cs.replay, origin: cs.origin }))

    // The substrate brings σ up to date itself before announcing.
    store.title = "merged"
    ctx.announce(
      [{ path: RawPath.empty.field("title"), change: replaceChange("merged") }],
      { origin: "sync", local: false },
    )

    expect(calls).toEqual({ prepare: 0, afterBatch: 0 })
    expect(replays).toEqual([{ replay: true, origin: "sync" }])
    expect(doc.title()).toBe("merged")
  })
})

// ===========================================================================
// The batch lifecycle: capture, seal, release
// ===========================================================================

/**
 * A two-field doc over a stub substrate that writes straight into `store`.
 * `onCommit` runs inside the native bracket, after `work`, standing in for
 * whatever a native commit sets off.
 */
function buildLifecycleDoc(options?: {
  onCommit?: (ctx: WritableContext) => void
  failCompensation?: boolean
}) {
  const schema = Schema.struct({ a: Schema.string(), b: Schema.string() })
  const store: StateCell = { current: { a: "", b: "" } }
  const afterBatch = { calls: 0 }
  let ctx: WritableContext | undefined
  const stub: SubstratePrepare = {
    reader: plainReader(store),
    prepare: (path, change, recordInverse) => {
      if (recordInverse === null && options?.failCompensation) {
        throw new Error("compensation failed")
      }
      if (recordInverse) {
        recordInverse(invert(path.read(store.current), change))
      }
      applyChange(store, path, change)
    },
    afterBatch: () => {
      afterBatch.calls++
    },
    runBatch: work => {
      work()
      if (ctx && options?.onCommit) options.onCommit(ctx)
    },
  }
  ctx = buildWritableContext(stub, schema)
  const doc = refOver(schema, ctx) as any
  const seen: {
    replay: boolean | undefined
    aborted?: boolean
    paths: string[]
  }[] = []
  subscribe(doc, cs => {
    seen.push({
      replay: cs.replay,
      ...(cs.aborted ? { aborted: true } : {}),
      paths: cs.changes.map(op => op.path.format()),
    })
  })
  return { ctx, doc, seen, afterBatch }
}

describe("writable: the batch lifecycle", () => {
  it("an announcement made during the native commit is delivered after the batch", () => {
    const { doc, seen } = buildLifecycleDoc({
      onCommit: ctx =>
        ctx.announce(
          [{ path: RawPath.empty.field("b"), change: replaceChange("peer") }],
          { local: false },
        ),
    })
    batch(doc, (d: any) => d.a.set("local"))
    expect(seen).toEqual([
      { replay: false, paths: ["a"] },
      { replay: true, paths: ["b"] },
    ])
  })

  it("a merge inside a batch() body is its own changeset, delivered first", () => {
    const S = Schema.struct({ a: Schema.string(), b: Schema.string() })
    const peer = plainSubstrateFactory.create(S)
    const peerDoc = createRef(S, peer)
    batch(peerDoc, d => d.a.set("seed"))
    // The local document starts where the peer is, so what arrives in the
    // batch body below is a delta, not the whole document.
    const local = plainSubstrateFactory.fromEntirety(peer.exportEntirety(), S)
    const v0 = peer.version()
    batch(peerDoc, d => d.b.set("remote"))
    const delta = exportSince(peerDoc, v0) as SubstratePayload

    const doc = createRef(S, local)
    const seen: { replay: boolean | undefined; paths: string[] }[] = []
    subscribe(doc, cs =>
      seen.push({
        replay: cs.replay,
        paths: cs.changes.map(op => op.path.format()),
      }),
    )
    const ops = batch(doc, d => {
      d.a.set("local")
      merge(doc, delta)
    })

    expect(seen).toEqual([
      { replay: true, paths: ["b"] },
      { replay: false, paths: ["a"] },
    ])
    expect(ops.map(op => op.path.format())).toEqual(["a"])
  })

  it("nested batch() calls return their own ops; the outer returns both", () => {
    const { doc } = buildLifecycleDoc()
    let inner: readonly { path: Path }[] = []
    const outer = batch(doc, (d: any) => {
      d.a.set("1")
      inner = batch(doc, (d2: any) => d2.b.set("2"))
    })
    expect(inner.map(op => op.path.format())).toEqual(["b"])
    expect(outer.map(op => op.path.format())).toEqual(["a", "b"])
  })

  it("an aborted batch delivers its forward and inverse ops, and does not leak", () => {
    const { doc, seen } = buildLifecycleDoc()
    expect(() =>
      batch(doc, (d: any) => {
        d.a.set("x")
        throw new Error("abort")
      }),
    ).toThrow("abort")
    const next = batch(doc, (d: any) => d.b.set("y"))

    expect(seen).toEqual([
      { replay: false, aborted: true, paths: ["a", "a"] },
      { replay: false, paths: ["b"] },
    ])
    expect(next.map(op => op.path.format())).toEqual(["b"])
  })

  it("a failed compensation delivers nothing, and does not leak", () => {
    const { doc, seen } = buildLifecycleDoc({ failCompensation: true })
    expect(() =>
      batch(doc, (d: any) => {
        d.a.set("x")
        throw new Error("abort")
      }),
    ).toThrow("compensation failed")
    const next = batch(doc, (d: any) => d.b.set("y"))

    expect(seen).toEqual([{ replay: false, paths: ["b"] }])
    expect(next.map(op => op.path.format())).toEqual(["b"])
  })

  it("an empty batch still ends the substrate's batch once and delivers nothing", () => {
    const { doc, seen, afterBatch } = buildLifecycleDoc()
    batch(doc, () => {})
    expect(afterBatch.calls).toBe(1)
    expect(seen).toEqual([])
  })

  it("ctx.prepare outside runBatch or announce throws", () => {
    const { ctx } = buildLifecycleDoc()
    expect(() =>
      ctx.prepare(RawPath.empty.field("a"), replaceChange("x"), {
        ingress: "author",
      }),
    ).toThrow("outside runBatch or announce")
  })
})

it("counter annotated ref has [TRANSACT] pointing to ctx", () => {
  const { ctx, doc } = createAnnotatedDoc()
  expect(doc.count[TRANSACT]).toBe(ctx)
})

it("doc (delegating annotation) ref has [TRANSACT] pointing to ctx", () => {
  const { ctx, doc } = createAnnotatedDoc()
  expect(doc[TRANSACT]).toBe(ctx)
})

it("[TRANSACT] does not appear in Object.keys()", () => {
  const { doc } = createStructuralDoc()
  expect(Object.keys(doc.settings)).not.toContain(TRANSACT)
  expect(Object.keys(doc.settings)).not.toContain(String(TRANSACT))
})

it("hasTransact() returns true for refs with [TRANSACT]", () => {
  const { doc } = createStructuralDoc()
  expect(hasTransact(doc)).toBe(true)
  expect(hasTransact(doc.settings)).toBe(true)
  expect(hasTransact(doc.settings.darkMode)).toBe(true)
  expect(hasTransact(doc.metadata)).toBe(true)
})

it("[TRANSACT] works on Proxy-backed map refs", () => {
  const { ctx, doc } = createStructuralDoc()
  // Map refs use Proxy — Object.defineProperty must bypass set trap
  expect(doc.metadata[TRANSACT]).toBe(ctx)
  // Verify the map still works normally after TRANSACT attachment
  doc.metadata.set("newKey", "newValue")
  expect(doc.metadata.at("newKey")?.()).toBe("newValue")
})

// ===========================================================================
// Completion: an authored change is completed before anything sees it
// ===========================================================================

describe("writable: an authored change is completed first", () => {
  const Point = Schema.struct({ x: Schema.number(), y: Schema.number() })
  const schema = Schema.struct({ rows: Schema.record(Point) })

  function setup() {
    const store: Record<string, unknown> = { rows: {} }
    const ctx = contextOver(schema, store)
    const doc = refOver(schema, ctx) as any
    const before: ChangeBase[] = []
    subscribe(doc, cs => before.push(...cs.changes.map(op => op.change)))
    return { store, doc, before }
  }

  it("a subscriber hears an authored partial value completed", () => {
    const { store, doc, before } = setup()
    doc.rows.set("a", { x: 1, extra: true })
    expect(before).toEqual([
      { type: "map", set: { a: { x: 1, y: 0 } }, delete: undefined },
    ])
    expect(store).toEqual({ rows: { a: { x: 1, y: 0 } } })
  })

  it("applyChanges completes a partial value", () => {
    const { store, doc, before } = setup()
    applyChanges(doc, [
      {
        path: RawPath.empty.field("rows"),
        change: { type: "map", set: { b: { y: 2 } } } as ChangeBase,
      },
    ])
    expect(before).toEqual([{ type: "map", set: { b: { x: 0, y: 2 } } }])
    expect(store).toEqual({ rows: { b: { x: 0, y: 2 } } })
  })
})
