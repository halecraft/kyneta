// alias-table — pure-function tests for the FC/IS contract.
//
// Property-style: round-trip messages through outbound/inbound and verify
// they preserve identity. Exercise feature snapshotting, mutualAlias
// derivation, idempotent re-assignment, announce-vs-use behavior, and
// unknown-alias error path.

import { SYNC_AUTHORITATIVE } from "@kyneta/schema"
import {
  DOC_ID_MAX_UTF8_BYTES,
  encodeWireMessage,
  SCHEMA_HASH_MAX_UTF8_BYTES,
} from "@kyneta/wire"
import { describe, expect, it } from "vitest"
import {
  applyInboundAliasing,
  applyOutboundAliasing,
  emptyAliasState,
} from "../alias-table.js"
import type { EstablishMsg, InterestMsg, PresentMsg } from "../messages.js"

const alice: EstablishMsg = {
  type: "establish",
  identity: { peerId: "alice", type: "user" },
  features: { alias: true },
}

const bob: EstablishMsg = {
  type: "establish",
  identity: { peerId: "bob", type: "user" },
  features: { alias: true },
}

const presentDoc1: PresentMsg = {
  type: "present",
  docs: [
    {
      docId: "doc-1",
      schemaHash: "h-1",
      replicaType: ["plain", 1, 0] as const,
      syncProtocol: SYNC_AUTHORITATIVE,
    },
  ],
}

describe("alias-table — establish snapshots features", () => {
  it("outbound establish snapshots selfFeatures", () => {
    const { state, result } = applyOutboundAliasing(emptyAliasState(), alice)
    expect(result.ok).toBe(true)
    expect(state.selfFeatures).toEqual({ alias: true })
    expect(state.peerFeatures).toBeUndefined()
    expect(state.mutualAlias).toBe(false) // peer features unknown
  })

  it("inbound establish snapshots peerFeatures", () => {
    const { state, result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x01,
      id: "bob",
      y: "user",
      f: { a: true },
    } as any)
    expect(result.ok).toBe(true)
    expect(state.peerFeatures).toEqual({ alias: true })
    expect(state.selfFeatures).toBeUndefined()
    expect(state.mutualAlias).toBe(false)
  })

  it("mutualAlias becomes true once both establish messages have flowed", () => {
    let state = emptyAliasState()
    state = applyOutboundAliasing(state, alice).state
    expect(state.mutualAlias).toBe(false)
    state = applyInboundAliasing(state, {
      t: 0x01,
      id: "bob",
      y: "user",
      f: { a: true },
    } as any).state
    expect(state.mutualAlias).toBe(true)
  })

  it("mutualAlias stays false if peer omits alias", () => {
    let state = emptyAliasState()
    state = applyOutboundAliasing(state, alice).state
    state = applyInboundAliasing(state, {
      t: 0x01,
      id: "bob",
      y: "user",
      // no f field → no peer features
    } as any).state
    expect(state.mutualAlias).toBe(false)
  })

  it("mutualAlias stays false if either side advertises alias: false", () => {
    let state = emptyAliasState()
    state = applyOutboundAliasing(state, {
      ...alice,
      features: { alias: false },
    }).state
    state = applyInboundAliasing(state, {
      t: 0x01,
      id: "bob",
      y: "user",
      f: { a: true },
    } as any).state
    expect(state.mutualAlias).toBe(false)
  })
})

