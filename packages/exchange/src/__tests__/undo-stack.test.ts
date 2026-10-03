// undo-stack — undo across documents over an Exchange: one step per gesture,
// typing grouped, undone by document, durable through a Store, and a crash
// mid-undo recovered without reverting twice.

import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  base64ToUint8Array,
  batch,
  exportEntirety,
  json,
  merge,
  Schema,
  subscribe,
  uint8ArrayToBase64,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import type { Exchange } from "../exchange.js"
import { whenPersisted, writeRefusal } from "../persistence.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import type { Store } from "../store/store.js"
import { UndoDoc } from "../undo/schema.js"
import { createUndoStack, type Undone } from "../undo/stack.js"
import { drain, exchangesPerTest } from "./exchanges.js"
import { wrapStore } from "./wrap-store.js"

const Card = Schema.struct({ text: Schema.text() })
const Places = Schema.struct({ place: Schema.string(), note: Schema.text() })
const CardDoc = yjs.bind(Card)
const PlacesDoc = loro.bind(Places)

const createExchange = exchangesPerTest()

function open(exchange: Exchange) {
  const card: any = exchange.get("card", CardDoc)
  const places: any = exchange.get("places", PlacesDoc)
  return { card, places }
}

async function stackOn(exchange: Exchange, now?: () => number) {
  return createUndoStack({
    exchange,
    docId: "undo",
    key: "main",
    scope: docId => docId !== "elsewhere",
    now,
  })
}

describe("an undo stack", () => {
  it("a gesture across a Yjs and a Loro document is one step", async () => {
    const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const { card, places } = open(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => {
      card.text.insert(0, "hello")
      places.place.set("column")
    })
    expect((await stack.undo()).kind).toBe("undone")
    expect(card.text()).toBe("")
    expect(places.place()).toBe("")
    expect((await stack.undo()).kind).toBe("none")
    expect((await stack.redo()).kind).toBe("undone")
    expect(card.text()).toBe("hello")
    expect(places.place()).toBe("column")
  })

  it("typing is grouped by the typing policy, and redoes in order", async () => {
    const exchange = createExchange({ schemas: [CardDoc] })
    const { card } = open(exchange)
    let t = 0
    const stack = await stackOn(exchange, () => t)
    for (const [at, ch] of [
      [0, "h"],
      [100, "i"],
      [200, " "],
      [300, "t"],
      [400, "o"],
    ] as const) {
      t = at
      stack.typing(() => card.text.insert(card.text().length, ch))
    }
    expect(card.text()).toBe("hi to")
    await stack.undo()
    expect(card.text()).toBe("hi ")
    await stack.undo()
    expect(card.text()).toBe("")
    // A step of several keystrokes redoes in order.
    await stack.redo()
    expect(card.text()).toBe("hi ")
    await stack.redo()
    expect(card.text()).toBe("hi to")
    stack.dispose()
  })

  it("a step nothing of which still stands is dropped, and the result names it", async () => {
    const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const { card, places } = open(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => card.text.insert(0, "abc"))
    stack.gesture(() => places.place.set("mine"))
    const dead = stack.top("undo")
    const below = stack.top("undo", ["card"])
    // Outside any gesture: someone else's write, as far as the stack knows.
    places.place.set("theirs")
    expect(await stack.undo()).toEqual({
      kind: "undone",
      step: below,
      stale: [],
      dropped: [dead],
    })
    expect(places.place()).toBe("theirs")
    expect(card.text()).toBe("")
  })

  it("a destroyed document is not created again, and its step is skipped", async () => {
    const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const { card, places } = open(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => places.place.set("column"))
    stack.gesture(() => card.text.insert(0, "sent"))
    exchange.destroy("card")
    expect((await stack.undo()).kind).toBe("undone")
    expect(places.place()).toBe("")
    expect(exchange.has("card")).toBe(false)
  })

  it("a document destroyed during an undo does not stand, and is not created again", async () => {
    const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const { card, places } = open(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => places.place.set("column"))
    stack.gesture(() => card.text.insert(0, "sent"))
    const undone = stack.undo()
    exchange.destroy("card")
    expect((await undone).kind).toBe("undone")
    expect(places.place()).toBe("")
    expect(exchange.has("card")).toBe(false)
  })

  it("does not capture documents out of scope, or its own document", async () => {
    const exchange = createExchange({ schemas: [CardDoc] })
    const elsewhere: any = exchange.get("elsewhere", CardDoc)
    const stack = await stackOn(exchange)
    stack.gesture(() => elsewhere.text.insert(0, "x"))
    expect(stack.top("undo")).toBeUndefined()
    expect((await stack.undo()).kind).toBe("none")
    expect(elsewhere.text()).toBe("x")
  })
})

