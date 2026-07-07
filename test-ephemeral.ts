import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { batch, json, Schema, ephemeral } from "@kyneta/schema"
import { Exchange } from "./packages/exchange/src/exchange.js"

const TestDoc = ephemeral.bind(
  Schema.object({
    val: json.number(),
  }),
)

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

async function run() {
  let resetCount = 0
  const alice = new Exchange({
    id: "alice",
    policies: [{
      canReset: () => {
        resetCount++
        return true
      }
    }]
  })
  const bob = new Exchange({ id: "bob" })

  const bridge = new Bridge()
  alice.addTransport(createBridgeTransport(bridge, "alice"))
  bob.addTransport(createBridgeTransport(bridge, "bob"))

  const aDoc = alice.get("doc-1", TestDoc)
  const bDoc = bob.get("doc-1", TestDoc)

  batch(aDoc, (d: any) => { d.val = 1 })
  await drain()
  
  batch(bDoc, (d: any) => { d.val = 2 })
  await drain()

  console.log("resetCount after initial sync:", resetCount)

  batch(aDoc, (d: any) => { d.val = 3 })
  await drain()

  console.log("resetCount after second write:", resetCount)

  await alice.shutdown()
  await bob.shutdown()
}

run().catch(console.error)
