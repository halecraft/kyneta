import { describe, expect, it } from "vitest"
import { CHANGEFEED } from "../changefeed.js"
import { firstDefined, settableFeed, signalFeed } from "../combinators.js"

/** A feed over a variable, and the setter that moves it. */
function variable<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const feed = signalFeed(
    () => value,
    onChange => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
  )
  return {
    feed,
    listeners,
    set(next: T) {
      value = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe("signalFeed", () => {
  it("reads the getter and signals with an empty changeset", () => {
    const v = variable(1)
    const heard: unknown[] = []
    v.feed[CHANGEFEED].subscribe(changeset => heard.push(changeset))
    v.set(2)
    expect(v.feed()).toBe(2)
    expect(v.feed[CHANGEFEED].current).toBe(2)
    expect(heard).toEqual([{ changes: [] }])
  })
})

describe("firstDefined", () => {
  it("answers the first feed that has an answer", () => {
    const a = variable<string | undefined>(undefined)
    const b = variable<string | undefined>("b")
    const first = firstDefined(a.feed, b.feed)
    expect(first()).toBe("b")
    a.set("a")
    expect(first()).toBe("a")
    a.set(undefined)
    b.set(undefined)
    expect(first()).toBeUndefined()
  })

  it("notifies when any of its feeds changes, and stops with the subscription", () => {
    const a = variable<number | undefined>(undefined)
    const b = variable<number | undefined>(undefined)
    let heard = 0
    const stop = firstDefined(a.feed, b.feed)[CHANGEFEED].subscribe(() => {
      heard++
    })
    a.set(1)
    b.set(2)
    expect(heard).toBe(2)
    stop()
    expect(a.listeners.size + b.listeners.size).toBe(0)
  })
})

describe("settableFeed", () => {
  it("holds a value and notifies on every set", () => {
    const settable = settableFeed(1)
    let heard = 0
    settable[CHANGEFEED].subscribe(() => {
      heard++
    })
    settable.set(2)
    settable.set(2)
    expect(settable()).toBe(2)
    expect(heard).toBe(2)
  })

  it("follows a feed it holds, and lets go of it when set aside", () => {
    const inner = variable("live")
    const settable = settableFeed(inner.feed)
    let heard = 0
    settable[CHANGEFEED].subscribe(() => {
      heard++
    })
    inner.set("moved")
    expect(settable()).toBe("moved")
    expect(heard).toBe(1)
    settable.set("closed")
    expect(heard).toBe(2)
    expect(inner.listeners.size).toBe(0)
    inner.set("ignored")
    expect(settable()).toBe("closed")
    expect(heard).toBe(2)
  })

  it("subscribes to the feed it holds only while it has subscribers", () => {
    const inner = variable(0)
    const settable = settableFeed(inner.feed)
    expect(inner.listeners.size).toBe(0)
    const stop = settable[CHANGEFEED].subscribe(() => {})
    expect(inner.listeners.size).toBe(1)
    stop()
    expect(inner.listeners.size).toBe(0)
  })
})
