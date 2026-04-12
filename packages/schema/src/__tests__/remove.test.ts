import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  applyChanges,
  change,
  hasRemove,
  interpret,
  observation,
  plainContext,
  readable,
  REMOVE,
  remove,
  Schema,
  subscribe,
  writable,
} from "../index.js"

// ===========================================================================
// Shared fixtures
// ===========================================================================

const todoSchema = Schema.struct({
  todos: Schema.list(
    Schema.struct({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const mapSchema = Schema.struct({
  metadata: Schema.record(Schema.string()),
})

const setSchema = Schema.struct({
  tags: Schema.set(Schema.string()),
})

const movableSchema = Schema.struct({
  items: Schema.movableList(
    Schema.struct({
      name: Schema.string(),
    }),
  ),
})

const nestedSchema = Schema.struct({
  groups: Schema.list(
    Schema.struct({
      items: Schema.list(
        Schema.struct({
          name: Schema.string(),
        }),
      ),
    }),
  ),
})

function createTodoDoc(initialTodos: Array<{ text: string; done: boolean }>) {
  const store = { todos: initialTodos }
  const ctx = plainContext(store)
  const doc = interpret(todoSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store }
}

function createMapDoc(initialMetadata: Record<string, string>) {
  const store = { metadata: initialMetadata }
  const ctx = plainContext(store)
  const doc = interpret(mapSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store }
}

function createSetDoc(initialTags: Record<string, string>) {
  const store = { tags: initialTags }
  const ctx = plainContext(store)
  const doc = interpret(setSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store }
}

function createMovableDoc(initialItems: Array<{ name: string }>) {
  const store = { items: initialItems }
  const ctx = plainContext(store)
  const doc = interpret(movableSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store }
}

function createNestedDoc(
  groups: Array<{ items: Array<{ name: string }> }>,
) {
  const store = { groups }
  const ctx = plainContext(store)
  const doc = interpret(nestedSchema, ctx)
    .with(readable)
    .with(writable)
    .with(observation)
    .done() as any
  return { doc, store }
}

// ===========================================================================
// Sequence self-removal
// ===========================================================================

describe("[REMOVE]: sequences", () => {
  it("removes item from parent list", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
      { text: "c", done: false },
    ])

    const b = doc.todos.at(1)
    expect(b.text()).toBe("b")
    expect(hasRemove(b)).toBe(true)

    b[REMOVE]()

    expect(doc.todos.length).toBe(2)
    expect(doc.todos.at(0).text()).toBe("a")
    expect(doc.todos.at(1).text()).toBe("c")
    expect(b.deleted).toBe(true)
  })

  it("removes first item (index 0, no retain)", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
    ])

    doc.todos.at(0)[REMOVE]()

    expect(doc.todos.length).toBe(1)
    expect(doc.todos.at(0).text()).toBe("b")
  })

  it("removes sole item, leaving empty list", () => {
    const { doc } = createTodoDoc([{ text: "only", done: false }])

    const only = doc.todos.at(0)
    only[REMOVE]()

    expect(doc.todos.length).toBe(0)
    expect(only.deleted).toBe(true)
  })

  it("works with advanced addresses after prior deletion", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
      { text: "c", done: false },
    ])

    const a = doc.todos.at(0)
    const b = doc.todos.at(1)
    const c = doc.todos.at(2)

    // Delete item 0 via parent — b advances from 1→0, c from 2→1
    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    expect(a.deleted).toBe(true)
    expect(b.deleted).toBe(false)
    expect(c.deleted).toBe(false)

    // c's address is now index 1 — [REMOVE] should use the advanced index
    c[REMOVE]()

    expect(doc.todos.length).toBe(1)
    expect(doc.todos.at(0).text()).toBe("b")
    expect(c.deleted).toBe(true)
  })
})

// ===========================================================================
// Map entry self-removal
// ===========================================================================

