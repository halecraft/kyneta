import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  ADDRESS_TABLE,
  applyChanges,
  change,
  interpret,
  observation,
  plainContext,
  RawPath,
  readable,
  replaceChange,
  resolveToAddressed,
  Schema,
  withCaching,
  withNavigation,
  withReadable,
  writable,
} from "../index.js"
import type { RefContext } from "../interpreter-types.js"
import { bottomInterpreter } from "../interpreters/bottom.js"
import { AddressedPath, AddressTableRegistry } from "../path.js"
import { plainReader } from "../reader.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const todoSchema = Schema.doc({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const mapSchema = Schema.doc({
  metadata: Schema.record(Schema.string()),
})

function createTodoDoc(initialTodos: Array<{ text: string; done: boolean }>) {
  const store = { todos: initialTodos }
  const ctx = plainContext(store)
  const doc = interpret(todoSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store, ctx }
}

function createMapDoc(initialMetadata: Record<string, string>) {
  const store = { metadata: initialMetadata }
  const ctx = plainContext(store)
  const doc = interpret(mapSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store, ctx }
}

// ===========================================================================
// Sequence addressing — identity and advancement
// ===========================================================================

describe("withAddressing: sequences", () => {
  it("ref at shifted index still reads correct value after insert", () => {
    const { doc, store } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    // Capture ref to item at index 1 ("beta")
    const betaRef = doc.todos.at(1)
    expect(betaRef.text()).toBe("beta")

    // Insert at index 0 — "beta" shifts from index 1 to index 2
    change(doc, (d: any) => {
      d.todos.insert(0, [{ text: "new", done: false }])
    })

    // The captured ref should still read "beta" at the new index
    expect(betaRef.text()).toBe("beta")
    expect(store.todos[2]).toEqual({ text: "beta", done: false })
  })

  it("reference identity preserved after insert — list.at(newIndex) === capturedRef", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    const refA = doc.todos.at(0)
    const refB = doc.todos.at(1)

    // Insert at index 0 — "alpha" moves to 1, "beta" moves to 2
    change(doc, (d: any) => {
      d.todos.insert(0, [{ text: "new", done: false }])
    })

    // Same JS object at the new index
    expect(doc.todos.at(1)).toBe(refA)
    expect(doc.todos.at(2)).toBe(refB)
    // Reads are correct
    expect(refA.text()).toBe("alpha")
    expect(refB.text()).toBe("beta")
  })

  it("reference identity preserved after delete — list.at(newIndex) === capturedRef", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
      { text: "gamma", done: false },
    ])

    const refB = doc.todos.at(1)
    const refC = doc.todos.at(2)

    // Delete index 0 — "beta" moves to 0, "gamma" moves to 1
    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    expect(doc.todos.at(0)).toBe(refB)
    expect(doc.todos.at(1)).toBe(refC)
  })

  it("iterator yields identity-stable refs via address table", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    // Access via .at() to populate address table
    const refA = doc.todos.at(0)
    const refB = doc.todos.at(1)

    // Iterator should yield the same refs
    const iterated = [...doc.todos]
    expect(iterated[0]).toBe(refA)
    expect(iterated[1]).toBe(refB)
  })

  it("captured refs read correct values after structural changes (address advancement)", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
      { text: "c", done: false },
    ])

    // Access all items to populate the address table
    const a = doc.todos.at(0)
    const b = doc.todos.at(1)
    const c = doc.todos.at(2)

    // Delete index 0 ("a")
    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    // After delete: "a" is dead, "b" and "c" read correct values
    // via their advanced addresses
    expect(a.deleted).toBe(true)
    expect(b.deleted).toBe(false)
    expect(b.text()).toBe("b")
    expect(c.deleted).toBe(false)
    expect(c.text()).toBe("c")

    // Fresh lookups at the new indices also read correctly
    expect(doc.todos.at(0).text()).toBe("b")
    expect(doc.todos.at(1).text()).toBe("c")

    // NOTE: Identity preservation (doc.todos.at(0) === b) requires
    // Phase 5, where withCaching delegates to the address table.
  })
})

