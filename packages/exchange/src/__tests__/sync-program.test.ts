// sync-program — unit tests for the pure TEA update function.

import {
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
  type SyncMode,
} from "@kyneta/schema"
import { defined } from "@kyneta/schema/testing"
import { describe, expect, it } from "vitest"
import {
  createSyncUpdate,
  hasReconciled,
  initSync,
  reconciledMatching,
  type SyncEffect,
  type SyncModel,
  type SyncUpdate,
} from "../sync-program.js"
import type { Diagnostic } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const alice = { peerId: "alice", principal: "alice", type: "user" as const }
const bob = { peerId: "bob", principal: "bob", type: "user" as const }
const carol = { peerId: "carol", principal: "carol", type: "user" as const }

function makeUpdate(params?: {
  canShare?: (docId: string, peer: any) => boolean
  canAccept?: (docId: string, peer: any) => boolean
}): SyncUpdate {
  return createSyncUpdate(params)
}

/**
 * Run `update` with the given input and split the result into model
 * and effects. Replaces the old `flattenEffects` (no more `batch`
 * combinator; the algebra is variadic).
 */
function applyUpdate(
  update: SyncUpdate,
  input: Parameters<SyncUpdate>[0],
  model: SyncModel,
): [SyncModel, SyncEffect[]] {
  const [m, ...fx] = update(input, model)
  return [m, fx]
}

/** Add a peer to the model (simulates sync/peer-available). */
function addPeer(
  update: SyncUpdate,
  model: SyncModel,
  peerId: string,
  identity: any,
): [SyncModel, SyncEffect[]] {
  return applyUpdate(
    update,
    { type: "sync/peer-available", peerId, identity },
    model,
  )
}

/** Register a document via sync/doc-ensure. */
function ensureDoc(
  update: SyncUpdate,
  model: SyncModel,
  docId: string,
  opts?: {
    mode?: "interpret" | "replicate"
    syncMode?: SyncMode
    version?: string
    schemaHash?: string
    supportedHashes?: readonly string[]
    historyFree?: boolean
  },
): [SyncModel, SyncEffect[]] {
  return applyUpdate(
    update,
    {
      type: "sync/doc-ensure",
      docId,
      mode: opts?.mode ?? "interpret",
      version: opts?.version ?? "v1",
      replicaType: ["test", 0, 0],
      historyFree: opts?.historyFree ?? false,
      syncMode: opts?.syncMode ?? SYNC_COLLABORATIVE,
      schemaHash: opts?.schemaHash ?? "abc123",
      supportedHashes: opts?.supportedHashes,
    },
    model,
  )
}

/** Register a deferred document via sync/doc-defer. */
function deferDoc(
  update: SyncUpdate,
  model: SyncModel,
  docId: string,
  opts?: {
    syncMode?: SyncMode
  },
): [SyncModel, SyncEffect[]] {
  return applyUpdate(
    update,
    {
      type: "sync/doc-defer",
      docId,
      replicaType: ["test", 0, 0],
      syncMode: opts?.syncMode ?? SYNC_COLLABORATIVE,
      schemaHash: "abc123",
    },
    model,
  )
}

/** Send a message-received input and flatten results. */
function receiveMessage(
  update: SyncUpdate,
  model: SyncModel,
  from: string,
  message: any,
): [SyncModel, SyncEffect[]] {
  return applyUpdate(
    update,
    { type: "sync/message-received", from, message },
    model,
  )
}

/**
 * Report offers of `docId` sent, as the shell does after it queues them:
 * each peer's offer carried our `version`.
 */
function reportSent(
  update: SyncUpdate,
  model: SyncModel,
  docId: string,
  version: string,
  ...peerIds: string[]
): [SyncModel, SyncEffect[]] {
  return applyUpdate(
    update,
    {
      type: "sync/offers-sent",
      docId,
      sent: peerIds.map(peerId => ({ peerId, version })),
    },
    model,
  )
}

