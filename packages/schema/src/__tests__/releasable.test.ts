import { CHANGEFEED } from "@kyneta/changefeed"
import { describe, expect, it } from "vitest"
import { DocumentClosedError } from "../refusal.js"
import { releasable } from "../releasable.js"

describe("releasable", () => {
  it("hands out its value until released, then throws DocumentClosedError with the reason", () => {
    const slot = releasable({ n: 1 }, null)
    expect(slot.get()).toEqual({ n: 1 })
    expect(slot.closed()).toBeUndefined()
    slot.release("destroyed")
    expect(() => slot.get()).toThrow(DocumentClosedError)
    expect(slot.closed()?.reason).toBe("destroyed")
    try {
      slot.get()
    } catch (error) {
      expect((error as DocumentClosedError).reason).toBe("destroyed")
    }
  })

  it("frees an owned value once, however often it is released", () => {
    const freed: object[] = []
    const value = {}
    const slot = releasable(value, v => freed.push(v))
    slot.release("disposed")
    slot.release("destroyed")
    expect(freed).toEqual([value])
    expect(slot.closed()?.reason).toBe("disposed")
  })

  it("never frees a borrowed value", () => {
    const slot = releasable({}, null)
    expect(() => slot.release("disposed")).not.toThrow()
    expect(() => slot.get()).toThrow(DocumentClosedError)
  })

  it("take empties the slot without freeing, and the new holder owns the value", () => {
    const freed: object[] = []
    const value = {}
    const slot = releasable(value, v => freed.push(v))
    expect(slot.take()).toBe(value)
    expect(() => slot.get()).toThrow(DocumentClosedError)
    expect(() => slot.take()).toThrow(DocumentClosedError)
    slot.release("disposed")
    expect(freed).toEqual([])
  })

  it("closed notifies on release and on take", () => {
    const released = releasable({}, null)
    const taken = releasable({}, null)
    let heard = 0
    released.closed[CHANGEFEED].subscribe(() => heard++)
    taken.closed[CHANGEFEED].subscribe(() => heard++)
    released.release("destroyed")
    released.release("destroyed")
    taken.take()
    expect(heard).toBe(2)
  })
})
