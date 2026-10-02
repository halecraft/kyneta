// undo-stack — undo across documents over an Exchange: one step per gesture,
// typing grouped, undone by document, durable through a Store, and a crash
// mid-undo recovered without reverting twice.

import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  base64ToUint8Array,
  batch,
  json,
  Schema,
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
import { createUndoStack } from "../undo/stack.js"
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
    expect(await stack.undo()).toBe(true)
    expect(card.text()).toBe("")
    expect(places.place()).toBe("")
    expect(await stack.undo()).toBe(false)
    expect(await stack.redo()).toBe(true)
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

  it("a step nothing of which still stands is skipped", async () => {
    const exchange = createExchange({ schemas: [CardDoc, PlacesDoc] })
    const { card, places } = open(exchange)
    const stack = await stackOn(exchange)
    stack.gesture(() => card.text.insert(0, "abc"))
    stack.gesture(() => places.place.set("mine"))
    // Outside any gesture: someone else's write, as far as the stack knows.
    places.place.set("theirs")
    expect(await stack.undo()).toBe(true)
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
    expect(await stack.undo()).toBe(true)
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
    expect(await undone).toBe(true)
    expect(places.place()).toBe("")
    expect(exchange.has("card")).toBe(false)
  })

  it("does not capture documents out of scope, or its own document", async () => {
    const exchange = createExchange({ schemas: [CardDoc] })
    const elsewhere: any = exchange.get("elsewhere", CardDoc)
    const stack = await stackOn(exchange)
    stack.gesture(() => elsewhere.text.insert(0, "x"))
    expect(stack.top("undo")).toBeUndefined()
    expect(await stack.undo()).toBe(false)
    expect(elsewhere.text()).toBe("x")
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
    expect(await stack.undo({ docs: ["card:x"] })).toBe(true)
    expect(x.text()).toBe("")
    expect(y.text()).toBe("why")
    // A step on another card does not clear this card's redo.
    t = 4000
    stack.typing(() => y.text.insert(3, "!"))
    expect(await stack.redo({ docs: ["card:x"] })).toBe(true)
    expect(x.text()).toBe("ex")
    expect(await stack.undo({ docs: ["card:y"] })).toBe(true)
    expect(y.text()).toBe("why")
    expect(await stack.undo({ docs: ["card:y"] })).toBe(true)
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
    expect(await stack.undo({ docs: ["card:x"] })).toBe(true)
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
    expect(await stack.undo({ docs: ["card:y"] })).toBe(false)
    expect(await stack.undo({ docs: [] })).toBe(false)
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
        expect(await stack.undo(options)).toBe(true)
        expect(await stack.undo(options)).toBe(true)
        expect(shown("a")).toEqual({ has: false, text: "" })

        // Creating c writes another key of index and another text, so it
        // commutes with creating a; on a strict stack it clears a's
        // creation, and with it the typing made on it.
        create("c", "gamma")
        if (strict) {
          expect(stack.top("redo", options?.docs)).toBeUndefined()
          expect(await stack.redo(options)).toBe(false)
          expect(shown("a")).toEqual({ has: false, text: "" })
          return
        }
        expect(await stack.redo(options)).toBe(true)
        expect(shown("a")).toEqual({ has: true, text: "alpha" })
        expect(await stack.redo(options)).toBe(true)
        expect(shown("a")).toEqual({ has: true, text: "alpha more" })
      })
    }

    it(`an item's creation undoes from under a newer item's, unless the document is a strict stack: ${substrate}`, async () => {
      const { stack, create, shown } = await items(IndexDoc, TextDoc)
      create("a", "alpha")
      create("c", "gamma")
      if (strict) {
        expect(stack.top("undo", ["text:a"])).toBeUndefined()
        expect(await stack.undo({ docs: ["text:a"] })).toBe(false)
        expect(shown("a")).toEqual({ has: true, text: "alpha" })
        return
      }
      expect(await stack.undo({ docs: ["text:a"] })).toBe(true)
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
      expect(await stack.undo()).toBe(true)
      expect(await stack.undo()).toBe(true)

      // The second step typed into a's text, which only the first created.
      expect(stack.top("redo", ["text:b"])).toBeUndefined()
      expect(await stack.redo({ docs: ["text:b"] })).toBe(false)
      expect(shown("a")).toEqual({ has: false, text: "" })
      expect(text("b").text()).toBe("")

      expect(await stack.redo()).toBe(true)
      expect(shown("a")).toEqual({ has: true, text: "alpha" })
      expect(await stack.redo()).toBe(true)
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
    expect(await again.undo()).toBe(true)
    expect(b.card.text()).toBe("hello")
    expect(await again.undo()).toBe(true)
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
    expect(await again.undo()).toBe(true)
    expect(second.has("card")).toBe(false)
    const places: any = second.get("places", PlacesDoc)
    expect(places.place()).toBe("")
    await second.flush()
    expect(
      await createInMemoryStore({ sharedData: data }).currentMeta("card"),
    ).toBeNull()
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
    expect(await again.undo()).toBe(true)
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
        positions: { card: uint8ArrayToBase64(position) },
      }),
    )
    await whenPersisted(undoDoc)
    const [only] = top.parts
    if (only === undefined) throw new Error("no part")
    revertible.revert(
      revertible.codec.decode(base64ToUint8Array(only.record)),
      {},
    )
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
    expect(await again.redo()).toBe(true)
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
      expect(await stack.undo()).toBe(true)
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

    expect(await stack.undo()).toBe(true)
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
      expect(await stack.undo()).toBe(true)
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
