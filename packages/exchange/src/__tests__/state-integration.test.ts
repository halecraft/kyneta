// state-integration.test.ts — verifies the behavior of the `state` CvRDT substrate.
//
// These tests mimic the current "Ephemeral clobbering bug" to prove that
// the `state` substrate correctly implements a field-level LWW Map.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { batch, lastUpdated, Schema, state } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"

const StateSchema = Schema.struct({
  alice: Schema.string().nullable(),
  bob: Schema.string().nullable(),
})

const StateDoc = state.bind(StateSchema)

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

describe("State Substrate (CvRDT Field-Level LWW)", () => {
  it("merges concurrently at the field level without clobbering", async () => {
    const bridge = new Bridge()

    const exchangeA = new Exchange({
      id: "alice",
      transports: [createBridgeTransport({ transportId: "alice", bridge })],
      schemas: [StateDoc],
    })

    const exchangeB = new Exchange({
      id: "bob",
      transports: [createBridgeTransport({ transportId: "bob", bridge })],
      schemas: [StateDoc],
    })

    const docA = exchangeA.get("presence", StateDoc)
    const docB = exchangeB.get("presence", StateDoc)

    // Initially they both compute structural zeros for `alice` and `bob` (which is `null`)
    expect(docA.alice()).toBeNull()
    expect(docA.bob()).toBeNull()

    // The timestamps should be 0 for structural zeros
    expect(lastUpdated(docA.alice)).toBe(0)
    expect(lastUpdated(docA.bob)).toBe(0)

    // Alice writes her presence
    batch(docA, d => d.alice.set("online-alice"))
    expect(docA.alice()).toBe("online-alice")

    // Ensure Bob's write happens at a different timestamp so StateVersion doesn't
    // spuriously return "equal" for completely different causal events.
    await new Promise<void>(r => setTimeout(r, 5))

    // Bob writes his presence concurrently
    batch(docB, d => d.bob.set("online-bob"))
    expect(docB.bob()).toBe("online-bob")

    // Connect them (the bridge handles this automatically once constructed)
    await drain(40)

    // Both should now have both values
    expect(docA.alice()).toBe("online-alice")
    expect(docA.bob()).toBe("online-bob")
    expect(docB.alice()).toBe("online-alice")
    expect(docB.bob()).toBe("online-bob")

    // Timestamps should be valid non-zero
    const tA = lastUpdated(docA.alice)
    const tB = lastUpdated(docB.bob)
    expect(tA).toBeGreaterThan(0)
    expect(tB).toBeGreaterThan(0)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })
})