describe("[REMOVE]: maps", () => {
  it("removes entry from parent map", () => {
    const { doc } = createMapDoc({ version: "1.0", author: "alice" })

    const versionRef = doc.metadata.at("version")
    expect(versionRef()).toBe("1.0")
    expect(hasRemove(versionRef)).toBe(true)

    versionRef[REMOVE]()

    expect(doc.metadata.has("version")).toBe(false)
    expect(doc.metadata.has("author")).toBe(true)
    expect(versionRef.deleted).toBe(true)
  })
})

// ===========================================================================
// Set entry self-removal
// ===========================================================================

describe("[REMOVE]: sets", () => {
  it("removes entry from parent set", () => {
    const { doc } = createSetDoc({ urgent: "urgent", low: "low" })

    const urgentRef = doc.tags.at("urgent")
    expect(hasRemove(urgentRef)).toBe(true)

    urgentRef[REMOVE]()

    expect(doc.tags.has("urgent")).toBe(false)
    expect(doc.tags.has("low")).toBe(true)
    expect(urgentRef.deleted).toBe(true)
  })
})

// ===========================================================================
// Dead ref throws on [REMOVE]
// ===========================================================================

describe("[REMOVE]: dead ref", () => {
  it("throws when calling [REMOVE] on a dead ref", () => {
    const { doc } = createTodoDoc([{ text: "only", done: false }])

    const item = doc.todos.at(0)
    change(doc, (d: any) => {
      d.todos.delete(0, 1)
    })

    expect(item.deleted).toBe(true)
    expect(() => item[REMOVE]()).toThrow("Cannot remove a dead ref")
  })

  it("throws when calling [REMOVE] on a dead map entry", () => {
    const { doc } = createMapDoc({ key: "value" })

    const ref = doc.metadata.at("key")
    change(doc, (d: any) => {
      d.metadata.delete("key")
    })

    expect(ref.deleted).toBe(true)
    expect(() => ref[REMOVE]()).toThrow("Cannot remove a dead ref")
  })
})

// ===========================================================================
// Product fields and top-level docs do NOT have [REMOVE]
// ===========================================================================

describe("[REMOVE]: non-removable refs", () => {
  it("product field does not have [REMOVE]", () => {
    const { doc } = createTodoDoc([])

    expect(hasRemove(doc.todos)).toBe(false)
    expect((doc.todos as any)[REMOVE]).toBeUndefined()
  })

  it("scalar product field does not have [REMOVE]", () => {
    const { doc } = createTodoDoc([{ text: "a", done: false }])

    const item = doc.todos.at(0)
    // The item itself is removable (sequence child)
    expect(hasRemove(item)).toBe(true)
    // But its fields are not (product children)
    expect(hasRemove(item.text)).toBe(false)
    expect(hasRemove(item.done)).toBe(false)
  })

  it("top-level doc does not have [REMOVE]", () => {
    const { doc } = createTodoDoc([])
    expect(hasRemove(doc)).toBe(false)
  })
})

// ===========================================================================
// Works within transactions
// ===========================================================================

describe("[REMOVE]: transactions", () => {
  it("works inside change()", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
      { text: "c", done: false },
    ])

    const b = doc.todos.at(1)

    const ops = change(doc, () => {
      b[REMOVE]()
    })

    expect(ops.length).toBe(1)
    expect(doc.todos.length).toBe(2)
    expect(doc.todos.at(0).text()).toBe("a")
    expect(doc.todos.at(1).text()).toBe("c")
  })

  it("ops from [REMOVE] round-trip through applyChanges", () => {
    const { doc: docA } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
      { text: "c", done: false },
    ])
    const { doc: docB } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
      { text: "c", done: false },
    ])

    const ops = change(docA, () => {
      docA.todos.at(1)[REMOVE]()
    })

    applyChanges(docB, ops, { origin: "sync" })

    expect(docA()).toEqual(docB())
    expect(docB.todos.length).toBe(2)
    expect(docB.todos.at(0).text()).toBe("a")
    expect(docB.todos.at(1).text()).toBe("c")
  })
})

