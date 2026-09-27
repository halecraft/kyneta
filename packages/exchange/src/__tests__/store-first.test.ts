// store-first — an own operation leaves the process only once its store has
// confirmed it.
//
// A peer that pushed a write and crashed before storing it reloads without
// that write and issues new operations at the addresses it occupies. Peers
// holding the old ones deduplicate by address, and the replicas never
// converge. So with a store, no offer of a document leaves while the store
// has not confirmed its own writes: not a push, not a relay, not an answer to
// an interest.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { CHANGEFEED } from "@kyneta/changefeed"
import { loro } from "@kyneta/loro-schema"
import { batch, json, Schema, unwrap } from "@kyneta/schema"
import { PROTOCOL_VERSION } from "@kyneta/transport"
import { yjs } from "@kyneta/yjs-schema"
import { LoroText } from "loro-crdt"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Exchange, ExchangeParams } from "../exchange.js"
import {
  persisted,
  persistedFeed,
  persistenceError,
  whenPersisted,
} from "../persistence.js"
import { Runtime } from "../runtime.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import type { Store } from "../store/store.js"
import { exchangesPerTest, sleep } from "./exchanges.js"
import { ScriptedPeer } from "./scripted-peer.js"
import { wrapStore } from "./wrap-store.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LogSchema = Schema.struct({ log: Schema.text() })

const yjsLog = yjs.bind(LogSchema)
const loroLog = loro.bind(LogSchema)
const plainLog = json.bind(LogSchema)

/** A document of any backend here: a text `log` to append to and read. */
type LogDoc = {
  readonly log: { (): string; insert(index: number, text: string): void }
}

/** Each backend, with its document `"doc"` opened on an exchange. */
const BACKENDS: readonly {
  readonly name: string
  /** Takes concurrent writers; plain is written serially. */
  readonly concurrent: boolean
  readonly get: (exchange: Exchange) => LogDoc
}[] = [
  { name: "yjs", concurrent: true, get: e => e.get("doc", yjsLog) },
  { name: "loro", concurrent: true, get: e => e.get("doc", loroLog) },
  { name: "plain", concurrent: false, get: e => e.get("doc", plainLog) },
]

function append(doc: LogDoc, text: string): void {
  doc.log.insert(doc.log().length, text)
}

const createExchange = exchangesPerTest()
afterEach(() => {
  vi.useRealTimers()
})

function freshData(): InMemoryStoreData {
  return createInMemoryStoreData()
}

function open(
  id: string,
  bridges: Bridge[],
  params: Partial<ExchangeParams> = {},
): Exchange {
  const exchange = createExchange({
    principal: id,
    transports: bridges.map((bridge, i) =>
      createBridgeTransport({ bridge, transportId: `${id}-${i}` }),
    ),
    onStoreError: () => {},
    ...params,
  })
  return exchange
}

/** Stop `exchange` without flushing anything, as a crash would. */
function crash(exchange: Exchange): void {
  createExchange.forget(exchange)
  exchange.reset()
}

/** A store whose appends can be held back until released. */
class HeldStore {
  readonly store: Store
  #waiting: (() => void)[] | undefined

  constructor(sharedData: InMemoryStoreData = freshData()) {
    const inner = createInMemoryStore({ sharedData })
    this.store = wrapStore(inner, {
      append: async (docId, record) => {
        const waiting = this.#waiting
        if (waiting) await new Promise<void>(resolve => waiting.push(resolve))
        await inner.append(docId, record)
      },
    })
  }

  /** Hold every append from now on. */
  hold(): void {
    this.#waiting = []
  }

  /** Let every held append land, and stop holding. */
  release(): void {
    const waiting = this.#waiting ?? []
    this.#waiting = undefined
    for (const resolve of waiting) resolve()
  }
}

/** A store whose next appends reject, and which counts its appends. */
class FlakyStore {
  readonly store: Store
  appends = 0
  #failing: { error: unknown; times: number } | undefined

  constructor(sharedData: InMemoryStoreData = freshData()) {
    const inner = createInMemoryStore({ sharedData })
    this.store = wrapStore(inner, {
      append: async (docId, record) => {
        this.appends++
        const failing = this.#failing
        if (failing && failing.times > 0) {
          failing.times--
          throw failing.error
        }
        await inner.append(docId, record)
      },
    })
  }