describe("alias-table — present always announces aliases", () => {
  it("outbound present sets `a` (docId alias) and `sa` (schema alias) on first reference", () => {
    const { result } = applyOutboundAliasing(emptyAliasState(), presentDoc1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.t).toBe(0x10) // Present
    const present = result.value as any
    expect(present.docs[0]).toMatchObject({
      d: "doc-1",
      a: 0,
      sh: "h-1",
      sa: 0,
    })
  })

  it("idempotent: same docId from same state yields same alias", () => {
    let state = emptyAliasState()
    const a = applyOutboundAliasing(state, presentDoc1)
    state = a.state
    expect(a.result.ok).toBe(true)
    if (!a.result.ok) return
    expect((a.result.value as any).docs[0].a).toBe(0)
    const b = applyOutboundAliasing(state, presentDoc1)
    expect(b.result.ok).toBe(true)
    if (!b.result.ok) return
    expect((b.result.value as any).docs[0].a).toBe(0)
    expect(state).toBe(b.state) // idempotent: state unchanged
  })

  it("monotonically assigns aliases for distinct docIds", () => {
    const state = emptyAliasState()
    const present2: PresentMsg = {
      type: "present",
      docs: [
        ...presentDoc1.docs,
        {
          docId: "doc-2",
          schemaHash: "h-2",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    const { result } = applyOutboundAliasing(state, present2)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const docs = (result.value as any).docs
    expect(docs[0].a).toBe(0)
    expect(docs[1].a).toBe(1)
    expect(docs[0].sa).toBe(0)
    expect(docs[1].sa).toBe(1)
  })
})

describe("alias-table — sync messages gate use on mutualAlias", () => {
  function setupMutual(): ReturnType<typeof emptyAliasState> {
    let state = emptyAliasState()
    state = applyOutboundAliasing(state, alice).state
    state = applyInboundAliasing(state, {
      t: 0x01,
      id: "bob",
      y: "user",
      f: { a: true },
    } as any).state
    // Send a present to assign an alias to doc-1.
    state = applyOutboundAliasing(state, presentDoc1).state
    return state
  }

  it("with mutualAlias on, outbound interest uses dx (alias)", () => {
    const state = setupMutual()
    expect(state.mutualAlias).toBe(true)
    const msg: InterestMsg = { type: "interest", docId: "doc-1" }
    const { result } = applyOutboundAliasing(state, msg)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as any).dx).toBe(0)
    expect((result.value as any).doc).toBeUndefined()
  })

  it("with mutualAlias off, outbound interest uses doc (full)", () => {
    let state = emptyAliasState()
    // Local establish but no peer establish → mutualAlias false
    state = applyOutboundAliasing(state, alice).state
    state = applyOutboundAliasing(state, presentDoc1).state
    const msg: InterestMsg = { type: "interest", docId: "doc-1" }
    const { result } = applyOutboundAliasing(state, msg)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.value as any).doc).toBe("doc-1")
    expect((result.value as any).dx).toBeUndefined()
  })

  it("with mutualAlias on, present-doc subsequent reference uses shx (schema alias)", () => {
    const state = setupMutual()
    // Second present for doc-1 (already aliased) — uses shx
    const { result } = applyOutboundAliasing(state, presentDoc1)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const entry = (result.value as any).docs[0]
    expect(entry.shx).toBe(0)
    expect(entry.sh).toBeUndefined()
    expect(entry.a).toBe(0)
  })
})

describe("alias-table — round-trip", () => {
  it("ChannelMsg → WireMessage → ChannelMsg preserves identity", () => {
    let outState = emptyAliasState()
    let inState = emptyAliasState()

    // Both peers exchange establish first
    const aliceOut = applyOutboundAliasing(outState, alice)
    outState = aliceOut.state
    expect(aliceOut.result.ok).toBe(true)
    if (!aliceOut.result.ok) return
    const inboundResult = applyInboundAliasing(inState, aliceOut.result.value)
    inState = inboundResult.state

    // Send a present from out to in
    const presentOut = applyOutboundAliasing(outState, presentDoc1)
    outState = presentOut.state
    expect(presentOut.result.ok).toBe(true)
    if (!presentOut.result.ok) return
    const presentIn = applyInboundAliasing(inState, presentOut.result.value)
    inState = presentIn.state
    expect(presentIn.result.ok).toBe(true)
    if (!presentIn.result.ok) return
    expect(presentIn.result.value).toEqual(presentDoc1)
  })
})

describe("alias-table — unknown-alias error path", () => {
  it("inbound interest with unknown dx returns error, not throw", () => {
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x11, // Interest
      dx: 42,
    } as any)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ code: "unknown-doc-alias", alias: 42 })
  })

  it("inbound present with unknown shx returns error", () => {
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x10, // Present
      docs: [
        {
          d: "doc-1",
          a: 0,
          rt: ["plain", 1, 0],
          ms: 1,
          shx: 99,
        },
      ],
    } as any)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({ code: "unknown-schema-alias", alias: 99 })
  })

  it("inbound interest with both doc and dx returns error", () => {
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x11,
      doc: "doc-1",
      dx: 5,
    } as any)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("missing-doc-id")
  })
})