// ===========================================================================
// Changefeed fires correctly
// ===========================================================================

describe("[REMOVE]: changefeed", () => {
  it("parent list changefeed fires on child [REMOVE]", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
    ])

    const events: any[] = []
    subscribe(doc.todos, (changeset: any) => {
      events.push(changeset)
    })

    doc.todos.at(0)[REMOVE]()

    expect(events.length).toBe(1)
    expect(doc.todos.length).toBe(1)
    expect(doc.todos.at(0).text()).toBe("b")
  })
})

// ===========================================================================
// Read-only stack has no [REMOVE]
// ===========================================================================

describe("[REMOVE]: read-only stack", () => {
  it("refs on a readable-only stack do not have [REMOVE]", () => {
    const store = {
      todos: [{ text: "a", done: false }],
    }
    const ctx = plainContext(store)
    const doc = interpret(todoSchema, ctx)
      .with(readable)
      .with(observation)
      .done() as any

    const item = doc.todos.at(0)
    expect(hasRemove(item)).toBe(false)
  })
})

// ===========================================================================
// Movable sequence self-removal
// ===========================================================================

describe("[REMOVE]: movable sequences", () => {
  it("removes item from movable list", () => {
    const { doc } = createMovableDoc([
      { name: "x" },
      { name: "y" },
      { name: "z" },
    ])

    const y = doc.items.at(1)
    expect(hasRemove(y)).toBe(true)

    y[REMOVE]()

    expect(doc.items.length).toBe(2)
    expect(doc.items.at(0).name()).toBe("x")
    expect(doc.items.at(1).name()).toBe("z")
    expect(y.deleted).toBe(true)
  })
})

// ===========================================================================
// Nested container self-removal
// ===========================================================================

describe("[REMOVE]: nested containers", () => {
  it("removes item from inner list without affecting outer list", () => {
    const { doc } = createNestedDoc([
      {
        items: [{ name: "a" }, { name: "b" }, { name: "c" }],
      },
      {
        items: [{ name: "x" }],
      },
    ])

    const innerItem = doc.groups.at(0).items.at(1)
    expect(innerItem.name()).toBe("b")
    expect(hasRemove(innerItem)).toBe(true)

    innerItem[REMOVE]()

    // Inner list lost item "b"
    expect(doc.groups.at(0).items.length).toBe(2)
    expect(doc.groups.at(0).items.at(0).name()).toBe("a")
    expect(doc.groups.at(0).items.at(1).name()).toBe("c")

    // Outer list is unaffected
    expect(doc.groups.length).toBe(2)
    expect(doc.groups.at(1).items.at(0).name()).toBe("x")
  })

  it("removes outer group via [REMOVE]", () => {
    const { doc } = createNestedDoc([
      { items: [{ name: "a" }] },
      { items: [{ name: "b" }] },
    ])

    const group = doc.groups.at(0)
    expect(hasRemove(group)).toBe(true)

    group[REMOVE]()

    expect(doc.groups.length).toBe(1)
    expect(doc.groups.at(0).items.at(0).name()).toBe("b")
  })
})

// ===========================================================================
// remove() facade function
// ===========================================================================

describe("remove() facade", () => {
  it("removes a sequence item via remove(ref)", () => {
    const { doc } = createTodoDoc([
      { text: "a", done: false },
      { text: "b", done: false },
    ])

    const a = doc.todos.at(0)
    remove(a)

    expect(doc.todos.length).toBe(1)
    expect(doc.todos.at(0).text()).toBe("b")
    expect(a.deleted).toBe(true)
  })

  it("removes a map entry via remove(ref)", () => {
    const { doc } = createMapDoc({ key: "value" })

    const ref = doc.metadata.at("key")
    remove(ref)

    expect(doc.metadata.has("key")).toBe(false)
  })
})