// storage-first-sync — pure TEA tests for the storage-first sync machinery.
//
// These tests validate the pendingStorageChannels / pendingInterests
// coordination in the synchronizer-program. They are pure model tests
// with no I/O, no adapters, no substrates — only the TEA update function.

import { describe, expect, it } from "vitest"
import type { ConnectedChannel, EstablishedChannel } from "../channel.js"
import {
  type Command,
  createSynchronizerUpdate,
  init,
  type SynchronizerMessage,
  type SynchronizerModel,
} from "../synchronizer-program.js"
import type { PeerIdentityDetails } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const serverIdentity: PeerIdentityDetails = {
  peerId: "server",
  name: "Server",
  type: "service",
}

const storageIdentity: PeerIdentityDetails = {
  peerId: "storage-1",
  name: "storage",
  type: "service",
}

const storage2Identity: PeerIdentityDetails = {
  peerId: "storage-2",
  name: "storage-2",
  type: "service",
}

const networkPeerIdentity: PeerIdentityDetails = {
  peerId: "peer-a",
  name: "Peer A",
  type: "user",
}

const networkPeer2Identity: PeerIdentityDetails = {
  peerId: "peer-b",
  name: "Peer B",
  type: "user",
}

function makeUpdate(params?: Parameters<typeof createSynchronizerUpdate>[0]) {
  return createSynchronizerUpdate(params)
}

function makeConnectedChannel(
  channelId: number,
  kind: "network" | "storage" = "network",
): ConnectedChannel {
  return {
    type: "connected",
    channelId,
    kind,
    adapterType: "test",
    send: () => {},
    stop: () => {},
    onReceive: () => {},
  }
}

function makeEstablishedChannel(
  channelId: number,
  peerId: string,
  kind: "network" | "storage" = "network",
): EstablishedChannel {
  return {
    type: "established",
    channelId,
    peerId,
    kind,
    adapterType: "test",
    send: () => {},
    stop: () => {},
    onReceive: () => {},
  }
}

function flattenCommands(cmd: Command | undefined): Command[] {
  if (!cmd) return []
  if (cmd.type === "cmd/batch") {
    return cmd.commands.flatMap(flattenCommands)
  }
  return [cmd]
}

/**
 * Establish a channel in the model by running the full handshake:
 * channel-added → receive establish-request (from remote).
 */
