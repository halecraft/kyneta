import { describe, expect, it } from "vitest"
import {
  Catalog,
  type CatalogChange,
  type WritableCatalog,
} from "../catalog.js"
import { json, Schema, createDoc, change, subscribe } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const testSchema = Schema.struct({ title: Schema.string() })
const TestDoc = json.bind(testSchema)

/** Create a ref as `any` to sidestep TS2589 deep Ref<S> instantiation. */
const makeRef = (): any => createDoc(TestDoc)

// ---------------------------------------------------------------------------
// Catalog.collect() — manual aggregation
// ---------------------------------------------------------------------------

describe("Catalog.collect()", () => {
  // Cast to `any` to fully sidestep TS2589 deep Ref<S> instantiation.
  // The catalog source itself uses `any` internally for the same reason
  // — see createManual in catalog.ts.
  const create = () => Catalog.collect() as any as [any, any]

  it("returns a tuple [catalog, handle]", () => {
    const result = create()
    expect(Array.isArray(result)).toBe(true)
    const [catalog, handle] = result
    expect(typeof catalog).toBe("function")
    expect(handle).toBeDefined()
    expect(typeof handle.set).toBe("function")
    expect(typeof handle.delete).toBe("function")
  })

  it("handle.set(key, ref) on new key → catalog.has(key) is true, catalog.get(key) returns the ref", () => {
    const [catalog, handle] = create()
    const ref = makeRef()
    handle.set("doc-1", ref)

    expect(catalog.has("doc-1")).toBe(true)
    expect(catalog.get("doc-1")).toBe(ref)
  })

  it("handle.set(key, ref) on new key → changefeed emits { type: 'added', key }", () => {
    const [catalog, handle] = create()
    const ref = makeRef()

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    handle.set("doc-1", ref)

    expect(changes).toEqual([{ type: "added", key: "doc-1" }])
  })

  it("handle.set(key, ref) on existing key → no changefeed emission (idempotent)", () => {
    const [catalog, handle] = create()
    const ref1 = makeRef()
    const ref2 = makeRef()

    handle.set("doc-1", ref1)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    // Re-set same key with a different ref — should be silent
    handle.set("doc-1", ref2)

    expect(changes).toEqual([])
  })

  it("handle.delete(key) on existing key → catalog.has(key) is false, returns true, emits 'removed'", () => {
    const [catalog, handle] = create()
    const ref = makeRef()
    handle.set("doc-1", ref)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const result = handle.delete("doc-1")

    expect(result).toBe(true)
    expect(catalog.has("doc-1")).toBe(false)
    expect(changes).toEqual([{ type: "removed", key: "doc-1" }])
  })

  it("handle.delete(key) on missing key → returns false, no changefeed emission", () => {
    const [catalog, handle] = create()

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const result = handle.delete("nonexistent")

    expect(result).toBe(false)
    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Catalog.create(bound) — with BoundSchema
// ---------------------------------------------------------------------------

describe("Catalog.create(bound) with BoundSchema", () => {
  it("returns a single WritableCatalog (not a tuple)", () => {
    const catalog = Catalog.create(TestDoc)
    expect(Array.isArray(catalog)).toBe(false)
    expect(typeof catalog).toBe("function")
    expect(typeof catalog.createDoc).toBe("function")
    expect(typeof catalog.delete).toBe("function")
    expect(typeof catalog.dispose).toBe("function")
  })

  it("catalog.createDoc(key) creates a ref, adds to catalog, emits 'added'", () => {
    const catalog = Catalog.create(TestDoc)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const ref = catalog.createDoc("doc-1")

    expect(ref).toBeDefined()
    expect(catalog.has("doc-1")).toBe(true)
    expect(catalog.get("doc-1")).toBe(ref)
    expect(catalog.size).toBe(1)
    expect(changes).toEqual([{ type: "added", key: "doc-1" }])
  })

  it("catalog.createDoc(key) on existing key throws", () => {
    const catalog = Catalog.create(TestDoc)
    catalog.createDoc("doc-1")

    expect(() => catalog.createDoc("doc-1")).toThrow(
      /Key "doc-1" already exists/,
    )
  })

  it("catalog.delete(key) removes and emits 'removed'", () => {
    const catalog = Catalog.create(TestDoc)
    catalog.createDoc("doc-1")

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const result = catalog.delete("doc-1")

    expect(result).toBe(true)
    expect(catalog.has("doc-1")).toBe(false)
    expect(catalog.size).toBe(0)
    expect(changes).toEqual([{ type: "removed", key: "doc-1" }])
  })

  it("catalog.delete(key) on missing key returns false, no emission", () => {
    const catalog = Catalog.create(TestDoc)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const result = catalog.delete("nonexistent")

    expect(result).toBe(false)
    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Catalog.fromRecord() — record ref → catalog
// ---------------------------------------------------------------------------

const recordSchema = Schema.struct({
  members: Schema.record(Schema.struct({ role: Schema.string() })),
})
const RecordDoc = json.bind(recordSchema)

/** Drain the microtask queue so async changefeed delivery completes. */
const flush = () => Promise.resolve()

describe("Catalog.fromRecord()", () => {
  it("initial record keys become catalog entries", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "viewer" })
    })

    const catalog = Catalog.fromRecord(doc.members) as any

    expect(catalog.size).toBe(2)
    expect(catalog.has("alice")).toBe(true)
    expect(catalog.has("bob")).toBe(true)
  })

  it("catalog.get(key) returns the ref at that key", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
    })

    const catalog = Catalog.fromRecord(doc.members) as any
    const ref = catalog.get("alice")

    expect(ref).toBeDefined()
    // The ref should be the same object as navigating via the record
    expect(ref).toBe(doc.members.at("alice"))
  })

  it("catalog.size matches record size", () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "viewer" })
      d.members.set("carol", { role: "editor" })
    })

    const catalog = Catalog.fromRecord(doc.members) as any

    expect(catalog.size).toBe(3)
  })

  it("adding a key to the record emits 'added'", async () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
    })

    const catalog = Catalog.fromRecord(doc.members) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    change(doc, (d: any) => {
      d.members.set("bob", { role: "viewer" })
    })
    await flush()

    expect(changes).toEqual([{ type: "added", key: "bob" }])
    expect(catalog.has("bob")).toBe(true)
    expect(catalog.size).toBe(2)
  })

  it("removing a key from the record emits 'removed'", async () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
      d.members.set("bob", { role: "viewer" })
    })

    const catalog = Catalog.fromRecord(doc.members) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    change(doc, (d: any) => {
      d.members.delete("alice")
    })
    await flush()

    expect(changes).toEqual([{ type: "removed", key: "alice" }])
    expect(catalog.has("alice")).toBe(false)
    expect(catalog.size).toBe(1)
  })

  it("dispose() stops subscription — changes after dispose don't emit", async () => {
    const doc = createDoc(RecordDoc) as any
    change(doc, (d: any) => {
      d.members.set("alice", { role: "admin" })
    })

    const catalog = Catalog.fromRecord(doc.members) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    catalog.dispose()

    change(doc, (d: any) => {
      d.members.set("bob", { role: "viewer" })
    })
    await flush()

    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Catalog.fromList() — list ref → catalog
// ---------------------------------------------------------------------------

const itemSchema = Schema.struct({
  id: Schema.string(),
  name: Schema.string(),
})
const listSchema = Schema.struct({
  items: Schema.list(itemSchema),
})
const ListDoc = json.bind(listSchema)

describe("Catalog.fromList()", () => {
  it("initial list items become catalog entries keyed by keyFn", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "item-1", name: "First" })
      d.items.push({ id: "item-2", name: "Second" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any

    expect(catalog.size).toBe(2)
    expect(catalog.has("item-1")).toBe(true)
    expect(catalog.has("item-2")).toBe(true)
  })

  it("catalog.get(key) returns the corresponding item ref", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "item-1", name: "First" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any
    const ref = catalog.get("item-1")

    expect(ref).toBeDefined()
    // The ref's id should read back as "item-1"
    expect((ref as any).id()).toBe("item-1")
  })

  it("pushing a new item emits 'added' with the new key", async () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "item-1", name: "First" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    change(doc, (d: any) => {
      d.items.push({ id: "item-2", name: "Second" })
    })
    await flush()

    expect(changes).toEqual([{ type: "added", key: "item-2" }])
    expect(catalog.has("item-2")).toBe(true)
    expect(catalog.size).toBe(2)
  })

  it("deleting an item from the list emits 'removed'", async () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "only-item", name: "Only" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any
    expect(catalog.size).toBe(1)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    // Use a single-item list to avoid positional-ref shifting
    // ambiguity in the plain substrate (positional refs re-key when
    // earlier indices are removed, producing non-obvious diff results).
    change(doc, (d: any) => {
      d.items.delete(0)
    })
    await flush()

    expect(changes).toEqual([{ type: "removed", key: "only-item" }])
    expect(catalog.has("only-item")).toBe(false)
    expect(catalog.size).toBe(0)
  })

  it("mutating an item's key field re-keys the catalog entry", async () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "old-key", name: "Item" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any
    expect(catalog.has("old-key")).toBe(true)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    // Mutate the key field on the existing item
    const itemRef = catalog.get("old-key")
    change(doc, (d: any) => {
      d.items.at(0).id.set("new-key")
    })
    await flush()

    expect(changes).toEqual([
      { type: "removed", key: "old-key" },
      { type: "added", key: "new-key" },
    ])
    expect(catalog.has("old-key")).toBe(false)
    expect(catalog.has("new-key")).toBe(true)
    // The ref should be the same object
    expect(catalog.get("new-key")).toBe(itemRef)
  })

  it("mutating a non-key field on a list item does not emit catalog changes", () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "item-1", name: "Original" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const itemRef = catalog.get("item-1")
    change(itemRef, (d: any) => {
      d.name.set("Updated")
    })

    expect(changes).toEqual([])
  })

  it("dispose() stops subscription — changes after dispose don't emit", async () => {
    const doc = createDoc(ListDoc) as any
    change(doc, (d: any) => {
      d.items.push({ id: "item-1", name: "First" })
    })

    const catalog = Catalog.fromList(doc.items, (item: any) => item.id) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    catalog.dispose()

    change(doc, (d: any) => {
      d.items.push({ id: "item-2", name: "Second" })
    })
    await flush()

    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Catalog.fromExchange() — exchange-backed catalog (mock)
// ---------------------------------------------------------------------------

describe("Catalog.fromExchange()", () => {
  function createMockExchange() {
    const docs = new Map<string, { ref: any; schemaHash: string }>()
    const scopes: any[] = []
    return {
      get(docId: string, bound: any) {
        let entry = docs.get(docId)
        if (!entry) {
          const ref = makeRef()
          entry = { ref, schemaHash: bound.schemaHash }
          docs.set(docId, entry)
          // Notify scopes
          for (const scope of scopes) {
            scope.onDocCreated?.(docId, { peerId: "test" }, "interpret", "local")
          }
        }
        return entry.ref
      },
      documentIds() {
        return new Set(docs.keys())
      },
      getDocSchemaHash(docId: string) {
        return docs.get(docId)?.schemaHash
      },
      registerSchema(_bound: any) {},
      register(scope: any) {
        scopes.push(scope)
        return () => {
          const idx = scopes.indexOf(scope)
          if (idx !== -1) scopes.splice(idx, 1)
        }
      },
      // Simulate dismiss
      dismiss(docId: string) {
        docs.delete(docId)
        for (const scope of scopes) {
          scope.onDocDismissed?.(docId, { peerId: "test" }, "local")
        }
      },
    }
  }

  it("tracks existing docs at construction time", () => {
    const ex = createMockExchange()
    ex.get("doc:1", TestDoc) // pre-create

    const catalog = Catalog.fromExchange(ex, TestDoc, {
      toKey: (docId) => docId,
      toDocId: (key) => key,
    }) as any

    expect(catalog.has("doc:1")).toBe(true)
    expect(catalog.size).toBe(1)
  })

  it("createDoc creates in exchange and emits added", () => {
    const ex = createMockExchange()
    const catalog = Catalog.fromExchange(ex, TestDoc, {
      toKey: (docId) => docId,
      toDocId: (key) => key,
    }) as any

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => changes.push(...cs.changes))

    const ref = catalog.createDoc("doc:new")
    expect(ref).toBeDefined()
    expect(catalog.has("doc:new")).toBe(true)
    expect(changes.some((c: any) => c.type === "added" && c.key === "doc:new")).toBe(true)
  })

  it("dismiss removes catalog entry", () => {
    const ex = createMockExchange()
    const catalog = Catalog.fromExchange(ex, TestDoc, {
      toKey: (docId) => docId,
      toDocId: (key) => key,
    }) as any

    catalog.createDoc("doc:1")
    expect(catalog.has("doc:1")).toBe(true)

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => changes.push(...cs.changes))

    ex.dismiss("doc:1")

    expect(catalog.has("doc:1")).toBe(false)
    expect(changes).toEqual([{ type: "removed", key: "doc:1" }])
  })

  it("toKey returning null filters out the doc", () => {
    const ex = createMockExchange()
    ex.get("internal:secret", TestDoc)

    const catalog = Catalog.fromExchange(ex, TestDoc, {
      toKey: (docId) => docId.startsWith("internal:") ? null : docId,
      toDocId: (key) => key,
    }) as any

    expect(catalog.has("internal:secret")).toBe(false)
    expect(catalog.size).toBe(0)
  })

  it("dispose stops tracking new docs", () => {
    const ex = createMockExchange()
    const catalog = Catalog.fromExchange(ex, TestDoc, {
      toKey: (docId) => docId,
      toDocId: (key) => key,
    }) as any

    catalog.dispose()

    const changes: CatalogChange[] = []
    catalog.subscribe((cs: any) => changes.push(...cs.changes))

    ex.get("doc:late", TestDoc)
    expect(changes).toEqual([])
  })
})