/** `from`'s state merged into `into`: a peer's change reaching it. */
function receive(into: object, from: object): void {
  merge(into, exportEntirety(from))
}

describe("what an undo says it did", () => {
  const Board = Schema.struct({ slots: Schema.record(Schema.string()) })
  const BoardDoc = loro.bind(Board)
  const Slot = Schema.struct({ place: Schema.string() })
  const SlotDoc = loro.bind(Slot)

  /** Mine and Bea's, each on its own exchange. */
  async function two() {
    const mine = createExchange({ schemas: [BoardDoc, SlotDoc, PlacesDoc] })
    const bea = createExchange({ schemas: [BoardDoc, SlotDoc, PlacesDoc] })
    const stack = await stackOn(mine)
    /** Bea, brought up to date with mine on the document `get` names,
     *  writes `fn`, and mine hears. */
    const beaWrites = (get: (e: Exchange) => object, fn: (d: any) => void) => {
      const here = get(mine)
      const there = get(bea)
      receive(there, here)
      batch(there as any, fn)
      receive(here, there)
    }
    return { mine, stack, beaWrites }
  }

  /** A keep of three cards: each card its own document. */
  function keep(stack: Awaited<ReturnType<typeof stackOn>>, mine: Exchange) {
    const cards = ["card:1", "card:2", "card:3"].map(
      id => mine.get(id, SlotDoc) as any,
    )
    for (const card of cards) card.place.set("drawer")
    stack.gesture(() => {
      for (const card of cards) card.place.set("kept")
    })
    return cards
  }

  describe("without whole", () => {
    it("takes A, takes B, Bea moves B: undo drops B's step, undoes A's, and names both", async () => {
      const { mine, stack, beaWrites } = await two()
      const board: any = mine.get("board", BoardDoc)
      stack.gesture(() => board.slots.set("a", "taken"))
      const a = stack.top("undo")
      stack.gesture(() => board.slots.set("b", "taken"))
      const b = stack.top("undo")
      beaWrites(
        e => e.get("board", BoardDoc),
        d => d.slots.set("b", "moved"),
      )
      expect(await stack.undo()).toEqual({
        kind: "undone",
        step: a,
        stale: [],
        dropped: [b],
      })
      expect(board.slots()).toEqual({ b: "moved" })
      expect(stack.top("undo")).toBeUndefined()
    })

    it("undoes a keep of three cards Bea moved one of, and names that card's part stale", async () => {
      const { mine, stack, beaWrites } = await two()
      const cards = keep(stack, mine)
      beaWrites(
        e => e.get("card:2", SlotDoc),
        d => d.place.set("queue"),
      )
      const undone = await stack.undo()
      expect(undone.kind).toBe("undone")
      if (undone.kind !== "undone") return
      expect(undone.stale.map(p => p.docId)).toEqual(["card:2"])
      expect(cards.map(c => c.place())).toEqual(["drawer", "queue", "drawer"])
    })

    it("undoes two slots of one batch Bea changed one of, and names the part stale", async () => {
      const { mine, stack, beaWrites } = await two()
      const board: any = mine.get("board", BoardDoc)
      stack.gesture(() =>
        batch(board, (d: any) => {
          d.slots.set("x", "mine")
          d.slots.set("y", "mine")
        }),
      )
      beaWrites(
        e => e.get("board", BoardDoc),
        d => d.slots.set("y", "hers"),
      )
      const undone = await stack.undo()
      expect(undone.kind).toBe("undone")
      if (undone.kind !== "undone") return
      expect(undone.stale.map(p => p.docId)).toEqual(["board"])
      expect(board.slots()).toEqual({ y: "hers" })
    })
  })

  describe("with whole", () => {
    it("refuses the keep: no card moves, the step is gone, and the next undo takes the step below", async () => {
      const { mine, stack, beaWrites } = await two()
      const places: any = mine.get("places", PlacesDoc)
      stack.gesture(() => places.place.set("below"))
      const below = stack.top("undo")
      const cards = keep(stack, mine)
      const kept = stack.top("undo")
      beaWrites(
        e => e.get("card:2", SlotDoc),
        d => d.place.set("queue"),
      )
      const refused = await stack.undo({ whole: true })
      expect(refused).toEqual({
        kind: "refused",
        step: kept,
        stale: kept?.parts.filter(p => p.docId === "card:2"),
      })
      expect(cards.map(c => c.place())).toEqual(["kept", "queue", "kept"])
      expect(stack.top("undo")).toEqual(below)
      expect(stack.top("redo")).toBeUndefined()
      expect(await stack.undo({ whole: true })).toEqual({
        kind: "undone",
        step: below,
      })
      expect(places.place()).toBe("")
    })

    it("refuses two slots of one batch Bea changed one of", async () => {
      const { mine, stack, beaWrites } = await two()
      const board: any = mine.get("board", BoardDoc)
      stack.gesture(() =>
        batch(board, (d: any) => {
          d.slots.set("x", "mine")
          d.slots.set("y", "mine")
        }),
      )
      beaWrites(
        e => e.get("board", BoardDoc),
        d => d.slots.set("y", "hers"),
      )
      expect((await stack.undo({ whole: true })).kind).toBe("refused")
      expect(board.slots()).toEqual({ x: "mine", y: "hers" })
    })

    it("undoes entirely a gesture that wrote one value twice, in two commits, as one part", async () => {
      const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
      const { places } = open(exchange)
      const stack = await stackOn(exchange)
      stack.gesture(() => {
        places.place.set("a")
        places.place.set("b")
      })
      expect(stack.top("undo")?.parts).toHaveLength(1)
      expect((await stack.undo({ whole: true })).kind).toBe("undone")
      expect(places.place()).toBe("")
      expect((await stack.redo({ whole: true })).kind).toBe("undone")
      expect(places.place()).toBe("b")
    })

    it("undoes a gesture whose writes cancel out", async () => {
      const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
      const { card, places } = open(exchange)
      const stack = await stackOn(exchange)
      stack.gesture(() => {
        places.place.set("a")
        places.place.set("")
        card.text.insert(0, "x")
        card.text.delete(0, 1)
      })
      expect((await stack.undo({ whole: true })).kind).toBe("undone")
      expect(places.place()).toBe("")
      expect(card.text()).toBe("")
    })

    it("a refused redo step clears the redo steps that build on it", async () => {
      const { mine, stack, beaWrites } = await two()
      const places: any = mine.get("places", PlacesDoc)
      stack.gesture(() => places.place.set("a"))
      stack.gesture(() => places.place.set("b"))
      expect((await stack.undo()).kind).toBe("undone")
      expect((await stack.undo()).kind).toBe("undone")
      expect(places.place()).toBe("")
      beaWrites(
        e => e.get("places", PlacesDoc),
        d => d.place.set("q"),
      )
      expect((await stack.redo({ whole: true })).kind).toBe("refused")
      expect(stack.top("redo")).toBeUndefined()
      expect(places.place()).toBe("q")
    })
  })

  describe("splitting", () => {
    it("a Loro typing step splits where a peer's change merges between keystrokes", async () => {
      const { mine, stack, beaWrites } = await two()
      const places: any = mine.get("places", PlacesDoc)
      const type = (ch: string) =>
        stack.typing(() => places.note.insert(places.note().length, ch))
      type("a")
      type("b")
      beaWrites(
        e => e.get("places", PlacesDoc),
        d => d.place.set("hers"),
      )
      type("c")
      await stack.undo()
      expect(places.note()).toBe("ab")
      await stack.undo()
      expect(places.note()).toBe("")
    })

    it("a Yjs typing step does not", async () => {
      const mine = createExchange({ schemas: [CardDoc] })
      const bea = createExchange({ schemas: [CardDoc] })
      const card: any = mine.get("card", CardDoc)
      const hers: any = bea.get("card", CardDoc)
      let t = 0
      const stack = await stackOn(mine, () => t)
      const type = (at: number, index: number, ch: string) => {
        t = at
        stack.typing(() => card.text.insert(index, ch))
      }
      type(0, 0, "a")
      type(100, 1, "b")
      // Past the caret, so the typing policy goes on.
      receive(hers, card)
      hers.text.insert(2, "!")
      receive(card, hers)
      type(200, 2, "c")
      expect(card.text()).toBe("abc!")
      await stack.undo()
      expect(card.text()).toBe("!")
      expect(stack.top("undo")).toBeUndefined()
    })

    it("a gesture whose function merges a peer's change between two writes to one Loro document becomes two steps", async () => {
      const { mine, stack, beaWrites } = await two()
      const places: any = mine.get("places", PlacesDoc)
      stack.gesture(() => {
        places.note.insert(0, "a")
        beaWrites(
          e => e.get("places", PlacesDoc),
          d => d.place.set("hers"),
        )
        places.note.insert(1, "b")
      })
      await stack.undo()
      expect(places.note()).toBe("a")
      await stack.undo()
      expect(places.note()).toBe("")
      expect(places.place()).toBe("hers")
    })
  })

  it("types: the result follows from the call", async () => {
    const exchange = createExchange({ schemas: [CardDoc] })
    const stack = await stackOn(exchange)
    const plain: Undone = await stack.undo()
    // @ts-expect-error A result without `whole` is never refused.
    expect(plain.kind === "refused").toBe(false)
    // @ts-expect-error `whole` is `true` or absent.
    await stack.undo({ whole: false })
    const mode: boolean = plain.kind === "none"
    // @ts-expect-error A mode not known statically has no result type.
    await stack.undo({ whole: mode })
  })
})

