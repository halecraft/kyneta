// pipeline — integration tests for the Pipeline imperative shell.
//
// Verifies symmetric and asymmetric round-trips (binary, text, SSE pair),
// fragmentation, reset/dispose semantics, and error routing.

import { decodeBinaryFrame, type Result, type WireError } from "@kyneta/wire"
import { describe, expect, it, vi } from "vitest"
import type { ChannelMsg, EstablishMsg, OfferMsg } from "../messages.js"
import { type FrameTrace, Pipeline } from "../pipeline.js"
import { PROTOCOL_VERSION } from "../types.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const establishMsg: EstablishMsg = {
  type: "establish",
  identity: { peerId: "peer1", principal: "Test", type: "user" },
  features: { alias: true },
  protocolVersion: PROTOCOL_VERSION,
}

const largeOffer: OfferMsg = {
  type: "offer",
  docId: "doc1",
  payload: {
    kind: "entirety",
    encoding: "binary",
    data: new Uint8Array(2000),
  },
  version: "1",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap all results, throwing on the first error. */
function unwrapAll<T>(results: readonly Result<T, WireError>[]): T[] {
  const out: T[] = []
  for (const r of results) {
    if (!r.ok) {
      throw new Error(`Unexpected error: ${JSON.stringify(r.error)}`)
    }
    out.push(r.value)
  }
  return out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Pipeline — symmetric binary round-trip", () => {
  it("send → receive recovers the original establish message", () => {
    const sender = new Pipeline({ send: "binary" })
    const receiver = new Pipeline({ send: "binary" })

    try {
      const results = sender.send(establishMsg)
      expect(results.length).toBeGreaterThan(0)

      const frames = unwrapAll(results)

      const recovered: ChannelMsg[] = []
      for (const frame of frames) {
        const msgs = receiver.receive(frame)
        for (const r of msgs) {
          if (!r.ok)
            throw new Error(`receive error: ${JSON.stringify(r.error)}`)
          recovered.push(r.value)
        }
      }

      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toEqual(establishMsg)
    } finally {
      sender.dispose()
      receiver.dispose()
    }
  })
})

describe("Pipeline — symmetric text round-trip", () => {
  it("send → receive recovers the original establish message", () => {
    const sender = new Pipeline({ send: "text" })
    const receiver = new Pipeline({ send: "text" })

    try {
      const results = sender.send(establishMsg)
      expect(results.length).toBeGreaterThan(0)

      const frames = unwrapAll(results)

      const recovered: ChannelMsg[] = []
      for (const frame of frames) {
        const msgs = receiver.receive(frame)
        for (const r of msgs) {
          if (!r.ok)
            throw new Error(`receive error: ${JSON.stringify(r.error)}`)
          recovered.push(r.value)
        }
      }

      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toEqual(establishMsg)
    } finally {
      sender.dispose()
      receiver.dispose()
    }
  })
})

describe("Pipeline — asymmetric round-trip (SSE pair)", () => {
  it("server text→binary, client binary→text both recover messages", () => {
    // Server sends text, receives binary
    const server = new Pipeline<"text", "binary">({
      send: "text",
      receive: "binary",
    })
    // Client sends binary, receives text
    const client = new Pipeline<"binary", "text">({
      send: "binary",
      receive: "text",
    })

    try {
      // Server sends establish (text out) → client receives (text in)
      const serverOut = server.send(establishMsg)
      const serverFrames = unwrapAll(serverOut)

      const clientReceived: ChannelMsg[] = []
      for (const frame of serverFrames) {
        const msgs = client.receive(frame)
        for (const r of msgs) {
          if (!r.ok)
            throw new Error(`client receive error: ${JSON.stringify(r.error)}`)
          clientReceived.push(r.value)
        }
      }

      expect(clientReceived).toHaveLength(1)
      expect(clientReceived[0]).toEqual(establishMsg)

      // Client sends establish (binary out) → server receives (binary in)
      const clientEstablish: EstablishMsg = {
        type: "establish",
        identity: { peerId: "peer2", principal: "Client", type: "user" },
        features: { alias: true },
        protocolVersion: PROTOCOL_VERSION,
      }

      const clientOut = client.send(clientEstablish)
      const clientFrames = unwrapAll(clientOut)

      const serverReceived: ChannelMsg[] = []
      for (const frame of clientFrames) {
        const msgs = server.receive(frame)
        for (const r of msgs) {
          if (!r.ok)
            throw new Error(`server receive error: ${JSON.stringify(r.error)}`)
          serverReceived.push(r.value)
        }
      }

      expect(serverReceived).toHaveLength(1)
      expect(serverReceived[0]).toEqual(clientEstablish)
    } finally {
      server.dispose()
      client.dispose()
    }
  })
})