  /** Reject the next `times` appends with `error`. */
  fail(error: unknown, times = Number.POSITIVE_INFINITY): void {
    this.#failing = { error, times }
  }
}

// ---------------------------------------------------------------------------
// Every backend
// ---------------------------------------------------------------------------

for (const { name, get } of BACKENDS) {
  describe(`store-first (${name})`, () => {
    it("holds a local write from peers until the store confirms it", async () => {
      const bridge = new Bridge()
      const held = new HeldStore()
      const writer = get(open("writer", [bridge], { store: held.store }))
      const reader = get(open("reader", [bridge]))
      await sleep(30)

      append(writer, "A")
      await sleep(30)
      expect(reader.log()).toBe("A")

      held.hold()
      append(writer, "B")
      await sleep(30)
      expect(reader.log()).toBe("A")
      expect(persisted(writer)).toBe(false)

      held.release()
      await sleep(30)
      expect(reader.log()).toBe("AB")
      expect(persisted(writer)).toBe(true)
    })

    it("converges after a crash that lost a write the network never saw", async () => {
      // The reproduction: without store-first the host keeps the lost write,
      // and the reloaded peer reissues its addresses.
      const bridge = new Bridge()
      const data = freshData()
      const held = new HeldStore(data)
      const host = get(open("host", [bridge]))
      const before = open("browser", [bridge], { store: held.store })
      const browser = get(before)
      await sleep(30)

      append(browser, "A")
      await sleep(30)
      expect(host.log()).toBe("A")

      held.hold()
      append(browser, "B")
      await sleep(30)
      crash(before)

      const after = createExchange({
        principal: "browser",
        transports: [
          createBridgeTransport({ bridge, transportId: "browser-reloaded" }),
        ],
        store: createInMemoryStore({ sharedData: data }),
      })
      const reloaded = get(after)
      await whenHydrated(reloaded)
      append(reloaded, "C")
      await sleep(60)

      expect(host.log()).toBe("AC")
      expect(reloaded.log()).toBe("AC")
    })

    it("answers a new peer's interest only once its own write is confirmed", async () => {
      const bridge = new Bridge()
      const held = new HeldStore()
      const writer = get(open("writer", [bridge], { store: held.store }))
      await sleep(30)
      append(writer, "x")
      await sleep(30)

      held.hold()
      append(writer, "y")
      await sleep(30)
      const late = get(open("late", [bridge]))
      await sleep(30)
      expect(late.log()).toBe("")

      held.release()
      await sleep(30)
      expect(late.log()).toBe("xy")
    })

    it("sends as soon as it is written when there is no store", async () => {
      const bridge = new Bridge()
      const writer = get(open("writer", [bridge]))
      const reader = get(open("reader", [bridge]))
      await sleep(30)

      append(writer, "A")
      expect(persisted(writer)).toBe(true)
      await sleep(0)
      expect(reader.log()).toBe("A")
    })

    it("flush() resolves once the withheld offers have gone out", async () => {
      const bridge = new Bridge()
      const inner = createInMemoryStore({ sharedData: freshData() })
      const slow = wrapStore(inner, {
        append: async (docId, record) => {
          await new Promise(resolve => setTimeout(resolve, 20))
          await inner.append(docId, record)
        },
      })
      const writerExchange = open("writer", [bridge], { store: slow })
      const writer = get(writerExchange)
      const reader = get(open("reader", [bridge]))
      await sleep(60)

      append(writer, "A")
      await writerExchange.flush()
      expect(reader.log()).toBe("A")
    })
  })
}

// ---------------------------------------------------------------------------
// Backend-specific
// ---------------------------------------------------------------------------

// A relay that holds its own write while it imports another peer's needs two
// writers, which a plain document, written serially, does not have.
for (const { name, get } of BACKENDS.filter(b => b.concurrent)) {
  describe(`store-first (${name}): a relay`, () => {
    it("relays nothing while its own write is unconfirmed, then both", async () => {
      // a — b — c in a line; b stores.
      const ab = new Bridge()
      const bc = new Bridge()
      const held = new HeldStore()
      const a = get(open("a", [ab]))
      const b = get(open("b", [ab, bc], { store: held.store }))
      const c = get(open("c", [bc]))
      await sleep(30)

      held.hold()
      append(b, "b")
      await sleep(30)
      append(a, "a")
      await sleep(30)
      expect(b.log()).toHaveLength(2)
      expect(c.log()).toBe("")

      held.release()
      await sleep(30)
      expect(c.log()).toBe(b.log())
    })
  })
}