// ---------------------------------------------------------------------------
// Identifier length validation
// ---------------------------------------------------------------------------

describe("alias-table — identifier length validation", () => {
  it("inbound interest with oversized docId returns doc-id-too-long error", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x11, // Interest
      doc: docId,
    } as any)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      code: "doc-id-too-long",
      message: `DocId exceeds ${DOC_ID_MAX_UTF8_BYTES} UTF-8 bytes (got ${DOC_ID_MAX_UTF8_BYTES + 1})`,
    })
  })

  it("inbound present with oversized schemaHash returns schema-hash-too-long error", () => {
    const schemaHash = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES + 1)
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x10, // Present
      docs: [
        {
          d: "doc-1",
          a: 0,
          rt: ["plain", 1, 0],
          ms: 1,
          sh: schemaHash,
        },
      ],
    } as any)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toEqual({
      code: "schema-hash-too-long",
      message: `SchemaHash exceeds ${SCHEMA_HASH_MAX_UTF8_BYTES} UTF-8 bytes (got ${SCHEMA_HASH_MAX_UTF8_BYTES + 1})`,
    })
  })

  it("inbound docId at cap (512 bytes) resolves correctly", () => {
    const docId = "a".repeat(DOC_ID_MAX_UTF8_BYTES)
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x11, // Interest
      doc: docId,
    } as any)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe("interest")
    if (result.value.type === "interest") {
      expect(result.value.docId).toBe(docId)
    }
  })

  it("inbound schemaHash at cap (256 bytes) resolves correctly", () => {
    const schemaHash = "h".repeat(SCHEMA_HASH_MAX_UTF8_BYTES)
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x10, // Present
      docs: [
        {
          d: "doc-1",
          a: 0,
          rt: ["plain", 1, 0],
          ms: 1,
          sh: schemaHash,
        },
      ],
    } as any)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe("present")
    if (result.value.type === "present") {
      expect(result.value.docs[0]?.schemaHash).toBe(schemaHash)
    }
  })

  it("multi-byte UTF-8 docId at cap (512 bytes) resolves correctly", () => {
    // "ñ" is 2 UTF-8 bytes. 256 × 2 = 512 bytes.
    const docId = "ñ".repeat(256)
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x11, // Interest
      doc: docId,
    } as any)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.type).toBe("interest")
    if (result.value.type === "interest") {
      expect(result.value.docId).toBe(docId)
    }
  })

  it("multi-byte UTF-8 docId one byte over cap returns error", () => {
    // "ñ" is 2 UTF-8 bytes. 256 × 2 = 512 bytes (at cap).
    // 257 × 2 = 514 bytes (over cap).
    const docId = "ñ".repeat(257)
    const { result } = applyInboundAliasing(emptyAliasState(), {
      t: 0x11, // Interest
      doc: docId,
    } as any)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe("doc-id-too-long")
  })
})

// ---------------------------------------------------------------------------
// SchemaHash aliasing compaction win
// ---------------------------------------------------------------------------

