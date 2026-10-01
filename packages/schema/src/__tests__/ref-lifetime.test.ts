// ref lifetime — a ref lives while something holds it, and a coordinate stays
// in the trie while something needs it. Runs with `--expose-gc`
// (`vitest.config.ts`).
import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import {
  applyChanges,
  batch,
  createDoc,
  Schema,
  subscribe,
} from "../basic/index.js"
import { own, replaceChange, sequenceChange } from "../change.js"
import { __countKeptRefs, __countTrieNodes } from "../coordinate-trie.js"
import { deleted, deletedFeed } from "../index.js"
import { RawPath } from "../path.js"
import { TRANSACT } from "../ref/write.js"
import { withReadScope } from "../tracking.js"
import type { WritableContext } from "../writable-context.js"

const Doc = Schema.struct({
  rows: Schema.record(Schema.struct({ n: Schema.number() })),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})

const contextOf = (doc: any) => doc[TRANSACT] as WritableContext

const gc = (): void => {
  const collectGarbage = (globalThis as { gc?: () => void }).gc
  if (collectGarbage === undefined) throw new Error("run with --expose-gc")
  collectGarbage()
}

/**
 * Collect, then let the finalizers run. A `WeakRef` made in this job is kept
 * until it ends, and a finalizer runs in a task of its own, so each round
 * yields first.
 */
async function collect(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    gc()
  }
  await new Promise(resolve => setTimeout(resolve, 0))
}

function fixture(): any {
  const doc: any = createDoc(Doc)
  batch(doc, (d: any) => {
    for (let i = 0; i < 1000; i++) d.rows.set(`row-${i}`, { n: i })
    d.items.push({ name: "a" }, { name: "b" })
  })
  return doc
}

/** Navigate to every row and its field, holding nothing. */
function visitRows(doc: any): void {
  for (let i = 0; i < 1000; i++) doc.rows.at(`row-${i}`).n()
}

describe("refs live while held", () => {
  it("navigating to 1,000 entries and dropping them leaves no ref and no coordinate below the record", async () => {
    const doc = fixture()
    doc.rows.at("row-0")
    await collect()
    const before = __countTrieNodes(contextOf(doc))
    visitRows(doc)
    expect(__countTrieNodes(contextOf(doc))).toBeGreaterThan(before)
    await collect()
    expect(__countKeptRefs(contextOf(doc))).toBe(0)
    expect(__countTrieNodes(contextOf(doc))).toBe(before)
  })

  it("a held entry is the one at(k) hands back", async () => {
    const doc = fixture()
    const held = doc.rows.at("row-1")
    visitRows(doc)
    await collect()
    expect(doc.rows.at("row-1")).toBe(held)
  })

  it("holding only an entry's field keeps the entry", async () => {
    const doc = fixture()
    const heldN = doc.rows.at("row-2").n
    await collect()
    expect(doc.rows.at("row-2").n).toBe(heldN)
  })

  it("a held entry deleted and set again revives as the same ref", async () => {
    const doc = fixture()
    const held = doc.rows.at("row-3")
    doc.rows.delete("row-3")
    expect(deleted(held)).toBe(true)
    await collect()
    doc.rows.set("row-3", { n: 30 })
    expect(deleted(held)).toBe(false)
    expect(doc.rows.at("row-3")).toBe(held)
    expect(held.n()).toBe(30)
  })

  it("an unheld deleted entry is pruned", async () => {
    const doc = fixture()
    await collect()
    const before = __countTrieNodes(contextOf(doc))
    doc.rows.at("row-4").n()
    doc.rows.delete("row-4")
    await collect()
    expect(__countTrieNodes(contextOf(doc))).toBe(before)
  })
})

describe("what else keeps a coordinate", () => {
  it("a subscription on an entry outlives its collected ref", async () => {
    const doc = fixture()
    const heard: unknown[] = []
    subscribe(doc.rows.at("row-5"), changeset => heard.push(changeset))
    await collect()
    applyChanges(doc, [
      {
        path: RawPath.empty.field("rows").entry("row-5").field("n"),
        change: replaceChange(own(50)),
      },
    ])
    expect(heard).toHaveLength(1)
  })

  it("a subscription on a list item outlives its collected ref, through inserts before it", async () => {
    const doc = fixture()
    const heard: unknown[] = []
    subscribe(doc.items.at(1), changeset => heard.push(changeset))
    await collect()
    applyChanges(doc, [
      {
        path: RawPath.empty.field("items"),
        change: sequenceChange([{ insert: [own({ name: "z" })] }]),
      },
    ])
    await collect()
    applyChanges(doc, [
      {
        path: RawPath.empty.field("items").item(2).field("name"),
        change: replaceChange(own("B")),
      },
    ])
    expect(heard).toHaveLength(1)
  })

  it("a deletion listener keeps its coordinate, and hears the deletion", async () => {
    const doc = fixture()
    let heard = 0
    deletedFeed(doc.rows.at("row-6"))[CHANGEFEED].subscribe(() => {
      heard++
    })
    await collect()
    doc.rows.delete("row-6")
    expect(heard).toBe(1)
  })

  it("a tracking dependency holds its ref, so its key survives a collection", async () => {
    const doc = fixture()
    const read = () => withReadScope(() => doc.rows.at("row-7").n()).deps
    const first = read()
    await collect()
    expect(read().map(dep => dep.key)).toEqual(first.map(dep => dep.key))
  })
})
