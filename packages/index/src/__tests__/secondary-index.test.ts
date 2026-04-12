import { describe, expect, it } from "vitest"
import { json, Schema, createDoc, change } from "@kyneta/schema"
import { Catalog } from "../catalog.js"
import { Index as _Index } from "../secondary-index.js"
import type { SecondaryIndexChange } from "../secondary-index.js"
import { join } from "../join-index.js"

// Cast to `any` to avoid TS2589 — Ref<S> depth explosion when TypeScript
// tries to verify generic return types through the IndexStatic interface.
const Index = _Index as any

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const itemSchema = Schema.struct({
  ownerId: Schema.string(),
  name: Schema.string(),
})
const ItemDoc = json.bind(itemSchema)

const taggedSchema = Schema.struct({
  tags: Schema.record(Schema.struct({ label: Schema.string() })),
})
const TaggedDoc = json.bind(taggedSchema)

const simpleSchema = Schema.struct({ title: Schema.string() })
const SimpleDoc = json.bind(simpleSchema)

/** Create a manual catalog, cast to `any` to sidestep TS2589. */
const createManualCatalog = () => Catalog.collect() as any as [any, any]

/** Create a ref as `any` to sidestep TS2589 deep Ref<S> instantiation. */
const makeItemRef = (): any => createDoc(ItemDoc)
const makeTaggedRef = (): any => createDoc(TaggedDoc)
const makeSimpleRef = (): any => createDoc(SimpleDoc)

// ---------------------------------------------------------------------------
// Index.by — scalar FK grouping
// ---------------------------------------------------------------------------

