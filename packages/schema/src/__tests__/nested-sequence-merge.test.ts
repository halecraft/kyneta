// A remote change to a sequence nested inside another sequence moves the
// nested sequence's addresses, exactly as a local write does. The change
// arrives with a raw path; the prepare pipeline resolves it before any stage
// runs, so the addressing stage finds the nested list's addresses under the
// same key a local write would.
import { describe, expect, it } from "vitest"
import { createRef, plainSubstrateFactory, Schema } from "../index.js"

const ListDoc = Schema.struct({
  items: Schema.list(Schema.struct({ tags: Schema.list(Schema.string()) })),
})

function peer() {
  const substrate = plainSubstrateFactory.create(ListDoc)
  return { substrate, doc: createRef(ListDoc, substrate) as any }
}

describe("a remote change to a nested sequence", () => {
  it("keeps every held carrier on the item it named", () => {
    const a = peer()
    a.doc.items.push({ tags: ["x", "y"] })
    const b = peer()
    b.substrate.merge(a.substrate.exportEntirety())

    const x = a.doc.items.at(0).tags.at(0)
    const y = a.doc.items.at(0).tags.at(1)
    expect(x()).toBe("x")

    const since = b.substrate.version()
    b.doc.items.at(0).tags.insert(0, "NEW")
    const delta = b.substrate.exportSince(since)
    if (delta === null) throw new Error("expected a delta")
    a.substrate.merge(delta)

    expect(a.doc.items.at(0).tags()).toEqual(["NEW", "x", "y"])
    expect(x()).toBe("x")
    expect(y()).toBe("y")
    expect(a.doc.items.at(0).tags.at(1)).toBe(x)
    expect(a.doc.items.at(0).tags.at(2)).toBe(y)

    // Identity stays right for later local writes too.
    a.doc.items.at(0).tags.delete(0, 1)
    expect(a.doc.items.at(0).tags.at(0)).toBe(x)
    expect(x()).toBe("x")
  })
})