// ===========================================================================
// Map addressing — tombstoning and resurrection
// ===========================================================================

describe("withAddressing: maps", () => {
  it("ref for deleted entry has dead address", () => {
    const { doc } = createMapDoc({ version: "1.0", author: "alice" })

    const versionRef = doc.metadata.at("version")
    expect(versionRef()).toBe("1.0")

    // Delete the "version" key
    change(doc, (d: any) => {
      d.metadata.delete("version")
    })

    expect(versionRef.deleted).toBe(true)
    expect(() => versionRef()).toThrow("Ref access on deleted map entry")
  })

  it("deleted key address is resurrected on re-set", () => {
    const { doc } = createMapDoc({ version: "1.0" })

    const versionRef = doc.metadata.at("version")
    expect(versionRef()).toBe("1.0")

    // Delete
    change(doc, (d: any) => {
      d.metadata.delete("version")
    })
    expect(versionRef.deleted).toBe(true)

    // Re-set the same key
    change(doc, (d: any) => {
      d.metadata.set("version", "2.0")
    })

    // Address should be resurrected
    expect(versionRef.deleted).toBe(false)
    expect(versionRef()).toBe("2.0")
  })
})

// ===========================================================================
// Product addressing
// ===========================================================================

// ===========================================================================
// Stack composition and rootPath propagation
// ===========================================================================

describe("withAddressing: composition", () => {
  it("stacks without withAddressing use RawPath (fallback works)", () => {
    const store = { x: 42 }
    const schema = Schema.doc({ x: Schema.number() })
    // Build a stack WITHOUT withAddressing
    const interp = withCaching(withReadable(withNavigation(bottomInterpreter)))
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, interp, ctx) as any

    expect(doc.x()).toBe(42)
    // The context should NOT have rootPath set (or it's undefined/RawPath)
    expect(ctx.rootPath).toBeUndefined()
  })

  it("readable layer includes withAddressing — paths are addressed", () => {
    const store = { todos: [{ text: "test", done: false }] }
    const ctx = plainContext(store)
    const _doc = interpret(todoSchema, ctx)
      .with(readable)
      .with(writable)
      .done() as any

    // ctx.rootPath should be set by withAddressing
    expect(ctx.rootPath).toBeDefined()
    expect(ctx.rootPath?.isAddressed).toBe(true)
    expect(ctx.rootPath).toBeInstanceOf(AddressedPath)
  })

  it("ctx.rootPath determines path type for entire tree", () => {
    const store = { todos: [{ text: "test", done: false }] }
    const ctx = plainContext(store)
    const doc = interpret(todoSchema, ctx)
      .with(readable)
      .with(writable)
      .done() as any

    // Access a deeply nested ref and verify it has `deleted` property
    // (which is only attached by the onRefCreated hook from withAddressing)
    const item = doc.todos.at(0)
    expect("deleted" in item).toBe(true)
    expect(item.deleted).toBe(false)

    // The text leaf under the item should also have `deleted`
    const textRef = item.text
    expect("deleted" in textRef).toBe(true)
    expect(textRef.deleted).toBe(false)
  })
})

// ===========================================================================
// onRefCreated hook — deleted getter and ref registration
// ===========================================================================

describe("withAddressing: onRefCreated", () => {
  it("attaches deleted getter on all ref types (product, sequence item)", () => {
    const { doc } = createTodoDoc([{ text: "test", done: false }])

    // Product field ref — never dead
    expect(doc.todos.deleted).toBe(false)

    // Sequence item ref — starts alive, becomes dead on delete
    const item = doc.todos.at(0)
    expect(item.deleted).toBe(false)

    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })
    expect(item.deleted).toBe(true)
  })
})

// ===========================================================================
// ADDRESS_TABLE symbol — discovery by downstream layers
// ===========================================================================

