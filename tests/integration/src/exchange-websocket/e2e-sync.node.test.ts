// e2e-sync-node — Node-compatible integration test proving full-stack sync
// over real WebSocket connections using the `ws` library.
//
// Mirrors a subset of the Bun-based e2e-sync.bun.test.ts, but uses the
// `ws.WebSocketServer` + `wrapNodeWebsocket` server harness instead of
// `Bun.serve`. The test bodies are otherwise identical in shape; the
// shared `_helpers/` harness factors out the lifecycle code.

import { change, json, Schema } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { createTestLifecycle } from "../helpers/cleanup.js"
import { drain } from "../helpers/drain.js"
import { createConnectedPair } from "../helpers/exchange-pair.js"

const lifecycle = createTestLifecycle()

afterEach(() => lifecycle.cleanup())

const SequentialDoc = json.bind(
  Schema.struct({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

describe("Sequential sync over Node.js WebSocket (ws library)", () => {
  it("server creates doc, client syncs and gets the same state", async () => {
    const { serverExchange, clientExchange } =
      await createConnectedPair(lifecycle)

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    change(docServer, (d: any) => {
      d.title.set("Hello from Node Server")
      d.count.set(42)
    })

    expect(docServer.title()).toBe("Hello from Node Server")
    expect(docServer.count()).toBe(42)

    const docClient = clientExchange.get("doc-1", SequentialDoc)

    await drain()

    expect(docClient.title()).toBe("Hello from Node Server")
    expect(docClient.count()).toBe(42)
  })

  it("client creates doc, server syncs and gets the same state", async () => {
    const { serverExchange, clientExchange } =
      await createConnectedPair(lifecycle)

    const docClient = clientExchange.get("doc-1", SequentialDoc)
    change(docClient, (d: any) => {
      d.title.set("Hello from Node Client")
      d.count.set(99)
    })

    await drain()

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    await drain()

    expect(docServer.title()).toBe("Hello from Node Client")
    expect(docServer.count()).toBe(99)
  })

  it("bidirectional mutations propagate", async () => {
    const { serverExchange, clientExchange } =
      await createConnectedPair(lifecycle)

    const docServer = serverExchange.get("doc-1", SequentialDoc)
    const docClient = clientExchange.get("doc-1", SequentialDoc)

    change(docServer, (d: any) => {
      d.title.set("Initial")
      d.count.set(0)
    })

    await drain()

    expect(docClient.title()).toBe("Initial")
    expect(docClient.count()).toBe(0)

    change(docClient, (d: any) => {
      d.count.set(100)
    })

    await drain()

    expect(docServer.count()).toBe(100)
    expect(docClient.count()).toBe(100)
  })
})
