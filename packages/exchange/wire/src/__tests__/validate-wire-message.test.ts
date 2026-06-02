// validate-wire-message — exhaustive tests for the runtime wire validator.
//
// Covers top-level rejection, per-variant positive/negative cases,
// path reporting, and forward-compatibility (unknown extra fields).

import { describe, expect, it } from "vitest"
import { validateWireMessage } from "../validate-wire-message.js"
import {
  MessageType,
  PayloadEncoding,
  PayloadKind,
  SyncModeWire,
} from "../wire-types.js"

// ---------------------------------------------------------------------------
// 1. Top-level validation
// ---------------------------------------------------------------------------

describe("top-level validation", () => {
  it("rejects null", () => {
    const r = validateWireMessage(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("non-null object")
  })

  it("rejects undefined", () => {
    const r = validateWireMessage(undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("non-null object")
  })

  it("rejects a string", () => {
    const r = validateWireMessage("string")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("non-null object")
  })

  it("rejects a number", () => {
    const r = validateWireMessage(42)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("non-null object")
  })

  it("rejects an array", () => {
    const r = validateWireMessage([])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("non-null object")
  })

  it("rejects empty object (no t field)", () => {
    const r = validateWireMessage({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("MessageTypeValue")
  })

  it("rejects unknown message type", () => {
    const r = validateWireMessage({ t: 999 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("MessageTypeValue")
      expect(r.error.path).toEqual(["t"])
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Establish (t: 0x01)
// ---------------------------------------------------------------------------

describe("establish (t: 0x01)", () => {
  it("accepts a valid establish message", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "peer1",
      y: "user",
    })
    expect(r.ok).toBe(true)
  })

  it("accepts establish with optional fields", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "peer1",
      y: "service",
      n: "MyService",
      f: { a: true, s: false },
    })
    expect(r.ok).toBe(true)
  })

  it("accepts establish with unknown extra fields (forward compat)", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "peer1",
      y: "user",
      xyz: 42,
    })
    expect(r.ok).toBe(true)
  })

  it("rejects missing id", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      y: "user",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["id"])
  })

  it("rejects missing y", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "peer1",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["y"])
  })

  it("rejects wrong type for id", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: 123,
      y: "user",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["id"])
  })

  it("rejects invalid y value", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "peer1",
      y: "invalid",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["y"])
  })

  it("rejects non-boolean f.a", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "peer1",
      y: "user",
      f: { a: "yes" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["f", "a"])
  })

  it("accepts establish with a valid pv pair", () => {
    for (const pv of [
      [1, 0],
      [2, 1],
    ]) {
      const r = validateWireMessage({
        t: MessageType.Establish,
        id: "peer1",
        y: "user",
        pv,
      })
      expect(r.ok).toBe(true)
    }
  })

  it("accepts establish with pv absent (forward-tolerant)", () => {
    const r = validateWireMessage({
      t: MessageType.Establish,
      id: "p",
      y: "user",
    })
    expect(r.ok).toBe(true)
  })

  it("rejects malformed pv with path [pv]", () => {
    for (const pv of [
      [],
      [1],
      [1, 2, 3],
      [0, 0],
      [1, -1],
      [1.5, 0],
      ["1", 0],
      1,
    ]) {
      const r = validateWireMessage({
        t: MessageType.Establish,
        id: "peer1",
        y: "user",
        pv,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.path).toEqual(["pv"])
    }
  })
})

// ---------------------------------------------------------------------------
// 3. Depart (t: 0x02)
// ---------------------------------------------------------------------------

