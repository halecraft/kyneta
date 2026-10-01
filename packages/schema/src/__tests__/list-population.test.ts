// list population — a list's items are populated exactly when the list is.
import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { applyChanges, batch, createDoc, Schema } from "../basic/index.js"
import { own, replaceChange, sequenceChange } from "../change.js"
import { __countTrieNodes } from "../coordinate-trie.js"
import { populated, populatedFeed } from "../index.js"
import { RawPath } from "../path.js"
import { TRANSACT } from "../ref/write.js"
import type { SubscriberNode } from "../subscriber-trie.js"
import type { WritableContext } from "../writable-context.js"
import { untypedDocOver } from "./stack.js"

const Doc = Schema.struct({
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})

const contextOf = (doc: any) => doc[TRANSACT] as WritableContext

/** The nodes below `node` in a subscriber trie. */
function countBelow(node: SubscriberNode): number {
  let count = 0
  for (const child of node.children.values()) count += 1 + countBelow(child)
  return count
}

/** A document over a plain state holding `n` items that nothing has
 *  populated. */
function seeded(n: number): any {
  const items = Array.from({ length: n }, (_, i) => ({ name: `item ${i}` }))
  return untypedDocOver(Doc, { items })
}

describe("a list's items are populated exactly when the list is", () => {
  it("an item that arrived by a remote insert is populated, and so are its fields", () => {
    const writer: any = createDoc(Doc)
    const reader: any = createDoc(Doc)
    const ops = batch(writer, (d: any) => d.items.push({ name: "a" }))
    applyChanges(reader, ops, { origin: "remote" })
    expect(populated(reader.items)).toBe(true)
    expect(populated(reader.items.at(0))).toBe(true)
    expect(populated(reader.items.at(0).name)).toBe(true)
  })

  it("an item's population listener fires when its list is first populated", () => {
    const doc = seeded(1)
    const item = doc.items.at(0)
    expect(populated(item)).toBe(false)
    let fired = 0
    populatedFeed(item)[CHANGEFEED].subscribe(() => {
      fired++
    })
    applyChanges(doc, [
      {
        path: RawPath.empty.field("items"),
        change: sequenceChange([
          { retain: 1 },
          { insert: [own({ name: "b" })] },
        ]),
      },
    ])
    expect(fired).toBe(1)
    expect(populated(item)).toBe(true)
  })

  it("ops into different list items nobody navigated create no node in either trie", () => {
    const doc = seeded(1000)
    const ctx = contextOf(doc)
    const write = (i: number) =>
      applyChanges(doc, [
        {
          path: RawPath.empty.field("items").item(i).field("name"),
          change: replaceChange(own(`name ${i}`)),
        },
      ])
    write(0)
    const subscribers = countBelow(ctx.subscribers.root)
    const coordinates = __countTrieNodes(ctx)
    for (let i = 1; i < 1000; i++) write(i)
    expect(countBelow(ctx.subscribers.root)).toBe(subscribers)
    expect(__countTrieNodes(ctx)).toBe(coordinates)
    expect(doc().items[999].name).toBe("name 999")
  })
})