describe("Index.by (scalar FK grouping)", () => {
  function setup() {
    const [catalog, handle] = createManualCatalog()

    const ref1 = makeItemRef()
    change(ref1, (d: any) => {
      d.ownerId.set("user:alice")
      d.name.set("Item 1")
    })
    handle.set("item1", ref1)

    const ref2 = makeItemRef()
    change(ref2, (d: any) => {
      d.ownerId.set("user:alice")
      d.name.set("Item 2")
    })
    handle.set("item2", ref2)

    const index = Index.by(catalog, (ref: any) => ref.ownerId)

    return { catalog, handle, ref1, ref2, index }
  }

  it("lookup returns entries belonging to the group", () => {
    const { index } = setup()
    const entries = index.lookup("user:alice")
    expect(entries).toHaveLength(2)
    const keys = entries.map((e: any) => e.key).sort()
    expect(keys).toEqual(["item1", "item2"])
  })

  it("groupKeysFor returns the group key for a catalog entry", () => {
    const { index } = setup()
    expect(index.groupKeysFor("item1")).toEqual(["user:alice"])
  })

  it("adding a catalog entry updates lookup and emits group-added", () => {
    const { catalog, handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const ref3 = makeItemRef()
    change(ref3, (d: any) => {
      d.ownerId.set("user:bob")
      d.name.set("Item 3")
    })
    handle.set("item3", ref3)

    expect(changes).toEqual([
      { type: "group-added", groupKey: "user:bob", entryKey: "item3" },
    ])
    expect(index.lookup("user:bob")).toHaveLength(1)
    expect(index.lookup("user:bob")[0].key).toBe("item3")
    expect(index.keys().sort()).toEqual(["user:alice", "user:bob"])
    expect(index.size).toBe(2)
  })

  it("removing a catalog entry updates lookup and emits group-removed", () => {
    const { handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    handle.delete("item1")

    expect(changes).toEqual([
      { type: "group-removed", groupKey: "user:alice", entryKey: "item1" },
    ])
    expect(index.lookup("user:alice")).toHaveLength(1)
    expect(index.lookup("user:alice")[0].key).toBe("item2")
  })

  it("mutating the FK moves the entry between groups", () => {
    const { ref1, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.ownerId.set("user:bob")
    })

    // Should emit group-removed for old group, group-added for new group
    expect(changes).toEqual([
      { type: "group-removed", groupKey: "user:alice", entryKey: "item1" },
      { type: "group-added", groupKey: "user:bob", entryKey: "item1" },
    ])

    // item1 should now be in user:bob, not user:alice
    const bobEntries = index.lookup("user:bob")
    expect(bobEntries).toHaveLength(1)
    expect(bobEntries[0].key).toBe("item1")

    // user:alice should only have item2 now
    const aliceEntries = index.lookup("user:alice")
    expect(aliceEntries).toHaveLength(1)
    expect(aliceEntries[0].key).toBe("item2")

    // groupKeysFor should reflect the move
    expect(index.groupKeysFor("item1")).toEqual(["user:bob"])
  })

  it("dispose() tears down subscriptions — FK mutation after dispose does not emit", () => {
    const { ref1, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    index.dispose()

    change(ref1, (d: any) => {
      d.ownerId.set("user:carol")
    })

    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Index.byKeys — record fan-out grouping
// ---------------------------------------------------------------------------

describe("Index.byKeys (record fan-out grouping)", () => {
  function setup() {
    const [catalog, handle] = createManualCatalog()

    const ref1 = makeTaggedRef()
    change(ref1, (d: any) => {
      d.tags.set("tag1", { label: "Tag 1" })
      d.tags.set("tag2", { label: "Tag 2" })
    })
    handle.set("entry1", ref1)

    const index = Index.byKeys(catalog, (ref: any) => ref.tags)

    return { catalog, handle, ref1, index }
  }

  it("entry with tags [tag1, tag2] appears in both lookup(tag1) and lookup(tag2)", () => {
    const { index } = setup()

    const tag1Entries = index.lookup("tag1")
    expect(tag1Entries).toHaveLength(1)
    expect(tag1Entries[0].key).toBe("entry1")

    const tag2Entries = index.lookup("tag2")
    expect(tag2Entries).toHaveLength(1)
    expect(tag2Entries[0].key).toBe("entry1")
  })

  it("adding a tag key makes the entry appear in the new group and emits group-added", () => {
    const { ref1, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.tags.set("tag3", { label: "Tag 3" })
    })

    const addedChanges = changes.filter((c) => c.type === "group-added")
    expect(addedChanges).toEqual([
      { type: "group-added", groupKey: "tag3", entryKey: "entry1" },
    ])

    expect(index.lookup("tag3")).toHaveLength(1)
    expect(index.lookup("tag3")[0].key).toBe("entry1")
    expect(index.size).toBe(3)
  })

  it("removing a tag key removes the entry from that group and emits group-removed", () => {
    const { ref1, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    change(ref1, (d: any) => {
      d.tags.delete("tag1")
    })

    const removedChanges = changes.filter((c) => c.type === "group-removed")
    expect(removedChanges).toEqual([
      { type: "group-removed", groupKey: "tag1", entryKey: "entry1" },
    ])

    expect(index.lookup("tag1")).toEqual([])
    expect(index.lookup("tag2")).toHaveLength(1)
    expect(index.size).toBe(1)
  })

  it("adding a catalog entry with tags fans out to all tag groups", () => {
    const { handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const ref2 = makeTaggedRef()
    change(ref2, (d: any) => {
      d.tags.set("tag2", { label: "Also Tag 2" })
      d.tags.set("tag4", { label: "Tag 4" })
    })
    handle.set("entry2", ref2)

    const addedChanges = changes
      .filter((c) => c.type === "group-added")
      .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    expect(addedChanges).toEqual([
      { type: "group-added", groupKey: "tag2", entryKey: "entry2" },
      { type: "group-added", groupKey: "tag4", entryKey: "entry2" },
    ])

    // tag2 should now have both entries
    expect(index.lookup("tag2")).toHaveLength(2)
  })

  it("removing a catalog entry removes it from all tag groups", () => {
    const { handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    handle.delete("entry1")

    const removedChanges = changes
      .filter((c) => c.type === "group-removed")
      .sort((a, b) => a.groupKey.localeCompare(b.groupKey))
    expect(removedChanges).toEqual([
      { type: "group-removed", groupKey: "tag1", entryKey: "entry1" },
      { type: "group-removed", groupKey: "tag2", entryKey: "entry1" },
    ])

    expect(index.lookup("tag1")).toEqual([])
    expect(index.lookup("tag2")).toEqual([])
    expect(index.size).toBe(0)
  })

  it("dispose() tears down subscriptions", () => {
    const { ref1, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    index.dispose()

    change(ref1, (d: any) => {
      d.tags.set("tag99", { label: "Should not appear" })
    })

    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Index.byIdentity — trivial identity index
// ---------------------------------------------------------------------------

describe("Index.byIdentity (trivial identity)", () => {
  function setup() {
    const [catalog, handle] = createManualCatalog()

    const ref1 = makeSimpleRef()
    change(ref1, (d: any) => {
      d.title.set("First")
    })
    handle.set("item1", ref1)

    const ref2 = makeSimpleRef()
    change(ref2, (d: any) => {
      d.title.set("Second")
    })
    handle.set("item2", ref2)

    const index = Index.byIdentity(catalog)

    return { catalog, handle, ref1, ref2, index }
  }

  it("each catalog entry has its own group (catalog key = group key)", () => {
    const { index } = setup()
    expect(index.keys().sort()).toEqual(["item1", "item2"])
    expect(index.size).toBe(2)
  })

  it("lookup(key) returns exactly the entry for that key", () => {
    const { ref1, index } = setup()
    const entries = index.lookup("item1")
    expect(entries).toHaveLength(1)
    expect(entries[0].key).toBe("item1")
    expect(entries[0].ref).toBe(ref1)
  })

  it("adding an entry emits group-added", () => {
    const { handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    const ref3 = makeSimpleRef()
    change(ref3, (d: any) => {
      d.title.set("Third")
    })
    handle.set("item3", ref3)

    expect(changes).toEqual([
      { type: "group-added", groupKey: "item3", entryKey: "item3" },
    ])
    expect(index.lookup("item3")).toHaveLength(1)
    expect(index.size).toBe(3)
  })

  it("removing an entry emits group-removed", () => {
    const { handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    handle.delete("item1")

    expect(changes).toEqual([
      { type: "group-removed", groupKey: "item1", entryKey: "item1" },
    ])
    expect(index.lookup("item1")).toEqual([])
    expect(index.size).toBe(1)
  })

  it("dispose() tears down subscriptions — catalog changes after dispose do not emit", () => {
    const { handle, index } = setup()

    const changes: SecondaryIndexChange[] = []
    index.subscribe((cs: any) => {
      changes.push(...cs.changes)
    })

    index.dispose()

    const ref3 = makeSimpleRef()
    handle.set("item3", ref3)

    expect(changes).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cross-layer: FK mutation propagates through join
// ---------------------------------------------------------------------------

describe("cross-layer: FK mutation propagates through join", () => {
  it("mutating a thread's conversationId updates the join's lookup results", () => {
    const [convCatalog, convHandle] = createManualCatalog()
    const [threadCatalog, threadHandle] = createManualCatalog()

    const convRef = createDoc(SimpleDoc) as any
    change(convRef, (d: any) => { d.title.set("Conv A") })
    convHandle.set("conv:a", convRef)

    const conv2Ref = createDoc(SimpleDoc) as any
    change(conv2Ref, (d: any) => { d.title.set("Conv B") })
    convHandle.set("conv:b", conv2Ref)

    const threadRef = makeItemRef()
    change(threadRef, (d: any) => {
      d.ownerId.set("conv:a")
      d.name.set("Thread 1")
    })
    threadHandle.set("t1", threadRef)

    const leftIndex = Index.byIdentity(convCatalog)
    const rightIndex = Index.by(threadCatalog, (ref: any) => ref.ownerId)

    const convThreads = join(leftIndex, rightIndex)

    // Initially, t1 belongs to conv:a
    expect(convThreads.lookup("conv:a").length).toBe(1)
    expect(convThreads.lookup("conv:b").length).toBe(0)

    // Mutate the FK
    change(threadRef, (d: any) => {
      d.ownerId.set("conv:b")
    })

    // Now t1 should have moved to conv:b
    expect(convThreads.lookup("conv:a").length).toBe(0)
    expect(convThreads.lookup("conv:b").length).toBe(1)
    expect(convThreads.lookup("conv:b")[0].key).toBe("t1")

    // Reverse should also update
    expect(convThreads.reverse("t1").length).toBe(1)
    expect(convThreads.reverse("t1")[0].key).toBe("conv:b")
  })
})