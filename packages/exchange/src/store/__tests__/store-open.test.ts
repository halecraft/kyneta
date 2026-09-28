// store-open — the pure decision every backend's open runs: the format
// marker and the seat, from one read of the store-wide metadata.

import { describe, expect, it } from "vitest"
import type { SeatPool } from "../seats.js"
import {
  type StoreFormatVersion,
  StoreFormatVersionError,
} from "../store-format.js"
import { planStoreOpen, type Seating } from "../store-open.js"

const current: StoreFormatVersion = { major: 1, minor: 1 }

function plan(input: {
  seating: Seating
  storedFormat?: unknown
  storeHasData?: boolean
  storedPool?: unknown
  fresh?: string[]
}) {
  return planStoreOpen({
    backend: "test",
    current,
    storedFormat: input.storedFormat,
    storeHasData: input.storeHasData ?? false,
    storedPool: input.storedPool,
    seating: input.seating,
    fresh: input.fresh ?? ["fresh-1", "fresh-2"],
  })
}

const pooled = (held: string[] = []): Seating => ({
  kind: "pooled",
  held: new Set(held),
})

describe("planStoreOpen — the format", () => {
  it.each([
    ["session", { kind: "session" }],
    ["owned", { kind: "owned" }],
    ["pooled", pooled()],
  ] as const)("refuses an incompatible store before seating (%s)", (_n, seating) => {
    const opened = plan({ seating, storedFormat: { major: 2, minor: 0 } })
    expect(opened.action).toBe("refuse")
    if (opened.action !== "refuse") return
    expect(opened.error).toBeInstanceOf(StoreFormatVersionError)
    expect(opened.error.reason).toBe("incompatible-major")
    expect(opened.error.backend).toBe("test")
  })

  it("refuses a malformed marker", () => {
    const opened = plan({ seating: pooled(), storedFormat: "nonsense" })
    expect(opened.action === "refuse" && opened.error.reason).toBe(
      "malformed-version",
    )
  })

  it("refuses data with no marker", () => {
    const opened = plan({ seating: pooled(), storeHasData: true })
    expect(opened.action === "refuse" && opened.error.reason).toBe(
      "unversioned-existing-data",
    )
  })

  it("stamps a fresh store, and accepts an older minor without writing it", () => {
    const fresh = plan({ seating: pooled() })
    expect(fresh.action === "open" && fresh.writeFormat).toEqual(current)
    const older = plan({
      seating: pooled(),
      storedFormat: { major: 1, minor: 0 },
    })
    expect(older.action === "open" && older.writeFormat).toBeUndefined()
  })
})

describe("planStoreOpen — the seat", () => {
  const stored: SeatPool = { seats: ["a", "b"], fences: { a: 2, b: 1 } }
  const format = { major: 1, minor: 0 }

  it("session: a fresh seat, and no pool write", () => {
    expect(
      plan({
        seating: { kind: "session" },
        storedFormat: format,
        storedPool: stored,
      }),
    ).toEqual({ action: "open", seat: { kind: "session", peerId: "fresh-1" } })
  })

  it("owned: a fresh store stores its first seat", () => {
    expect(plan({ seating: { kind: "owned" } })).toEqual({
      action: "open",
      seat: { kind: "owned", peerId: "fresh-1" },
      writeFormat: current,
      writePool: { seats: ["fresh-1"], fences: {} },
    })
  })

  it("owned: an existing store reuses its seat, writing nothing", () => {
    expect(
      plan({
        seating: { kind: "owned" },
        storedFormat: format,
        storedPool: stored,
      }),
    ).toEqual({ action: "open", seat: { kind: "owned", peerId: "a" } })
  })

  it("pooled: a fresh store adds its first seat", () => {
    expect(plan({ seating: pooled() })).toEqual({
      action: "open",
      seat: { kind: "pooled", peerId: "fresh-1", fence: 1 },
      writeFormat: current,
      writePool: { seats: ["fresh-1"], fences: { "fresh-1": 1 } },
    })
  })

  it("pooled: takes the oldest free seat", () => {
    expect(
      plan({
        seating: pooled(["a"]),
        storedFormat: format,
        storedPool: stored,
      }),
    ).toEqual({
      action: "open",
      seat: { kind: "pooled", peerId: "b", fence: 2 },
      writePool: { seats: ["a", "b"], fences: { a: 2, b: 2 } },
    })
  })

  it("pooled: passes over a fresh id that collides, and takes the next", () => {
    // Their 53-bit peer numbers agree (see seats.test.ts).
    const pool: SeatPool = { seats: ["1885b9e88dae2f"], fences: {} }
    const opened = plan({
      seating: pooled(["1885b9e88dae2f"]),
      storedFormat: format,
      storedPool: pool,
      fresh: ["052945767069a9", "fresh-2"],
    })
    expect(opened.action === "open" && opened.seat).toEqual({
      kind: "pooled",
      peerId: "fresh-2",
      fence: 1,
    })
  })
})
