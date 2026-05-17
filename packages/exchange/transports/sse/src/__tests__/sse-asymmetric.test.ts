// sse-asymmetric — tests for asymmetric text/binary Pipeline encoding.
//
// Verifies the key SSE invariant: server sends text, client sends binary,
// and a single AliasState covers both encoding directions because the
// alias transformer operates on WireMessage shape, not encoded bytes.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import type {
  ChannelMsg,
  EstablishMsg,
  InterestMsg,
  PresentMsg,
} from "@kyneta/transport"
import { Pipeline } from "@kyneta/transport"
import type { Result, WireError } from "@kyneta/wire"
import { describe, expect, it } from "vitest"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapAll<T>(results: readonly Result<T, WireError>[]): T[] {
  const out: T[] = []
  for (const r of results) {
    if (!r.ok) throw new Error(`Unexpected error: ${JSON.stringify(r.error)}`)
    out.push(r.value)
  }
  return out
}

function recoverAll(
  pipeline: Pipeline<any, any>,
  frames: readonly unknown[],
): ChannelMsg[] {
  const msgs: ChannelMsg[] = []
  for (const frame of frames) {
    for (const r of pipeline.receive(frame as any)) {
      if (!r.ok) throw new Error(`receive error: ${JSON.stringify(r.error)}`)
      msgs.push(r.value)
    }
  }
  return msgs
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const serverEstablish: EstablishMsg = {
  type: "establish",
  identity: { peerId: "server", name: "Server", type: "service" },
  features: { alias: true },
}

const clientEstablish: EstablishMsg = {
  type: "establish",
  identity: { peerId: "client", name: "Client", type: "user" },
  features: { alias: true },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SSE asymmetric encoding", () => {
  it("server text → client binary receive", () => {
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
      const serverOut = unwrapAll(server.send(serverEstablish))
      const recovered = recoverAll(client, serverOut)

      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toEqual(serverEstablish)
    } finally {
      server.dispose()
      client.dispose()
    }
  })

  it("client binary → server binary receive", () => {
    const server = new Pipeline<"text", "binary">({
      send: "text",
      receive: "binary",
    })
    const client = new Pipeline<"binary", "text">({
      send: "binary",
      receive: "text",
    })

    try {
      const clientOut = unwrapAll(client.send(clientEstablish))
      const recovered = recoverAll(server, clientOut)

      expect(recovered).toHaveLength(1)
      expect(recovered[0]).toEqual(clientEstablish)
    } finally {
      server.dispose()
      client.dispose()
    }
  })

  it("alias state shared across encoding asymmetry", () => {
    const server = new Pipeline<"text", "binary">({
      send: "text",
      receive: "binary",
    })
    const client = new Pipeline<"binary", "text">({
      send: "binary",
      receive: "text",
    })

    try {
      // Step 1: Server sends establish with alias:true → client receives
      const serverEstFrames = unwrapAll(server.send(serverEstablish))
      const clientGotEst = recoverAll(client, serverEstFrames)
      expect(clientGotEst).toHaveLength(1)
      expect(clientGotEst[0]).toEqual(serverEstablish)

      // Step 2: Client sends establish with alias:true → server receives
      const clientEstFrames = unwrapAll(client.send(clientEstablish))
      const serverGotEst = recoverAll(server, clientEstFrames)
      expect(serverGotEst).toHaveLength(1)
      expect(serverGotEst[0]).toEqual(clientEstablish)

      // Both pipelines now have mutualAlias enabled.

      // Step 3: Server sends present with alias info (text) → client receives
      const presentMsg: PresentMsg = {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            schemaHash: "h-1",
            replicaType: ["plain", 1, 0],
            syncProtocol: SYNC_AUTHORITATIVE,
          },
        ],
      }

      const presentFrames = unwrapAll(server.send(presentMsg))
      const clientGotPresent = recoverAll(client, presentFrames)
      expect(clientGotPresent).toHaveLength(1)
      const gotPresent = clientGotPresent[0]
      if (gotPresent === undefined) throw new Error("unreachable")
      expect(gotPresent.type).toBe("present")
      if (gotPresent.type !== "present") throw new Error("unreachable")
      expect(gotPresent.docs).toHaveLength(1)
      expect(gotPresent.docs[0]?.docId).toBe("doc-1")

      // Step 4: Client sends its own present for doc-1 (binary) → server receives.
      // This assigns an outbound alias in the client's alias table.
      const clientPresent: PresentMsg = {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            schemaHash: "h-1",
            replicaType: ["plain", 1, 0],
            syncProtocol: SYNC_AUTHORITATIVE,
          },
        ],
      }

      const clientPresentFrames = unwrapAll(client.send(clientPresent))
      const serverGotPresent = recoverAll(server, clientPresentFrames)
      expect(serverGotPresent).toHaveLength(1)
      const gotClientPresent = serverGotPresent[0]
      if (gotClientPresent === undefined) throw new Error("unreachable")
      expect(gotClientPresent.type).toBe("present")
      if (gotClientPresent.type !== "present") throw new Error("unreachable")
      expect(gotClientPresent.docs[0]?.docId).toBe("doc-1")

      // Step 5: Client sends interest using the alias (dx instead of doc) → server receives
      // The client's outbound alias table now has doc-1 (from step 4),
      // and mutualAlias is true, so the interest will use dx.
      const interestMsg: InterestMsg = {
        type: "interest",
        docId: "doc-1",
        version: "v1",
      }

      const interestFrames = unwrapAll(client.send(interestMsg))
      const serverGotInterest = recoverAll(server, interestFrames)
      expect(serverGotInterest).toHaveLength(1)
      const gotInterest = serverGotInterest[0]
      if (gotInterest === undefined) throw new Error("unreachable")
      expect(gotInterest.type).toBe("interest")
      if (gotInterest.type !== "interest") throw new Error("unreachable")
      expect(gotInterest.docId).toBe("doc-1")
    } finally {
      server.dispose()
      client.dispose()
    }
  })
})
