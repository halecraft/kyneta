// e2e-supported-hashes — heterogeneous-version sync across a migrated
// schema chain over real WebSocket. Proves the full producer-to-consumer
// path of `BoundSchema.supportedHashes` (per plan: jj:snrmsznm).
//
// Producer side: `bind()` computes a multi-hash set via
// `computeSupportedHashes` (the recursive tree walk). Wire side:
// `sync-program` emits the set in the `present` message when it carries
// more info than the primary hash alone. Consumer side: receivers
// intersect their local supportedHashes against the remote set and
// proceed to sync if non-empty.

import {
  batch,
  bind,
  Migration,
  plainReplicaFactory,
  plainSubstrateFactory,
  Schema,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { createTestLifecycle } from "../helpers/cleanup.js"
import { drain } from "../helpers/drain.js"
import { createConnectedPair } from "../helpers/exchange-pair.js"

const lifecycle = createTestLifecycle()

afterEach(() => lifecycle.cleanup())

/**
 * Capture protocol diagnostics across both console streams.
 *
 * Diagnostics route by severity (`synchronizer.ts`): convergence-preventing
 * mismatches are `severity: "error"` → `console.error`; advisory ones →
 * `console.warn`. Tests that assert on a specific diagnostic must not assume
 * a stream — capture both. Returns a `restore` function (call it to undo the
 * patch) that also carries `.matching(substr)` for filtering captured lines.
 */
function captureDiagnostics(): {
  (): void
  matching: (substr: string) => string[]
} {
  const lines: string[] = []
  const originalWarn = console.warn
  const originalError = console.error
  const sink = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "))
  }
  console.warn = sink
  console.error = sink
  const restore = (() => {
    console.warn = originalWarn
    console.error = originalError
  }) as { (): void; matching: (substr: string) => string[] }
  restore.matching = (substr: string) => lines.filter(l => l.includes(substr))
  return restore
}

describe("supportedHashes — cross-migrated-version sync", () => {
  it("server with migrated chain syncs with client at an ancestor schema version", async () => {
    // Server runs the migrated schema: rename("name" → "title")
    // applied. `supportedHashes` is multi-element because the rename is
    // T1a (identity-preserving).
    const serverSchema = bind({
      schema: Schema.struct({
        title: Schema.string(),
        count: Schema.number(),
      }).migrated(Migration.rename("name", "title")),
      factory: () => plainSubstrateFactory,
      replicaType: plainReplicaFactory.replicaType,
      syncMode: SYNC_AUTHORITATIVE,
    })

    // Client runs the older schema — the pre-rename shape. Its primary
    // hash equals one of the server's `supportedHashes`.
    const clientSchema = bind({
      schema: Schema.struct({
        name: Schema.string(),
        count: Schema.number(),
      }),
      factory: () => plainSubstrateFactory,
      replicaType: plainReplicaFactory.replicaType,
      syncMode: SYNC_AUTHORITATIVE,
    })

    // Producer-side property: server's supportedHashes is a multi-element
    // set, and it contains the client's primary hash. Without this, the
    // chain walk would only ever produce singletons and the test below
    // would pass for the wrong reason.
    expect(serverSchema.supportedHashes.size).toBeGreaterThan(1)
    expect(serverSchema.supportedHashes.has(clientSchema.schemaHash)).toBe(true)
    expect(serverSchema.schemaHash).not.toBe(clientSchema.schemaHash)

    const { serverExchange, clientExchange } = await createConnectedPair(
      lifecycle,
      { schemas: [serverSchema, clientSchema] },
    )

    // Capture diagnostics — "schema hash mismatch — skipping sync" indicates
    // the supportedHashes intersection failed, which would mean the chain
    // walk didn't produce the expected ancestor hash. The mismatch is a
    // convergence-preventing diagnostic (`severity: "error"`), so it lands on
    // `console.error`; capture both streams to be severity-agnostic.
    const restore = captureDiagnostics()

    try {
      // Server creates the doc under its (newer) schema.
      const docServer = serverExchange.get("doc-rename", serverSchema)
      batch(docServer, (d: any) => {
        d.title.set("Hello from migrated server")
        d.count.set(42)
      })

      // Client opens the doc under its (older, pre-rename) schema. Sync
      // should proceed because supportedHashes overlap.
      const docClient = clientExchange.get("doc-rename", clientSchema)

      await drain()

      // The client should observe the count field (which has the same
      // identity across the rename) at the synced value. The title/name
      // fields are different identities (rename is keyed by identity at
      // the substrate level), but the count is invariant across the
      // rename.
      expect(docClient.count()).toBe(42)

      // No "schema hash mismatch" diagnostic fired — sync proceeded.
      expect(restore.matching("schema hash mismatch")).toEqual([])
    } finally {
      restore()
    }
  })

  it("disjoint supportedHashes (no overlap) does NOT sync", async () => {
    // Negative control: two unrelated schemas with no chain → no overlap
    // → "schema hash mismatch" warning, no sync. Proves the test setup
    // can detect the rejection case and isn't trivially green.
    const schemaA = bind({
      schema: Schema.struct({ a: Schema.string() }),
      factory: () => plainSubstrateFactory,
      replicaType: plainReplicaFactory.replicaType,
      syncMode: SYNC_AUTHORITATIVE,
    })

    const schemaB = bind({
      schema: Schema.struct({ b: Schema.number() }),
      factory: () => plainSubstrateFactory,
      replicaType: plainReplicaFactory.replicaType,
      syncMode: SYNC_AUTHORITATIVE,
    })

    expect(schemaA.schemaHash).not.toBe(schemaB.schemaHash)
    expect(schemaA.supportedHashes.has(schemaB.schemaHash)).toBe(false)

    const { serverExchange, clientExchange } = await createConnectedPair(
      lifecycle,
      { schemas: [schemaA, schemaB] },
    )

    const restore = captureDiagnostics()

    try {
      const docServer = serverExchange.get("doc-disjoint", schemaA)
      batch(docServer, (d: any) => {
        d.a.set("server side")
      })

      // Client opens under disjoint schema. Sync should be rejected.
      clientExchange.get("doc-disjoint", schemaB)

      await drain()

      // Confirms the rejection path is reachable — otherwise the positive
      // case above could be a false positive. The mismatch is emitted as a
      // `severity: "error"` diagnostic (→ console.error), so we assert across
      // both captured streams.
      expect(restore.matching("schema hash mismatch").length).toBeGreaterThan(0)
    } finally {
      restore()
    }
  })
})