describe("Pipeline — fragmentation", () => {
  it("large offer fragments into multiple pieces, receiver reassembles", () => {
    const sender = new Pipeline({
      send: "binary",
      opts: { threshold: 100 },
    })
    const receiver = new Pipeline({ send: "binary" })

    try {
      // First establish so alias state is initialized for both sides
      const estResults = sender.send(establishMsg)
      const estFrames = unwrapAll(estResults)
      for (const frame of estFrames) {
        receiver.receive(frame)
      }

      // Now send the large offer — should produce multiple fragments
      const results = sender.send(largeOffer)
      expect(results.length).toBeGreaterThan(1)

      const frames = unwrapAll(results)

      const recovered: ChannelMsg[] = []
      for (let i = 0; i < frames.length; i++) {
        const msgs = receiver.receive(frames[i])
        if (i < frames.length - 1) {
          // Intermediate fragments return no messages
          expect(msgs).toHaveLength(0)
        } else {
          // Last fragment completes reassembly
          for (const r of msgs) {
            if (!r.ok)
              throw new Error(`receive error: ${JSON.stringify(r.error)}`)
            recovered.push(r.value)
          }
        }
      }

      expect(recovered).toHaveLength(1)
      const msg = recovered[0]
      expect(msg).toBeDefined()
      if (msg === undefined) throw new Error("unreachable")
      expect(msg.type).toBe("offer")
    } finally {
      sender.dispose()
      receiver.dispose()
    }
  })
})

describe("Pipeline — reset() rebuilds state", () => {
  it("alias is reassigned from scratch after reset", () => {
    const sender = new Pipeline({ send: "binary" })

    try {
      // Send a message — advances alias state and the frame seq counter
      const firstResults = sender.send(establishMsg)
      expect(firstResults.length).toBeGreaterThan(0)
      const firstFrames = unwrapAll(firstResults)

      // Reset — rebuilds alias state and the frame seq counter from scratch
      sender.reset()

      // Send the same message — should produce identical output because
      // the alias state and frame seq counter both restarted
      const secondResults = sender.send(establishMsg)
      expect(secondResults.length).toBeGreaterThan(0)
      const secondFrames = unwrapAll(secondResults)

      // After reset, the wire output should be byte-identical to the first
      // send because alias assignment and the frame seq counter both restarted
      expect(firstFrames.length).toBe(secondFrames.length)
      for (let i = 0; i < firstFrames.length; i++) {
        expect(secondFrames[i]).toEqual(firstFrames[i])
      }
    } finally {
      sender.dispose()
    }
  })
})

describe("Pipeline — dispose() is terminal", () => {
  it("send() throws after dispose", () => {
    const pipeline = new Pipeline({ send: "binary" })
    pipeline.dispose()
    expect(() => pipeline.send(establishMsg)).toThrow("Pipeline disposed")
  })

  it("receive() throws after dispose", () => {
    const pipeline = new Pipeline({ send: "binary" })
    pipeline.dispose()
    expect(() => pipeline.receive(new Uint8Array([0]))).toThrow(
      "Pipeline disposed",
    )
  })

  it("reset() throws after dispose", () => {
    const p = new Pipeline({ send: "binary" })
    p.dispose()
    expect(() => p.reset()).toThrow("Pipeline disposed")
  })
})