describe("undo by document", () => {
  function cards(exchange: Exchange) {
    const x: any = exchange.get("card:x", CardDoc)
    const y: any = exchange.get("card:y", CardDoc)
    return { x, y }
  }

  it("undoes one card's step from under another's, and keeps its redo", async () => {
    const exchange = createExchange({ schemas: [CardDoc] })
    const { x, y } = cards(exchange)
    let t = 0
    const stack = await stackOn(exchange, () => t)
    stack.typing(() => x.text.insert(0, "ex"))
    t = 2000
    stack.typing(() => y.text.insert(0, "why"))
    expect(stack.top("undo", ["card:x"])?.parts.map(p => p.docId)).toEqual([
      "card:x",
    ])
    expect((await stack.undo({ docs: ["card:x"] })).kind).toBe("undone")
    expect(x.text()).toBe("")
    expect(y.text()).toBe("why")
    // A step on another card does not clear this card's redo.
    t = 4000
    stack.typing(() => y.text.insert(3, "!"))
    expect((await stack.redo({ docs: ["card:x"] })).kind).toBe("undone")
    expect(x.text()).toBe("ex")
    expect((await stack.undo({ docs: ["card:y"] })).kind).toBe("undone")
    expect(y.text()).toBe("why")
    expect((await stack.undo({ docs: ["card:y"] })).kind).toBe("undone")
    expect(y.text()).toBe("")
    expect(x.text()).toBe("ex")
    stack.dispose()
  })

  it("a step on several documents is undone whole", async () => {
    const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const { x, y } = cards(exchange)
    const { places } = open(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => {
      x.text.insert(0, "ex")
      places.place.set("column")
    })
    stack.gesture(() => y.text.insert(0, "why"))
    expect((await stack.undo({ docs: ["card:x"] })).kind).toBe("undone")
    expect(x.text()).toBe("")
    expect(places.place()).toBe("")
    expect(y.text()).toBe("why")
  })

  it("is false when no step writes the documents asked for", async () => {
    const exchange = createExchange({ schemas: [CardDoc] })
    const { x } = cards(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => x.text.insert(0, "ex"))
    expect(stack.top("undo", ["card:y"])).toBeUndefined()
    expect((await stack.undo({ docs: ["card:y"] })).kind).toBe("none")
    expect((await stack.undo({ docs: [] })).kind).toBe("none")
    expect(x.text()).toBe("ex")
  })
})