describe("withAddressing: [ADDRESS_TABLE]", () => {
  it("sequence refs have ADDRESS_TABLE symbol when withAddressing is in the stack", () => {
    const { doc } = createTodoDoc([{ text: "test", done: false }])

    // Access an item so the table gets populated
    doc.todos.at(0)

    expect(ADDRESS_TABLE in doc.todos).toBe(true)
    const table = (doc.todos as any)[ADDRESS_TABLE]
    expect(table).toBeDefined()
    expect(table.byIndex).toBeInstanceOf(Map)
    expect(table.byId).toBeInstanceOf(Map)
  })

  it("map refs have ADDRESS_TABLE symbol when withAddressing is in the stack", () => {
    const { doc } = createMapDoc({ version: "1.0" })

    // Access an entry so the table gets populated
    doc.metadata.at("version")

    expect(ADDRESS_TABLE in doc.metadata).toBe(true)
    const table = (doc.metadata as any)[ADDRESS_TABLE]
    expect(table).toBeDefined()
    expect(table.byKey).toBeInstanceOf(Map)
  })

  it("sequence refs without withAddressing do NOT have ADDRESS_TABLE", () => {
    const store = { items: ["a", "b"] }
    const schema = Schema.doc({ items: Schema.list(Schema.string()) })
    const interp = withCaching(withReadable(withNavigation(bottomInterpreter)))
    const ctx: RefContext = { reader: plainReader(store) }
    const doc = interpret(schema, interp, ctx) as any

    expect(ADDRESS_TABLE in doc.items).toBe(false)
  })
})

// ===========================================================================
// ReplaceChange handling
// ===========================================================================

describe("withAddressing: ReplaceChange", () => {
  it("replaceChange on a sequence marks all addresses dead", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    const alpha = doc.todos.at(0)
    const beta = doc.todos.at(1)

    expect(alpha.deleted).toBe(false)
    expect(beta.deleted).toBe(false)

    // Replace the entire list via applyChanges with a replaceChange op
    applyChanges(doc, [
      {
        path: RawPath.empty.field("todos"),
        change: replaceChange([{ text: "gamma", done: true }]),
      },
    ])

    expect(alpha.deleted).toBe(true)
    expect(beta.deleted).toBe(true)
  })
})

// ===========================================================================
// Phase 3 — Dead Address Detection (end-to-end verification)
// ===========================================================================

describe("withAddressing: dead ref detection", () => {
  it("reading through a child ref of a deleted sequence item throws", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    const beta = doc.todos.at(1)
    expect(beta.done()).toBe(false)

    // Delete beta (index 1)
    change(doc, (d: any) => {
      d.todos.delete(1, 1)
    })

    // Reading through the child ref should throw
    expect(() => beta.done()).toThrow("Ref access on deleted list item")
    expect(() => beta.text()).toThrow("Ref access on deleted list item")
  })

  it("writing through a child ref of a deleted sequence item throws", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    const beta = doc.todos.at(1)

    // Delete beta
    change(doc, (d: any) => {
      d.todos.delete(1, 1)
    })

    // Writing through the child ref should throw
    expect(() => {
      change(doc, () => {
        beta.done.set(true)
      })
    }).toThrow("Ref access on deleted list item")
  })

  it("reading through a deleted map entry ref throws", () => {
    const { doc } = createMapDoc({ version: "1.0", author: "alice" })

    const versionRef = doc.metadata.at("version")
    expect(versionRef()).toBe("1.0")

    change(doc, (d: any) => {
      d.metadata.delete("version")
    })

    expect(() => versionRef()).toThrow("Ref access on deleted map entry")
  })

  it("writing through a deleted map entry ref throws", () => {
    const { doc } = createMapDoc({ version: "1.0" })

    const versionRef = doc.metadata.at("version")

    change(doc, (d: any) => {
      d.metadata.delete("version")
    })

    expect(() => {
      change(doc, () => {
        versionRef.set("2.0")
      })
    }).toThrow("Ref access on deleted map entry")
  })

  it("end-to-end sequence: delete item → read throws, write throws, deleted is true", () => {
    const { doc } = createTodoDoc([{ text: "only", done: false }])

    const item = doc.todos.at(0)
    expect(item.deleted).toBe(false)
    expect(item.text()).toBe("only")

    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    expect(item.deleted).toBe(true)
    expect(() => item.text()).toThrow("Ref access on deleted list item")
    expect(() => {
      change(doc, () => {
        item.done.set(true)
      })
    }).toThrow("Ref access on deleted list item")
  })

  it("end-to-end map: delete key → read throws, write throws, deleted is true", () => {
    const { doc } = createMapDoc({ version: "1.0" })

    const ref = doc.metadata.at("version")
    expect(ref.deleted).toBe(false)
    expect(ref()).toBe("1.0")

    change(doc, (d: any) => {
      d.metadata.delete("version")
    })

    expect(ref.deleted).toBe(true)
    expect(() => ref()).toThrow("Ref access on deleted map entry")
    expect(() => {
      change(doc, () => {
        ref.set("2.0")
      })
    }).toThrow("Ref access on deleted map entry")
  })

  it("ref.deleted can be used as a guard in event handlers", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    const beta = doc.todos.at(1)

    // Simulate an event handler pattern
    const handler = () => {
      if (beta.deleted) return "guarded"
      return beta.text()
    }

    expect(handler()).toBe("beta")

    change(doc, (d: any) => {
      d.todos.delete(1, 1)
    })

    expect(handler()).toBe("guarded")
  })
})

