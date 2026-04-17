// sync-program — unit tests for the pure TEA update function.

import { describe, expect, it } from "vitest"
import {
  createSyncUpdate,
  initSync,
  type SyncEffect,
  type SyncModel,
  type SyncNotification,
  type SyncUpdate,
} from "../sync-program.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Assert a value is defined and return it narrowed. */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  return value as T
}

const alice = { peerId: "alice", type: "user" as const }
const bob = { peerId: "bob", type: "user" as const }
const carol = { peerId: "carol", type: "user" as const }

function makeUpdate(params?: {
  route?: (docId: string, peer: any) => boolean
  authorize?: (docId: string, peer: any) => boolean
}): SyncUpdate {
  return createSyncUpdate(params)
}

function flattenEffects(effect: SyncEffect | undefined): SyncEffect[] {
  if (!effect) return []
  if (effect.type === "batch") return effect.effects.flatMap(flattenEffects)
  return [effect]
}

function flattenNotifications(
  notification: SyncNotification | undefined,
): SyncNotification[] {
  if (!notification) return []
  if (notification.type === "notify/batch")
    return notification.notifications.flatMap(flattenNotifications)
  return [notification]
}

/** Add a peer to the model (simulates sync/peer-available). */
function addPeer(
  update: SyncUpdate,
  model: SyncModel,
  peerId: string,
  identity: any,
): [SyncModel, SyncEffect[], SyncNotification[]] {
  const [m, e, n] = update(
    { type: "sync/peer-available", peerId, identity },
    model,
  )
  return [m, flattenEffects(e), flattenNotifications(n)]
}

/** Register a document via sync/doc-ensure. */
function ensureDoc(
  update: SyncUpdate,
  model: SyncModel,
  docId: string,
  opts?: {
    mode?: "interpret" | "replicate"
    mergeStrategy?: "collaborative" | "authoritative" | "ephemeral"
    version?: string
  },
): [SyncModel, SyncEffect[], SyncNotification[]] {
  const [m, e, n] = update(
    {
      type: "sync/doc-ensure",
      docId,
      mode: opts?.mode ?? "interpret",
      version: opts?.version ?? "v1",
      replicaType: ["test", 0, 0],
      mergeStrategy: opts?.mergeStrategy ?? "collaborative",
      schemaHash: "abc123",
    },
    model,
  )
  return [m, flattenEffects(e), flattenNotifications(n)]
}

/** Register a deferred document via sync/doc-defer. */
function deferDoc(
  update: SyncUpdate,
  model: SyncModel,
  docId: string,
  opts?: {
    mergeStrategy?: "collaborative" | "authoritative" | "ephemeral"
  },
): [SyncModel, SyncEffect[], SyncNotification[]] {
  const [m, e, n] = update(
    {
      type: "sync/doc-defer",
      docId,
      replicaType: ["test", 0, 0],
      mergeStrategy: opts?.mergeStrategy ?? "collaborative",
      schemaHash: "abc123",
    },
    model,
  )
  return [m, flattenEffects(e), flattenNotifications(n)]
}

/** Send a message-received input and flatten results. */
function receiveMessage(
  update: SyncUpdate,
  model: SyncModel,
  from: string,
  message: any,
): [SyncModel, SyncEffect[], SyncNotification[]] {
  const [m, e, n] = update(
    { type: "sync/message-received", from, message },
    model,
  )
  return [m, flattenEffects(e), flattenNotifications(n)]
}

/** Find effects of a given type from a flat list. */
function effectsOfType<T extends SyncEffect["type"]>(
  effects: SyncEffect[],
  type: T,
): Extract<SyncEffect, { type: T }>[] {
  return effects.filter(e => e.type === type) as any
}

