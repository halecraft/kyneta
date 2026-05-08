// exchange-pair — connected server + client Exchange pair over Node ws.
//
// Returns two `Exchange`s already bridged via real WebSocket transport
// (HTTP server + `ws` library). Per-side `stores` and `schemas` are
// optional, supporting both store-less integration tests and persistence
// tests.

import type { BoundSchema, Store } from "@kyneta/exchange"
import { Exchange, type ExchangeParams } from "@kyneta/exchange"
import {
  type WebSocketConstructor,
  WebsocketClientTransport,
} from "@kyneta/websocket-transport/browser"
import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
import { WebSocket } from "ws"
import type { TestLifecycle } from "./cleanup.js"
import { drain } from "./drain.js"
import { createNodeTestServer, type TestServer } from "./node-ws-server.js"

export interface CreateConnectedPairOptions {
  serverPeerId?: string
  clientPeerId?: string
  fragmentThreshold?: number
  serverStores?: Store[]
  clientStores?: Store[]
  schemas?: BoundSchema[]
}

export interface ConnectedPair {
  serverExchange: Exchange
  clientExchange: Exchange
  serverTransport: WebsocketServerTransport
  clientTransport: WebsocketClientTransport
  testServer: TestServer
}

export async function createConnectedPair(
  lifecycle: TestLifecycle,
  opts: CreateConnectedPairOptions = {},
): Promise<ConnectedPair> {
  const serverPeerId = opts.serverPeerId ?? "server"
  const clientPeerId = opts.clientPeerId ?? "client"
  const fragmentThreshold = opts.fragmentThreshold

  const serverTransport = new WebsocketServerTransport(
    fragmentThreshold !== undefined ? { fragmentThreshold } : undefined,
  )

  const testServer = lifecycle.registerServer(
    createNodeTestServer(serverTransport),
  )

  const serverParams: ExchangeParams = {
    id: serverPeerId,
    transports: [() => serverTransport],
    ...(opts.serverStores ? { stores: opts.serverStores } : {}),
    ...(opts.schemas ? { schemas: opts.schemas } : {}),
  }
  const serverExchange = lifecycle.registerExchange(new Exchange(serverParams))

  const clientTransport = new WebsocketClientTransport({
    url: testServer.url,
    WebSocket: WebSocket as unknown as WebSocketConstructor,
    reconnect: { enabled: false },
    fragmentThreshold,
  })

  const clientParams: ExchangeParams = {
    id: clientPeerId,
    transports: [() => clientTransport],
    ...(opts.clientStores ? { stores: opts.clientStores } : {}),
    ...(opts.schemas ? { schemas: opts.schemas } : {}),
  }
  const clientExchange = lifecycle.registerExchange(new Exchange(clientParams))

  await clientTransport.waitForStatus("ready", { timeoutMs: 5000 })
  await drain(20)

  return {
    serverExchange,
    clientExchange,
    serverTransport,
    clientTransport,
    testServer,
  }
}