// ===========================================================================
// Phase 4 — Addressed Changefeed Routing
// ===========================================================================

describe("resolveToAddressed", () => {
  it("is idempotent — already-addressed path passes through unchanged", () => {
    const registry = new AddressTableRegistry()
    const addressed = new AddressedPath([], registry).field("a").item(0)
    const resolved = resolveToAddressed(addressed, registry)
    expect(resolved).toBe(addressed)
  })

  it("converts a RawPath to an AddressedPath with matching key", () => {
    const registry = new AddressTableRegistry()
    const raw = RawPath.empty.field("todos").item(0).field("done")

    // First, create the addresses via the registry (simulating .at(0) access)
    const addrRoot = new AddressedPath([], registry)
    const expected = addrRoot.field("todos").item(0).field("done")

    const resolved = resolveToAddressed(raw, registry)
    expect(resolved.isAddressed).toBe(true)
    expect(resolved.key).toBe(expected.key)
  })
})

describe("withAddressing: external mutation routing", () => {
  it("applyChanges with RawPath fires leaf-level subscriber", () => {
    const { doc } = createTodoDoc([{ text: "alpha", done: false }])

    const item = doc.todos.at(0)
    const textChanges: any[] = []
    item.text[CHANGEFEED].subscribe((cs: any) => textChanges.push(cs))

    // External mutation targeting the text leaf
    applyChanges(doc, [
      {
        path: RawPath.empty.field("todos").item(0).field("text"),
        change: replaceChange("remote-update"),
      },
    ])

    expect(textChanges).toHaveLength(1)
    expect(item.text()).toBe("remote-update")
  })
})