describe("store-first (loro): a pending native write", () => {
  it("is held like any other own write", async () => {
    const bound = loro.bind(LogSchema)
    const bridge = new Bridge()
    const held = new HeldStore()
    const writerExchange = open("writer", [bridge], { store: held.store })
    const writer = writerExchange.get("doc", bound)
    await sleep(30)
    append(writer, "x")
    await sleep(30)

    // Left uncommitted, the write fires no signal. The export of the
    // interest's answer would commit it and send it; the gate commits it
    // first, and holds it.
    held.hold()
    const text = unwrap(writer.log)
    if (!(text instanceof LoroText)) throw new Error("expected a LoroText")
    text.insert(1, "p")

    const late = open("late", [bridge]).get("doc", bound)
    await sleep(30)
    expect(late.log()).toBe("")

    held.release()
    await sleep(30)
    expect(late.log()).toBe("xp")
  })
})

describe("store-first (loro): a store write after a pending native write", () => {
  it("records a version that covers everything the entry holds", async () => {
    // The write commits the pending operation before it reads the version,
    // so a reload finds the store at the version it loads, and owes nothing.
    const bound = loro.bind(LogSchema)
    const data = freshData()
    const first = new Runtime({
      store: createInMemoryStore({ sharedData: data }),
      tickInterval: 0,
    })
    const doc = first.get("doc", bound)
    await first.flush()
    const text = unwrap(doc.log)
    if (!(text instanceof LoroText)) throw new Error("expected a LoroText")
    text.insert(0, "pending")
    await first.compact("doc")
    await first.shutdown()
    const records = data.records.get("doc")?.length

    const second = new Runtime({
      store: createInMemoryStore({ sharedData: data }),
      tickInterval: 0,
    })
    const reloaded = second.get("doc", bound)
    await second.flush()
    expect(reloaded.log()).toBe("pending")
    expect(data.records.get("doc")?.length).toBe(records)
    await second.shutdown()
  })
})

describe("store-first (yjs): a delete-only write", () => {
  it("closes the gate", async () => {
    // A delete advances a Yjs state vector only through the delete clock. It
    // is what makes the delete's version one the store must confirm.
    const bound = yjs.bind(LogSchema)
    const bridge = new Bridge()
    const held = new HeldStore()
    const writer = open("writer", [bridge], { store: held.store }).get(
      "doc",
      bound,
    )
    const reader = open("reader", [bridge]).get("doc", bound)
    await sleep(30)
    append(writer, "abc")
    await sleep(30)
    expect(reader.log()).toBe("abc")

    held.hold()
    batch(writer, d => d.log.delete(2, 1))
    await sleep(30)
    expect(reader.log()).toBe("abc")
    expect(persisted(writer)).toBe(false)

    held.release()
    await sleep(30)
    expect(reader.log()).toBe("ab")
  })
})

// ---------------------------------------------------------------------------
// Failed writes
// ---------------------------------------------------------------------------