describe("alias-table — schema-hash compaction", () => {
  function setupMutual(): ReturnType<typeof emptyAliasState> {
    let state = emptyAliasState()
    state = applyOutboundAliasing(state, alice).state
    state = applyInboundAliasing(state, {
      t: 0x01,
      id: "bob",
      y: "user",
      f: { a: true },
    } as any).state
    return state
  }

  it("present with N docs sharing one schema sends sh once and shx N-1 times", () => {
    let state = setupMutual()
    // First present — introduces docs and the schema. All entries get
    // their own a + sa is set on the first, then shx referenced for
    // subsequent docs sharing the schema.
    const present: PresentMsg = {
      type: "present",
      docs: Array.from({ length: 5 }, (_, i) => ({
        docId: `doc-${i}`,
        schemaHash: "shared-h",
        replicaType: ["plain", 1, 0] as const,
        syncProtocol: SYNC_AUTHORITATIVE,
      })),
    }
    const outResult = applyOutboundAliasing(state, present)
    state = outResult.state
    expect(outResult.result.ok).toBe(true)
    if (!outResult.result.ok) return
    const docs = (outResult.result.value as any).docs as Array<
      Record<string, unknown>
    >

    // Exactly one entry carries `sh` (the first), the rest carry `shx`.
    const hasSh = docs.filter(d => d.sh !== undefined).length
    const hasShx = docs.filter(d => d.shx !== undefined).length
    expect(hasSh).toBe(1)
    expect(hasShx).toBe(4)

    // The first carries `sa` (alias assignment); the rest don't.
    const hasSa = docs.filter(d => d.sa !== undefined).length
    expect(hasSa).toBe(1)
  })

  it("byte-size: present with shared schema is O(1) in schema-hash bytes", () => {
    const state = setupMutual()
    // Build a present with a relatively long schema hash (34 chars) and
    // 10 docs, all sharing it. The encoded byte count should be much
    // smaller than the naive (10 × 34) bytes for the schema hash.
    const longHash = "h".repeat(34)
    const present: PresentMsg = {
      type: "present",
      docs: Array.from({ length: 10 }, (_, i) => ({
        docId: `doc-${i}`,
        schemaHash: longHash,
        replicaType: ["plain", 1, 0] as const,
        syncProtocol: SYNC_AUTHORITATIVE,
      })),
    }
    const { result } = applyOutboundAliasing(state, present)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const bytes = encodeWireMessage(result.value)

    // The schema hash appears at most once in the encoded bytes.
    const hashBytes = new TextEncoder().encode(longHash)
    let occurrences = 0
    for (let i = 0; i < bytes.length - hashBytes.length; i++) {
      let match = true
      for (let j = 0; j < hashBytes.length; j++) {
        if (bytes[i + j] !== hashBytes[j]) {
          match = false
          break
        }
      }
      if (match) occurrences++
    }
    expect(occurrences).toBe(1)
  })

  it("inbound resolves shx → full schemaHash on subsequent doc entries", () => {
    let outState = emptyAliasState()
    let inState = emptyAliasState()
    // Establish mutual.
    const aliceOut = applyOutboundAliasing(outState, alice)
    outState = aliceOut.state
    expect(aliceOut.result.ok).toBe(true)
    if (!aliceOut.result.ok) return
    const bobInbound = applyInboundAliasing(inState, aliceOut.result.value)
    inState = bobInbound.state
    const bobOut = applyOutboundAliasing(emptyAliasState(), bob)
    expect(bobOut.result.ok).toBe(true)
    if (!bobOut.result.ok) return
    const aliceInbound = applyInboundAliasing(outState, bobOut.result.value)
    outState = aliceInbound.state
    inState = applyInboundAliasing(inState, aliceOut.result.value).state // (no-op)

    // Send a present with shared schema — twice — so second present
    // uses shx-only on every entry.
    const present: PresentMsg = {
      type: "present",
      docs: [
        {
          docId: "d1",
          schemaHash: "shared",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
        {
          docId: "d2",
          schemaHash: "shared",
          replicaType: ["plain", 1, 0] as const,
          syncProtocol: SYNC_AUTHORITATIVE,
        },
      ],
    }
    const r1 = applyOutboundAliasing(outState, present)
    outState = r1.state
    expect(r1.result.ok).toBe(true)
    if (!r1.result.ok) return
    const i1 = applyInboundAliasing(inState, r1.result.value)
    inState = i1.state
    expect(i1.result.ok).toBe(true)
    if (!i1.result.ok) return
    expect(i1.result.value).toEqual(present)

    // Second send — schema is already aliased; entries should use shx
    // on the wire but still resolve to "shared" on the receiver.
    const r2 = applyOutboundAliasing(outState, present)
    outState = r2.state
    expect(r2.result.ok).toBe(true)
    if (!r2.result.ok) return
    const wireDocs = (r2.result.value as any).docs
    expect(wireDocs[0].sh).toBeUndefined()
    expect(wireDocs[0].shx).toBe(0)
    expect(wireDocs[1].shx).toBe(0)

    const i2 = applyInboundAliasing(inState, r2.result.value)
    inState = i2.state
    expect(i2.result.ok).toBe(true)
    if (!i2.result.ok) return
    expect(i2.result.value).toEqual(present)
  })
})
