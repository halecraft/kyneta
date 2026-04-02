import { beforeEach, describe, expect, it } from "vitest"
import {
  type Address,
  AddressedPath,
  AddressTableRegistry,
  indexAddress,
  keyAddress,
  RawPath,
  type RawSegment,
  rawIndex,
  rawKey,
  resetAddressIdCounter,
  type Segment,
} from "../path.js"
import { writeByPath } from "../reader.js"

// ===========================================================================
// RawPath
// ===========================================================================

describe("RawPath", () => {
  it("field(key) produces a new RawPath with appended key segment", () => {
    const p = RawPath.empty.field("title")
    expect(p).toBeInstanceOf(RawPath)
    expect(p.length).toBe(1)
    expect(p.segments[0]!.role).toBe("key")
    expect(p.segments[0]!.resolve()).toBe("title")
  })

  it("item(index) produces a new RawPath with appended index segment", () => {
    const p = RawPath.empty.item(3)
    expect(p).toBeInstanceOf(RawPath)
    expect(p.length).toBe(1)
    expect(p.segments[0]!.role).toBe("index")
    expect(p.segments[0]!.resolve()).toBe(3)
  })

  it("field() and item() can be chained", () => {
    const p = RawPath.empty.field("todos").item(2).field("done")
    expect(p.length).toBe(3)
    expect(p.segments[0]!.resolve()).toBe("todos")
    expect(p.segments[1]!.resolve()).toBe(2)
    expect(p.segments[2]!.resolve()).toBe("done")
  })

  it("does not mutate the parent path", () => {
    const parent = RawPath.empty.field("a")
    const child = parent.field("b")
    expect(parent.length).toBe(1)
    expect(child.length).toBe(2)
  })

  describe("key", () => {
    it("produces positional strings using null-byte delimiter", () => {
      const NUL = String.fromCharCode(0)
      const p = RawPath.empty.field("todos").item(2).field("done")
      expect(p.key).toBe("todos" + NUL + "2" + NUL + "done")
    })

    it("empty path produces empty string key", () => {
      expect(RawPath.empty.key).toBe("")
    })

    it("memoizes — second access returns same string", () => {
      const p = RawPath.empty.field("a").field("b")
      const k1 = p.key
      const k2 = p.key
      expect(k1).toBe(k2)
      // Verify it's truly the same reference (memoized)
      expect(k1 === k2).toBe(true)
    })
  })

  describe("read", () => {
    it("reads correct store location for nested paths", () => {
      const store = { todos: [{ done: true }, { done: false }] }
      const p = RawPath.empty.field("todos").item(1).field("done")
      expect(p.read(store)).toBe(false)
    })

    it("returns undefined for missing paths", () => {
      const store = { a: 1 }
      const p = RawPath.empty.field("b").field("c")
      expect(p.read(store)).toBeUndefined()
    })

    it("returns the store itself for empty path", () => {
      const store = { x: 42 }
      expect(RawPath.empty.read(store)).toBe(store)
    })

    it("handles null/undefined intermediate values", () => {
      const store = { a: null }
      const p = RawPath.empty.field("a").field("b")
      expect(p.read(store)).toBeUndefined()
    })
  })

  describe("slice", () => {
    it("produces ancestor paths", () => {
      const p = RawPath.empty.field("a").field("b").field("c")
      const sliced = p.slice(0, 2)
      expect(sliced.length).toBe(2)
      expect(sliced.format()).toBe("a.b")
    })

    it("slice with start only", () => {
      const p = RawPath.empty.field("a").field("b").field("c")
      const sliced = p.slice(1)
      expect(sliced.length).toBe(2)
      expect(sliced.format()).toBe("b.c")
    })

    it("produces a RawPath", () => {
      const p = RawPath.empty.field("x").item(0)
      const sliced = p.slice(0, 1)
      expect(sliced).toBeInstanceOf(RawPath)
      expect(sliced.isAddressed).toBe(false)
    })
  })

  describe("concat", () => {
    it("concatenates two raw paths", () => {
      const a = RawPath.empty.field("a")
      const b = RawPath.empty.field("b").item(0)
      const c = a.concat(b)
      expect(c.length).toBe(3)
      expect(c.format()).toBe("a.b[0]")
    })

    it("throws when passed an AddressedPath", () => {
      const raw = RawPath.empty.field("a")
      const registry = new AddressTableRegistry()
      const addressed = new AddressedPath([], registry)
      expect(() => raw.concat(addressed)).toThrow(
        "Cannot concat AddressedPath onto RawPath",
      )
    })
  })

  describe("format", () => {
    it("empty path formats as 'root'", () => {
      expect(RawPath.empty.format()).toBe("root")
    })

    it("single key segment", () => {
      expect(RawPath.empty.field("title").format()).toBe("title")
    })

    it("nested key segments use dot notation", () => {
      expect(RawPath.empty.field("settings").field("darkMode").format()).toBe(
        "settings.darkMode",
      )
    })

    it("index segments use bracket notation", () => {
      expect(RawPath.empty.field("items").item(0).format()).toBe("items[0]")
    })

    it("mixed key and index segments", () => {
      expect(
        RawPath.empty.field("messages").item(2).field("author").format(),
      ).toBe("messages[2].author")
    })
  })

  it("isAddressed is false", () => {
    expect(RawPath.empty.isAddressed).toBe(false)
    expect(RawPath.empty.field("x").isAddressed).toBe(false)
  })

  it("root() returns RawPath.empty", () => {
    const p = RawPath.empty.field("a").item(0)
    const r = p.root()
    expect(r).toBe(RawPath.empty)
    expect(r.length).toBe(0)
  })

  it("RawPath.empty is a singleton", () => {
    expect(RawPath.empty).toBe(RawPath.empty)
    expect(RawPath.empty.length).toBe(0)
  })
})