function establishChannel(
  update: ReturnType<typeof createSynchronizerUpdate>,
  model: SynchronizerModel,
  channelId: number,
  remoteIdentity: PeerIdentityDetails,
  kind: "network" | "storage" = "network",
): SynchronizerModel {
  const channel = makeConnectedChannel(channelId, kind)

  // 1. Add channel
  let [m] = update({ type: "synchronizer/channel-added", channel }, model)

  // 2. Receive establish-request from remote
  ;[m] = update(
    {
      type: "synchronizer/channel-receive-message",
      envelope: {
        fromChannelId: channelId,
        message: { type: "establish-request", identity: remoteIdentity },
      },
    },
    m,
  )

  return m
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("storage-first sync", () => {
  // =========================================================================
  // Test 1: Queue + probe
  // =========================================================================

  it("queues network interest and sends discover to storage channels", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    // Set up: one storage channel, one network channel
    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network peer sends interest for unknown doc
    const [m2, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: {
            type: "interest",
            docId: "doc-1",
            version: "v1",
            reciprocate: true,
          },
        },
      },
      m,
    )

    // Should have created a placeholder doc entry
    const docEntry = m2.documents.get("doc-1")
    expect(docEntry).toBeDefined()
    expect(docEntry!.pendingStorageChannels).toBeDefined()
    expect(docEntry!.pendingStorageChannels!.has(100)).toBe(true)
    expect(docEntry!.pendingInterests).toHaveLength(1)
    expect(docEntry!.pendingInterests![0]!.channelId).toBe(200)
    expect(docEntry!.pendingInterests![0]!.version).toBe("v1")
    expect(docEntry!.pendingInterests![0]!.reciprocate).toBe(true)

    // Should have sent discover to storage channel
    const commands = flattenCommands(cmd)
    const discoverCmds = commands.filter(
      c =>
        c.type === "cmd/send-message" &&
        c.envelope.message.type === "discover",
    )
    expect(discoverCmds).toHaveLength(1)
    const discoverCmd = discoverCmds[0]!
    expect(discoverCmd.type).toBe("cmd/send-message")
    if (discoverCmd.type === "cmd/send-message") {
      expect(discoverCmd.envelope.toChannelIds).toEqual([100])
      expect(discoverCmd.envelope.message).toEqual({
        type: "discover",
        docIds: ["doc-1"],
      })
    }
  })

  // =========================================================================
  // Test 2: No storage channels → immediate drop
  // =========================================================================

  it("drops interest for unknown doc when no storage channels exist", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    // Only network channel, no storage
    let m = establishChannel(update, model, 200, networkPeerIdentity, "network")

    const [m2, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // No doc entry created
    expect(m2.documents.has("doc-1")).toBe(false)
    // No commands
    expect(cmd).toBeUndefined()
  })

  // =========================================================================
  // Test 3: Storage discover → creation
  // =========================================================================

  it("emits request-doc-creation when storage responds with discover", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Step 1: Network peer sends interest for unknown doc → probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Step 2: Storage responds with discover — it has the doc
    const [m2, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "discover", docIds: ["doc-1"] },
        },
      },
      m,
    )

    // Should emit request-doc-creation (placeholder treated as unknown)
    const commands = flattenCommands(cmd)
    const creationCmds = commands.filter(
      c => c.type === "cmd/request-doc-creation",
    )
    expect(creationCmds).toHaveLength(1)
    if (creationCmds[0]!.type === "cmd/request-doc-creation") {
      expect(creationCmds[0]!.docId).toBe("doc-1")
    }
  })

  // =========================================================================
  // Test 4: Offers + completion signal
  // =========================================================================

  it("releases queued interest only after completion interest from storage", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Step 1: Network interest → probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Step 2: Storage responds with discover
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "discover", docIds: ["doc-1"] },
        },
      },
      m,
    )

    // Step 3: Simulate doc-ensure (from onDocDiscovered → exchange.get())
    ;[m] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "0",
        mergeStrategy: "sequential",
      },
      m,
    )

    // Doc entry should still have pending state (preserved by doc-ensure)
    const docBefore = m.documents.get("doc-1")!
    expect(docBefore.pendingStorageChannels).toBeDefined()
    expect(docBefore.pendingStorageChannels!.size).toBe(1)
    expect(docBefore.pendingInterests).toHaveLength(1)
    // But version should be upgraded
    expect(docBefore.version).toBe("0")
    expect(docBefore.mergeStrategy).toBe("sequential")

    // Step 4: Storage sends completion interest → releases queued interests
    const [m3, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: {
            type: "interest",
            docId: "doc-1",
            version: "",
            reciprocate: false,
          },
        },
      },
      m,
    )

    // Pending state should be cleared
    const docAfter = m3.documents.get("doc-1")!
    expect(docAfter.pendingStorageChannels).toBeUndefined()
    expect(docAfter.pendingInterests).toBeUndefined()

    // Should have produced send-offer for the queued network interest
    const commands = flattenCommands(cmd)
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds).toHaveLength(1)
    if (offerCmds[0]!.type === "cmd/send-offer") {
      expect(offerCmds[0]!.docId).toBe("doc-1")
      expect(offerCmds[0]!.toChannelIds).toEqual([200])
    }
  })

  // =========================================================================
  // Test 5: Multiple storage adapters
  // =========================================================================

  it("waits for ALL storage channels before releasing queued interests", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 101, storage2Identity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest → probe (both storage channels should be in pending set)
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    const doc1 = m.documents.get("doc-1")!
    expect(doc1.pendingStorageChannels!.size).toBe(2)
    expect(doc1.pendingStorageChannels!.has(100)).toBe(true)
    expect(doc1.pendingStorageChannels!.has(101)).toBe(true)

    // Simulate doc-ensure
    ;[m] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "0",
        mergeStrategy: "sequential",
      },
      m,
    )

    // Storage 1 completion — still waiting for storage 2
    const [m2, cmd1] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "interest", docId: "doc-1", version: "" },
        },
      },
      m,
    )

    const doc2 = m2.documents.get("doc-1")!
    expect(doc2.pendingStorageChannels).toBeDefined()
    expect(doc2.pendingStorageChannels!.size).toBe(1)
    expect(doc2.pendingStorageChannels!.has(101)).toBe(true)
    // No commands yet — still waiting
    const cmds1 = flattenCommands(cmd1)
    const offerCmds1 = cmds1.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds1).toHaveLength(0)

    // Storage 2 completion — now all done, should release
    const [m3, cmd2] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 101,
          message: { type: "interest", docId: "doc-1", version: "" },
        },
      },
      m2,
    )

    const doc3 = m3.documents.get("doc-1")!
    expect(doc3.pendingStorageChannels).toBeUndefined()
    expect(doc3.pendingInterests).toBeUndefined()

    const cmds2 = flattenCommands(cmd2)
    const offerCmds2 = cmds2.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds2).toHaveLength(1)
  })

  // =========================================================================
  // Test 6: Storage has nothing
  // =========================================================================

  it("drops queued interest gracefully when storage has nothing", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest → probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Storage responds with empty discover (doesn't have the doc)
    // — no discover response from storage, just the completion interest
    // Storage sends completion interest — "I have nothing"
    const [m2, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "interest", docId: "doc-1", version: "" },
        },
      },
      m,
    )

    // Pending state cleared
    const doc = m2.documents.get("doc-1")!
    expect(doc.pendingStorageChannels).toBeUndefined()
    expect(doc.pendingInterests).toBeUndefined()

    // No send-offer because the doc was never created (version still "")
    const commands = flattenCommands(cmd)
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds).toHaveLength(0)
  })

  // =========================================================================
  // Test 7a: Storage channel removed (sole)
  // =========================================================================

  it("clears pending and processes queued interests when sole storage channel is removed", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest → probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Simulate doc-ensure (from storage discover → onDocDiscovered)
    ;[m] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "0",
        mergeStrategy: "sequential",
      },
      m,
    )

    // Remove storage channel before it responds
    const storageChannel = m.channels.get(100)!
    const [m2, cmd] = update(
      { type: "synchronizer/channel-removed", channel: storageChannel },
      m,
    )

    // Pending state should be cleared
    const doc = m2.documents.get("doc-1")!
    expect(doc.pendingStorageChannels).toBeUndefined()
    expect(doc.pendingInterests).toBeUndefined()

    // Should process queued interest (doc was ensured with version "0")
    const commands = flattenCommands(cmd)
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds).toHaveLength(1)
  })

  // =========================================================================
  // Test 7b: Storage channel removed (one of many)
  // =========================================================================

  it("keeps waiting for remaining storage channels when one is removed", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 101, storage2Identity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest → probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Remove one storage channel
    const storageChannel = m.channels.get(100)!
    const [m2, cmd] = update(
      { type: "synchronizer/channel-removed", channel: storageChannel },
      m,
    )

    // Still waiting for channel 101
    const doc = m2.documents.get("doc-1")!
    expect(doc.pendingStorageChannels).toBeDefined()
    expect(doc.pendingStorageChannels!.size).toBe(1)
    expect(doc.pendingStorageChannels!.has(101)).toBe(true)

    // No queued interests processed yet
    const commands = flattenCommands(cmd)
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds).toHaveLength(0)
  })

  // =========================================================================
  // Test 8: No premature relay
  // =========================================================================

  it("doc-imported during hydration does not push to peers with queued interests", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest → probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Doc-ensure (from storage discover → onDocDiscovered)
    ;[m] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "0",
        mergeStrategy: "sequential",
      },
      m,
    )

    // Simulate a doc-imported (from storage offer being processed)
    // The queued network peer should NOT receive an offer via relay
    const [m2, cmd] = update(
      {
        type: "synchronizer/doc-imported",
        docId: "doc-1",
        version: "1",
        fromPeerId: "storage-1",
      },
      m,
    )

    // buildPush only targets synced peers. The queued network peer (channel 200)
    // has no docSyncState entry — it's waiting in pendingInterests. So relay
    // must produce zero offers that include channel 200.
    const commands = flattenCommands(cmd)
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")

    // No offer should target the queued network peer at all
    const targetsQueuedPeer = offerCmds.some(
      c => c.type === "cmd/send-offer" && c.toChannelIds.includes(200),
    )
    expect(targetsQueuedPeer).toBe(false)

    // Stronger: the only other established channel is storage (100),
    // so relay should target nobody (storage is excluded as the sender)
    expect(offerCmds).toHaveLength(0)
  })

  // =========================================================================
  // Test 9: Multiple queued network interests
  // =========================================================================

  it("queues all network interests and processes all on completion", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")
    m = establishChannel(update, m, 201, networkPeer2Identity, "network")

    // First network peer sends interest → triggers probe
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // Second network peer sends interest → piggybacks, no new discover
    const [m2, cmd2] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 201,
          message: { type: "interest", docId: "doc-1", version: "v2" },
        },
      },
      m,
    )

    // Should have 2 queued interests
    const doc = m2.documents.get("doc-1")!
    expect(doc.pendingInterests).toHaveLength(2)
    expect(doc.pendingInterests![0]!.channelId).toBe(200)
    expect(doc.pendingInterests![1]!.channelId).toBe(201)

    // Second interest should NOT send another discover
    expect(cmd2).toBeUndefined()

    // Doc-ensure
    let m3 = m2
    ;[m3] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "0",
        mergeStrategy: "sequential",
      },
      m3,
    )

    // Storage completion
    const [m4, cmd4] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "interest", docId: "doc-1", version: "" },
        },
      },
      m3,
    )

    // Should produce offers for both queued peers
    const commands = flattenCommands(cmd4)
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds).toHaveLength(2)

    const targetChannels = offerCmds.map(c =>
      c.type === "cmd/send-offer" ? c.toChannelIds[0] : undefined,
    )
    expect(targetChannels).toContain(200)
    expect(targetChannels).toContain(201)
  })

  // =========================================================================
  // Test 10: Storage-originated interest
  // =========================================================================

  it("does not enter pending state for storage-originated interest", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Storage channel sends interest for unknown doc
    const [m2, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    // No doc entry created (storage doesn't wait for itself)
    expect(m2.documents.has("doc-1")).toBe(false)
    expect(cmd).toBeUndefined()
  })

  // =========================================================================
  // Test 11: Causal reciprocate semantics
  // =========================================================================

  it("queued interest with reciprocate=true produces offer + reciprocal interest after hydration", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest with reciprocate for causal doc
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: {
            type: "interest",
            docId: "doc-1",
            version: "v1",
            reciprocate: true,
          },
        },
      },
      m,
    )

    // Doc-ensure as causal
    ;[m] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "0",
        mergeStrategy: "causal",
      },
      m,
    )

    // Storage completion
    const [m2, cmd] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 100,
          message: { type: "interest", docId: "doc-1", version: "" },
        },
      },
      m,
    )

    const commands = flattenCommands(cmd)

    // Should have a send-offer
    const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
    expect(offerCmds).toHaveLength(1)
    if (offerCmds[0]!.type === "cmd/send-offer") {
      expect(offerCmds[0]!.docId).toBe("doc-1")
      expect(offerCmds[0]!.toChannelIds).toEqual([200])
    }

    // Should have a reciprocal interest (causal bidirectional)
    const interestCmds = commands.filter(
      c =>
        c.type === "cmd/send-message" &&
        c.envelope.message.type === "interest",
    )
    expect(interestCmds).toHaveLength(1)
    if (interestCmds[0]!.type === "cmd/send-message") {
      const msg = interestCmds[0]!.envelope.message
      expect(msg.type).toBe("interest")
      if (msg.type === "interest") {
        expect(msg.docId).toBe("doc-1")
        expect(msg.reciprocate).toBe(false) // prevent infinite loop
      }
    }
  })

  // =========================================================================
  // Additional: doc-ensure preserves pending state
  // =========================================================================

  it("doc-ensure upgrades placeholder while preserving pending state", () => {
    const update = makeUpdate()
    const [model] = init(serverIdentity)

    let m = establishChannel(update, model, 100, storageIdentity, "storage")
    m = establishChannel(update, m, 200, networkPeerIdentity, "network")

    // Network interest → creates placeholder
    ;[m] = update(
      {
        type: "synchronizer/channel-receive-message",
        envelope: {
          fromChannelId: 200,
          message: { type: "interest", docId: "doc-1", version: "v1" },
        },
      },
      m,
    )

    const placeholder = m.documents.get("doc-1")!
    expect(placeholder.version).toBe("")
    expect(placeholder.pendingStorageChannels!.size).toBe(1)

    // Doc-ensure should upgrade, not bail
    const [m2] = update(
      {
        type: "synchronizer/doc-ensure",
        docId: "doc-1",
        mode: "interpret",
        version: "42",
        mergeStrategy: "sequential",
      },
      m,
    )

    const upgraded = m2.documents.get("doc-1")!
    expect(upgraded.version).toBe("42")
    expect(upgraded.mode).toBe("interpret")
    expect(upgraded.mergeStrategy).toBe("sequential")
    // Pending state preserved
    expect(upgraded.pendingStorageChannels!.size).toBe(1)
    expect(upgraded.pendingInterests).toHaveLength(1)
  })
})