/** Find effects of a given type from a flat list. */
function effectsOfType<T extends SyncEffect["type"]>(
  effects: SyncEffect[],
  type: T,
): Extract<SyncEffect, { type: T }>[] {
  return effects.filter(e => e.type === type) as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-program", () => {
  // -----------------------------------------------------------------------
  // init
  // -----------------------------------------------------------------------
  describe("init", () => {
    it("initializes with empty documents and peers", () => {
      const model = initSync(alice)
      expect(model.identity).toBe(alice)
      expect(model.documents.size).toBe(0)
      expect(model.peers.size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // sync/peer-available
  // -----------------------------------------------------------------------
  describe("sync/peer-available", () => {
    it("adds peer to model", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      expect(model.peers.has("bob")).toBe(true)
      expect(
        defined(model.peers.get("bob"), 'model.peers.get("bob")').identity,
      ).toBe(bob)
    })

    it("sends present for all existing documents to new peer", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = ensureDoc(update, model, "doc-2")

      const [_m, effects] = addPeer(update, model, "bob", bob)
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(1)
      expect(defined(sends[0], "sends[0]").to).toBe("bob")
      expect(defined(sends[0], "sends[0]").message.type).toBe("present")
      const presentMsg = defined(sends[0], "sends[0]").message as any
      const docIds = presentMsg.docs.map((d: any) => d.docId)
      expect(docIds).toContain("doc-1")
      expect(docIds).toContain("doc-2")
    })

    it("filters documents by canShare predicate", () => {
      const update = makeUpdate({
        canShare: (docId, _peer) => docId !== "secret-doc",
      })
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "public-doc")
      ;[model] = ensureDoc(update, model, "secret-doc")

      const [, effects] = addPeer(update, model, "bob", bob)
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(1)
      const presentMsg = defined(sends[0], "sends[0]").message as any
      const docIds = presentMsg.docs.map((d: any) => d.docId)
      expect(docIds).toContain("public-doc")
      expect(docIds).not.toContain("secret-doc")
    })

    it("preserves existing docSyncStates on reconnect", () => {
      const update = makeUpdate()
      let model = initSync(alice)

      // Add bob, ensure a doc, simulate an import so bob gets a sync state
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      // Simulate receiving an offer and importing — triggers doc-imported
      // which sets peer sync state to synced
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      const syncStateBefore = defined(
        model.peers.get("bob"),
        'model.peers.get("bob")',
      ).docSyncStates.get("doc-1")
      expect(syncStateBefore).toBeDefined()
      expect(defined(syncStateBefore, "syncStateBefore").status).toBe("synced")

      // Peer goes unavailable (but NOT gone — state preserved)
      ;[model] = update({ type: "sync/peer-unavailable", peerId: "bob" }, model)

      // Peer comes back
      ;[model] = addPeer(update, model, "bob", bob)

      const syncStateAfter = defined(
        model.peers.get("bob"),
        'model.peers.get("bob")',
      ).docSyncStates.get("doc-1")
      expect(syncStateAfter).toBeDefined()
      expect(defined(syncStateAfter, "syncStateAfter").status).toBe("synced")
    })
  })

  // -----------------------------------------------------------------------
  // sync/peer-unavailable
  // -----------------------------------------------------------------------
  describe("sync/peer-unavailable", () => {
    it("preserves peer in model with docSyncStates", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      // Create a sync state for bob via doc-imported
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      ;[model] = update({ type: "sync/peer-unavailable", peerId: "bob" }, model)

      // Peer should still be in model
      expect(model.peers.has("bob")).toBe(true)
      expect(
        defined(
          model.peers.get("bob"),
          'model.peers.get("bob")',
        ).docSyncStates.get("doc-1"),
      ).toBeDefined()
    })

    it("emits readyStateChanged for docs the peer had sync state for", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      const [m2] = applyUpdate(
        update,
        { type: "sync/peer-unavailable", peerId: "bob" },
        model,
      )

      expect(m2.pendingPeerSyncDocIds).toContain("doc-1")
    })

    it("no-op for unknown peer", () => {
      const update = makeUpdate()
      const model = initSync(alice)
      const [m2, effects] = applyUpdate(
        update,
        { type: "sync/peer-unavailable", peerId: "unknown" },
        model,
      )

      expect(m2).toBe(model) // reference equality — no change
      expect(effects.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // sync/peer-departed
  // -----------------------------------------------------------------------
  describe("sync/peer-departed", () => {
    it("deletes peer from model", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      expect(model.peers.has("bob")).toBe(true)

      ;[model] = update({ type: "sync/peer-departed", peerId: "bob" }, model)
      expect(model.peers.has("bob")).toBe(false)
    })

    it("emits readyStateChanged for docs the peer had sync state for", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      const [m2] = applyUpdate(
        update,
        { type: "sync/peer-departed", peerId: "bob" },
        model,
      )

      expect(m2.pendingPeerSyncDocIds).toContain("doc-1")
    })

    it("no-op for unknown peer", () => {
      const update = makeUpdate()
      const model = initSync(alice)
      const [m2, effects] = applyUpdate(
        update,
        { type: "sync/peer-departed", peerId: "unknown" },
        model,
      )

      expect(m2).toBe(model)
      expect(effects.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // sync/doc-ensure
  // -----------------------------------------------------------------------
  describe("sync/doc-ensure", () => {
    it("registers document in model", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      expect(model.documents.has("doc-1")).toBe(true)
      const entry = defined(
        model.documents.get("doc-1"),
        'model.documents.get("doc-1")',
      )
      expect(entry.docId).toBe("doc-1")
      expect(entry.mode).toBe("interpret")
      expect(entry.version).toBe("v1")
      expect(entry.syncMode).toBe(SYNC_COLLABORATIVE)
    })

    it("announces to all available peers via present", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)

      const [, effects] = ensureDoc(update, model, "doc-1")
      const presents = effectsOfType(effects, "send-to-peers")
      const presentEffect = presents.find(
        e => (e.message as any).type === "present",
      )
      expect(presentEffect).toBeDefined()
      expect(defined(presentEffect, "presentEffect").to).toContain("bob")
      expect(defined(presentEffect, "presentEffect").to).toContain("carol")
    })

    it("sends interest to peers for collaborative doc", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })
      expect(effectsOfType(effects, "send-to-peer")).toEqual([
        {
          type: "send-to-peer",
          to: "bob",
          message: {
            type: "interest",
            docId: "doc-1",
            version: "v1",
            reciprocate: true, // collaborative → bidirectional
            since: undefined,
          },
        },
      ])
    })

    it("quotes the cursor of theirs we hold when a document is promoted", () => {
      // A replicated document that took bob's offer, then promoted to
      // interpret: the interest it re-sends asks bob only for what came after.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", { mode: "replicate" })
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "b:3",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      const [, effects] = ensureDoc(update, model, "doc-1", {
        mode: "interpret",
        version: "v2",
      })
      const interests = effectsOfType(effects, "send-to-peer").filter(
        e => e.message.type === "interest",
      )
      expect(interests).toMatchObject([
        { to: "bob", message: { version: "v2", since: "b:3" } },
      ])
    })

    it("idempotent — second ensure for same doc returns model unchanged", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2, effects] = ensureDoc(update, model, "doc-1")
      expect(m2).toBe(model) // reference equality
      expect(effects.length).toBe(0)
    })

    it("promotes deferred doc to interpret/replicate", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = deferDoc(update, model, "doc-1")

      expect(
        defined(model.documents.get("doc-1"), 'model.documents.get("doc-1")')
          .mode,
      ).toBe("deferred")

      ;[model] = ensureDoc(update, model, "doc-1", { mode: "interpret" })
      expect(
        defined(model.documents.get("doc-1"), 'model.documents.get("doc-1")')
          .mode,
      ).toBe("interpret")
      expect(
        defined(model.documents.get("doc-1"), 'model.documents.get("doc-1")')
          .version,
      ).toBe("v1")
    })
  })

  // -----------------------------------------------------------------------
  // sync/doc-defer
  // -----------------------------------------------------------------------
  describe("sync/doc-defer", () => {
    it("registers deferred document", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = deferDoc(update, model, "doc-1")

      expect(model.documents.has("doc-1")).toBe(true)
      const entry = defined(
        model.documents.get("doc-1"),
        'model.documents.get("doc-1")',
      )
      expect(entry.mode).toBe("deferred")
      expect(entry.version).toBe("")
    })

    it("announces via present but does NOT send interest", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = deferDoc(update, model, "doc-1")
      // Should have a present effect
      const presents = effectsOfType(effects, "send-to-peers")
      const presentEffect = presents.find(
        e => (e.message as any).type === "present",
      )
      expect(presentEffect).toBeDefined()

      // Should NOT have an interest effect
      const interestEffect = presents.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestEffect).toBeUndefined()
    })

    it("idempotent for existing doc", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2, effects] = deferDoc(update, model, "doc-1")
      // Already exists as "interpret", so defer is a no-op
      expect(m2).toBe(model)
      expect(effects.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // sync/message-received — present
  // -----------------------------------------------------------------------
  describe("sync/message-received — present", () => {
    it("known doc: sends interest", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect(defined(interestSend, "interestSend").to).toBe("bob")
      expect((defined(interestSend, "interestSend").message as any).docId).toBe(
        "doc-1",
      )
    })

    it("known doc with reciprocate for collaborative: sends interest with reciprocate", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect(
        (defined(interestSend, "interestSend").message as any).reciprocate,
      ).toBe(true)
    })

    it("unknown doc: emits ensure-doc effect", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "unknown-doc",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const ensureEffects = effectsOfType(effects, "ensure-doc")
      expect(ensureEffects.length).toBe(1)
      expect(defined(ensureEffects[0], "ensureEffects[0]").docId).toBe(
        "unknown-doc",
      )
      expect(defined(ensureEffects[0], "ensureEffects[0]").peer).toBe(bob)
    })

    it("unknown doc filtered by canShare: no ensure-doc", () => {
      const update = makeUpdate({
        canShare: docId => docId !== "blocked-doc",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "blocked-doc",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const ensureEffects = effectsOfType(effects, "ensure-doc")
      expect(ensureEffects.length).toBe(0)
    })

    it("known doc from a peer denied by canShare: no interest reply", () => {
      // The sibling of the case above, for a doc we already hold. Replying
      // `interest` would confirm to a peer we refuse to share with both that
      // we have the document and what version we are at.
      const update = makeUpdate({
        canShare: docId => docId !== "blocked-doc",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "blocked-doc")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "blocked-doc",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      expect(effectsOfType(effects, "send-to-peer")).toHaveLength(0)
    })

    it("deferred doc: no interest sent", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = deferDoc(update, model, "doc-1")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeUndefined()
    })

    it("replica type mismatch: emits a diagnostic", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["other", 0, 0], // different name → incompatible
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const warnings = effectsOfType(effects, "diagnostic")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0], "warnings[0]").message).toContain(
        "replica type mismatch",
      )

      // No interest should be sent
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })

    it("schema hash mismatch: emits a diagnostic", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "different-hash",
          },
        ],
      })

      const warnings = effectsOfType(effects, "diagnostic")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0], "warnings[0]").message).toContain(
        "schema hash mismatch",
      )

      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })

    it("peers with overlapping supportedHashes proceed to sync despite different primary hashes", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      // Local doc has hash "v2" but supports both "v1" and "v2"
      ;[model] = ensureDoc(update, model, "doc-1", {
        schemaHash: "v2",
        supportedHashes: ["v1", "v2"],
      })

      // Remote peer has hash "v1" but supports "v1"
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "v1",
            supportedHashes: ["v1"],
          },
        ],
      })

      // Should NOT produce warnings — hashes overlap at "v1"
      const warnings = effectsOfType(effects, "diagnostic")
      expect(warnings.length).toBe(0)

      // Should send interest (sync proceeds)
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(1)
      expect(defined(sends[0], "sends[0]").message.type).toBe("interest")
    })

    it("legacy peer without supportedHashes falls back to exact primary hash match", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      // Remote peer sends same schemaHash, no supportedHashes field
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
            // NO supportedHashes — legacy peer
          },
        ],
      })

      // Should proceed (exact match on primary hash)
      const warnings = effectsOfType(effects, "diagnostic")
      expect(warnings.length).toBe(0)

      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(1)
      expect(defined(sends[0], "sends[0]").message.type).toBe("interest")
    })

    it("disjoint supportedHashes reject sync", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        schemaHash: "v3",
        supportedHashes: ["v2", "v3"],
      })

      // Remote peer supports only v1 — no overlap with local [v2, v3]
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "v1",
            supportedHashes: ["v1"],
          },
        ],
      })

      const warnings = effectsOfType(effects, "diagnostic")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0], "warnings[0]").message).toContain(
        "schema hash mismatch",
      )

      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })

    it("syncMode mismatch: emits a diagnostic", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_EPHEMERAL,
            schemaHash: "abc123",
          },
        ],
      })

      const warnings = effectsOfType(effects, "diagnostic")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0], "warnings[0]").message).toContain(
        "syncMode mismatch",
      )

      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })

    it("schema hash mismatch: the diagnostic carries structured fields", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", { schemaHash: "local-hash" })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "remote-hash",
          },
        ],
      })

      const diagnostics = effectsOfType(effects, "diagnostic")
      expect(diagnostics.length).toBe(1)
      // Structured — not a substring of `message`. Context: jj:nztkqwpm
      expect(defined(diagnostics[0], "diagnostics[0]")).toMatchObject({
        type: "diagnostic",
        code: "schema-hash-mismatch",
        severity: "error",
        peer: "bob",
        docId: "doc-1",
        local: "local-hash",
        remote: "remote-hash",
      })
    })

    it("Diagnostic forbids illegal states (type-level)", () => {
      // @ts-expect-error — a doc-sync code must carry `docId`
      const _missingDocId: Diagnostic = {
        code: "schema-hash-mismatch",
        severity: "error",
        peer: "bob",
        local: "a",
        remote: "b",
      }
      // @ts-expect-error — a comparison code must carry `local`/`remote`
      const _missingComparison: Diagnostic = {
        code: "sync-mode-mismatch",
        severity: "error",
        peer: "bob",
        docId: "doc-1",
      }
      expect([_missingDocId, _missingComparison]).toHaveLength(2)
    })
  })

  // -----------------------------------------------------------------------
  // sync/message-received — interest
  // -----------------------------------------------------------------------
  describe("what each side knows about the other", () => {
    const docState = (model: SyncModel, peer: string) =>
      model.peers.get(peer)?.docSyncStates.get("doc-1")

    function importedFromBob() {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = applyUpdate(
        update,
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "bob-v7",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )
      return { update, model }
    }

    it("an interest records the cursor it quotes as what the peer holds of ours, and keeps what we hold of theirs", () => {
      const { update, model: before } = importedFromBob()

      const [model] = receiveMessage(update, before, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "bob-v8",
        since: "v2",
      })

      expect(docState(model, "bob")?.status).toBe("pending")
      expect(docState(model, "bob")?.ourVersionTheyHold).toBe("v2")
      expect(docState(model, "bob")?.theirVersionWeHold).toBe("bob-v7")
    })

    it("a local reset voids what we hold of each peer's, and asks each again from our new version", () => {
      // The reset discarded operations the peer may have sent. An interest
      // quoting the old cursor would claim them, and the peer would answer
      // from past them.
      const { update, model: before } = importedFromBob()
      expect(docState(before, "bob")?.theirVersionWeHold).toBe("bob-v7")

      const [model, effects] = applyUpdate(
        update,
        { type: "sync/doc-reset", docId: "doc-1", version: "v9" },
        before,
      )

      expect(docState(model, "bob")?.theirVersionWeHold).toBeUndefined()
      expect(docState(model, "bob")?.status).toBe(
        docState(before, "bob")?.status,
      )
      expect(model.documents.get("doc-1")?.version).toBe("v9")
      expect(effects).toEqual([
        {
          type: "send-to-peer",
          to: "bob",
          message: {
            type: "interest",
            docId: "doc-1",
            version: "v9",
            reciprocate: false,
          },
        },
      ])
    })

    it("a local reset of a document it does not hold changes nothing", () => {
      const update = makeUpdate()
      const model = initSync(alice)
      const [next, effects] = applyUpdate(
        update,
        { type: "sync/doc-reset", docId: "doc-1", version: "v9" },
        model,
      )
      expect(next).toBe(model)
      expect(effects).toEqual([])
    })

    it("an interest without a cursor records the peer's own version", () => {
      const { update, model: before } = importedFromBob()

      const [model] = receiveMessage(update, before, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v1",
      })

      expect(docState(model, "bob")?.ourVersionTheyHold).toBe("v1")
    })

    it("an offer is imported owing an accept, unless the document is history-free", () => {
      const acceptOwed = (historyFree: boolean) => {
        const update = makeUpdate()
        let model = initSync(alice)
        ;[model] = addPeer(update, model, "bob", bob)
        ;[model] = ensureDoc(update, model, "doc-1", { historyFree })
        const [, effects] = receiveMessage(update, model, "bob", {
          type: "offer",
          docId: "doc-1",
          payload: { kind: "since", encoding: "json", data: "{}" },
          version: "bob-v7",
        })
        return effectsOfType(effects, "import-doc-data").map(e => e.accept)
      }

      expect(acceptOwed(false)).toEqual([true])
      expect(acceptOwed(true)).toEqual([false])
    })

    it("a peer canShare vetoes is owed no accept, though canAccept lets its offer in", () => {
      // `accept` names the document, so it leaves by the same gate as
      // everything else that does.
      const update = makeUpdate({ canShare: () => false })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload: { kind: "since", encoding: "json", data: "{}" },
        version: "bob-v7",
      })
      expect(
        effectsOfType(effects, "import-doc-data").map(e => e.accept),
      ).toEqual([false])
    })

    it("an accept records what the peer holds of ours, and nothing else", () => {
      const { update, model: before } = importedFromBob()

      const [model, effects] = receiveMessage(update, before, "bob", {
        type: "accept",
        docId: "doc-1",
        version: "v2",
      })

      expect(effects).toEqual([])
      expect(docState(model, "bob")?.ourVersionTheyHold).toBe("v2")
      expect(docState(model, "bob")?.status).toBe("synced")
      expect(model.pendingPeerSyncDocIds).toEqual(before.pendingPeerSyncDocIds)
    })

    it("an offer not held leaves its sender pending, keeps our cursor of theirs, and asks for the rest", () => {
      const { update, model: before } = importedFromBob()

      const [model, effects] = applyUpdate(
        update,
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v3",
          offered: "bob-v9",
          fromPeerId: "bob",
          changed: true,
          held: false,
        },
        before,
      )

      expect(docState(model, "bob")?.status).toBe("pending")
      expect(docState(model, "bob")?.theirVersionWeHold).toBe("bob-v7")
      expect(effectsOfType(effects, "send-to-peer")).toEqual([
        {
          type: "send-to-peer",
          to: "bob",
          message: {
            type: "interest",
            docId: "doc-1",
            version: "v3",
            reciprocate: false,
            since: "bob-v7",
          },
        },
      ])
    })

    it("an offer held marks its sender synced and records what we hold of theirs", () => {
      const { model } = importedFromBob()
      expect(docState(model, "bob")?.status).toBe("synced")
      expect(docState(model, "bob")?.theirVersionWeHold).toBe("bob-v7")
    })

    it("a returning peer's holding of ours is forgotten, and ours of theirs kept", () => {
      const { update, model: imported } = importedFromBob()
      const [before] = receiveMessage(update, imported, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v2",
      })

      const [model] = applyUpdate(
        update,
        { type: "sync/peer-available", peerId: "bob", identity: bob },
        before,
      )

      expect(docState(model, "bob")?.ourVersionTheyHold).toBeUndefined()
      expect(docState(model, "bob")?.theirVersionWeHold).toBe("bob-v7")
    })
  })

  describe("what each peer will hold", () => {
    const willHold = (model: SyncModel, peer: string) =>
      defined(
        model.peers.get(peer)?.docSyncStates.get("doc-1"),
        `${peer}'s state for doc-1`,
      ).ourVersionTheyWillHold

    const owed = (model: SyncModel, peer: string) =>
      model.peers.get(peer)?.docSyncStates.get("doc-1")?.offerOwed

    /**
     * Alice holds doc-1 at v1; bob and carol have each sent an interest, and
     * the shell has reported both answers sent.
     */
    function bothInterested() {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "b0",
      })
      ;[model] = receiveMessage(update, model, "carol", {
        type: "interest",
        docId: "doc-1",
        version: "c0",
      })
      ;[model] = reportSent(update, model, "doc-1", "v1", "bob", "carol")
      return { update, model }
    }

    it("an interest owes the peer an answer from what it holds, and clears its baseline", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "b0",
      })
      ;[model] = reportSent(update, model, "doc-1", "v1", "bob")
      expect(willHold(model, "bob")).toBe("v1")

      // A second interest restates what bob holds: the answer is owed from
      // there, and no push reaches bob until it is reported sent.
      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "b1",
        since: "v0",
      })
      expect(owed(model, "bob")).toEqual({ since: "v0" })
      expect(willHold(model, "bob")).toBeUndefined()

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        model,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([])
    })

    it("an answer reported sent brings the peer to the version it carried", () => {
      const { model } = bothInterested()
      expect(willHold(model, "bob")).toBe("v1")
      expect(willHold(model, "carol")).toBe("v1")
      expect(owed(model, "bob")).toBeUndefined()
      expect(owed(model, "carol")).toBeUndefined()
    })

    it("a push owes each peer an offer from its baseline, and leaves the baselines alone", () => {
      const { update, model: before } = bothInterested()
      const [pushed, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        before,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [
            { peerId: "bob", sinceVersion: "v1" },
            { peerId: "carol", sinceVersion: "v1" },
          ],
        },
      ])
      expect(willHold(pushed, "bob")).toBe("v1")
      expect(owed(pushed, "bob")).toEqual({ since: "v1" })

      // A second push before the report keeps the earlier starting point,
      // which covers it.
      const [again] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v3" },
        pushed,
      )
      expect(owed(again, "bob")).toEqual({ since: "v1" })

      const [reported] = reportSent(update, again, "doc-1", "v3", "bob")
      expect(willHold(reported, "bob")).toBe("v3")
      expect(owed(reported, "bob")).toBeUndefined()
      expect(owed(reported, "carol")).toEqual({ since: "v1" })
    })

    it("doc-publishable resends to owed peers only, each from where its offer starts", () => {
      const { update, model: before } = bothInterested()
      let model = before
      ;[model] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        model,
      )
      // Carol's push went out; bob's was withheld.
      ;[model] = reportSent(update, model, "doc-1", "v2", "carol")

      const [after, effects] = applyUpdate(
        update,
        { type: "sync/doc-publishable", docId: "doc-1" },
        model,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: "v1" }],
        },
      ])
      // The record stays until the report.
      expect(owed(after, "bob")).toEqual({ since: "v1" })
    })

    it("doc-publishable resends an owed answer to an interest from what the peer holds", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
      })

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-publishable", docId: "doc-1" },
        model,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        { type: "send-offers", docId: "doc-1", to: [{ peerId: "bob" }] },
      ])
    })

    it("doc-publishable does not resend to a peer no longer shared with", () => {
      // The offer was owed while bob could see the document; the policy
      // changed before the store confirmed.
      const { update, model: before } = bothInterested()
      const [pushed] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        before,
      )
      const vetoBob = makeUpdate({
        canShare: (_docId, peer) => peer.peerId !== "bob",
      })
      const [, effects] = applyUpdate(
        vetoBob,
        { type: "sync/doc-publishable", docId: "doc-1" },
        pushed,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "carol", sinceVersion: "v1" }],
        },
      ])
    })

    it("doc-publishable with nobody owed sends nothing", () => {
      const { update, model } = bothInterested()
      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-publishable", docId: "doc-1" },
        model,
      )
      expect(effects).toEqual([])
    })

    it("a returning peer's owed offer is forgotten with its baselines", () => {
      const { update, model: before } = bothInterested()
      const [pushed] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        before,
      )
      expect(owed(pushed, "bob")).toEqual({ since: "v1" })

      const [returned] = applyUpdate(
        update,
        { type: "sync/peer-available", peerId: "bob", identity: bob },
        pushed,
      )
      expect(owed(returned, "bob")).toBeUndefined()
      expect(willHold(returned, "bob")).toBeUndefined()
    })

    it("a local change pushes each peer from its own baseline", () => {
      const { update, model: before } = bothInterested()
      const [imported] = applyUpdate(
        update,
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "b1",
          fromPeerId: "bob",
          changed: true,
          held: true,
          senderWillHold: "v1+b1",
        },
        before,
      )
      expect(willHold(imported, "bob")).toBe("v1+b1")
      // The relay to carol moves her baseline once it is reported sent.
      expect(willHold(imported, "carol")).toBe("v1")
      const [relayed] = reportSent(update, imported, "doc-1", "v2", "carol")
      expect(willHold(relayed, "carol")).toBe("v2")

      const [model, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v3" },
        relayed,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [
            { peerId: "bob", sinceVersion: "v1+b1" },
            { peerId: "carol", sinceVersion: "v2" },
          ],
        },
      ])
      const [reported] = reportSent(
        update,
        model,
        "doc-1",
        "v3",
        "bob",
        "carol",
      )
      expect(willHold(reported, "bob")).toBe("v3")
      expect(willHold(reported, "carol")).toBe("v3")
    })

    it("an import relays to the other peers from theirs, not to its sender", () => {
      const { update, model } = bothInterested()
      const [, effects] = applyUpdate(
        update,
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "b1",
          fromPeerId: "bob",
          changed: true,
          held: true,
          senderWillHold: "v1+b1",
        },
        model,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "carol", sinceVersion: "v1" }],
        },
      ])
    })

    it("an offer carries its sender's baseline to the shell", () => {
      const { update, model } = bothInterested()
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        version: "b1",
        payload: { kind: "since", encoding: "json", data: "{}" },
      })
      expect(effectsOfType(effects, "import-doc-data")).toMatchObject([
        { fromPeerId: "bob", ourVersionTheyWillHold: "v1" },
      ])
    })

    it("a peer whose baseline we do not know is not pushed to", () => {
      // A returning peer's baseline is forgotten; the answer to its interest
      // catches it up.
      const { update, model: before } = bothInterested()
      const [returned] = applyUpdate(
        update,
        { type: "sync/peer-available", peerId: "bob", identity: bob },
        before,
      )
      expect(willHold(returned, "bob")).toBeUndefined()

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        returned,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "carol", sinceVersion: "v1" }],
        },
      ])
    })
  })

  describe("sync/message-received — interest", () => {
    it("collaborative doc: sends offer with sinceVersion", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: "v0" }],
        },
      ])
    })

    it("collaborative doc with reciprocate: sends offer + reciprocal interest", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: true,
      })

      const offers = effectsOfType(effects, "send-offers")
      expect(offers.length).toBe(1)
      expect(defined(offers[0], "offers[0]").to).toEqual([
        { peerId: "bob", sinceVersion: "v0" },
      ])

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect(defined(interestSend, "interestSend").to).toBe("bob")
      expect(
        (defined(interestSend, "interestSend").message as any).reciprocate,
      ).toBe(false) // prevent loop
    })

    it("authoritative doc: sends offer", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_AUTHORITATIVE,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: "v0" }],
        },
      ])
    })

    it("ephemeral doc: sends offer (no sinceVersion)", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_EPHEMERAL,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
      })

      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: undefined }],
        },
      ])
    })

    it("unknown doc: no-op", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "nonexistent",
        version: "v0",
      })

      expect(effects.length).toBe(0)
      expect(m2).toBe(model)
    })

    it("deferred doc: no-op", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = deferDoc(update, model, "doc-1")

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      expect(effects.length).toBe(0)
      expect(m2).toBe(model)
    })

    it("updates peer sync state to pending", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: true,
      })

      const peerState = m2.peers.get("bob")
      expect(peerState).toBeDefined()
      const docSync = defined(peerState, "peerState").docSyncStates.get("doc-1")
      expect(docSync).toBeDefined()
      expect(defined(docSync, "docSync").status).toBe("pending")
    })

    it("a non-reciprocating interest marks the peer pending and asks the shell to classify its version", () => {
      // `reciprocate: false` exists to stop two peers exchanging interests
      // forever. It says nothing about whether the sender has state we need
      // — that is a version comparison, and only the shell can parse a
      // version. So the program marks `pending` and emits the question.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_AUTHORITATIVE,
      })

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: false,
      })

      const docSync = defined(
        m2.peers.get("bob"),
        'm2.peers.get("bob")',
      ).docSyncStates.get("doc-1")
      expect(defined(docSync, "docSync").status).toBe("pending")
      expect(effects).toContainEqual({
        type: "classify-peer-version",
        docId: "doc-1",
        peerId: "bob",
        version: "v0",
      })
    })

    it("an ephemeral doc's non-reciprocating interest takes the same path", () => {
      // SYNC_EPHEMERAL sets reciprocate: false, same as SYNC_AUTHORITATIVE.
      // The handler does not distinguish sync modes: every interest is a
      // request for our state, answered with an offer, and the sender's own
      // standing is decided by its version.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_EPHEMERAL,
      })

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: false,
      })

      const docSync = defined(
        m2.peers.get("bob"),
        'm2.peers.get("bob")',
      ).docSyncStates.get("doc-1")
      expect(defined(docSync, "docSync").status).toBe("pending")
      expect(effects.some(e => e.type === "classify-peer-version")).toBe(true)
    })

    it("does not reconcile the authority on its interest — only on its offer", () => {
      // The reported defect, pinned where it lives. A fresh client at genesis
      // receives the authority's interest before the authority's offer. Over
      // a websocket those are separate tasks, and `whenSettled` — which reads
      // the reconciliation latch — resolved in the gap, with the document
      // still empty. The latch must not move until state has arrived.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_AUTHORITATIVE,
        version: "kyneta.genesis:0",
      })
      expect(hasReconciled(model, "doc-1")).toBe(false)

      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "bob:54",
        reciprocate: false,
      })
      expect(hasReconciled(model, "doc-1")).toBe(false)

      // The offer arrives and merges; the shell reports it.
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "bob:54",
          offered: "bob:54",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )
      expect(hasReconciled(model, "doc-1")).toBe(true)
      expect(
        defined(
          defined(
            model.peers.get("bob"),
            'model.peers.get("bob")',
          ).docSyncStates.get("doc-1"),
          'defined(model.peers.get("bob")).docSyncStates.get("doc-1")',
        ).status,
      ).toBe("synced")
    })

    it("a reciprocating interest also marks pending and asks for classification", () => {
      // Reconnect: a peer we had as `synced` sends a reciprocal interest.
      // It flips to `pending`; whether it flips straight back is the shell's
      // call from its version, which is what lets a peer at our version
      // re-settle without waiting for the offer round trip.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v1",
          offered: "v1",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v1",
        reciprocate: true,
      })

      expect(
        defined(
          defined(m2.peers.get("bob"), 'm2.peers.get("bob")').docSyncStates.get(
            "doc-1",
          ),
          'defined(m2.peers.get("bob")).docSyncStates.get("doc-1")',
        ).status,
      ).toBe("pending")
      expect(effects).toContainEqual({
        type: "classify-peer-version",
        docId: "doc-1",
        peerId: "bob",
        version: "v1",
      })
    })

    it("a peer left pending by an interest still receives pushes", () => {
      // Routing was never the problem: `getSyncedPeers` sends to
      // `synced | pending`. Pinned because a tightened `pending` rule is the
      // regression this change would most plausibly cause — a read-only
      // client that got its first offer and then silence.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_AUTHORITATIVE,
      })
      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: false,
      })
      expect(
        defined(
          defined(
            model.peers.get("bob"),
            'model.peers.get("bob")',
          ).docSyncStates.get("doc-1"),
          'defined(model.peers.get("bob")).docSyncStates.get("doc-1")',
        ).status,
      ).toBe("pending")
      // The answer went out, and bob is still pending.
      ;[model] = reportSent(update, model, "doc-1", "v1", "bob")

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        model,
      )
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: "v1" }],
        },
      ])
    })

    // The by-id request path. Announcing a doc has always been gated by
    // `canShare`; answering a peer that asks for one by name was not, so a
    // peer that knew the id could pull the whole document anyway.
    const deniesDoc1ForBob = {
      canShare: (docId: string, peer: any) =>
        !(docId === "doc-1" && peer.peerId === "bob"),
    }

    it("denied by canShare: replies vacant, sends no offer, records no peer state", () => {
      const update = makeUpdate(deniesDoc1ForBob)
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      expect(effectsOfType(effects, "send-offers")).toHaveLength(0)
      const replies = effectsOfType(effects, "send-to-peer")
      expect(replies).toHaveLength(1)
      expect(defined(replies[0], "replies[0]").to).toBe("bob")
      expect(defined(replies[0], "replies[0]").message).toEqual({
        type: "vacant",
        docId: "doc-1",
      })

      // No sync relationship is recorded. A `synced` entry here would put bob
      // into `getSyncedPeers` for a doc he is never going to receive.
      expect(
        defined(m2.peers.get("bob"), 'm2.peers.get("bob")').docSyncStates.has(
          "doc-1",
        ),
      ).toBe(false)
    })

    it("denied by canShare: a collaborative interest with reciprocate gets vacant, not a reciprocal interest", () => {
      // Denial has to short-circuit the *whole* response. A CRDT interest
      // normally draws an offer plus a reciprocal interest; neither may leak.
      const update = makeUpdate(deniesDoc1ForBob)
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: true,
      })

      expect(effectsOfType(effects, "send-offers")).toHaveLength(0)
      const replies = effectsOfType(effects, "send-to-peer")
      expect(replies).toHaveLength(1)
      expect((defined(replies[0], "replies[0]").message as any).type).toBe(
        "vacant",
      )
    })

    it("denied by canShare: an interest for a document we do not hold also gets vacant", () => {
      // This is what makes the gate's *position* load-bearing rather than
      // incidental. It sits above the document lookup, so the reply is the
      // same whether or not we hold the doc. Move it below and a denied peer
      // would get a prompt `vacant` for docs we have and silence for ones we
      // do not — which is a way to test whether a doc id exists without ever
      // being allowed to read it.
      const update = makeUpdate(deniesDoc1ForBob)
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      // Deliberately no ensureDoc: alice does not have "doc-1" at all.

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      expect(effects).toHaveLength(1)
      expect(defined(effects[0], "effects[0]").type).toBe("send-to-peer")
      expect((defined(effects[0], "effects[0]") as any).message).toEqual({
        type: "vacant",
        docId: "doc-1",
      })
    })
  })

  // -----------------------------------------------------------------------
  // sync/message-received — offer
  // -----------------------------------------------------------------------
  describe("sync/message-received — offer", () => {
    it("known authorized doc: emits import-doc-data effect", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const payload = {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      }
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload,
        version: "v2",
      })

      const imports = effectsOfType(effects, "import-doc-data")
      expect(imports.length).toBe(1)
      expect(defined(imports[0], "imports[0]").docId).toBe("doc-1")
      expect(defined(imports[0], "imports[0]").payload).toBe(payload)
      expect(defined(imports[0], "imports[0]").version).toBe("v2")
      expect(defined(imports[0], "imports[0]").fromPeerId).toBe("bob")
    })

    it("unauthorized peer: no import effect", () => {
      const update = makeUpdate({
        canAccept: (_docId, peer) => peer.peerId !== "bob",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const payload = {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      }
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload,
        version: "v2",
      })

      const imports = effectsOfType(effects, "import-doc-data")
      expect(imports.length).toBe(0)
    })

    it("only imports: an offer is answered by an accept once imported, never by an interest", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload: { kind: "entirety", encoding: "json", data: "{}" },
        version: "v2",
      })

      expect(effectsOfType(effects, "import-doc-data")).toHaveLength(1)
      expect(effectsOfType(effects, "send-to-peer")).toHaveLength(0)
    })

    it("unknown doc: no-op", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const payload = {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      }
      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "nonexistent",
        payload,
        version: "v2",
      })

      expect(effects.length).toBe(0)
      expect(m2).toBe(model)
    })

    it("deferred doc: no-op", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = deferDoc(update, model, "doc-1")

      const payload = {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      }
      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload,
        version: "v2",
      })

      expect(effects.length).toBe(0)
      expect(m2).toBe(model)
    })
  })

  // -----------------------------------------------------------------------
  // sync/message-received — dismiss
  // -----------------------------------------------------------------------
  describe("sync/message-received — dismiss", () => {
    it("removes doc sync state for peer", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      // First create a sync state via interest
      const [modelAfterInterest] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: true,
      })
      expect(
        defined(
          modelAfterInterest.peers.get("bob"),
          'modelAfterInterest.peers.get("bob")',
        ).docSyncStates.has("doc-1"),
      ).toBe(true)

      // Now receive dismiss
      const [m2] = receiveMessage(update, modelAfterInterest, "bob", {
        type: "dismiss",
        docId: "doc-1",
      })

      expect(
        defined(m2.peers.get("bob"), 'm2.peers.get("bob")').docSyncStates.has(
          "doc-1",
        ),
      ).toBe(false)
    })

    it("leaves our replica, queues the doc, and has no effect", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2, effects] = receiveMessage(update, model, "bob", {
        type: "dismiss",
        docId: "doc-1",
      })

      expect(effects).toEqual([])
      expect(m2.documents.has("doc-1")).toBe(true)
      expect(m2.pendingPeerSyncDocIds).toContain("doc-1")
    })

    it("emits readyStateChanged", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2] = receiveMessage(update, model, "bob", {
        type: "dismiss",
        docId: "doc-1",
      })

      expect(m2.pendingPeerSyncDocIds).toContain("doc-1")
    })
  })

  // -----------------------------------------------------------------------
  // sync/doc-advanced
  // -----------------------------------------------------------------------
  describe("sync/doc-advanced", () => {
    it("updates doc version in model", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      ;[model] = update(
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        model,
      )

      expect(
        defined(model.documents.get("doc-1"), 'model.documents.get("doc-1")')
          .version,
      ).toBe("v2")
    })

    it("pushes to synced peers for collaborative", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      // Bob offered us his version, which he holds: his baseline.
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
          senderWillHold: "v2",
        },
        model,
      )

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v3" },
        model,
      )

      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: "v2" }],
        },
      ])
    })

    it("pushes to synced peers for ephemeral, with a baseline to delta from", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_EPHEMERAL,
      })

      // Only bob has expressed interest; carol has not.
      ;[model] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
      })
      // An ephemeral answer has no gate, so it is reported sent at once, at
      // our version. That, not bob's private counter, is his baseline.
      ;[model] = reportSent(update, model, "doc-1", "v1", "bob")

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v3" },
        model,
      )

      // Interest-based routing: only bob receives the push, from the version
      // our answer to his interest brought him to.
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "bob", sinceVersion: "v1" }],
        },
      ])
    })

    it("does not request persistence", () => {
      // The Runtime persisted the change before it told us. State-advanced
      // is the network's report, so a local change must not raise it, or the
      // change is persisted twice.
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        model,
      )

      expect(m2.pendingStateAdvancedDocIds).not.toContain("doc-1")
    })
  })

  // -----------------------------------------------------------------------
  // sync/doc-dismiss
  // -----------------------------------------------------------------------
  describe("sync/doc-dismiss", () => {
    it("removes document and broadcasts dismiss", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2, effects] = applyUpdate(
        update,
        { type: "sync/doc-dismiss", docId: "doc-1" },
        model,
      )

      expect(m2.documents.has("doc-1")).toBe(false)

      const sends = effectsOfType(effects, "send-to-peers")
      expect(sends.length).toBe(1)
      expect((defined(sends[0], "sends[0]").message as any).type).toBe(
        "dismiss",
      )
      expect((defined(sends[0], "sends[0]").message as any).docId).toBe("doc-1")
      expect(defined(sends[0], "sends[0]").to).toContain("bob")
      expect(defined(sends[0], "sends[0]").to).toContain("carol")
    })
  })

  // -----------------------------------------------------------------------
  // sync/doc-imported
  // -----------------------------------------------------------------------
  describe("sync/doc-imported", () => {
    it("updates doc version and peer sync state to synced", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "bob-v7",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      expect(
        defined(model.documents.get("doc-1"), 'model.documents.get("doc-1")')
          .version,
      ).toBe("v2")
      const peerSync = defined(
        model.peers.get("bob"),
        'model.peers.get("bob")',
      ).docSyncStates.get("doc-1")
      expect(peerSync).toBeDefined()
      expect(defined(peerSync, "peerSync").status).toBe("synced")
      // What we hold of bob's is the version he offered, in his terms, not
      // our own version after the import.
      expect(peerSync?.theirVersionWeHold).toBe("bob-v7")
    })

    it("relays to other peers (multi-hop)", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_COLLABORATIVE,
      })

      // Both peers need to have synced state for relay to work
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
          senderWillHold: "v2",
        },
        model,
      )
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v3",
          offered: "v3",
          fromPeerId: "carol",
          changed: true,
          held: true,
          senderWillHold: "v3",
        },
        model,
      )

      // Now import from bob again — should relay to carol but not back to bob
      const [, effects] = applyUpdate(
        update,
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v4",
          offered: "v4",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      // Relayed to carol from her baseline, not back to bob, the sender.
      expect(effectsOfType(effects, "send-offers")).toEqual([
        {
          type: "send-offers",
          docId: "doc-1",
          to: [{ peerId: "carol", sinceVersion: "v3" }],
        },
      ])
    })

    it("emits readyStateChanged and stateAdvanced via model fields", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [m2] = applyUpdate(
        update,
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          offered: "v2",
          fromPeerId: "bob",
          changed: true,
          held: true,
        },
        model,
      )

      expect(m2.pendingPeerSyncDocIds).toContain("doc-1")
      expect(m2.pendingStateAdvancedDocIds).toContain("doc-1")
    })
  })

  // -----------------------------------------------------------------------
  // canShare predicate
  // -----------------------------------------------------------------------
  describe("canShare predicate", () => {
    it("filters peers for doc-ensure announcements", () => {
      const update = makeUpdate({
        canShare: (docId, peer) => {
          // Only allow bob to see "doc-1"
          if (docId === "doc-1" && peer.peerId === "carol") return false
          return true
        },
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)

      const [, effects] = ensureDoc(update, model, "doc-1")
      const presents = effectsOfType(effects, "send-to-peers")
      const presentEffect = presents.find(
        e => (e.message as any).type === "present",
      )
      expect(presentEffect).toBeDefined()
      expect(defined(presentEffect, "presentEffect").to).toContain("bob")
      expect(defined(presentEffect, "presentEffect").to).not.toContain("carol")
    })

    it("filters peers for doc-advanced pushes", () => {
      const update = makeUpdate({
        canShare: (docId, peer) => {
          if (docId === "doc-1" && peer.peerId === "carol") return false
          return true
        },
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1", {
        syncMode: SYNC_EPHEMERAL,
      })

      const [, effects] = applyUpdate(
        update,
        { type: "sync/doc-advanced", docId: "doc-1", version: "v2" },
        model,
      )

      const offers = effectsOfType(effects, "send-offers")
      if (offers.length > 0) {
        expect(defined(offers[0], "offers[0]").to).toContain("bob")
        expect(defined(offers[0], "offers[0]").to).not.toContain("carol")
      }
    })

    it("filters peers for present → ensure-doc", () => {
      const update = makeUpdate({
        canShare: docId => docId !== "private-doc",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "private-doc",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
          {
            docId: "public-doc",
            replicaType: ["test", 0, 0],
            syncMode: SYNC_COLLABORATIVE,
            schemaHash: "abc123",
          },
        ],
      })

      const ensureEffects = effectsOfType(effects, "ensure-doc")
      const docIds = ensureEffects.map(e => e.docId)
      expect(docIds).not.toContain("private-doc")
      expect(docIds).toContain("public-doc")
    })
  })

  // -----------------------------------------------------------------------
  // canShare — the invariant, over every path at once
  // -----------------------------------------------------------------------
  //
  // The tests above sample one path each, which is how the by-id request path
  // stayed ungated through a whole release: the suite covered announcing a
  // document and nothing ever asked for one by name. An announce-path test
  // proves a peer was not *told*, not that it could not *ask*.
  //
  // Because the sync program is pure, the guarantee can be asserted as an
  // invariant instead of sampled: drive every input that can produce an
  // outbound effect and check that none of them names the vetoed peer for the
  // vetoed document. This is the test that fails when a fifth outbound path
  // is added without a `canShare` check.
  describe("canShare — no outbound effect reaches a vetoed peer", () => {
    it("holds across every input that can emit one", () => {
      const VETOED_DOC = "doc-1"
      const update = makeUpdate({
        canShare: (docId, peer) =>
          !(docId === VETOED_DOC && peer.peerId === "carol"),
      })

      let model = initSync(alice)
      const collected: SyncEffect[] = []
      const drive = (input: Parameters<SyncUpdate>[0]) => {
        const [m, fx] = applyUpdate(update, input, model)
        model = m
        collected.push(...fx)
      }

      // Bob is the control: unvetoed, and must show up in the effects, or
      // this test could pass simply by producing nothing at all.
      ;[model] = addPeer(update, model, "bob", bob)

      // One per outbound-capable member of the `SyncInput` union in
      // sync-program.ts. When that union grows a case that sends anything,
      // add it here — the two lists are meant to be read side by side.
      drive({ type: "sync/peer-available", peerId: "carol", identity: carol })
      drive({
        type: "sync/doc-ensure",
        docId: VETOED_DOC,
        mode: "interpret",
        version: "v1",
        replicaType: ["test", 0, 0],
        historyFree: false,
        syncMode: SYNC_COLLABORATIVE,
        schemaHash: "abc123",
      })
      drive({
        type: "sync/doc-defer",
        docId: VETOED_DOC,
        replicaType: ["test", 0, 0],
        syncMode: SYNC_COLLABORATIVE,
        schemaHash: "abc123",
      })
      drive({ type: "sync/doc-advanced", docId: VETOED_DOC, version: "v2" })
      drive({
        type: "sync/doc-imported",
        docId: VETOED_DOC,
        version: "v3",
        offered: "v3",
        fromPeerId: "bob",
        changed: true,
        held: true,
      })
      drive({ type: "sync/doc-dismiss", docId: VETOED_DOC })
      drive({
        type: "sync/message-received",
        from: "carol",
        message: {
          type: "present",
          docs: [
            {
              docId: VETOED_DOC,
              replicaType: ["test", 0, 0],
              syncMode: SYNC_COLLABORATIVE,
              schemaHash: "abc123",
            },
          ],
        },
      })
      drive({
        type: "sync/message-received",
        from: "carol",
        message: { type: "interest", docId: VETOED_DOC, version: "v0" },
      })
      drive({
        type: "sync/offers-sent",
        docId: VETOED_DOC,
        sent: [{ peerId: "bob", version: "v3" }],
      })
      drive({ type: "sync/doc-advanced", docId: VETOED_DOC, version: "v4" })
      drive({ type: "sync/doc-publishable", docId: VETOED_DOC })
      drive({ type: "sync/doc-reset", docId: VETOED_DOC, version: "v4a" })
      drive({
        type: "sync/doc-imported",
        docId: VETOED_DOC,
        version: "v5",
        offered: "c1",
        fromPeerId: "carol",
        changed: false,
        held: false,
        crossing: { local: "ours", remote: "c", response: "outranking" },
      })

      /** Does this effect mention the vetoed doc, however it carries ids? */
      const namesVetoedDoc = (effect: SyncEffect): boolean => {
        const e = effect as any
        if (e.docId === VETOED_DOC) return true
        const msg = e.message
        if (!msg) return false
        if (msg.docId === VETOED_DOC) return true
        // `present` carries a list rather than a single id.
        return (
          Array.isArray(msg.docs) &&
          msg.docs.some((d: any) => d.docId === VETOED_DOC)
        )
      }

      // `send-offers` names each recipient as `{ peerId, sinceVersion }`.
      const recipients = (effect: SyncEffect): string[] => {
        const to = (effect as any).to
        if (to === undefined) return []
        return (Array.isArray(to) ? to : [to]).map((r: any) =>
          typeof r === "string" ? r : r.peerId,
        )
      }

      let carolSawSomething = false
      let bobSawSomething = false

      for (const effect of collected) {
        if (!recipients(effect).includes("carol")) {
          if (recipients(effect).includes("bob") && namesVetoedDoc(effect)) {
            bobSawSomething = true
          }
          continue
        }
        if (!namesVetoedDoc(effect)) continue

        carolSawSomething = true
        // `vacant` — "I will not serve you this" — is the one thing carol may
        // receive about this document. It carries no data and, by design, is
        // the same reply she would get for a document that does not exist.
        expect(effect.type).toBe("send-to-peer")
        expect((effect as any).message.type).toBe("vacant")
      }

      // Carol asked, so she must have been answered — a silent denial would
      // leave her `whenSettled` hanging, and would itself be a signal.
      expect(carolSawSomething).toBe(true)
      // And the veto is specific to carol, not a global mute.
      expect(bobSawSomething).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // canAccept predicate
  // -----------------------------------------------------------------------
  describe("canAccept predicate", () => {
    it("blocks offer import from unauthorized peer", () => {
      const update = makeUpdate({
        canAccept: (_docId, peer) => peer.peerId !== "bob",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const payload = {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      }
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload,
        version: "v2",
      })

      const imports = effectsOfType(effects, "import-doc-data")
      expect(imports.length).toBe(0)
    })

    it("allows offer import from authorized peer", () => {
      const update = makeUpdate({
        canAccept: (_docId, peer) => peer.peerId === "bob",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const payload = {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      }
      const [, effects] = receiveMessage(update, model, "bob", {
        type: "offer",
        docId: "doc-1",
        payload,
        version: "v2",
      })

      const imports = effectsOfType(effects, "import-doc-data")
      expect(imports.length).toBe(1)
      expect(defined(imports[0], "imports[0]").docId).toBe("doc-1")
      expect(defined(imports[0], "imports[0]").fromPeerId).toBe("bob")
    })
  })
})

// ---------------------------------------------------------------------------
// Vacant message + monotonic readiness latch
// ---------------------------------------------------------------------------

describe("vacant + reconciliation latch", () => {
  function setup(): { update: SyncUpdate; model: SyncModel } {
    const update = makeUpdate()
    let model = initSync(alice)
    ;[model] = addPeer(update, model, "bob", bob)
    ;[model] = ensureDoc(update, model, "doc-1")
    return { update, model }
  }

  function markSynced(
    update: SyncUpdate,
    model: SyncModel,
    peerId: string,
    version = "v2",
  ): SyncModel {
    const [m] = applyUpdate(
      update,
      {
        type: "sync/peer-synced",
        docId: "doc-1",
        version,
        peerId,
      },
      model,
    )
    return m
  }

  describe("handleVacant (consumer)", () => {
    it("records the peer vacant and queues the doc", () => {
      const { update, model } = setup()
      const [m2, fx] = receiveMessage(update, model, "bob", {
        type: "vacant",
        docId: "doc-1",
      })
      expect(m2.peers.get("bob")?.docSyncStates.get("doc-1")?.status).toBe(
        "vacant",
      )
      expect(m2.pendingPeerSyncDocIds).toContain("doc-1")
      expect(fx).toEqual([])
    })

    it("a vacant reply makes the doc reconciled (ready latch)", () => {
      const { update, model } = setup()
      const [m2] = receiveMessage(update, model, "bob", {
        type: "vacant",
        docId: "doc-1",
      })
      expect(hasReconciled(m2, "doc-1")).toBe(true)
    })

    it("ignores a doc we don't track", () => {
      const { update, model } = setup()
      const [m2, fx] = receiveMessage(update, model, "bob", {
        type: "vacant",
        docId: "doc-unknown",
      })
      expect(m2).toBe(model)
      expect(fx).toHaveLength(0)
    })
  })

  describe("sync/declare-vacant (producer)", () => {
    it("emits exactly one send-to-peer vacant for a known peer", () => {
      const { update, model } = setup()
      const [, fx] = applyUpdate(
        update,
        { type: "sync/declare-vacant", docId: "doc-1", to: "bob" },
        model,
      )
      const sends = effectsOfType(fx, "send-to-peer")
      expect(sends).toHaveLength(1)
      expect(defined(sends[0], "sends[0]").to).toBe("bob")
      expect(defined(sends[0], "sends[0]").message).toEqual({
        type: "vacant",
        docId: "doc-1",
      })
    })

    it("emits nothing when the target peer is unknown", () => {
      const { update, model } = setup()
      const [, fx] = applyUpdate(
        update,
        { type: "sync/declare-vacant", docId: "doc-1", to: "nobody" },
        model,
      )
      expect(fx).toHaveLength(0)
    })
  })

  describe("reconciledIdentities (monotonic latch)", () => {
    it("retains the identity across a synced → pending → synced flip", () => {
      const { update, model } = setup()
      let m = markSynced(update, model, "bob")
      expect(hasReconciled(m, "doc-1")).toBe(true)

      // Reciprocal interest flips volatile state back to pending…
      ;[m] = receiveMessage(update, m, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v2",
        reciprocate: true,
      })
      expect(m.peers.get("bob")?.docSyncStates.get("doc-1")?.status).toBe(
        "pending",
      )
      // …but the latch survives the flip.
      expect(hasReconciled(m, "doc-1")).toBe(true)

      m = markSynced(update, m, "bob", "v3")
      expect(hasReconciled(m, "doc-1")).toBe(true)
    })

    it("survives the peer leaving model.peers; reconciledMatching resolves the stored identity", () => {
      const { update, model } = setup()
      let m = markSynced(update, model, "bob")
      ;[m] = applyUpdate(
        update,
        { type: "sync/peer-departed", peerId: "bob" },
        m,
      )
      expect(m.peers.has("bob")).toBe(false)
      expect(hasReconciled(m, "doc-1")).toBe(true)
      expect(reconciledMatching(m, "doc-1", p => p.peerId === "bob")).toBe(true)
      expect(reconciledMatching(m, "doc-1", p => p.peerId === "zzz")).toBe(
        false,
      )
    })
  })

  describe("clear lifecycle (suspend vs dismiss)", () => {
    it("retains the latch on a doc-suspended dismiss but clears it on a true removal", () => {
      const { update, model } = setup()
      const m = markSynced(update, model, "bob")
      expect(hasReconciled(m, "doc-1")).toBe(true)

      const [suspended] = applyUpdate(
        update,
        {
          type: "sync/doc-dismiss",
          docId: "doc-1",
          event: { type: "doc-suspended", docId: "doc-1" },
        },
        m,
      )
      expect(hasReconciled(suspended, "doc-1")).toBe(true)

      const [removed] = applyUpdate(
        update,
        {
          type: "sync/doc-dismiss",
          docId: "doc-1",
          event: { type: "doc-removed", docId: "doc-1" },
        },
        m,
      )
      expect(hasReconciled(removed, "doc-1")).toBe(false)
    })
  })
})

describe("sync/doc-imported across a lineage", () => {
  /** Alice holds doc-1; bob has asked for it, and the answer went out. */
  function answered(update = makeUpdate()) {
    let model = initSync(alice)
    ;[model] = addPeer(update, model, "bob", bob)
    ;[model] = ensureDoc(update, model, "doc-1")
    ;[model] = receiveMessage(update, model, "bob", {
      type: "interest",
      docId: "doc-1",
      version: "kyneta.genesis:0",
    })
    ;[model] = reportSent(update, model, "doc-1", "v1", "bob")
    // A version check found bob at genesis: that is our cursor of his.
    ;[model] = applyUpdate(
      update,
      {
        type: "sync/peer-synced",
        docId: "doc-1",
        peerId: "bob",
        version: "kyneta.genesis:0",
      },
      model,
    )
    return { update, model }
  }

  const imported = (
    response: "adopted" | "asking" | "outranking" | "refused",
    over: { held?: boolean; changed?: boolean } = {},
  ) => ({
    type: "sync/doc-imported" as const,
    docId: "doc-1",
    version: "ours:1",
    offered: "theirs:1",
    fromPeerId: "bob",
    changed: over.changed ?? false,
    held: over.held ?? false,
    crossing: { local: "ours", remote: "theirs", response },
  })

  const state = (model: SyncModel) =>
    model.peers.get("bob")?.docSyncStates.get("doc-1")

  it("reports every crossing as a lineage collision", () => {
    for (const [response, over] of [
      ["adopted", { held: true, changed: true }],
      ["asking", {}],
      ["outranking", {}],
      ["refused", {}],
    ] as const) {
      const { update, model } = answered()
      const [, effects] = applyUpdate(update, imported(response, over), model)
      expect(effectsOfType(effects, "diagnostic")).toEqual([
        expect.objectContaining({
          code: "lineage-collision",
          severity: "error",
          peer: "bob",
          docId: "doc-1",
          local: "ours",
          remote: "theirs",
        }),
      ])
    }
  })

  it("asking quotes no cursor, so the answer is the sender's whole document", () => {
    const { update, model } = answered()
    expect(state(model)?.theirVersionWeHold).toBe("kyneta.genesis:0")

    const [after, effects] = applyUpdate(update, imported("asking"), model)
    expect(state(after)?.theirVersionWeHold).toBeUndefined()
    const [interest] = effectsOfType(effects, "send-to-peer")
    expect(interest?.message).toEqual(
      expect.objectContaining({ type: "interest", docId: "doc-1" }),
    )
    const message = interest?.message
    expect(message?.type === "interest" ? message.since : "absent").toBe(
      undefined,
    )
  })

  it("outranking owes and sends the sender our whole document", () => {
    const { update, model } = answered()
    const [after, effects] = applyUpdate(update, imported("outranking"), model)
    expect(effectsOfType(effects, "send-offers")).toEqual([
      { type: "send-offers", docId: "doc-1", to: [{ peerId: "bob" }] },
    ])
    expect(state(after)?.offerOwed).toEqual({})
    expect(state(after)?.ourVersionTheyWillHold).toBeUndefined()
  })

  it("outranking sends nothing to a peer no longer shared with", () => {
    const { model } = answered()
    const vetoBob = makeUpdate({
      canShare: (_docId, peer) => peer.peerId !== "bob",
    })
    const [, effects] = applyUpdate(vetoBob, imported("outranking"), model)
    expect(effectsOfType(effects, "send-offers")).toEqual([])
  })

  it("refused asks for nothing: the answer would be refused again", () => {
    const { update, model } = answered()
    const [, effects] = applyUpdate(update, imported("refused"), model)
    expect(effects.map(e => e.type)).toEqual(["diagnostic"])
  })
})
