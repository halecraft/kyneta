// authority — who gets to say whether a document already has data.
//
// The pure classifier is tested as a truth table, deliberately, because a
// wrong branch here does not throw or fail loudly: it makes an application
// conclude that a document is empty when it is not, and write defaults over
// live data. That is worth covering exhaustively rather than sampling through
// a live two-peer scenario.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { Authority } from "../governance.js"
import { Governance } from "../governance.js"
import { settled } from "../settle.js"
import { whenSettled } from "../sync.js"
import { derivePeerSettled } from "../synchronizer.js"
import { exchangesPerTest } from "./exchanges.js"

const TestDoc = json.bind(Schema.struct({ title: Schema.string() }))

const createExchange = exchangesPerTest()

const isServer = (p: { principal: string }) => p.principal === "server"

// ===========================================================================
// Pure — no Exchange, no transport
// ===========================================================================

describe("derivePeerSettled", () => {
  const F = false
  const T = true

  // authority, hasReconciled, matchesAuthority, isOffline → expected
  const table: Array<[Authority, boolean, boolean, boolean, boolean, string]> =
    [
      // "self" — we are the authority, so nobody is worth waiting for. True even
      // with no peer having answered, which is the whole point for a server.
      ["self", F, F, F, T, "self never waits"],
      ["self", F, F, T, T, "self, offline"],

      // "any" — the first peer to answer settles it.
      ["any", F, F, F, F, "any: nobody has answered"],
      ["any", T, F, F, T, "any: someone answered"],
      ["any", F, F, T, T, "any: offline means nothing can answer"],

      // predicate — only the named peer's answer counts.
      [isServer, F, F, F, F, "predicate: nobody answered"],
      [isServer, T, F, F, F, "predicate: the wrong peer answered"],
      [isServer, T, T, F, T, "predicate: the authority answered"],
      [isServer, F, F, T, T, "predicate: offline"],
    ]

  for (const [
    authority,
    hasReconciled,
    matchesAuthority,
    isOffline,
    expected,
    label,
  ] of table) {
    it(label, () => {
      expect(
        derivePeerSettled({
          authority,
          hasReconciled,
          matchesAuthority,
          isOffline,
        }),
      ).toBe(expected)
    })
  }

  it("a non-authority peer answering never settles a predicate authority", () => {
    // The two-empty-clients hazard in miniature: another client reconciling
    // must not be mistaken for the server having spoken.
    expect(
      derivePeerSettled({
        authority: isServer,
        hasReconciled: true,
        matchesAuthority: false,
        isOffline: false,
      }),
    ).toBe(false)
  })
})

// ===========================================================================
// Integration — the policy plumbing
// ===========================================================================

describe("Policy.authority", () => {
  it("defaults to 'any' when no policy declares one", () => {
    // No transports, so the peer term is satisfied by the offline branch and
    // the document settles immediately.
    const exchange = createExchange()
    const doc = exchange.get("doc-1", TestDoc)

    expect(settled(doc)).toBe(true)

    exchange.reset()
  })

  it("is picked up from the policy", () => {
    const exchange = createExchange({ authority: "self" })
    const doc = exchange.get("doc-1", TestDoc)

    expect(settled(doc)).toBe(true)

    exchange.reset()
  })

  it("'self' does not wait, even with a transport configured", async () => {
    // The case above passes for the wrong reason: with no transports every
    // authority rule short-circuits to settled, so it never tests `"self"` at
    // all. Configure a transport and the rule has to do real work — which is
    // how a `whenSettled` that ignored the authority went unnoticed through a
    // release, hanging exactly the server this option exists for.
    const bridge = new Bridge()
    const exchange = createExchange({
      principal: "server",
      authority: "self",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
    })
    const doc = exchange.get("doc-1", TestDoc)

    expect(settled(doc)).toBe(true)
    // The promise form must agree with the boolean form. They are two views of
    // one predicate, and any gap between them is a bug in one of the two.
    await expect(
      Promise.race([
        whenSettled(doc),
        new Promise(r => setTimeout(() => r("hung"), 150)),
      ]),
    ).resolves.toEqual({ via: "local" })

    exchange.reset()
  })

  it("resolves first-non-undefined across registered policies", () => {
    // Same rule as `resolve`: this looks up a value, so registration order
    // decides, rather than the three-valued composition `canConnect` uses.
    const governance = new Governance()
    governance.register({ name: "a" })
    governance.register({ name: "b", authority: "self" })
    governance.register({ name: "c", authority: "any" })

    expect(governance.authority()).toBe("self")
  })

  it("returns undefined when no policy declares an authority", () => {
    // The caller supplies the default; governance only reports what was
    // declared. Keeping those separate is what lets `docStatus` and
    // `initialize` apply different defaults later if they need to.
    const governance = new Governance()
    governance.register({ name: "a" })

    expect(governance.authority()).toBeUndefined()
  })
})
