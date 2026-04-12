import { describe, expect, it, vi } from "vitest"
import { json, Schema, createDoc, change } from "@kyneta/schema"
import { field, keys } from "../key-spec.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const itemSchema = Schema.struct({
  ownerId: Schema.string(),
  status: Schema.string(),
  name: Schema.string(),
})
const ItemDoc = json.bind(itemSchema)

const taggedSchema = Schema.struct({
  tags: Schema.record(Schema.struct({ label: Schema.string() })),
})
const TaggedDoc = json.bind(taggedSchema)

// ---------------------------------------------------------------------------
// field — scalar FK
// ---------------------------------------------------------------------------

describe("field (scalar FK)", () => {
  it("groupKeys returns single-element array with accessor value", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId)
    expect(spec.groupKeys("item1", ref)).toEqual(["user:alice"])
  })

  it("watch fires on FK mutation", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId)
    const callback = vi.fn()
    const unsub = spec.watch!("item1", ref, callback)

    change(ref, (d: any) => {
      d.ownerId.set("user:bob")
    })

    expect(callback).toHaveBeenCalled()
    unsub()
  })

  it("watch does NOT fire on non-FK field mutation", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId)
    const callback = vi.fn()
    const unsub = spec.watch!("item1", ref, callback)

    // Mutate name, not ownerId
    change(ref, (d: any) => {
      d.name.set("Updated Item")
    })

    expect(callback).not.toHaveBeenCalled()
    unsub()
  })

  it("unsub stops watch", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId)
    const callback = vi.fn()
    const unsub = spec.watch!("item1", ref, callback)
    unsub()

    change(ref, (d: any) => {
      d.ownerId.set("user:carol")
    })

    expect(callback).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// field — compound key
// ---------------------------------------------------------------------------

describe("field (compound key)", () => {
  it("groupKeys returns compound key with \\0 separator", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId, (r: any) => r.status)
    expect(spec.groupKeys("item1", ref)).toEqual(["user:alice\0active"])
  })

  it("watch fires when either accessor changes", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId, (r: any) => r.status)
    const callback = vi.fn()
    const unsub = spec.watch!("item1", ref, callback)

    // Mutate ownerId
    change(ref, (d: any) => {
      d.ownerId.set("user:bob")
    })
    expect(callback).toHaveBeenCalledTimes(1)

    // Mutate status
    change(ref, (d: any) => {
      d.status.set("inactive")
    })
    expect(callback).toHaveBeenCalledTimes(2)

    unsub()
  })

  it("compound unsub tears down all watches", () => {
    const ref = createDoc(ItemDoc) as any
    change(ref, (d: any) => {
      d.ownerId.set("user:alice")
      d.status.set("active")
      d.name.set("Item 1")
    })

    const spec = field<any>((r: any) => r.ownerId, (r: any) => r.status)
    const callback = vi.fn()
    const unsub = spec.watch!("item1", ref, callback)
    unsub()

    change(ref, (d: any) => {
      d.ownerId.set("user:carol")
    })
    change(ref, (d: any) => {
      d.status.set("archived")
    })

    expect(callback).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// keys — record fan-out
// ---------------------------------------------------------------------------

describe("keys (record fan-out)", () => {
  it("groupKeys returns all keys of the record", () => {
    const ref = createDoc(TaggedDoc) as any
    change(ref, (d: any) => {
      d.tags.set("urgent", { label: "Urgent" })
      d.tags.set("bug", { label: "Bug" })
    })

    const spec = keys<any>((r: any) => r.tags)
    const result = spec.groupKeys("entry1", ref).sort()
    expect(result).toEqual(["bug", "urgent"])
  })

  it("watch fires on structural change (key added)", () => {
    const ref = createDoc(TaggedDoc) as any
    change(ref, (d: any) => {
      d.tags.set("urgent", { label: "Urgent" })
    })

    const spec = keys<any>((r: any) => r.tags)
    const callback = vi.fn()
    const unsub = spec.watch!("entry1", ref, callback)

    change(ref, (d: any) => {
      d.tags.set("new-tag", { label: "New" })
    })

    expect(callback).toHaveBeenCalled()
    unsub()
  })

  it("watch does NOT fire on value mutation inside a record entry (subscribeNode fix)", () => {
    const ref = createDoc(TaggedDoc) as any
    change(ref, (d: any) => {
      d.tags.set("urgent", { label: "Urgent" })
    })

    const spec = keys<any>((r: any) => r.tags)
    const callback = vi.fn()
    const unsub = spec.watch!("entry1", ref, callback)

    // Mutate value inside the record — should NOT fire
    change(ref, (d: any) => {
      d.tags.at("urgent").label.set("Very Urgent")
    })

    expect(callback).not.toHaveBeenCalled()
    unsub()
  })

  it("watch fires on structural change (key removed)", () => {
    const ref = createDoc(TaggedDoc) as any
    change(ref, (d: any) => {
      d.tags.set("urgent", { label: "Urgent" })
      d.tags.set("bug", { label: "Bug" })
    })

    const spec = keys<any>((r: any) => r.tags)
    const callback = vi.fn()
    const unsub = spec.watch!("entry1", ref, callback)

    change(ref, (d: any) => {
      d.tags.delete("urgent")
    })

    expect(callback).toHaveBeenCalled()
    unsub()
  })
})