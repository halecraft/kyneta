import { describe, expect, it, vi } from "vitest"
import { createCallable } from "../callable.js"
import type { ChangeBase, Changeset } from "../change.js"
import {
  CHANGEFEED,
  changefeed,
  createChangefeed,
  hasChangefeed,
  staticChangefeed,
} from "../changefeed.js"

// ---------------------------------------------------------------------------
// hasChangefeed
// ---------------------------------------------------------------------------

describe("hasChangefeed", () => {
  it("returns false for nullish values and primitives", () => {
    expect(hasChangefeed(null)).toBe(false)
    expect(hasChangefeed(undefined)).toBe(false)
    expect(hasChangefeed(42)).toBe(false)
    expect(hasChangefeed("hello")).toBe(false)
    expect(hasChangefeed(true)).toBe(false)
  })

  it("returns false for a plain object", () => {
    expect(hasChangefeed({ foo: 1 })).toBe(false)
  })

  it("returns true for an object with [CHANGEFEED]", () => {
    const obj = {
      [CHANGEFEED]: {
        get current() {
          return 0
        },
        subscribe: () => () => {},
      },
    }
    expect(hasChangefeed(obj)).toBe(true)
  })

  it("returns true for a function with [CHANGEFEED]", () => {
    const fn: any = () => 0
    fn[CHANGEFEED] = {
      get current() {
        return 0
      },
      subscribe: () => () => {},
    }
    expect(hasChangefeed(fn)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Symbol identity
// ---------------------------------------------------------------------------

describe("CHANGEFEED symbol identity", () => {
  it("matches Symbol.for('kyneta:changefeed') — cross-package detection works", () => {
    // This is the critical invariant of the package extraction:
    // any object created with Symbol.for("kyneta:changefeed") (e.g. by
    // @kyneta/schema's withChangefeed interpreter) must be detectable
    // by hasChangefeed from @kyneta/changefeed.
    const externalSymbol = Symbol.for("kyneta:changefeed")
    const obj: Record<symbol, unknown> = {}
    Object.defineProperty(obj, externalSymbol, {
      value: { current: 0, subscribe: () => () => {} },
      enumerable: false,
    })
    expect(hasChangefeed(obj)).toBe(true)
    expect((obj as any)[CHANGEFEED]).toBe((obj as any)[externalSymbol])
  })
})

// ---------------------------------------------------------------------------
// createChangefeed
// ---------------------------------------------------------------------------

describe("createChangefeed", () => {
  it(".current reads the live value", () => {
    let value = "hello"
    const [feed] = createChangefeed(() => value)
    expect(feed.current).toBe("hello")

    value = "world"
    expect(feed.current).toBe("world")
  })

  it(".subscribe() receives emitted changesets with origin", () => {
    let value = 0
    const [feed, emit] = createChangefeed<number, ChangeBase>(() => value)

    const received: Changeset<ChangeBase>[] = []
    feed.subscribe(cs => {
      received.push(cs)
    })

    value = 1
    emit({ changes: [{ type: "replace" }] })

    value = 2
    emit({ changes: [{ type: "replace" }], origin: "sync" })

    expect(received).toHaveLength(2)
    expect(received[0]!.changes).toEqual([{ type: "replace" }])
    expect(received[0]!.origin).toBeUndefined()
    expect(received[1]!.origin).toBe("sync")
  })

  it("hasChangefeed() returns true for the feed", () => {
    const [feed] = createChangefeed(() => 0)
    expect(hasChangefeed(feed)).toBe(true)
  })

  it("[CHANGEFEED] protocol object has live .current", () => {
    let value = 10
    const [feed] = createChangefeed(() => value)
    expect(feed[CHANGEFEED].current).toBe(10)

    value = 20
    expect(feed[CHANGEFEED].current).toBe(20)
  })

  it("unsubscribe stops delivery", () => {
    const value = 0
    const [feed, emit] = createChangefeed<number, ChangeBase>(() => value)

    const received: Changeset<ChangeBase>[] = []
    const unsub = feed.subscribe(cs => {
      received.push(cs)
    })

    emit({ changes: [{ type: "replace" }] })
    expect(received).toHaveLength(1)

    unsub()
    emit({ changes: [{ type: "replace" }] })
    expect(received).toHaveLength(1)
  })

  it("multiple subscribers all receive changesets", () => {
    const [feed, emit] = createChangefeed<number, ChangeBase>(() => 0)

    const a: Changeset<ChangeBase>[] = []
    const b: Changeset<ChangeBase>[] = []
    feed.subscribe(cs => a.push(cs))
    feed.subscribe(cs => b.push(cs))

    emit({ changes: [{ type: "replace" }] })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// changefeed() projector
// ---------------------------------------------------------------------------

describe("changefeed() projector", () => {
  it("delegates .current to source protocol", () => {
    let value = "initial"
    const source = {
      [CHANGEFEED]: {
        get current() {
          return value
        },
        subscribe: () => () => {},
      },
    }

    const feed = changefeed(source)
    expect(feed.current).toBe("initial")

    value = "updated"
    expect(feed.current).toBe("updated")
  })

  it("delegates .subscribe() to source protocol", () => {
    const cb = vi.fn()
    let storedCb: ((cs: Changeset) => void) | null = null

    const source = {
      [CHANGEFEED]: {
        get current() {
          return 0
        },
        subscribe: (callback: (cs: Changeset) => void) => {
          storedCb = callback
          return () => {
            storedCb = null
          }
        },
      },
    }

    const feed = changefeed(source)
    const unsub = feed.subscribe(cb)

    expect(storedCb).not.toBeNull()
    storedCb!({ changes: [{ type: "replace" }] })
    expect(cb).toHaveBeenCalledTimes(1)

    unsub()
    expect(storedCb).toBeNull()
  })

  it("[CHANGEFEED] on projected feed is the source protocol", () => {
    const protocol = {
      get current() {
        return 42
      },
      subscribe: () => () => {},
    }

    const source = { [CHANGEFEED]: protocol }
    const feed = changefeed(source)
    expect(feed[CHANGEFEED]).toBe(protocol)
  })

  it("hasChangefeed() returns true for projected feed", () => {
    const source = {
      [CHANGEFEED]: {
        get current() {
          return 0
        },
        subscribe: () => () => {},
      },
    }
    expect(hasChangefeed(changefeed(source))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// staticChangefeed
// ---------------------------------------------------------------------------

describe("staticChangefeed", () => {
  it(".current returns the value and subscribe never fires", () => {
    const cf = staticChangefeed("hello")
    expect(cf.current).toBe("hello")

    const cb = vi.fn()
    const unsub = cf.subscribe(cb)
    expect(cb).not.toHaveBeenCalled()
    unsub()
    expect(cb).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createCallable
// ---------------------------------------------------------------------------

describe("createCallable", () => {
  it("calling the feed returns current value", () => {
    let value = 5
    const [source] = createChangefeed(() => value)
    const feed = createCallable(source)

    expect(feed()).toBe(5)

    value = 10
    expect(feed()).toBe(10)
  })

  it(".current returns the current value", () => {
    let value = "a"
    const [source] = createChangefeed(() => value)
    const feed = createCallable(source)

    expect(feed.current).toBe("a")

    value = "b"
    expect(feed.current).toBe("b")
  })

  it(".subscribe() delegates to source subscribe", () => {
    let value = 0
    const [source, emit] = createChangefeed<number, ChangeBase>(() => value)
    const feed = createCallable(source)

    const received: Changeset<ChangeBase>[] = []
    feed.subscribe(cs => {
      received.push(cs)
    })

    value = 1
    emit({ changes: [{ type: "replace" }] })
    expect(received).toHaveLength(1)
  })

  it("hasChangefeed() returns true", () => {
    const [source] = createChangefeed(() => 0)
    const feed = createCallable(source)
    expect(hasChangefeed(feed)).toBe(true)
  })

  it("[CHANGEFEED] protocol delegates to source", () => {
    let value = 100
    const [source] = createChangefeed(() => value)
    const feed = createCallable(source)

    expect(feed[CHANGEFEED].current).toBe(100)

    value = 200
    expect(feed[CHANGEFEED].current).toBe(200)
  })

  it("feed() reflects source value changes", () => {
    let value = 0
    const [source, emit] = createChangefeed<number, ChangeBase>(() => value)
    const feed = createCallable(source)

    expect(feed()).toBe(0)

    // Value changes are reflected through the getter delegation,
    // independent of emit (which only notifies subscribers).
    value = 42
    expect(feed()).toBe(42)
    expect(feed.current).toBe(42)
  })

  it("unsubscribe stops delivery", () => {
    const [source, emit] = createChangefeed<number, ChangeBase>(() => 0)
    const feed = createCallable(source)

    const received: Changeset<ChangeBase>[] = []
    const unsub = feed.subscribe(cs => {
      received.push(cs)
    })

    emit({ changes: [{ type: "replace" }] })
    expect(received).toHaveLength(1)

    unsub()
    emit({ changes: [{ type: "replace" }] })
    expect(received).toHaveLength(1)
  })

  it("[CHANGEFEED] is non-enumerable but discoverable via getOwnPropertySymbols", () => {
    const [source] = createChangefeed(() => 0)
    const feed = createCallable(source)
    expect(Object.keys(feed)).not.toContain(CHANGEFEED.toString())
    const symbols = Object.getOwnPropertySymbols(feed)
    expect(symbols).toContain(CHANGEFEED)
  })
})
