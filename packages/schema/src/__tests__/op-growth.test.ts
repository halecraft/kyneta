// op growth — an op's path is located, not created: ops leave nothing behind
// in either trie but what population needs.
import { describe, expect, it } from "vitest"
import { own, replaceChange, sequenceChange } from "../change.js"
import { __countTrieNodes } from "../coordinate-trie.js"
import {
  applyChanges,
  batch,
  createDoc,
  exportSince,
  json,
  merge,
  RawPath,
  Schema,
  version,
} from "../index.js"
import type { SubscriberNode } from "../interpreters/subscriber-trie.js"
import { TRANSACT, type WritableContext } from "../interpreters/writable.js"

const Rows = Schema.struct({
  rows: Schema.record(Schema.struct({ n: Schema.number() })),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})

const contextOf = (doc: any) => doc[TRANSACT] as WritableContext

function countBelow(node: SubscriberNode): number {
  let count = 0
  for (const child of node.children.values()) count += 1 + countBelow(child)
  return count
}

describe("ops create no coordinates", () => {
  it("merged batches, each writing a different row, leave both tries as they were", () => {
    const writer: any = createDoc(json.bind(Rows))
    const seed = version(writer)
    batch(writer, (d: any) => {
      for (let i = 0; i < 1000; i++) d.rows.set(`row-${i}`, { n: i })
    })
    const rows = exportSince(writer, seed)
    const payloads: unknown[] = []
    for (let i = 0; i < 1000; i++) {
      const since = version(writer)
      applyChanges(writer, [
        {
          path: RawPath.empty.field("rows").entry(`row-${i}`).field("n"),
          change: replaceChange(own(-i - 1)),
        },
      ])
      payloads.push(exportSince(writer, since))
    }

    const receiver: any = createDoc(json.bind(Rows))
    merge(receiver, rows as never)
    const ctx = contextOf(receiver)
    const coordinates = __countTrieNodes(ctx)
    const subscribers = countBelow(ctx.subscribers.root)
    for (const payload of payloads) merge(receiver, payload as never)
    expect(__countTrieNodes(ctx)).toBe(coordinates)
    expect(countBelow(ctx.subscribers.root)).toBe(subscribers)
    expect(receiver().rows["row-999"].n).toBe(-1000)
  })
})

describe("compensation through located paths", () => {
  const start = (navigate: boolean): any => {
    const doc: any = createDoc(json.bind(Rows))
    batch(doc, (d: any) => {
      d.items.push({ name: "a" }, { name: "b" })
    })
    if (navigate) doc.items.at(1).name()
    return doc
  }

  for (const navigate of [false, true]) {
    it(`an aborted batch writing to ${navigate ? "a navigated" : "an un-navigated"} item, then inserting before it, leaves the document as it was`, () => {
      const doc = start(navigate)
      const before = doc()
      expect(() =>
        batch(doc, (d: any) => {
          applyChanges(d, [
            {
              path: RawPath.empty.field("items").item(1).field("name"),
              change: replaceChange(own("B")),
            },
            {
              path: RawPath.empty.field("items"),
              change: sequenceChange([{ insert: [own({ name: "z" })] }]),
            },
          ])
          throw new Error("abort")
        }),
      ).toThrow("abort")
      expect(doc()).toEqual(before)
    })
  }
})