describe("depart (t: 0x02)", () => {
  it("accepts a valid depart message", () => {
    const r = validateWireMessage({ t: MessageType.Depart })
    expect(r.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 4. Present (t: 0x10)
// ---------------------------------------------------------------------------

describe("present (t: 0x10)", () => {
  const validDoc = {
    d: "doc1",
    rt: ["type", 1, 2],
    ms: SyncModeWire.Collaborative,
    sh: "hash123",
  }

  it("accepts a valid present message", () => {
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [validDoc],
    })
    expect(r.ok).toBe(true)
  })

  it("accepts present with alias fields (a, sa)", () => {
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [{ ...validDoc, a: 0, sa: 1 }],
    })
    expect(r.ok).toBe(true)
  })

  it("accepts present with shx instead of sh", () => {
    const { sh: _, ...docWithoutSh } = validDoc
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [{ ...docWithoutSh, shx: 5 }],
    })
    expect(r.ok).toBe(true)
  })

  it("rejects missing docs", () => {
    const r = validateWireMessage({ t: MessageType.Present })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["docs"])
  })

  it("rejects docs not array", () => {
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: "not-array",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["docs"])
  })

  it("rejects doc entry missing d", () => {
    const { d: _, ...docWithoutD } = validDoc
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [docWithoutD],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["docs", 0, "d"])
  })

  it("rejects doc entry with wrong rt shape", () => {
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [{ ...validDoc, rt: [1, 2, 3] }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["docs", 0, "rt"])
  })

  it("rejects doc entry with both sh and shx", () => {
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [{ ...validDoc, shx: 5 }],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("exactly one of sh or shx")
      expect(r.error.path).toEqual(["docs", 0])
    }
  })

  it("rejects doc entry with neither sh nor shx", () => {
    const { sh: _, ...docWithoutSh } = validDoc
    const r = validateWireMessage({
      t: MessageType.Present,
      docs: [docWithoutSh],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("exactly one of sh or shx")
      expect(r.error.path).toEqual(["docs", 0])
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Interest (t: 0x11)
// ---------------------------------------------------------------------------

describe("interest (t: 0x11)", () => {
  it("accepts interest with doc", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
      doc: "doc1",
    })
    expect(r.ok).toBe(true)
  })

  it("accepts interest with dx", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
      dx: 5,
    })
    expect(r.ok).toBe(true)
  })

  it("accepts interest with optional fields (v, r)", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
      doc: "doc1",
      v: "1.0",
      r: true,
    })
    expect(r.ok).toBe(true)
  })

  it("rejects both doc and dx", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
      doc: "doc1",
      dx: 5,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("exactly one of doc or dx")
  })

  it("rejects neither doc nor dx", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("exactly one of doc or dx")
  })

  it("rejects v not string", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
      doc: "doc1",
      v: 42,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("v must be a string")
      expect(r.error.path).toEqual(["v"])
    }
  })

  it("rejects r not boolean", () => {
    const r = validateWireMessage({
      t: MessageType.Interest,
      doc: "doc1",
      r: "yes",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("r must be a boolean")
      expect(r.error.path).toEqual(["r"])
    }
  })
})

// ---------------------------------------------------------------------------
// 6. Offer (t: 0x12)
// ---------------------------------------------------------------------------

describe("offer (t: 0x12)", () => {
  it("accepts a valid offer with binary data", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pk: PayloadKind.Entirety,
      pe: PayloadEncoding.Binary,
      d: new Uint8Array([1, 2, 3]),
      v: "1.0",
    })
    expect(r.ok).toBe(true)
  })

  it("accepts a valid offer with string data", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pk: PayloadKind.Entirety,
      pe: PayloadEncoding.Json,
      d: "jsondata",
      v: "1.0",
    })
    expect(r.ok).toBe(true)
  })

  it("rejects missing pk", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pe: PayloadEncoding.Json,
      d: "data",
      v: "1.0",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["pk"])
  })

  it("rejects missing pe", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pk: PayloadKind.Entirety,
      d: "data",
      v: "1.0",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["pe"])
  })

  it("rejects missing d", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pk: PayloadKind.Entirety,
      pe: PayloadEncoding.Json,
      v: "1.0",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["d"])
  })

  it("rejects missing v", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pk: PayloadKind.Entirety,
      pe: PayloadEncoding.Json,
      d: "data",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.path).toEqual(["v"])
  })

  it("rejects d as number", () => {
    const r = validateWireMessage({
      t: MessageType.Offer,
      doc: "doc1",
      pk: PayloadKind.Entirety,
      pe: PayloadEncoding.Json,
      d: 42,
      v: "1.0",
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("string or Uint8Array")
      expect(r.error.path).toEqual(["d"])
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Dismiss (t: 0x13)
// ---------------------------------------------------------------------------

describe("dismiss (t: 0x13)", () => {
  it("accepts dismiss with doc", () => {
    const r = validateWireMessage({
      t: MessageType.Dismiss,
      doc: "doc1",
    })
    expect(r.ok).toBe(true)
  })

  it("accepts dismiss with dx", () => {
    const r = validateWireMessage({
      t: MessageType.Dismiss,
      dx: 3,
    })
    expect(r.ok).toBe(true)
  })

  it("rejects both doc and dx", () => {
    const r = validateWireMessage({
      t: MessageType.Dismiss,
      doc: "doc1",
      dx: 3,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.reason).toContain("exactly one of doc or dx")
  })
})

describe("vacant (t: 0x14)", () => {
  it("accepts vacant with doc", () => {
    const r = validateWireMessage({
      t: MessageType.Vacant,
      doc: "doc1",
    })
    expect(r.ok).toBe(true)
  })

  it("accepts vacant with dx", () => {
    const r = validateWireMessage({
      t: MessageType.Vacant,
      dx: 3,
    })
    expect(r.ok).toBe(true)
  })

  it("rejects both doc and dx, labeling the variant 'vacant'", () => {
    const r = validateWireMessage({
      t: MessageType.Vacant,
      doc: "doc1",
      dx: 3,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.reason).toContain("exactly one of doc or dx")
      expect(r.error.reason).toContain("vacant")
    }
  })
})