/** Find notifications of a given type from a flat list. */
function notificationsOfType<T extends SyncNotification["type"]>(
  notifications: SyncNotification[],
  type: T,
): Extract<SyncNotification, { type: T }>[] {
  return notifications.filter(n => n.type === type) as any
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
      expect(defined(model.peers.get("bob")).identity).toBe(bob)
    })

    it("sends present for all existing documents to new peer", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")
      ;[model] = ensureDoc(update, model, "doc-2")

      const [_m, effects] = addPeer(update, model, "bob", bob)
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(1)
      expect(defined(sends[0]).to).toBe("bob")
      expect(defined(sends[0]).message.type).toBe("present")
      const presentMsg = defined(sends[0]).message as any
      const docIds = presentMsg.docs.map((d: any) => d.docId)
      expect(docIds).toContain("doc-1")
      expect(docIds).toContain("doc-2")
    })

    it("filters documents by route predicate", () => {
      const update = makeUpdate({
        route: (docId, _peer) => docId !== "secret-doc",
      })
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "public-doc")
      ;[model] = ensureDoc(update, model, "secret-doc")

      const [, effects] = addPeer(update, model, "bob", bob)
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(1)
      const presentMsg = defined(sends[0]).message as any
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
          fromPeerId: "bob",
        },
        model,
      )

      const syncStateBefore = defined(model.peers.get("bob")).docSyncStates.get(
        "doc-1",
      )
      expect(syncStateBefore).toBeDefined()
      expect(defined(syncStateBefore).status).toBe("synced")

      // Peer goes unavailable (but NOT gone — state preserved)
      ;[model] = update({ type: "sync/peer-unavailable", peerId: "bob" }, model)

      // Peer comes back
      ;[model] = addPeer(update, model, "bob", bob)

      const syncStateAfter = defined(model.peers.get("bob")).docSyncStates.get(
        "doc-1",
      )
      expect(syncStateAfter).toBeDefined()
      expect(defined(syncStateAfter).status).toBe("synced")
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
          fromPeerId: "bob",
        },
        model,
      )

      ;[model] = update({ type: "sync/peer-unavailable", peerId: "bob" }, model)

      // Peer should still be in model
      expect(model.peers.has("bob")).toBe(true)
      expect(
        defined(model.peers.get("bob")).docSyncStates.get("doc-1"),
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
          fromPeerId: "bob",
        },
        model,
      )

      const [, , n] = update(
        { type: "sync/peer-unavailable", peerId: "bob" },
        model,
      )
      const notifs = flattenNotifications(n)

      const readyChanges = notificationsOfType(
        notifs,
        "notify/ready-state-changed",
      )
      expect(readyChanges.length).toBe(1)
      expect(defined(readyChanges[0]).docIds.has("doc-1")).toBe(true)
    })

    it("no-op for unknown peer", () => {
      const update = makeUpdate()
      const model = initSync(alice)
      const [m2, e, n] = update(
        { type: "sync/peer-unavailable", peerId: "unknown" },
        model,
      )
      const effects = flattenEffects(e)
      const notifications = flattenNotifications(n)

      expect(m2).toBe(model) // reference equality — no change
      expect(effects.length).toBe(0)
      expect(notifications.length).toBe(0)
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
          fromPeerId: "bob",
        },
        model,
      )

      const [, , notifs] = (() => {
        const [m, e, n] = update(
          { type: "sync/peer-departed", peerId: "bob" },
          model,
        )
        return [m, flattenEffects(e), flattenNotifications(n)]
      })()

      const readyChanges = notificationsOfType(
        notifs,
        "notify/ready-state-changed",
      )
      expect(readyChanges.length).toBe(1)
      expect(defined(readyChanges[0]).docIds.has("doc-1")).toBe(true)
    })

    it("no-op for unknown peer", () => {
      const update = makeUpdate()
      const model = initSync(alice)
      const [m2, e, n] = update(
        { type: "sync/peer-departed", peerId: "unknown" },
        model,
      )
      const effects = flattenEffects(e)
      const notifications = flattenNotifications(n)

      expect(m2).toBe(model)
      expect(effects.length).toBe(0)
      expect(notifications.length).toBe(0)
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
      const entry = defined(model.documents.get("doc-1"))
      expect(entry.docId).toBe("doc-1")
      expect(entry.mode).toBe("interpret")
      expect(entry.version).toBe("v1")
      expect(entry.mergeStrategy).toBe("collaborative")
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
      expect(defined(presentEffect).to).toContain("bob")
      expect(defined(presentEffect).to).toContain("carol")
    })

    it("sends interest to peers for collaborative doc", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })
      const interests = effectsOfType(effects, "send-to-peers")
      const interestEffect = interests.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestEffect).toBeDefined()
      const msg = defined(interestEffect).message as any
      expect(msg.type).toBe("interest")
      expect(msg.docId).toBe("doc-1")
      expect(msg.reciprocate).toBe(true) // collaborative → bidirectional
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

      expect(defined(model.documents.get("doc-1")).mode).toBe("deferred")

      ;[model] = ensureDoc(update, model, "doc-1", { mode: "interpret" })
      expect(defined(model.documents.get("doc-1")).mode).toBe("interpret")
      expect(defined(model.documents.get("doc-1")).version).toBe("v1")
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
      const entry = defined(model.documents.get("doc-1"))
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
            mergeStrategy: "collaborative",
            schemaHash: "abc123",
          },
        ],
      })

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect(defined(interestSend).to).toBe("bob")
      expect((defined(interestSend).message as any).docId).toBe("doc-1")
    })

    it("known doc with reciprocate for collaborative: sends interest with reciprocate", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            mergeStrategy: "collaborative",
            schemaHash: "abc123",
          },
        ],
      })

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect((defined(interestSend).message as any).reciprocate).toBe(true)
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
            mergeStrategy: "collaborative",
            schemaHash: "abc123",
          },
        ],
      })

      const ensureEffects = effectsOfType(effects, "ensure-doc")
      expect(ensureEffects.length).toBe(1)
      expect(defined(ensureEffects[0]).docId).toBe("unknown-doc")
      expect(defined(ensureEffects[0]).peer).toBe(bob)
    })

    it("unknown doc filtered by route: no ensure-doc", () => {
      const update = makeUpdate({
        route: docId => docId !== "blocked-doc",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "blocked-doc",
            replicaType: ["test", 0, 0],
            mergeStrategy: "collaborative",
            schemaHash: "abc123",
          },
        ],
      })

      const ensureEffects = effectsOfType(effects, "ensure-doc")
      expect(ensureEffects.length).toBe(0)
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
            mergeStrategy: "collaborative",
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

    it("replica type mismatch: emits warning", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects, notifications] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["other", 0, 0], // different name → incompatible
            mergeStrategy: "collaborative",
            schemaHash: "abc123",
          },
        ],
      })

      const warnings = notificationsOfType(notifications, "notify/warning")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0]).message).toContain("replica type mismatch")

      // No interest should be sent
      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })

    it("schema hash mismatch: emits warning", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects, notifications] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            mergeStrategy: "collaborative",
            schemaHash: "different-hash",
          },
        ],
      })

      const warnings = notificationsOfType(notifications, "notify/warning")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0]).message).toContain("schema hash mismatch")

      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })

    it("merge strategy mismatch: emits warning", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })

      const [, effects, notifications] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "doc-1",
            replicaType: ["test", 0, 0],
            mergeStrategy: "ephemeral",
            schemaHash: "abc123",
          },
        ],
      })

      const warnings = notificationsOfType(notifications, "notify/warning")
      expect(warnings.length).toBe(1)
      expect(defined(warnings[0]).message).toContain("mergeStrategy mismatch")

      const sends = effectsOfType(effects, "send-to-peer")
      expect(sends.length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // sync/message-received — interest
  // -----------------------------------------------------------------------
  describe("sync/message-received — interest", () => {
    it("collaborative doc: sends offer with sinceVersion", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      const offers = effectsOfType(effects, "send-offer")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).to).toBe("bob")
      expect(defined(offers[0]).docId).toBe("doc-1")
      expect(defined(offers[0]).sinceVersion).toBe("v0")
    })

    it("collaborative doc with reciprocate: sends offer + reciprocal interest", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
        reciprocate: true,
      })

      const offers = effectsOfType(effects, "send-offer")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).to).toBe("bob")

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect(defined(interestSend).to).toBe("bob")
      expect((defined(interestSend).message as any).reciprocate).toBe(false) // prevent loop
    })

    it("authoritative doc: sends offer", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "authoritative",
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
        version: "v0",
      })

      const offers = effectsOfType(effects, "send-offer")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).docId).toBe("doc-1")
      expect(defined(offers[0]).sinceVersion).toBe("v0")
    })

    it("ephemeral doc: sends offer (no sinceVersion)", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "ephemeral",
      })

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "interest",
        docId: "doc-1",
      })

      const offers = effectsOfType(effects, "send-offer")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).docId).toBe("doc-1")
      expect(defined(offers[0]).sinceVersion).toBeUndefined()
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
      })

      const peerState = m2.peers.get("bob")
      expect(peerState).toBeDefined()
      const docSync = defined(peerState).docSyncStates.get("doc-1")
      expect(docSync).toBeDefined()
      expect(defined(docSync).status).toBe("pending")
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
      expect(defined(imports[0]).docId).toBe("doc-1")
      expect(defined(imports[0]).payload).toBe(payload)
      expect(defined(imports[0]).version).toBe("v2")
      expect(defined(imports[0]).fromPeerId).toBe("bob")
    })

    it("unauthorized peer: no import effect", () => {
      const update = makeUpdate({
        authorize: (_docId, peer) => peer.peerId !== "bob",
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

    it("with reciprocate: sends interest back", () => {
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
        reciprocate: true,
      })

      const sends = effectsOfType(effects, "send-to-peer")
      const interestSend = sends.find(
        e => (e.message as any).type === "interest",
      )
      expect(interestSend).toBeDefined()
      expect(defined(interestSend).to).toBe("bob")
      expect((defined(interestSend).message as any).docId).toBe("doc-1")
      expect((defined(interestSend).message as any).reciprocate).toBe(false)
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
      })
      expect(
        defined(modelAfterInterest.peers.get("bob")).docSyncStates.has("doc-1"),
      ).toBe(true)

      // Now receive dismiss
      const [m2] = receiveMessage(update, modelAfterInterest, "bob", {
        type: "dismiss",
        docId: "doc-1",
      })

      expect(defined(m2.peers.get("bob")).docSyncStates.has("doc-1")).toBe(
        false,
      )
    })

    it("emits ensure-doc-dismissed effect", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "dismiss",
        docId: "doc-1",
      })

      const dismissed = effectsOfType(effects, "ensure-doc-dismissed")
      expect(dismissed.length).toBe(1)
      expect(defined(dismissed[0]).docId).toBe("doc-1")
      expect(defined(dismissed[0]).peer).toBe(bob)
    })

    it("emits readyStateChanged", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, , notifications] = receiveMessage(update, model, "bob", {
        type: "dismiss",
        docId: "doc-1",
      })

      const readyChanges = notificationsOfType(
        notifications,
        "notify/ready-state-changed",
      )
      expect(readyChanges.length).toBe(1)
      expect(defined(readyChanges[0]).docIds.has("doc-1")).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // sync/local-doc-change
  // -----------------------------------------------------------------------
  describe("sync/local-doc-change", () => {
    it("updates doc version in model", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      ;[model] = update(
        { type: "sync/local-doc-change", docId: "doc-1", version: "v2" },
        model,
      )

      expect(defined(model.documents.get("doc-1")).version).toBe("v2")
    })

    it("pushes to synced peers for collaborative", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })

      // Create a synced peer state for bob via doc-imported
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          fromPeerId: "bob",
        },
        model,
      )

      const [, e] = update(
        { type: "sync/local-doc-change", docId: "doc-1", version: "v3" },
        model,
      )
      const effects = flattenEffects(e)

      const offers = effectsOfType(effects, "send-offers")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).to).toContain("bob")
      expect(defined(offers[0]).docId).toBe("doc-1")
      expect(defined(offers[0]).sinceVersion).toBeDefined()
    })

    it("broadcasts to all peers for ephemeral", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "ephemeral",
      })

      const [, e] = update(
        { type: "sync/local-doc-change", docId: "doc-1", version: "v2" },
        model,
      )
      const effects = flattenEffects(e)

      // Ephemeral broadcasts to all available peers (not just synced)
      const offers = effectsOfType(effects, "send-offers")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).to).toContain("bob")
      expect(defined(offers[0]).to).toContain("carol")
      expect(defined(offers[0]).sinceVersion).toBeUndefined() // ephemeral = no delta
    })

    it("emits state-advanced notification", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, , n] = update(
        { type: "sync/local-doc-change", docId: "doc-1", version: "v2" },
        model,
      )
      const notifications = flattenNotifications(n)

      const advanced = notificationsOfType(
        notifications,
        "notify/state-advanced",
      )
      expect(advanced.length).toBe(1)
      expect(defined(advanced[0]).docIds.has("doc-1")).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // sync/doc-delete
  // -----------------------------------------------------------------------
  describe("sync/doc-delete", () => {
    it("removes document from model", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = ensureDoc(update, model, "doc-1")
      expect(model.documents.has("doc-1")).toBe(true)

      ;[model] = update({ type: "sync/doc-delete", docId: "doc-1" }, model)
      expect(model.documents.has("doc-1")).toBe(false)
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

      const [m2, e] = update(
        { type: "sync/doc-dismiss", docId: "doc-1" },
        model,
      )
      const effects = flattenEffects(e)

      expect(m2.documents.has("doc-1")).toBe(false)

      const sends = effectsOfType(effects, "send-to-peers")
      expect(sends.length).toBe(1)
      expect((defined(sends[0]).message as any).type).toBe("dismiss")
      expect((defined(sends[0]).message as any).docId).toBe("doc-1")
      expect(defined(sends[0]).to).toContain("bob")
      expect(defined(sends[0]).to).toContain("carol")
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
          fromPeerId: "bob",
        },
        model,
      )

      expect(defined(model.documents.get("doc-1")).version).toBe("v2")
      const peerSync = defined(model.peers.get("bob")).docSyncStates.get(
        "doc-1",
      )
      expect(peerSync).toBeDefined()
      expect(defined(peerSync).status).toBe("synced")
      expect((peerSync as any).lastKnownVersion).toBe("v2")
    })

    it("relays to other peers (multi-hop)", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "collaborative",
      })

      // Both peers need to have synced state for relay to work
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          fromPeerId: "bob",
        },
        model,
      )
      ;[model] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v3",
          fromPeerId: "carol",
        },
        model,
      )

      // Now import from bob again — should relay to carol but not back to bob
      const [, e] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v4",
          fromPeerId: "bob",
        },
        model,
      )
      const effects = flattenEffects(e)

      const offers = effectsOfType(effects, "send-offers")
      expect(offers.length).toBe(1)
      expect(defined(offers[0]).to).toContain("carol")
      expect(defined(offers[0]).to).not.toContain("bob") // excluded sender
    })

    it("emits readyStateChanged and stateAdvanced", () => {
      const update = makeUpdate()
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = ensureDoc(update, model, "doc-1")

      const [, , n] = update(
        {
          type: "sync/doc-imported",
          docId: "doc-1",
          version: "v2",
          fromPeerId: "bob",
        },
        model,
      )
      const notifications = flattenNotifications(n)

      const readyChanges = notificationsOfType(
        notifications,
        "notify/ready-state-changed",
      )
      expect(readyChanges.length).toBe(1)
      expect(defined(readyChanges[0]).docIds.has("doc-1")).toBe(true)

      const advanced = notificationsOfType(
        notifications,
        "notify/state-advanced",
      )
      expect(advanced.length).toBe(1)
      expect(defined(advanced[0]).docIds.has("doc-1")).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // route predicate
  // -----------------------------------------------------------------------
  describe("route predicate", () => {
    it("filters peers for doc-ensure announcements", () => {
      const update = makeUpdate({
        route: (docId, peer) => {
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
      expect(defined(presentEffect).to).toContain("bob")
      expect(defined(presentEffect).to).not.toContain("carol")
    })

    it("filters peers for local-doc-change pushes", () => {
      const update = makeUpdate({
        route: (docId, peer) => {
          if (docId === "doc-1" && peer.peerId === "carol") return false
          return true
        },
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)
      ;[model] = addPeer(update, model, "carol", carol)
      ;[model] = ensureDoc(update, model, "doc-1", {
        mergeStrategy: "ephemeral",
      })

      const [, e] = update(
        { type: "sync/local-doc-change", docId: "doc-1", version: "v2" },
        model,
      )
      const effects = flattenEffects(e)

      const offers = effectsOfType(effects, "send-offers")
      if (offers.length > 0) {
        expect(defined(offers[0]).to).toContain("bob")
        expect(defined(offers[0]).to).not.toContain("carol")
      }
    })

    it("filters peers for present → ensure-doc", () => {
      const update = makeUpdate({
        route: docId => docId !== "private-doc",
      })
      let model = initSync(alice)
      ;[model] = addPeer(update, model, "bob", bob)

      const [, effects] = receiveMessage(update, model, "bob", {
        type: "present",
        docs: [
          {
            docId: "private-doc",
            replicaType: ["test", 0, 0],
            mergeStrategy: "collaborative",
            schemaHash: "abc123",
          },
          {
            docId: "public-doc",
            replicaType: ["test", 0, 0],
            mergeStrategy: "collaborative",
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
  // authorize predicate
  // -----------------------------------------------------------------------
  describe("authorize predicate", () => {
    it("blocks offer import from unauthorized peer", () => {
      const update = makeUpdate({
        authorize: (_docId, peer) => peer.peerId !== "bob",
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
        authorize: (_docId, peer) => peer.peerId === "bob",
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
      expect(defined(imports[0]).docId).toBe("doc-1")
      expect(defined(imports[0]).fromPeerId).toBe("bob")
    })
  })
})