describe("Pipeline — onError fires", () => {
  it("onError is called with a WireError and direction on garbage input", () => {
    const errorSpy = vi.fn<(e: WireError, dir: "send" | "receive") => void>()
    const pipeline = new Pipeline({
      send: "binary",
      opts: { onError: errorSpy },
    })

    try {
      // Feed garbage bytes — should trigger an error via onError
      const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa])
      pipeline.receive(garbage)

      expect(errorSpy).toHaveBeenCalledOnce()

      const [error, direction] = errorSpy.mock.calls[0]
      expect(direction).toBe("receive")
      expect(error).toHaveProperty("code")
    } finally {
      pipeline.dispose()
    }
  })
})

describe("Pipeline — frame seq", () => {
  it("stamps a complete (sub-threshold) message with seq = 1", () => {
    const sender = new Pipeline({ send: "binary" })
    try {
      const [frame] = unwrapAll(sender.send(establishMsg))
      if (frame === undefined) throw new Error("expected one frame")
      expect(decodeBinaryFrame(frame).seq).toBe(1)
    } finally {
      sender.dispose()
    }
  })

  it("shares one seq across all fragments and advances the counter once", () => {
    const sender = new Pipeline({ send: "binary", opts: { threshold: 100 } })
    try {
      // First send (establish) consumes seq 1.
      sender.send(establishMsg)
      // Second send (large offer) fragments — every piece shares seq 2.
      const fragments = unwrapAll(sender.send(largeOffer))
      expect(fragments.length).toBeGreaterThan(1)
      for (const piece of fragments) {
        expect(decodeBinaryFrame(piece).seq).toBe(2)
      }
      // The next send advances to seq 3 (the message bumped the counter once).
      const [next] = unwrapAll(sender.send(establishMsg))
      if (next === undefined) throw new Error("expected a frame")
      expect(decodeBinaryFrame(next).seq).toBe(3)
    } finally {
      sender.dispose()
    }
  })
})

describe("Pipeline — onFrame fires", () => {
  it("labels a received frame with the sender's seq, not the receiver's own counter", () => {
    const aTraces: FrameTrace[] = []
    const bTraces: FrameTrace[] = []
    const a = new Pipeline({
      send: "binary",
      opts: { onFrame: e => aTraces.push(e) },
    })
    const b = new Pipeline({
      send: "binary",
      opts: { onFrame: e => bTraces.push(e) },
    })

    const seqsFor = (traces: FrameTrace[], dir: "send" | "receive") =>
      traces.filter(e => e.dir === dir).map(e => e.seq)

    try {
      // B sends first, advancing B's own send counter. If a received frame
      // were (wrongly) labeled with the receiver's counter, B's receive seqs
      // below would not start at 1.
      for (const f of unwrapAll(b.send(establishMsg))) a.receive(f)

      // A sends two messages (A's send seqs 1, then 2); B receives both.
      for (const f of unwrapAll(a.send(establishMsg))) b.receive(f)
      for (const f of unwrapAll(a.send(establishMsg))) b.receive(f)

      // A's send seqs are its own, monotonic from 1.
      expect(seqsFor(aTraces, "send")).toEqual([1, 2])
      // B observes A's send seqs on receive — not B's own counter (now at 2).
      expect(seqsFor(bTraces, "receive")).toEqual([1, 2])
      expect(bTraces.find(e => e.dir === "receive")?.kind).toBe("complete")
    } finally {
      a.dispose()
      b.dispose()
    }
  })

  it("fires once per emitted piece for a fragmented send", () => {
    const traces: FrameTrace[] = []
    const sender = new Pipeline({
      send: "binary",
      opts: { threshold: 100, onFrame: ev => traces.push(ev) },
    })

    try {
      sender.send(establishMsg) // seq 1 (complete)
      traces.length = 0 // focus on the fragmented send
      const fragments = unwrapAll(sender.send(largeOffer)) // seq 2 (fragments)

      expect(traces).toHaveLength(fragments.length)
      traces.forEach((ev, i) => {
        expect(ev.dir).toBe("send")
        expect(ev.kind).toBe("fragment")
        expect(ev.seq).toBe(2)
        expect(ev.index).toBe(i)
        expect(ev.total).toBe(fragments.length)
      })
    } finally {
      sender.dispose()
    }
  })
})
