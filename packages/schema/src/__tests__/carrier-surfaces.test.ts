// carrier-surfaces — every member an `install…` helper declares is a member it
// actually attaches.
//
// The installers are assertion functions: `installListWriteOps` promises
// `asserts result is T & ListWriteOps`, and TypeScript takes that promise on
// trust. Nothing checks that the body delivers it. Declare `push` and define
// `psuh` and the code compiles, every existing test passes, and callers get a
// ref whose type says it has a method it does not have.
//
// The guard is a table of member names per surface, used twice:
//
//   - at *compile* time, `SameMembers` fails if the table and the interface
//     disagree, so adding a member to a surface without listing it here is a
//     type error;
//   - at *runtime*, each name is looked up on a ref built through the real
//     interpreter stack, so listing a member the installer never attaches is a
//     test failure.
//
// Neither half is sufficient alone. The type check alone would let an
// installer declare members it never defines; the runtime check alone would go
// quietly out of date as surfaces grow.

import { describe, expect, expectTypeOf, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import type {
  KeyedNavigation,
  KeyedReadable,
  KeyedWriteOps,
  ListWriteOps,
  RichTextWriteOps,
  SequenceNavigation,
  SequenceReadable,
  SetReadable,
  SetWriteOps,
  TextWriteOps,
  TreeNavigation,
  TreeReadable,
  TreeWriteOps,
} from "../index.js"
import { CALL, markCaching, markNavigation, markRead } from "../index.js"

/**
 * `true` only when `Names` is exactly the string-keyed members of `Surface`.
 * Any drift — a member added, removed or renamed on either side — makes this
 * resolve to `never`, and the `const _: true` below stops compiling.
 */
type SameMembers<Surface, Names extends string> = [
  Extract<keyof Surface, string>,
] extends [Names]
  ? [Names] extends [Extract<keyof Surface, string>]
    ? true
    : never
  : never

/** Members are non-enumerable by design, so `in` is the right lookup. */
function membersOf(ref: unknown, names: readonly string[]): string[] {
  return names.filter(name => !(name in (ref as object)))
}

const Doc = Schema.struct({
  title: Schema.text(),
  rich: Schema.richText({ bold: { expand: "after" } }),
  count: Schema.counter(),
  items: Schema.list(Schema.struct({ label: Schema.string() })),
  entries: Schema.record(Schema.number()),
  tags: Schema.set(Schema.string()),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

// ===========================================================================
// The tables — kept honest by the compiler
// ===========================================================================

const SET_READABLE = ["has", "size"] as const
const SET_WRITE_OPS = ["add", "delete", "clear"] as const
const KEYED_READABLE = ["get"] as const
const KEYED_WRITE_OPS = ["set", "delete", "clear"] as const
const KEYED_NAVIGATION = [
  "at",
  "has",
  "keys",
  "size",
  "entries",
  "values",
] as const
const SEQUENCE_READABLE = ["get"] as const
const SEQUENCE_NAVIGATION = ["at", "length"] as const
const LIST_WRITE_OPS = ["push", "insert", "delete"] as const
const TEXT_WRITE_OPS = ["insert", "delete", "update"] as const
const RICHTEXT_WRITE_OPS = [
  "insert",
  "delete",
  "update",
  "mark",
  "unmark",
] as const
const TREE_NAVIGATION = ["node", "has", "ids", "size"] as const
const TREE_READABLE = ["roots"] as const
const TREE_WRITE_OPS = ["create", "delete", "move"] as const

// Each line fails to compile if its table and its interface disagree. This is
// the half a runtime test cannot do: it catches a member *added* to a surface
// and never listed, which no amount of exercising refs would notice.
const _tablesMatchInterfaces: true[] = [
  true satisfies SameMembers<SetReadable, (typeof SET_READABLE)[number]>,
  true satisfies SameMembers<SetWriteOps, (typeof SET_WRITE_OPS)[number]>,
  true satisfies SameMembers<KeyedReadable, (typeof KEYED_READABLE)[number]>,
  true satisfies SameMembers<KeyedWriteOps, (typeof KEYED_WRITE_OPS)[number]>,
  true satisfies SameMembers<
    KeyedNavigation,
    (typeof KEYED_NAVIGATION)[number]
  >,
  true satisfies SameMembers<
    SequenceReadable,
    (typeof SEQUENCE_READABLE)[number]
  >,
  true satisfies SameMembers<
    SequenceNavigation,
    (typeof SEQUENCE_NAVIGATION)[number]
  >,
  true satisfies SameMembers<ListWriteOps, (typeof LIST_WRITE_OPS)[number]>,
  true satisfies SameMembers<TextWriteOps, (typeof TEXT_WRITE_OPS)[number]>,
  true satisfies SameMembers<
    RichTextWriteOps,
    (typeof RICHTEXT_WRITE_OPS)[number]
  >,
  true satisfies SameMembers<TreeNavigation, (typeof TREE_NAVIGATION)[number]>,
  true satisfies SameMembers<TreeReadable, (typeof TREE_READABLE)[number]>,
  true satisfies SameMembers<TreeWriteOps, (typeof TREE_WRITE_OPS)[number]>,
]

// ===========================================================================
// Read surfaces — on a ref outside a batch
// ===========================================================================

describe("read surfaces are attached", () => {
  it("attaches every member the set surfaces declare", () => {
    const doc: any = createDoc(Doc)
    expect(membersOf(doc.tags, SET_READABLE)).toEqual([])
  })

  it("attaches every member the keyed surfaces declare", () => {
    const doc: any = createDoc(Doc)
    expect(membersOf(doc.entries, KEYED_READABLE)).toEqual([])
    expect(membersOf(doc.entries, KEYED_NAVIGATION)).toEqual([])
  })

  it("attaches every member the sequence surfaces declare", () => {
    const doc: any = createDoc(Doc)
    expect(membersOf(doc.items, SEQUENCE_READABLE)).toEqual([])
    expect(membersOf(doc.items, SEQUENCE_NAVIGATION)).toEqual([])
  })

  it("attaches every member the tree surfaces declare", () => {
    const doc: any = createDoc(Doc)
    expect(membersOf(doc.tree, TREE_NAVIGATION)).toEqual([])
    expect(membersOf(doc.tree, TREE_READABLE)).toEqual([])
  })

  it("fills the [CALL] slot on every carrier that declares one", () => {
    // `[CALL]` is a symbol, so it sits outside the name tables above — and it
    // is the member most easily lost, since installers set it last.
    const doc: any = createDoc(Doc)
    for (const ref of [doc.tags, doc.entries, doc.items, doc.tree]) {
      expect(typeof ref[CALL]).toBe("function")
    }
  })

  it("makes the iterable carriers iterable", () => {
    // Also symbol-keyed, and also easy to drop.
    const doc: any = createDoc(Doc)
    for (const ref of [doc.tags, doc.entries, doc.items, doc.tree]) {
      expect(typeof ref[Symbol.iterator]).toBe("function")
    }
  })
})

// ===========================================================================
// Write surfaces — only present on the ref a batch hands you
// ===========================================================================

describe("write surfaces are attached", () => {
  it("attaches every member the write surfaces declare", () => {
    const doc: any = createDoc(Doc)
    const missing: Record<string, string[]> = {}

    batch(doc, (d: any) => {
      missing.set = membersOf(d.tags, SET_WRITE_OPS)
      missing.keyed = membersOf(d.entries, KEYED_WRITE_OPS)
      missing.list = membersOf(d.items, LIST_WRITE_OPS)
      missing.text = membersOf(d.title, TEXT_WRITE_OPS)
      missing.richtext = membersOf(d.rich, RICHTEXT_WRITE_OPS)
      missing.tree = membersOf(d.tree, TREE_WRITE_OPS)
    })

    expect(missing).toEqual({
      set: [],
      keyed: [],
      list: [],
      text: [],
      richtext: [],
      tree: [],
    })
  })

  it("attaches members that work, not just members that exist", () => {
    // `in` would be satisfied by a member attached with the wrong body. One
    // call per surface, checked through the document's own state.
    const doc: any = createDoc(Doc)
    let nodeId = ""

    batch(doc, (d: any) => {
      d.tags.add("a")
      d.entries.set("k", 1)
      d.items.push({ label: "first" })
      d.title.insert(0, "hello")
      d.count.increment(2)
      nodeId = d.tree.create({ data: { label: "root" } })
    })

    expect(doc.tags.has("a")).toBe(true)
    expect(doc.entries.at("k")()).toBe(1)
    expect(doc.items.at(0).label()).toBe("first")
    expect(doc.title()).toBe("hello")
    expect(doc.count()).toBe(2)
    expect(doc.tree.has(nodeId)).toBe(true)
  })
})

// ===========================================================================
// The brand markers
// ===========================================================================

describe("brand markers", () => {
  it("narrow without touching the value", () => {
    // The empty body is the contract. A marker that "helpfully" started
    // assigning its brand would put a symbol on every ref in the system, and
    // nothing else here would notice.
    const before = { kept: 1 }
    const snapshot = {
      keys: Object.keys(before),
      symbols: Object.getOwnPropertySymbols(before),
    }

    markRead(before)
    markNavigation(before)
    markCaching(before)

    expect(Object.keys(before)).toEqual(snapshot.keys)
    expect(Object.getOwnPropertySymbols(before)).toEqual(snapshot.symbols)
  })

  it("narrow the type they are given", () => {
    const carrier: unknown = {}
    if (typeof carrier === "object" && carrier !== null) {
      markRead(carrier)
      // Narrowed, and specifically not `any` — the failure mode that would
      // make every other assertion in this file vacuous.
      expectTypeOf(carrier).not.toBeAny()
    }
  })
})