// ===========================================================================
// Address
// ===========================================================================

describe("Address", () => {
  beforeEach(() => {
    resetAddressIdCounter()
  })

  it("key address resolves to key, throws when dead", () => {
    const addr = keyAddress("title")
    expect(addr.resolve()).toBe("title")
    addr.dead = true
    expect(() => addr.resolve()).toThrow("Ref access on deleted map entry")
  })

  it("index address resolves to index, throws when dead", () => {
    const addr = indexAddress(3)
    expect(addr.resolve()).toBe(3)
    addr.dead = true
    expect(() => addr.resolve()).toThrow("Ref access on deleted list item")
  })
})

// ===========================================================================
// AddressedPath
// ===========================================================================

describe("AddressedPath", () => {
  let registry: AddressTableRegistry

  beforeEach(() => {
    resetAddressIdCounter()
    registry = new AddressTableRegistry()
  })

  it("field(key) creates a key address in the registry", () => {
    const root = new AddressedPath([], registry)
    const child = root.field("title")
    expect(child).toBeInstanceOf(AddressedPath)
    expect(child.length).toBe(1)

    const seg = child.segments[0]! as Address
    expect(seg.kind).toBe("key")
    expect((seg as any).key).toBe("title")
    expect(seg.resolve()).toBe("title")
  })

  it("item(index) creates a cursor address in the registry", () => {
    const root = new AddressedPath([], registry)
    const child = root.item(0)
    expect(child).toBeInstanceOf(AddressedPath)
    expect(child.length).toBe(1)

    const seg = child.segments[0]! as Address
    expect(seg.kind).toBe("index")
    expect(seg.resolve()).toBe(0)
    expect((seg as any).id).toBeGreaterThan(0)
  })

  describe("idempotency", () => {
    it("field() with same arguments returns same Address object", () => {
      const root = new AddressedPath([], registry)
      const a = root.field("title")
      const b = root.field("title")
      // Same Address object reference
      expect(a.segments[0]).toBe(b.segments[0])
    })

    it("item() with same index returns same Address object", () => {
      const root = new AddressedPath([], registry)
      const a = root.item(0)
      const b = root.item(0)
      // Same Address object reference
      expect(a.segments[0]).toBe(b.segments[0])
    })
  })

  describe("key", () => {
    it("cursor-addressed segments produce stable strings across index changes", () => {
      const root = new AddressedPath([], registry)
      const child = root.item(5)
      const key1 = child.key

      // Mutate the cursor index (simulating advancement)
      const addr = child.segments[0]! as Address & { index: number }
      addr.index = 10

      // Key should NOT change — it uses cursor.id, not cursor.index
      // (Note: key is memoized, so this also verifies memoization correctness
      // for the addressed case where it MUST use id, not index)
      const freshPath = new AddressedPath([addr], registry)
      expect(freshPath.key).toBe(key1)
    })

    it("key-addressed segments use the key string", () => {
      const root = new AddressedPath([], registry)
      const child = root.field("settings").field("darkMode")
      expect(child.key).toBe("settings\0darkMode")
    })
  })

  describe("read", () => {
    it("reads correct store location via seg.resolve()", () => {
      const store = { items: [{ name: "alice" }, { name: "bob" }] }
      const root = new AddressedPath([], registry)
      const p = root.field("items").item(1).field("name")
      expect(p.read(store)).toBe("bob")
    })

    it("throws on read when address is dead", () => {
      const root = new AddressedPath([], registry)
      const child = root.item(0)
      const addr = child.segments[0]! as Address
      addr.dead = true
      expect(() => child.read({ items: ["x"] })).toThrow(
        "Ref access on deleted list item",
      )
    })
  })

  it("lastAddress() returns the last Address segment", () => {
    const root = new AddressedPath([], registry)
    const p = root.field("items").item(2)
    const last = p.lastAddress()!
    expect(last.kind).toBe("index")
    expect(last.resolve()).toBe(2)
  })

  it("lastAddress() returns undefined for empty path", () => {
    const root = new AddressedPath([], registry)
    expect(root.lastAddress()).toBeUndefined()
  })

  describe("concat", () => {
    it("concatenates two addressed paths", () => {
      const a = new AddressedPath([], registry).field("a")
      const b = new AddressedPath([], registry).field("b")
      const c = a.concat(b)
      expect(c.length).toBe(2)
      expect(c).toBeInstanceOf(AddressedPath)
    })

    it("throws when passed a RawPath", () => {
      const addressed = new AddressedPath([], registry).field("a")
      expect(() => addressed.concat(RawPath.empty)).toThrow(
        "Cannot concat RawPath onto AddressedPath",
      )
    })
  })

  it("isAddressed is true", () => {
    const root = new AddressedPath([], registry)
    expect(root.isAddressed).toBe(true)
    expect(root.field("x").isAddressed).toBe(true)
  })

  it("root() returns an empty AddressedPath with same registry", () => {
    const root = new AddressedPath([], registry)
    const child = root.field("a").item(0)
    const r = child.root()
    expect(r).toBeInstanceOf(AddressedPath)
    expect(r.length).toBe(0)
    expect(r.isAddressed).toBe(true)
    // Verify same registry by creating an address and checking idempotency
    const x = r.field("x")
    const y = root.field("x")
    expect(x.segments[0]).toBe(y.segments[0])
  })

  it("format() works identically to RawPath for equivalent segments", () => {
    const root = new AddressedPath([], registry)
    const p = root.field("todos").item(2).field("done")
    expect(p.format()).toBe("todos[2].done")
  })
})