describe("steps conflict by what they write", () => {
  const Index = Schema.struct({ items: Schema.record(Schema.string()) })
  const Text = Schema.struct({ text: Schema.text() })
  // A plain document's undo is a strict stack: every step on it conflicts
  // with every other.
  const targets: readonly (readonly [
    string,
    BoundSchema<typeof Index>,
    BoundSchema<typeof Text>,
    { readonly strict: boolean },
  ])[] = [
    ["Yjs", yjs.bind(Index), yjs.bind(Text), { strict: false }],
    ["Loro", loro.bind(Index), loro.bind(Text), { strict: false }],
    ["plain", json.bind(Index), json.bind(Text), { strict: true }],
  ]
  const filters = [
    ["with docs", { docs: ["text:a"] }],
    ["without docs", undefined],
  ] as const

  /** Items: an entry in `index` each, and a text document each. */
  async function items(
    IndexDoc: BoundSchema<typeof Index>,
    TextDoc: BoundSchema<typeof Text>,
  ) {
    const exchange = createExchange({ schemas: [IndexDoc, TextDoc] })
    const index = exchange.get("index", IndexDoc)
    const text = (id: string) => exchange.get(`text:${id}`, TextDoc)
    const stack = await stackOn(exchange)
    /** One step: the item's entry and its text. */
    const create = (id: string, content: string) =>
      stack.gesture(() => {
        index.items.set(id, id)
        text(id).text.insert(0, content)
      })
    const shown = (id: string) => ({
      has: index.items.has(id),
      text: text(id).text(),
    })
    return { text, stack, create, shown }
  }

  for (const [substrate, IndexDoc, TextDoc, { strict }] of targets) {
    for (const [filtered, options] of filters) {
      it(`a new item keeps another's redo unless the document is a strict stack: ${substrate}, ${filtered}`, async () => {
        const { text, stack, create, shown } = await items(IndexDoc, TextDoc)
        create("a", "alpha")
        stack.gesture(() => text("a").text.insert(5, " more"))
        expect((await stack.undo(options)).kind).toBe("undone")
        expect((await stack.undo(options)).kind).toBe("undone")
        expect(shown("a")).toEqual({ has: false, text: "" })

        // Creating c writes another key of index and another text, so it
        // commutes with creating a; on a strict stack it clears a's
        // creation, and with it the typing made on it.
        create("c", "gamma")
        if (strict) {
          expect(stack.top("redo", options?.docs)).toBeUndefined()
          expect((await stack.redo(options)).kind).toBe("none")
          expect(shown("a")).toEqual({ has: false, text: "" })
          return
        }
        expect((await stack.redo(options)).kind).toBe("undone")
        expect(shown("a")).toEqual({ has: true, text: "alpha" })
        expect((await stack.redo(options)).kind).toBe("undone")
        expect(shown("a")).toEqual({ has: true, text: "alpha more" })
      })
    }

    it(`an item's creation undoes from under a newer item's, unless the document is a strict stack: ${substrate}`, async () => {
      const { stack, create, shown } = await items(IndexDoc, TextDoc)
      create("a", "alpha")
      create("c", "gamma")
      if (strict) {
        expect(stack.top("undo", ["text:a"])).toBeUndefined()
        expect((await stack.undo({ docs: ["text:a"] })).kind).toBe("none")
        expect(shown("a")).toEqual({ has: true, text: "alpha" })
        return
      }
      expect((await stack.undo({ docs: ["text:a"] })).kind).toBe("undone")
      expect(shown("a")).toEqual({ has: false, text: "" })
      expect(shown("c")).toEqual({ has: true, text: "gamma" })
    })

    it(`a redo is not taken from under the step it was made on: ${substrate}`, async () => {
      const { text, stack, create, shown } = await items(IndexDoc, TextDoc)
      create("a", "alpha")
      stack.gesture(() => {
        text("a").text.insert(5, "!")
        text("b").text.insert(0, "beta")
      })
      expect((await stack.undo()).kind).toBe("undone")
      expect((await stack.undo()).kind).toBe("undone")

      // The second step typed into a's text, which only the first created.
      expect(stack.top("redo", ["text:b"])).toBeUndefined()
      expect((await stack.redo({ docs: ["text:b"] })).kind).toBe("none")
      expect(shown("a")).toEqual({ has: false, text: "" })
      expect(text("b").text()).toBe("")

      expect((await stack.redo()).kind).toBe("undone")
      expect(shown("a")).toEqual({ has: true, text: "alpha" })
      expect((await stack.redo()).kind).toBe("undone")
      expect(shown("a")).toEqual({ has: true, text: "alpha!" })
      expect(text("b").text()).toBe("beta")
    })
  }
})

