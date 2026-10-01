// ref-surfaces — every member a ref's type declares is a member a real ref
// carries.
//
// A ref's types (`Readable<S>`, `Ref<S>` and the surfaces they are built
// from) are interfaces, and
// its members are defined on its prototype by name (`ref/read.ts`,
// `navigate.ts`, `write.ts`). Nothing ties the two: declare `push` and define
// `psuh` and the code compiles, and callers get a ref whose type says it has
// a method it does not have.
//
// The guard is a table of member names per interface, used twice:
//
//   - at *compile* time, `SameMembers` fails if the table and the interface
//     disagree, so adding a member to an interface without listing it here
//     is a type error;
//   - at *runtime*, each name is looked up on a ref of a real document, so
//     listing a member no ref defines is a test failure.
//
// Neither half is sufficient alone. The type check alone would let an
// interface declare members no ref defines; the runtime check alone would go
// quietly out of date as the interfaces grow.

import { describe, expect, it } from "vitest"
import { batch, createDoc, Schema } from "../basic/index.js"
import type {
  CounterRef,
  ProductRef,
  ReadableMapRef,
  ReadableSequenceRef,
  ReadableSetRef,
  ReadableTreeRef,
  RichTextRef,
  ScalarRef,
  Schema as SchemaNode,
  SequenceRef,
  TextRef,
  WritableMapRef,
  WritableSetRef,
  WritableTreeRef,
} from "../index.js"
import { CALL } from "../index.js"

/**
 * `true` only when `Names` is exactly the string-keyed members of `Surface`.
 * Any drift (a member added, removed or renamed on either side) makes this
 * resolve to `never`, and the `true[]` below stops compiling.
 */
type SameMembers<Surface, Names extends string> = [
  Extract<keyof Surface, string>,
] extends [Names]
  ? [Names] extends [Extract<keyof Surface, string>]
    ? true
    : never
  : never

/** The names in `names` that `ref` lacks. Members live on the prototype,
 *  so `in` is the lookup. */
function missing(ref: unknown, names: readonly string[]): string[] {
  return names.filter(name => !(name in (ref as object)))
}

const Doc = Schema.struct({
  title: Schema.text(),
  rich: Schema.richText({ bold: { expand: "after" } }),
  count: Schema.counter(),
  flag: Schema.boolean(),
  items: Schema.list(Schema.struct({ label: Schema.string() })),
  moves: Schema.movableList(Schema.string()),
  entries: Schema.record(Schema.number()),
  tags: Schema.set(Schema.string()),
  tree: Schema.tree(Schema.struct({ label: Schema.string() })),
})

// ===========================================================================
// The tables — kept honest by the compiler
// ===========================================================================

const SET_READ = ["has", "size"] as const
const SET_WRITE = ["add", "delete", "clear"] as const
const MAP_READ = [
  "at",
  "has",
  "keys",
  "size",
  "entries",
  "values",
  "get",
] as const
const MAP_WRITE = ["set", "delete", "clear"] as const
const SEQUENCE_READ = ["at", "length", "get"] as const
const SEQUENCE_WRITE = ["push", "insert", "delete"] as const
const TEXT_WRITE = ["insert", "delete", "update"] as const
const RICHTEXT_WRITE = ["insert", "delete", "update", "mark", "unmark"] as const
const COUNTER_WRITE = ["increment", "decrement"] as const
const SCALAR_WRITE = ["set"] as const
const PRODUCT_WRITE = ["set"] as const
const TREE_READ = ["roots", "node", "has", "ids", "size"] as const
const TREE_WRITE = ["create", "delete", "move"] as const

type Names<T extends readonly string[]> = T[number]

// Each line fails to compile if its table and its interface disagree. This is
// the half a runtime test cannot do: it catches a member *added* to an
// interface and never listed, which no amount of exercising refs would notice.
const _tablesMatchInterfaces: true[] = [
  true satisfies SameMembers<ReadableSetRef, Names<typeof SET_READ>>,
  true satisfies SameMembers<WritableSetRef, Names<typeof SET_WRITE>>,
  true satisfies SameMembers<ReadableMapRef, Names<typeof MAP_READ>>,
  true satisfies SameMembers<WritableMapRef, Names<typeof MAP_WRITE>>,
  true satisfies SameMembers<ReadableSequenceRef, Names<typeof SEQUENCE_READ>>,
  true satisfies SameMembers<SequenceRef, Names<typeof SEQUENCE_WRITE>>,
  true satisfies SameMembers<TextRef, Names<typeof TEXT_WRITE>>,
  true satisfies SameMembers<RichTextRef, Names<typeof RICHTEXT_WRITE>>,
  true satisfies SameMembers<CounterRef, Names<typeof COUNTER_WRITE>>,
  true satisfies SameMembers<ScalarRef, Names<typeof SCALAR_WRITE>>,
  true satisfies SameMembers<ProductRef, Names<typeof PRODUCT_WRITE>>,
  true satisfies SameMembers<
    ReadableTreeRef<SchemaNode, unknown>,
    Names<typeof TREE_READ>
  >,
  true satisfies SameMembers<WritableTreeRef, Names<typeof TREE_WRITE>>,
]

// ===========================================================================
// Every declared member is on a real ref
// ===========================================================================

describe("ref surfaces", () => {
  it("every ref carries every member its type declares", () => {
    const doc: any = createDoc(Doc)
    batch(doc, (d: any) => d.items.push({ label: "a" }))
    expect({
      setRead: missing(doc.tags, SET_READ),
      setWrite: missing(doc.tags, SET_WRITE),
      mapRead: missing(doc.entries, MAP_READ),
      mapWrite: missing(doc.entries, MAP_WRITE),
      listRead: missing(doc.items, SEQUENCE_READ),
      listWrite: missing(doc.items, SEQUENCE_WRITE),
      movableRead: missing(doc.moves, SEQUENCE_READ),
      movableWrite: missing(doc.moves, SEQUENCE_WRITE),
      text: missing(doc.title, TEXT_WRITE),
      richtext: missing(doc.rich, RICHTEXT_WRITE),
      counter: missing(doc.count, COUNTER_WRITE),
      scalar: missing(doc.flag, SCALAR_WRITE),
      product: missing(doc.items.at(0), PRODUCT_WRITE),
      treeRead: missing(doc.tree, TREE_READ),
      treeWrite: missing(doc.tree, TREE_WRITE),
    }).toEqual({
      setRead: [],
      setWrite: [],
      mapRead: [],
      mapWrite: [],
      listRead: [],
      listWrite: [],
      movableRead: [],
      movableWrite: [],
      text: [],
      richtext: [],
      counter: [],
      scalar: [],
      product: [],
      treeRead: [],
      treeWrite: [],
    })
  })

  it("every ref is callable through [CALL], and every collection iterable", () => {
    // Both symbol-keyed, so outside the name tables above.
    const doc: any = createDoc(Doc)
    for (const ref of [doc.tags, doc.entries, doc.items, doc.moves, doc.tree]) {
      expect(typeof ref[CALL]).toBe("function")
      expect(typeof ref[Symbol.iterator]).toBe("function")
    }
  })

  it("the members work, not just exist", () => {
    // `in` would be satisfied by a member with the wrong body. One call per
    // interface, checked through the document's own state.
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
    expect(doc.tree.node(nodeId).label()).toBe("root")
  })
})
