// yjs-surface.test — every Yjs call undo depends on, pinned.
//
// Undo (`src/undo/`) is built on Yjs's public API alone, so that a
// Yjs upgrade cannot break it silently. Each case here exercises one call
// the way undo uses it; an upgrade that changes one fails here first. Each
// runs with gc on, and across a reload where undo relies on that.

import { describe, expect, it } from "vitest"
import * as Y from "yjs"

function reload(doc: Y.Doc): Y.Doc {
  const fresh = new Y.Doc()
  fresh.clientID = doc.clientID
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc))
  return fresh
}

function textDoc(content: string): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc()
  doc.clientID = 1
  const text = new Y.Text()
  doc.getMap("root").set("t", text)
  text.insert(0, content)
  return { doc, text }
}

type YChange = { type: string; id: { client: number; clock: number } }
const computeYChange = (type: string, id: Y.ID): YChange => ({
  type,
  id: { client: id.client, clock: id.clock },
})

describe("relative positions", () => {
  it("name the item at an index, as JSON", () => {
    const { text } = textDoc("abc")
    const json = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 1, 0),
    ) as { item?: { client: number; clock: number } }
    expect(json.item?.client).toBe(1)
    expect(typeof json.item?.clock).toBe("number")
  })

  it("resolve from an item id to where a deleted item was, after gc and a reload", () => {
    const { doc, text } = textDoc("hello world")
    const id = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 3, 0),
    ) as { item: { client: number; clock: number } }
    text.delete(3, 5)
    const reloaded = reload(doc)
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON({ item: id.item, assoc: 0 }),
      reloaded,
    )
    expect(abs?.index).toBe(3)
    expect(abs?.type).toBe(reloaded.getMap("root").get("t"))
  })

  it("resolve a live item to its type and index", () => {
    const { doc, text } = textDoc("abc")
    const id = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 2, 0),
    ) as { item: { client: number; clock: number } }
    text.insert(0, "zz")
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON({ item: id.item, assoc: 0 }),
      doc,
    )
    expect(abs).toEqual(expect.objectContaining({ index: 4, type: text }))
  })

  it("resolve just after an item, live or deleted, after a reload", () => {
    const { doc, text } = textDoc("hello")
    const l = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 2, 0),
    ) as { item: { client: number; clock: number } }
    const after = () =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON({ item: l.item, assoc: -1 }),
        reload(doc),
      )?.index
    expect(after()).toBe(3)
    text.delete(1, 3)
    expect(after()).toBe(1)
  })

  it("a text insert goes past the tombstones to its right; an array insert before them", () => {
    const { text } = textDoc("abc")
    const b = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(text, 1, 0),
    ) as { item: { client: number; clock: number } }
    text.delete(1, 1)
    text.insert(1, "X")
    // "b"'s tombstone resolves before the X inserted at its index.
    const at = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON({ item: b.item, assoc: 0 }),
      text.doc as Y.Doc,
    )?.index
    expect(at).toBe(1)
    const doc = new Y.Doc()
    const list = doc.getMap("root").set("l", new Y.Array<string>())
    list.insert(0, ["a", "b", "c"])
    const item = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(list, 1, 0),
    ) as { item: { client: number; clock: number } }
    list.delete(1, 1)
    list.insert(1, ["X"])
    expect(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON({ item: item.item, assoc: 0 }),
        doc,
      )?.index,
    ).toBe(2)
  })

  it("name the item at an index of an array", () => {
    const doc = new Y.Doc()
    const list = doc.getMap("root").set("l", new Y.Array<number>())
    list.insert(0, [1, 2, 3])
    const json = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(list, 2, 0),
    ) as { item?: unknown }
    expect(json.item).toBeDefined()
  })
})

describe("liveness and clocks", () => {
  it("isDeleted over a snapshot's delete set says whether an item is gone, after a reload", () => {
    const { doc, text } = textDoc("abc")
    text.delete(0, 1)
    const reloaded = reload(doc)
    const ds = Y.snapshot(reloaded).ds
    // The root's text item is clock 0, so "a" is clock 1.
    expect(Y.isDeleted(ds, Y.createID(1, 1))).toBe(true)
    expect(Y.isDeleted(ds, Y.createID(1, 2))).toBe(false)
  })

  it("getState is a client's next clock", () => {
    const { doc } = textDoc("abc")
    expect(Y.getState(doc.store, 1)).toBe(4) // the root's text item, then 3 chars
  })
})

describe("transactions and events", () => {
  it("afterTransaction sees local, beforeState and afterState", () => {
    const { doc, text } = textDoc("")
    const seen: { local: boolean; grew: number }[] = []
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      seen.push({
        local: tr.local,
        grew: (tr.afterState.get(1) ?? 0) - (tr.beforeState.get(1) ?? 0),
      })
    })
    text.insert(0, "ab")
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    other.getMap<Y.Text>("root").get("t")?.insert(0, "x")
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)))
    expect(seen[0]).toEqual({ local: true, grew: 2 })
    expect(seen.at(-1)?.local).toBe(false)
  })

  it("an array event lists the items it added, with ids and lengths", () => {
    const doc = new Y.Doc()
    const list = doc.getMap("root").set("l", new Y.Array<number>())
    let added: { client: number; clock: number; length: number }[] = []
    doc.getMap("root").observeDeep(events => {
      for (const event of events) {
        for (const item of event.changes.added) {
          added.push({
            client: item.id.client,
            clock: item.id.clock,
            length: item.length,
          })
        }
      }
    })
    list.insert(0, [1, 2, 3])
    expect(added).toEqual([
      { client: doc.clientID, clock: expect.any(Number), length: 3 },
    ])
    added = []
  })
})

describe("text in document order, through two snapshots", () => {
  it("names what a transaction removed and added, with ids, before gc", () => {
    const { doc, text } = textDoc("")
    text.insert(0, "ac")
    text.insert(1, "b") // ids a=1 c=2 b=3: order a b c
    let runs: unknown[] = []
    doc.getMap("root").observeDeep((_events, tr) => {
      const before = Y.createSnapshot(Y.createDeleteSet(), tr.beforeState)
      runs = text.toDelta(Y.snapshot(doc), before, computeYChange)
    })
    doc.transact(() => {
      text.delete(0, 3)
      text.insert(0, "X")
    })
    // Removed text in document order, not clock order; then the insert,
    // which went in after the deleted items it was typed over.
    expect(runs).toEqual([
      {
        insert: "a",
        attributes: { ychange: computeYChange("removed", Y.createID(1, 1)) },
      },
      {
        insert: "b",
        attributes: { ychange: computeYChange("removed", Y.createID(1, 3)) },
      },
      {
        insert: "c",
        attributes: { ychange: computeYChange("removed", Y.createID(1, 2)) },
      },
      {
        insert: "X",
        attributes: { ychange: computeYChange("added", Y.createID(1, 4)) },
      },
    ])
  })

  it("names every live character when compared with nothing", () => {
    const { doc, text } = textDoc("ab")
    const empty = Y.createSnapshot(Y.createDeleteSet(), new Map())
    const runs = text.toDelta(Y.snapshot(doc), empty, computeYChange)
    expect(runs).toEqual([
      {
        insert: "ab",
        attributes: { ychange: computeYChange("added", Y.createID(1, 1)) },
      },
    ])
  })
})
