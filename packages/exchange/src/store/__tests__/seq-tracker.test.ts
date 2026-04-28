import { describe, expect, it } from "vitest"
import { SeqNoTracker } from "../seq-tracker.js"

describe("SeqNoTracker", () => {
  it("calls discover on first access, then increments from cache", async () => {
    const tracker = new SeqNoTracker()
    let discoverCalls = 0

    const discover = async () => {
      discoverCalls++
      return 4 // simulate 5 existing records (0..4)
    }

    expect(await tracker.next("doc-1", discover)).toBe(5)
    expect(await tracker.next("doc-1", discover)).toBe(6)
    expect(await tracker.next("doc-1", discover)).toBe(7)
    expect(discoverCalls).toBe(1)
  })

  it("starts from 0 when discover returns null (no existing records)", async () => {
    const tracker = new SeqNoTracker()
    expect(await tracker.next("doc-1", async () => null)).toBe(0)
    expect(await tracker.next("doc-1", async () => null)).toBe(1)
  })

  it("tracks separate sequences per docId", async () => {
    const tracker = new SeqNoTracker()

    expect(await tracker.next("a", async () => null)).toBe(0)
    expect(await tracker.next("b", async () => 9)).toBe(10)
    expect(await tracker.next("a", async () => null)).toBe(1)
    expect(await tracker.next("b", async () => 9)).toBe(11)
  })

  it("reset sets the base for subsequent next calls", async () => {
    const tracker = new SeqNoTracker()

    expect(await tracker.next("doc-1", async () => null)).toBe(0)
    expect(await tracker.next("doc-1", async () => null)).toBe(1)

    tracker.reset("doc-1", 0) // e.g. replace with 1 record (seq 0)
    expect(await tracker.next("doc-1", async () => null)).toBe(1)
  })

  it("remove forces re-discovery on next access", async () => {
    const tracker = new SeqNoTracker()
    let discoverCalls = 0

    const discover = async () => {
      discoverCalls++
      return null
    }

    await tracker.next("doc-1", discover)
    expect(discoverCalls).toBe(1)

    tracker.remove("doc-1")

    await tracker.next("doc-1", discover)
    expect(discoverCalls).toBe(2)
  })
})