describe("a stored undo stack", () => {
  const withStore = (data: InMemoryStoreData) =>
    createExchange({
      schemas: [CardDoc, PlacesDoc],
      store: createInMemoryStore({ sharedData: data }),
    })

  async function settled(exchange: Exchange) {
    const { card, places } = open(exchange)
    await drain()
    return { card, places }
  }

  it("survives a reload", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    stack.gesture(() => a.card.text.insert(0, "hello"))
    stack.gesture(() => a.card.text.insert(5, " world"))
    await drain()
    await first.shutdown()

    const second = withStore(data)
    const b = await settled(second)
    const again = await stackOn(second)
    expect((await again.undo()).kind).toBe("undone")
    expect(b.card.text()).toBe("hello")
    expect((await again.undo()).kind).toBe("undone")
    expect(b.card.text()).toBe("")
  })

  it("a stored document destroyed before it is opened is skipped, not created", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    stack.gesture(() => a.places.place.set("column"))
    stack.gesture(() => a.card.text.insert(0, "sent"))
    await drain()
    await first.shutdown()

    const second = withStore(data)
    const again = await stackOn(second)
    second.destroy("card")
    expect((await again.undo()).kind).toBe("undone")
    expect(second.has("card")).toBe(false)
    const places: any = second.get("places", PlacesDoc)
    expect(places.place()).toBe("")
    await second.flush()
    expect(
      await createInMemoryStore({ sharedData: data }).currentMeta("card"),
    ).toBeNull()
  })

  it("a note naming a step no longer in its list is cleared on load", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    stack.gesture(() => a.card.text.insert(0, "hello"))
    const kept = stack.top("undo")
    const undoDoc: any = first.get("undo", UndoDoc)
    batch(undoDoc, (d: any) =>
      d.stacks.at("main").pending.set({
        step: "gone",
        direction: "undo",
        whole: false,
        positions: {},
      }),
    )
    await whenPersisted(undoDoc)
    await first.shutdown()

    const second = withStore(data)
    const b = await settled(second)
    const again = await stackOn(second)
    await drain()
    const after: any = second.get("undo", UndoDoc)
    expect(after.stacks.at("main").pending()).toBeNull()
    expect(again.top("undo")).toEqual(kept)
    expect((await again.undo()).kind).toBe("undone")
    expect(b.card.text()).toBe("")
  })

  it("a crash between the note and the revert reverts on the next load", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    stack.gesture(() => a.card.text.insert(0, "hello"))
    await drain()
    // The note is written and stored, then the process dies.
    const step = stack.top("undo")
    if (step === undefined) throw new Error("no step")
    const undoDoc: any = first.get("undo", UndoDoc)
    const revertible = first.runtime.instanceOf("card")
    if (revertible?.tier !== "interpret") throw new Error("card not open")
    const position = revertible.readyInfo.replica.revertible?.position()
    if (position === undefined) throw new Error("not revertible")
    batch(undoDoc, (d: any) =>
      d.stacks.at("main").pending.set({
        step: step.id,
        direction: "undo",
        whole: false,
        positions: { card: uint8ArrayToBase64(position) },
      }),
    )
    await whenPersisted(undoDoc)
    await first.shutdown()

    const second = withStore(data)
    const b = await settled(second)
    await stackOn(second)
    await drain()
    expect(b.card.text()).toBe("")
    const after: any = second.get("undo", UndoDoc)
    expect(after.stacks.at("main").pending()).toBeNull()
    expect(after.stacks.at("main").redo()).toHaveLength(1)
  })

  it("the note carries whole, and a crash before the revert decides again on load: a step no longer whole is refused", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    const undoDoc: any = first.get("undo", UndoDoc)
    const notes: unknown[] = []
    const stop = subscribe(undoDoc, () => {
      const pending = undoDoc.stacks.at("main").pending()
      if (pending !== null) notes.push(pending)
    })
    stack.gesture(() => a.card.text.insert(0, "x"))
    expect((await stack.undo({ whole: true })).kind).toBe("undone")
    stop()
    expect(notes).toMatchObject([{ whole: true }])

    // Two writes in one step; Bea overwrites one of them, and her write
    // arrives after the reload.
    stack.gesture(() => {
      a.places.place.set("mine")
      a.places.note.insert(0, "n")
    })
    await drain()
    const bea = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const hers: any = bea.get("places", PlacesDoc)
    receive(hers, a.places)
    hers.place.set("theirs")
    // The note is written and stored, then the process dies.
    const step = stack.top("undo")
    if (step === undefined) throw new Error("no step")
    const entry = first.runtime.instanceOf("places")
    if (entry?.tier !== "interpret") throw new Error("places not open")
    const position = entry.readyInfo.replica.revertible?.position()
    if (position === undefined) throw new Error("not revertible")
    batch(undoDoc, (d: any) =>
      d.stacks.at("main").pending.set({
        step: step.id,
        direction: "undo",
        whole: true,
        positions: { places: uint8ArrayToBase64(position) },
      }),
    )
    await whenPersisted(undoDoc)
    await drain()
    await first.shutdown()

    const second = withStore(data)
    const b = await settled(second)
    receive(b.places, hers)
    const again = await stackOn(second)
    await drain()
    expect(b.places.place()).toBe("theirs")
    expect(b.places.note()).toBe("n")
    const after: any = second.get("undo", UndoDoc)
    expect(after.stacks.at("main").pending()).toBeNull()
    expect(again.top("undo", ["places"])).toBeUndefined()
    expect(again.top("redo", ["places"])).toBeUndefined()
  })

  it("a crash while undoing a step under the top reverts that step on the next load", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    stack.gesture(() => a.card.text.insert(0, "hello"))
    stack.gesture(() => a.places.place.set("column"))
    await drain()
    const lower = stack.top("undo", ["card"])
    if (lower === undefined) throw new Error("no step on card")
    const entry = first.runtime.instanceOf("card")
    if (entry?.tier !== "interpret") throw new Error("card not open")
    const position = entry.readyInfo.replica.revertible?.position()
    if (position === undefined) throw new Error("not revertible")
    // The note is written and stored, then the process dies.
    const undoDoc: any = first.get("undo", UndoDoc)
    batch(undoDoc, (d: any) =>
      d.stacks.at("main").pending.set({
        step: lower.id,
        direction: "undo",
        whole: false,
        positions: { card: uint8ArrayToBase64(position) },
      }),
    )
    await whenPersisted(undoDoc)
    await first.shutdown()

    const second = withStore(data)
    const b = await settled(second)
    const again = await stackOn(second)
    await drain()
    expect(b.card.text()).toBe("")
    expect(b.places.place()).toBe("column")
    expect(again.top("undo", ["card"])).toBeUndefined()
    expect((await again.undo()).kind).toBe("undone")
    expect(b.places.place()).toBe("")
  })

  it("a crash after the revert finishes on the next load without reverting again", async () => {
    const data = createInMemoryStoreData()
    const first = withStore(data)
    const a = await settled(first)
    const stack = await stackOn(first)
    stack.gesture(() => a.card.text.insert(0, "hello world"))
    stack.gesture(() => a.card.text.delete(5, 6))
    await drain()
    // Note, revert, and die before the move is recorded.
    const undoDoc: any = first.get("undo", UndoDoc)
    const top = stack.top("undo")
    if (top === undefined) throw new Error("no step")
    const entry = first.runtime.instanceOf("card")
    if (entry?.tier !== "interpret") throw new Error("card not open")
    const revertible = entry.readyInfo.replica.revertible
    if (revertible === undefined) throw new Error("not revertible")
    const position = revertible.position()
    batch(undoDoc, (d: any) =>
      d.stacks.at("main").pending.set({
        step: top.id,
        direction: "undo",
        whole: false,
        positions: { card: uint8ArrayToBase64(position) },
      }),
    )
    await whenPersisted(undoDoc)
    const [only] = top.parts
    if (only === undefined) throw new Error("no part")
    revertible
      .plan(revertible.codec.decode(base64ToUint8Array(only.record)))
      .apply?.({})
    expect(a.card.text()).toBe("hello world")
    await drain()
    await first.shutdown()

    const second = withStore(data)
    const b = await settled(second)
    const again = await stackOn(second)
    await drain()
    expect(b.card.text()).toBe("hello world")
    const after: any = second.get("undo", UndoDoc)
    expect(after.stacks.at("main").pending()).toBeNull()
    // The recovered step is redoable, and the one below it still undoes.
    expect((await again.redo()).kind).toBe("undone")
    expect(b.card.text()).toBe("hello")
  })
})

