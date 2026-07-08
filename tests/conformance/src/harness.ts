import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { Exchange, type ExchangeParams } from "@kyneta/exchange"
import { batch } from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import type { SubstrateProfile } from "./profiles.js"

// biome-ignore lint/suspicious/noExplicitAny: docs are accessed untyped — the harness
// is deliberately substrate-agnostic, exercising the runtime, not the type surface.
type Doc = any

// Advance micro- and macro-task queues enough times for a full present/interest/
// offer handshake plus any reset re-request round trips.
async function drain(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const read = (doc: Doc) => ({ a: doc.a() as string, b: doc.b() as string })

/**
 * Runs the substrate-unification conformance battery against one profile through
 * the real Exchange/Bridge sync machinery. Universal invariants (convergence,
 * fresh-peer adoption) must hold for every substrate; capability-gated ones
 * (compaction) run only where the profile declares support. See `profiles.ts`
 * for the matrix these assertions enforce.
 */
export function runSubstrateConformance(profile: SubstrateProfile): void {
  describe(`substrate conformance — ${profile.name}`, () => {
    const active: Exchange[] = []
    const spawn = (
      id: string,
      bridge: Bridge | null,
      bound: unknown,
    ): Exchange => {
      const ex = new Exchange({
        id,
        schemas: [bound],
        transports: bridge
          ? [createBridgeTransport({ transportId: id, bridge })]
          : [],
      } as ExchangeParams)
      active.push(ex)
      return ex
    }
    afterEach(async () => {
      for (const ex of active) {
        try {
          await ex.shutdown()
        } catch {
          /* ignore */
        }
      }
      active.length = 0
    })

    it("converges to equal state; keeps independent-field writes iff it merges below whole-document granularity", async () => {
      const bound = profile.bind()

      if (profile.writerModel === "serialized") {
        // One authoritative writer at a time is the supported pattern for a
        // serialized substrate (two peers racing the same doc is misuse). Each
        // write syncs before the next, so both survive.
        const bridge = new Bridge()
        const docA: Doc = spawn("A", bridge, bound).get("doc", bound)
        const docB: Doc = spawn("B", bridge, bound).get("doc", bound)
        batch(docA, (d: Doc) => d.a.set("A"))
        await drain()
        batch(docB, (d: Doc) => d.b.set("B"))
        await drain()
        expect(read(docA)).toEqual(read(docB))
        expect(docA.a()).toBe("A")
        expect(docA.b()).toBe("B")
        return
      }

      // Concurrent substrates: genuinely concurrent writes require a partition —
      // each peer writes while disconnected, so neither observes the other. The
      // brief gap between the writes gives them distinct timestamps (same-ms
      // timestamps compare "equal", and the synchronizer would skip the sync).
      const a = spawn("A", null, bound)
      const b = spawn("B", null, bound)
      const docA: Doc = a.get("doc", bound)
      const docB: Doc = b.get("doc", bound)
      batch(docA, (d: Doc) => d.a.set("A"))
      await drain(5)
      batch(docB, (d: Doc) => d.b.set("B"))

      // Heal the partition and let it reconcile.
      const bridge = new Bridge()
      await a.addTransport(createBridgeTransport({ transportId: "A", bridge }))
      await b.addTransport(createBridgeTransport({ transportId: "B", bridge }))
      await drain()

      // Universal: both peers reach the same materialized state.
      expect(read(docA)).toEqual(read(docB))

      if (profile.fieldConcurrency === "both-survive") {
        expect(docA.a()).toBe("A")
        expect(docA.b()).toBe("B")
      } else {
        // Whole-document LWW: exactly one of the two field writes survives.
        const survivors = [docA.a() === "A", docA.b() === "B"].filter(
          Boolean,
        ).length
        expect(survivors).toBe(1)
      }
    })

    it("a fresh peer adopts an incumbent's state on join", async () => {
      const bound = profile.bind()
      const bridge = new Bridge()
      const docA: Doc = spawn("A", bridge, bound).get("doc", bound)
      const docB: Doc = spawn("B", bridge, bound).get("doc", bound)

      // Incumbent A writes; B is a fresh (genesis) peer that never writes.
      batch(docA, (d: Doc) => {
        d.a.set("A")
        d.b.set("B")
      })
      await drain()

      expect(docB.a()).toBe("A")
      expect(docB.b()).toBe("B")
    })

    if (profile.liveCompactable) {
      it("compaction preserves convergence with a synced peer", async () => {
        const bound = profile.bind()
        const bridge = new Bridge()
        const a = spawn("A", bridge, bound)
        const b = spawn("B", bridge, bound)
        const docA: Doc = a.get("doc", bound)
        const docB: Doc = b.get("doc", bound)

        // Both write so each sees the other as synced, then A compacts away the
        // shared history and writes again — B must still converge on the new state.
        batch(docA, (d: Doc) => d.a.set("A1"))
        await drain()
        batch(docB, (d: Doc) => d.b.set("B1"))
        await drain()

        await a.compact("doc")
        batch(docA, (d: Doc) => d.a.set("A2"))
        await drain()

        expect(docB.a()).toBe("A2")
        expect(read(docA)).toEqual(read(docB))
      })
    }
  })
}