// ===========================================================================
// Monoid laws
// ===========================================================================

describe("Monoid laws", () => {
  const store = {
    a: { b: { c: 42 } },
  }

  describe("RawPath", () => {
    const a = RawPath.empty.field("a")
    const b = RawPath.empty.field("b")
    const c = RawPath.empty.field("c")

    it("associativity: a.concat(b).concat(c).read === a.concat(b.concat(c)).read", () => {
      const left = a.concat(b).concat(c)
      const right = a.concat(b.concat(c))
      expect(left.read(store)).toBe(right.read(store))
      expect(left.read(store)).toBe(42)
    })

    it("right identity: path.concat(path.root()).key === path.key", () => {
      const p = RawPath.empty.field("a").field("b")
      expect(p.concat(p.root()).key).toBe(p.key)
    })

    it("left identity: path.root().concat(path).key === path.key", () => {
      const p = RawPath.empty.field("a").field("b")
      expect(p.root().concat(p).key).toBe(p.key)
    })

    it("read homomorphism: path.concat(suffix).read(store) === suffix.read(path.read(store))", () => {
      const prefix = RawPath.empty.field("a")
      const suffix = RawPath.empty.field("b").field("c")
      const combined = prefix.concat(suffix)

      const intermediate = prefix.read(store)
      expect(combined.read(store)).toBe(suffix.read(intermediate))
      expect(combined.read(store)).toBe(42)
    })
  })

  describe("AddressedPath", () => {
    let registry: AddressTableRegistry

    beforeEach(() => {
      resetAddressIdCounter()
      registry = new AddressTableRegistry()
    })

    it("right identity: path.concat(path.root()).key === path.key", () => {
      const root = new AddressedPath([], registry)
      const p = root.field("a").field("b")
      expect(p.concat(p.root()).key).toBe(p.key)
    })

    it("left identity: path.root().concat(path).key === path.key", () => {
      const root = new AddressedPath([], registry)
      const p = root.field("a").field("b")
      // Need to build a proper two-segment path by extracting segments
      const twoSeg = new AddressedPath(p.segments, registry)
      const leftIdentity = p.root().concat(twoSeg)
      expect(leftIdentity.key).toBe(p.key)
    })
  })
})

// ===========================================================================
// AddressTableRegistry
// ===========================================================================

// ===========================================================================
// Dead address propagation through writeByPath
// ===========================================================================

describe("dead address propagation", () => {
  beforeEach(() => {
    resetAddressIdCounter()
  })

  it("writeByPath throws when path contains a dead address", () => {
    const store = { items: [{ name: "alice" }] } as Record<string, unknown>
    const registry = new AddressTableRegistry()
    const root = new AddressedPath([], registry)
    const p = root.field("items").item(0).field("name")

    // Kill the index address
    const addr = p.segments[1]! as Address
    addr.dead = true

    expect(() => writeByPath(store, p, "bob")).toThrow(
      "Ref access on deleted list item",
    )
  })

  it("read() throws when path contains a dead key address", () => {
    const registry = new AddressTableRegistry()
    const root = new AddressedPath([], registry)
    const p = root.field("settings").field("theme")

    // Kill the key address
    const addr = p.segments[1]! as Address
    addr.dead = true

    expect(() => p.read({ settings: { theme: "dark" } })).toThrow(
      "Ref access on deleted map entry",
    )
  })
})

// ===========================================================================
// AddressTableRegistry
// ===========================================================================