describe("withAddressing: subscription survival after structural change", () => {
  it("leaf subscription survives deletion of a preceding item", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
      { text: "gamma", done: false },
    ])

    // Subscribe to gamma's text (index 2)
    const gamma = doc.todos.at(2)
    const textChanges: any[] = []
    gamma.text[CHANGEFEED].subscribe((cs: any) => textChanges.push(cs))

    // Delete alpha (index 0) — gamma shifts from index 2 to index 1
    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    // gamma is still alive and reads correctly
    expect(gamma.deleted).toBe(false)
    expect(gamma.text()).toBe("gamma")

    // Mutate gamma at its new position — subscription should fire
    change(doc, () => {
      gamma.text.set("gamma-updated")
    })

    expect(textChanges.length).toBeGreaterThanOrEqual(1)
    expect(gamma.text()).toBe("gamma-updated")
  })

  it("map subscription survives deletion of a different key", () => {
    const { doc } = createMapDoc({
      version: "1.0",
      author: "alice",
      license: "MIT",
    })

    const authorRef = doc.metadata.at("author")
    const authorChanges: any[] = []
    authorRef[CHANGEFEED].subscribe((cs: any) => authorChanges.push(cs))

    // Delete a different key
    change(doc, (d: any) => {
      d.metadata.delete("license")
    })

    // Author subscription should still work
    expect(authorRef.deleted).toBe(false)

    change(doc, () => {
      authorRef.set("bob")
    })

    expect(authorChanges.length).toBeGreaterThanOrEqual(1)
    expect(authorRef()).toBe("bob")
  })

  it("subscribeTree on a list propagates events after structural change", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    // Access items to populate address table
    doc.todos.at(0)
    doc.todos.at(1)

    const cf = (doc.todos as any)[CHANGEFEED]
    const treeEvents: any[] = []
    cf.subscribeTree((cs: any) => {
      for (const e of cs.changes) treeEvents.push(e)
    })

    // Delete alpha (index 0)
    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    // Should get a structural change event
    expect(treeEvents.length).toBeGreaterThanOrEqual(1)

    // Now mutate beta (now at index 0) — tree subscription should propagate
    treeEvents.length = 0
    const beta = doc.todos.at(0)
    change(doc, () => {
      beta.text.set("beta-updated")
    })

    expect(treeEvents.length).toBeGreaterThanOrEqual(1)
  })

  it("external mutation via applyChanges invalidates cached product field", () => {
    const { doc } = createTodoDoc([{ text: "alpha", done: false }])

    const item = doc.todos.at(0)
    // Read to populate the cache
    expect(item.text()).toBe("alpha")

    // External mutation via RawPath — must invalidate cache so
    // subsequent read returns the new value, not the stale cached one
    applyChanges(doc, [
      {
        path: RawPath.empty.field("todos").item(0).field("text"),
        change: replaceChange("remote"),
      },
    ])

    expect(item.text()).toBe("remote")
  })

  it("calling the CALL slot (ref()) does not break .at(i) ref identity", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    // Cache refs via .at()
    const refA = doc.todos.at(0)
    const refB = doc.todos.at(1)
    expect(refA.text()).toBe("alpha")
    expect(refB.text()).toBe("beta")

    // Invoke the CALL slot — produces a plain snapshot.
    // Pre-fix: this called raw item(i) internally, creating new carriers
    // that overwrote the address table entries.
    const snapshot = doc.todos()
    expect(snapshot).toEqual([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    // Identity must be preserved — .at(i) returns the SAME ref objects
    expect(doc.todos.at(0)).toBe(refA)
    expect(doc.todos.at(1)).toBe(refB)

    // Iterator must also return the same refs
    const iterated = [...doc.todos]
    expect(iterated[0]).toBe(refA)
    expect(iterated[1]).toBe(refB)
  })

  it("no duplicate tree events after insert", () => {
    const { doc } = createTodoDoc([
      { text: "alpha", done: false },
      { text: "beta", done: false },
    ])

    // Access items and subscribe to tree
    doc.todos.at(0)
    doc.todos.at(1)
    const cf = (doc.todos as any)[CHANGEFEED]
    const treeEvents: any[] = []
    cf.subscribeTree((cs: any) => {
      for (const e of cs.changes) treeEvents.push(e)
    })

    // Insert at index 0 — shifts alpha to 1, beta to 2
    change(doc, (d: any) => {
      d.todos.insert(0, [{ text: "new", done: false }])
    })

    // Clear structural change events
    treeEvents.length = 0

    // Mutate beta (now at index 2) — should fire exactly once
    const beta = doc.todos.at(2)
    change(doc, () => {
      beta.text.set("beta-updated")
    })

    // Exactly 1 event — no duplicates from double-subscription
    expect(treeEvents).toHaveLength(1)
  })
})