describe("an undo of a document leaving memory", () => {
  /**
   * A store whose appends of `docId` wait until `release` while held, and
   * which runs `onAppend` before an append of the undo document: the stack's
   * own record, so the stack is never held.
   */
  function holding(docId: string) {
    const inner = createInMemoryStore()
    let held: Promise<void> | undefined
    let release = (): void => {}
    let onAppend: (() => void) | undefined
    const store: Store = wrapStore(inner, {
      append: async (id, record, options) => {
        if (id === docId) await held
        if (id === "undo") {
          const once = onAppend
          onAppend = undefined
          once?.()
        }
        return inner.append(id, record, options)
      },
    })
    return {
      store,
      hold() {
        held = new Promise(resolve => {
          release = resolve
        })
      },
      release: () => release(),
      beforeNote(fn: () => void) {
        onAppend = fn
      },
    }
  }

  /** `card` and `places`, each written and stored, and a stack over them. */
  async function written(exchange: Exchange) {
    const { card, places } = open(exchange)
    card.text.insert(0, "kept")
    places.place.set("kept")
    await exchange.flush()
    return { card, places, stack: await stackOn(exchange) }
  }

  it("cancels an unload still in flight, and reverts", async () => {
    const gate = holding("card")
    const exchange = createExchange({
      schemas: [CardDoc, PlacesDoc],
      store: gate.store,
    })
    const { card, stack } = await written(exchange)
    stack.gesture(() => card.text.insert(4, "!"))
    gate.hold()
    exchange.unload("card")
    try {
      expect((await stack.undo()).kind).toBe("undone")
      expect(exchange.runtime.lifecycleOf("card")?.phase).toBe("ready")
      expect(card.text()).toBe("kept")
      expect(writeRefusal(card)).toBeUndefined()
    } finally {
      gate.release()
      stack.dispose()
    }
  })

  it("loads an unloaded document again, and reverts the new instance", async () => {
    const exchange = createExchange({
      schemas: [CardDoc, PlacesDoc],
      store: createInMemoryStore(),
    })
    const { card, stack } = await written(exchange)
    stack.gesture(() => card.text.insert(4, "!"))
    exchange.unload("card")
    await exchange.flush()
    expect(exchange.runtime.lifecycleOf("card")?.phase).toBe("unloaded")

    expect((await stack.undo()).kind).toBe("undone")
    const again: any = exchange.get("card", CardDoc)
    expect(again).not.toBe(card)
    expect(again.text()).toBe("kept")
    expect(writeRefusal(card)).toBeDefined()
    stack.dispose()
  })

  it("skips the part of a document unloaded between the open and the revert, and reverts the rest", async () => {
    const gate = holding("card")
    const exchange = createExchange({
      schemas: [CardDoc, PlacesDoc],
      store: gate.store,
    })
    const { card, places, stack } = await written(exchange)
    // The card's write is held, so its unload stays in memory, unloading,
    // through the revert.
    gate.hold()
    stack.gesture(() => {
      card.text.insert(4, "!")
      places.place.set("moved")
    })
    await drain()
    // The note is stored after the open and before the revert.
    gate.beforeNote(() => exchange.unload("card"))
    try {
      expect((await stack.undo()).kind).toBe("undone")
      expect(exchange.runtime.lifecycleOf("card")?.phase).toBe("unloading")
      expect(places.place()).toBe("kept")
      expect(card.text()).toBe("kept!")
    } finally {
      gate.release()
      stack.dispose()
    }
    await exchange.flush()
    expect(exchange.runtime.lifecycleOf("card")?.phase).toBe("unloaded")
    const reloaded: any = exchange.get("card", CardDoc)
    await exchange.whenHydrated("card")
    expect(reloaded.text()).toBe("kept!")
  })
})
