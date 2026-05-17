// pipeline — integration tests for the Pipeline imperative shell.
//
// Verifies symmetric and asymmetric round-trips (binary, text, SSE pair),
// fragmentation, reset/dispose semantics, and error routing.

import type { Result, WireError } from "@kyneta/wire"
import { describe, expect, it, vi } from "vitest"
import type { ChannelMsg, EstablishMsg, OfferMsg } from "../messages.js"
import { Pipeline } from "../pipeline.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const establishMsg: EstablishMsg = {
  type: "establish",
  identity: { peerId: "peer1", name: "Test", type: "user" },
  features: { alias: true },
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
        identity: { peerId: "peer2", name: "Client", type: "user" },
        features: { alias: true },
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
      // Send a message — advances alias state and uses the frame ID counter
      const firstResults = sender.send(establishMsg)
      expect(firstResults.length).toBeGreaterThan(0)
      const firstFrames = unwrapAll(firstResults)

      // Reset — rebuilds alias state and frame ID counter from scratch
      sender.reset()

      // Send the same message — should produce identical output because
      // the alias state and frame ID counter both restarted
      const secondResults = sender.send(establishMsg)
      expect(secondResults.length).toBeGreaterThan(0)
      const secondFrames = unwrapAll(secondResults)

      // After reset, the wire output should be byte-identical to the first
      // send because alias assignment and frame ID counter both restarted
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
