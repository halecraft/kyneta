import { describe, expect, it } from "vitest"
import { createLocalUpdateSignal } from "../substrates/local-update-signal.js"

describe("createLocalUpdateSignal", () => {
  it("notifies every subscriber, and no longer one that unsubscribed", () => {
    const signal = createLocalUpdateSignal()
    const heard: string[] = []
    const stopA = signal.subscribe(() => heard.push("a"))
    signal.subscribe(() => heard.push("b"))

    signal.notify()
    stopA()
    signal.notify()

    expect(heard).toEqual(["a", "b", "b"])
  })

  it("keeps two subscriptions of one function independent", () => {
    const signal = createLocalUpdateSignal()
    let count = 0
    const listener = (): void => {
      count++
    }
    const stop = signal.subscribe(listener)
    signal.subscribe(listener)

    stop()
    signal.notify()

    expect(count).toBe(1)
  })
})
