// seats — the pure seat pool: decoding it, allocating from it, and the fence
// check every pooled write runs.

import { peerNumber } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  allocateSeat,
  assertSeatHeld,
  parseSeatPool,
  SeatLostError,
  type SeatPool,
} from "../seats.js"

const EMPTY: SeatPool = { seats: [], fences: {} }

describe("parseSeatPool", () => {
  it("decodes a stored pool, as an object or as JSON text", () => {
    const pool = { seats: ["a", "b"], fences: { a: 2, b: 1 } }
    expect(parseSeatPool(pool)).toEqual(pool)
    expect(parseSeatPool(JSON.stringify(pool))).toEqual(pool)
  })

  it("decodes an absent pool as empty", () => {
    expect(parseSeatPool(undefined)).toEqual(EMPTY)
    expect(parseSeatPool(null)).toEqual(EMPTY)
  })

  it.each([
    ["not JSON", "{"],
    ["a number", 7],
    ["an array", ["a"]],
    ["seats missing", { fences: {} }],
    ["a seat that is not a string", { seats: [1], fences: {} }],
    ["a repeated seat", { seats: ["a", "a"], fences: {} }],
    ["fences missing", { seats: ["a"] }],
    ["fences as an array", { seats: ["a"], fences: [1] }],
    ["a fence for no seat", { seats: ["a"], fences: { b: 1 } }],
    ["a fractional fence", { seats: ["a"], fences: { a: 1.5 } }],
    ["a zero fence", { seats: ["a"], fences: { a: 0 } }],
    ["a fence that is not a number", { seats: ["a"], fences: { a: "1" } }],
  ])("decodes %s as empty", (_name, raw) => {
    expect(parseSeatPool(raw)).toEqual(EMPTY)
  })
})

describe("allocateSeat", () => {
  const pool: SeatPool = { seats: ["a", "b", "c"], fences: { a: 3, b: 1 } }

  it("takes the oldest seat not held, and increments its fence", () => {
    const allocated = allocateSeat({ pool, held: new Set(["a"]), fresh: "z" })
    expect(allocated).toEqual({
      seat: { kind: "pooled", peerId: "b", fence: 2 },
      pool: { seats: ["a", "b", "c"], fences: { a: 3, b: 2 } },
    })
  })

  it("starts a seat's fence at 1", () => {
    const allocated = allocateSeat({
      pool,
      held: new Set(["a", "b"]),
      fresh: "z",
    })
    expect(allocated).toEqual({
      seat: { kind: "pooled", peerId: "c", fence: 1 },
      pool: { seats: ["a", "b", "c"], fences: { a: 3, b: 1, c: 1 } },
    })
  })

  it("appends `fresh` when every seat is held", () => {
    const allocated = allocateSeat({
      pool,
      held: new Set(["a", "b", "c"]),
      fresh: "z",
    })
    expect(allocated).toEqual({
      seat: { kind: "pooled", peerId: "z", fence: 1 },
      pool: { seats: ["a", "b", "c", "z"], fences: { a: 3, b: 1, z: 1 } },
    })
  })

  it("refuses a `fresh` whose 53-bit peer number a seat already has", () => {
    // Two ids whose 64-bit numbers differ and whose 53-bit numbers agree,
    // found by a Pollard rho search over FNV-1a modulo 2^53.
    const [seat, fresh] = ["1885b9e88dae2f", "052945767069a9"]
    expect(peerNumber(fresh, 53)).toBe(peerNumber(seat, 53))
    expect(peerNumber(fresh, 64)).not.toBe(peerNumber(seat, 64))
    const full: SeatPool = { seats: [seat], fences: { [seat]: 1 } }
    expect(allocateSeat({ pool: full, held: new Set([seat]), fresh })).toEqual({
      collision: true,
    })
  })

  it("ignores `fresh` while a pool seat is free", () => {
    const allocated = allocateSeat({ pool, held: new Set(), fresh: "a" })
    expect(allocated).toEqual({
      seat: { kind: "pooled", peerId: "a", fence: 4 },
      pool: { seats: ["a", "b", "c"], fences: { a: 4, b: 1 } },
    })
  })
})

describe("assertSeatHeld", () => {
  const pool: SeatPool = { seats: ["a"], fences: { a: 2 } }

  it("passes for the seat's current claim", () => {
    expect(() =>
      assertSeatHeld(pool, { kind: "pooled", peerId: "a", fence: 2 }),
    ).not.toThrow()
  })

  it("throws SeatLostError once the seat has been claimed again", () => {
    expect(() =>
      assertSeatHeld(pool, { kind: "pooled", peerId: "a", fence: 1 }),
    ).toThrow(SeatLostError)
  })

  it("throws SeatLostError for a seat the pool does not list", () => {
    expect(() =>
      assertSeatHeld(pool, { kind: "pooled", peerId: "b", fence: 1 }),
    ).toThrow(SeatLostError)
  })
})