describe("store-first: a failed write", () => {
  const bound = json.bind(LogSchema)

  /** Fake the timers the retry uses; the Bridge delivers in microtasks. */
  function fakeTimers(): void {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    })
  }

  async function advance(ms = 0): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
  }

  async function pair(flaky: FlakyStore) {
    const bridge = new Bridge()
    const writer = open("writer", [bridge], {
      store: flaky.store,
      tickInterval: 0,
    }).get("doc", bound)
    const reader = open("reader", [bridge]).get("doc", bound)
    await advance()
    append(writer, "A")
    await advance()
    return { writer, reader }
  }

  it("is retried without another mutation, and its offers then go out", async () => {
    fakeTimers()
    const flaky = new FlakyStore()
    const { writer, reader } = await pair(flaky)
    const error = new Error("disk full")
    flaky.fail(error, 1)

    append(writer, "B")
    const waiting = whenPersisted(writer)
    const rejected = expect(waiting).rejects.toBe(error)
    await advance()

    expect(persisted(writer)).toBe(false)
    expect(persistenceError(writer)).toBe(error)
    expect(reader.log()).toBe("A")
    await rejected
    await expect(whenPersisted(writer)).rejects.toBe(error)

    await advance(250)
    expect(persisted(writer)).toBe(true)
    expect(persistenceError(writer)).toBeUndefined()
    expect(reader.log()).toBe("AB")
    await expect(whenPersisted(writer)).resolves.toBeUndefined()
  })

  it("is retried at 250, 500, 1000 ms and so on, and does not hold up flush()", async () => {
    fakeTimers()
    const flaky = new FlakyStore()
    const bridge = new Bridge()
    const writerExchange = open("writer", [bridge], {
      store: flaky.store,
      tickInterval: 0,
    })
    const writer = writerExchange.get("doc", bound)
    const reader = open("reader", [bridge]).get("doc", bound)
    await advance()
    append(writer, "A")
    await advance()

    flaky.fail(new Error("offline"))
    append(writer, "B")
    await advance()
    const attempts = [flaky.appends]
    for (const ms of [250, 500, 1000, 2000]) {
      await advance(ms - 1)
      expect(flaky.appends).toBe(attempts[attempts.length - 1])
      await advance(1)
      attempts.push(flaky.appends)
    }
    // One attempt at the end of each delay, and none before it.
    expect(attempts.slice(1).map((n, i) => n - (attempts[i] ?? 0))).toEqual([
      1, 1, 1, 1,
    ])

    await writerExchange.flush()
    expect(reader.log()).toBe("A")
  })

  it("does not wait on a retry once a new write has started", async () => {
    fakeTimers()
    const flaky = new FlakyStore()
    const runtime = new Runtime({
      store: flaky.store,
      tickInterval: 0,
      onStoreError: () => {},
    })
    const doc = runtime.get("doc", bound)
    await advance()
    flaky.fail(new Error("once"), 1)
    append(doc, "A")
    await advance()
    expect(vi.getTimerCount()).toBe(1) // the retry

    append(doc, "B")
    await advance()
    expect(vi.getTimerCount()).toBe(0)
    expect(persisted(doc)).toBe(true)
    await runtime.shutdown()
  })

  it("of imported operations only leaves own writes persisted", async () => {
    fakeTimers()
    const flaky = new FlakyStore()
    const bridge = new Bridge()
    const storing = open("storing", [bridge], {
      store: flaky.store,
      tickInterval: 0,
    }).get("doc", bound)
    const other = open("other", [bridge]).get("doc", bound)
    await advance()

    const error = new Error("disk full")
    flaky.fail(error, 1)
    append(other, "theirs")
    await advance()

    expect(storing.log()).toBe("theirs")
    expect(persistenceError(storing)).toBe(error)
    expect(persisted(storing)).toBe(true)
    await expect(whenPersisted(storing)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The persistence feed
// ---------------------------------------------------------------------------

describe("persistedFeed", () => {
  it("reports each change of persisted", async () => {
    const held = new HeldStore()
    const runtime = new Runtime({
      store: held.store,
      tickInterval: 0,
    })
    const doc = runtime.get("doc", json.bind(LogSchema))
    await sleep(30)
    const seen: boolean[] = []
    const feed = persistedFeed(doc)
    feed[CHANGEFEED].subscribe(() => seen.push(feed()))

    held.hold()
    append(doc, "A")
    await sleep(30)
    held.release()
    await sleep(30)

    expect(seen).toEqual([false, true])
    await runtime.shutdown()
  })
})

// ---------------------------------------------------------------------------
// An interest we cannot read
// ---------------------------------------------------------------------------

describe("an interest whose version does not parse", () => {
  it("is answered with the whole document, and the peer is then pushed to", async () => {
    const peer = new ScriptedPeer()
    const exchange = createExchange({ principal: "us", transports: [peer] })
    const doc = exchange.get("d", json.bind(LogSchema))
    append(doc, "A")
    await Promise.resolve()
    peer.receive({
      type: "establish",
      identity: { peerId: "them", principal: "them", type: "user" },
      protocolVersion: PROTOCOL_VERSION,
    })
    peer.receive({ type: "interest", docId: "d", since: "not a version" })
    await Promise.resolve()

    const [answer] = peer.sentOf("offer")
    expect(answer?.payload.kind).toBe("entirety")

    // Reported sent, so the next push goes out from where the answer left
    // the peer.
    append(doc, "B")
    await sleep(0)
    expect(peer.sentOf("offer")).toHaveLength(2)
  })
})
