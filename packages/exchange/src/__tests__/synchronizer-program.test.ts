// synchronizer-program — unit tests for the pure TEA update function.

import type {
  ConnectedChannel,
  EstablishedChannel,
  PeerIdentityDetails,
} from "@kyneta/transport"
import { describe, expect, it } from "vitest"
import {
  type Command,
  createSynchronizerUpdate,
  init,
  type Notification,
  type SynchronizerMessage,
  type SynchronizerModel,
} from "../synchronizer-program.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const aliceIdentity: PeerIdentityDetails = {
  peerId: "alice",
  name: "Alice",
  type: "user",
}

const bobIdentity: PeerIdentityDetails = {
  peerId: "bob",
  name: "Bob",
  type: "user",
}

const carolIdentity: PeerIdentityDetails = {
  peerId: "carol",
  name: "Carol",
  type: "user",
}

function makeUpdate() {
  return createSynchronizerUpdate()
}

function makeConnectedChannel(channelId: number): ConnectedChannel {
  return {
    type: "connected",
    channelId,
    transportType: "test",
    send: () => {},
    stop: () => {},
    onReceive: () => {},
  }
}

function _makeEstablishedChannel(
  channelId: number,
  peerId: string,
): EstablishedChannel {
  return {
    type: "established",
    channelId,
    peerId,
    transportType: "test",
    send: () => {},
    stop: () => {},
    onReceive: () => {},
  }
}

/**
 * Apply a sequence of messages to a model and return the final model + last command.
 */
function _applyMessages(
  update: ReturnType<typeof createSynchronizerUpdate>,
  model: SynchronizerModel,
  messages: SynchronizerMessage[],
): [SynchronizerModel, Command | undefined] {
  let current = model
  let lastCmd: Command | undefined
  for (const msg of messages) {
    const [next, cmd] = update(msg, current)
    current = next
    lastCmd = cmd
  }
  return [current, lastCmd]
}

/**
 * Flatten a batch command into an array of leaf commands.
 */
function flattenCommands(cmd: Command | undefined): Command[] {
  if (!cmd) return []
  if (cmd.type === "cmd/batch") {
    return cmd.commands.flatMap(flattenCommands)
  }
  return [cmd]
}

/**
 * Find a notification of a specific type within a potentially batched notification.
 * Returns undefined if not found.
 */
function findNotification<T extends Notification["type"]>(
  notification: Notification,
  type: T,
): Extract<Notification, { type: T }> | undefined {
  if (notification.type === type)
    return notification as Extract<Notification, { type: T }>
  if (notification.type === "notify/batch") {
    for (const sub of notification.notifications) {
      const found = findNotification(sub, type)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Collect all docIds from a Notification (recursively flattening batches).
 * Returns an empty set if the notification is undefined.
 */
function collectNotifiedDocIds(
  notification: Notification | undefined,
): Set<string> {
  if (!notification) return new Set()
  switch (notification.type) {
    case "notify/ready-state-changed":
      return new Set(notification.docIds)
    case "notify/state-advanced":
      return new Set(notification.docIds)
    case "notify/warning":
    case "notify/peer-joined":
    case "notify/peer-left":
      return new Set()
    case "notify/batch": {
      const result = new Set<string>()
      for (const sub of notification.notifications) {
        for (const id of collectNotifiedDocIds(sub)) {
          result.add(id)
        }
      }
      return result
    }
  }
}

/**
 * Establish a channel in the model by running the full handshake:
 * channel-added → establish-channel → receive establish-request → receive establish-response
 */
function establishChannel(
  update: ReturnType<typeof createSynchronizerUpdate>,
  model: SynchronizerModel,
  channelId: number,
  remoteIdentity: PeerIdentityDetails,
): SynchronizerModel {
  const channel = makeConnectedChannel(channelId)

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

describe("synchronizer-program", () => {
  describe("init", () => {
    it("produces empty model with identity", () => {
      const [model, cmd] = init(aliceIdentity)
      expect(model.identity).toBe(aliceIdentity)
      expect(model.documents.size).toBe(0)
      expect(model.channels.size).toBe(0)
      expect(model.peers.size).toBe(0)
      expect(cmd).toBeUndefined()
    })
  })

  describe("channel lifecycle", () => {
    it("channel-added registers the channel", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const channel = makeConnectedChannel(1)

      const [m] = update({ type: "synchronizer/channel-added", channel }, model)
      expect(m.channels.size).toBe(1)
      expect(m.channels.get(1)).toBeDefined()
      expect(m.channels.get(1)?.type).toBe("connected")
    })

    it("establish-channel produces establish-request command", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const channel = makeConnectedChannel(1)

      const [m1] = update(
        { type: "synchronizer/channel-added", channel },
        model,
      )
      const [_m2, cmd] = update(
        { type: "synchronizer/establish-channel", channelId: 1 },
        m1,
      )

      expect(cmd).toBeDefined()
      expect(cmd?.type).toBe("cmd/send-message")
      const sendCmd = cmd as Extract<Command, { type: "cmd/send-message" }>
      expect(sendCmd.envelope.message.type).toBe("establish-request")
    })

    it("channel-removed cleans up channel and peer state", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish a channel with bob
      const m = establishChannel(update, model, 1, bobIdentity)
      expect(m.channels.get(1)?.type).toBe("established")
      expect(m.peers.has("bob")).toBe(true)

      // Remove the channel
      const channel = m.channels.get(1)
      if (!channel) throw new Error("Expected channel 1 to exist")
      const [m2] = update({ type: "synchronizer/channel-removed", channel }, m)
      expect(m2.channels.has(1)).toBe(false)
      // Peer should be removed since it has no remaining channels
      expect(m2.peers.has("bob")).toBe(false)
    })
  })

  describe("establish handshake", () => {
    it("establish-request upgrades channel to established and tracks peer", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const channel = makeConnectedChannel(1)

      const [m1] = update(
        { type: "synchronizer/channel-added", channel },
        model,
      )

      const [m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m1,
      )

      // Channel should be established
      expect(m2.channels.get(1)?.type).toBe("established")
      const established = m2.channels.get(1) as EstablishedChannel
      expect(established.peerId).toBe("bob")

      // Peer should be tracked
      expect(m2.peers.has("bob")).toBe(true)
      expect(m2.peers.get("bob")?.channels.has(1)).toBe(true)

      // Should send establish-response
      const commands = flattenCommands(cmd)
      const responseCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "establish-response",
      )
      expect(responseCmd).toBeDefined()
    })

    it("establish-response upgrades channel to established", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const channel = makeConnectedChannel(1)

      const [m1] = update(
        { type: "synchronizer/channel-added", channel },
        model,
      )

      const [m2] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "establish-response", identity: bobIdentity },
          },
        },
        m1,
      )

      expect(m2.channels.get(1)?.type).toBe("established")
      expect(m2.peers.has("bob")).toBe(true)
    })
  })

  // =========================================================================
  // Peer identity detection
  // =========================================================================

  describe("peer identity detection", () => {
    it("duplicate peerId emits warning notification on second channel establishment", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish channel 1 with bob
      let m = establishChannel(update, model, 1, bobIdentity)

      // Establish channel 2 (different channelId) with the same bob identity
      const channel2 = makeConnectedChannel(2)
      ;[m] = update(
        { type: "synchronizer/channel-added", channel: channel2 },
        m,
      )

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 2,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m,
      )

      expect(notification).toBeDefined()
      expect(notification?.type).toBe("notify/warning")
      if (notification?.type === "notify/warning") {
        expect(notification?.message).toContain("duplicate peerId")
        expect(notification?.message).toContain("bob")
      }
    })

    it("self-connection emits warning notification", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Connect a channel where remote peer claims to be alice (our own identity)
      const channel = makeConnectedChannel(1)
      const [m] = update({ type: "synchronizer/channel-added", channel }, model)

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "establish-request", identity: aliceIdentity },
          },
        },
        m,
      )

      expect(notification).toBeDefined()
      // The warning is batched with a peer-joined notification
      expect(notification?.type).toBe("notify/batch")
      if (notification?.type === "notify/batch") {
        const warning = notification.notifications.find(
          n => n.type === "notify/warning",
        )
        expect(warning).toBeDefined()
        if (warning?.type === "notify/warning") {
          expect(warning.message).toContain("self-connection")
          expect(warning.message).toContain("alice")
        }
        const peerJoined = notification.notifications.find(
          n => n.type === "notify/peer-joined",
        )
        expect(peerJoined).toBeDefined()
      }
    })

    it("reconnection after channel removal does not emit warning", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish channel 1 with bob
      let m = establishChannel(update, model, 1, bobIdentity)

      // Remove channel 1
      const removedChannel = m.channels.get(1)
      if (!removedChannel) throw new Error("Expected channel 1 to exist")
      ;[m] = update(
        { type: "synchronizer/channel-removed", channel: removedChannel },
        m,
      )

      // Establish channel 2 with bob — old channel is gone, no duplicate
      const channel2 = makeConnectedChannel(2)
      ;[m] = update(
        { type: "synchronizer/channel-added", channel: channel2 },
        m,
      )

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 2,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m,
      )

      // No warning — the old channel was cleaned up before the new one arrived.
      // But we do get a peer-joined notification since this is a new connection.
      expect(notification).toBeDefined()
      expect(notification?.type).toBe("notify/peer-joined")
    })

    it("replicaType mismatch emits warning notification (not console.warn)", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Remote peer announces same doc but with incompatible replicaType
      const [_m2, cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["loro", 1, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      // No commands — mismatch means skip
      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(0)

      // Warning notification emitted (not a direct console.warn)
      expect(notification).toBeDefined()
      expect(notification?.type).toBe("notify/warning")
      if (notification?.type === "notify/warning") {
        expect(notification?.message).toContain("replica type mismatch")
        expect(notification?.message).toContain("doc-1")
      }
    })
  })

  describe("doc-ensure", () => {
    it("registers document and sends present + interest to established channels", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Set up an established channel first
      const m = establishChannel(update, model, 1, bobIdentity)

      // Ensure a doc
      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      expect(m2.documents.has("doc-1")).toBe(true)
      expect(m2.documents.get("doc-1")?.version).toBe("v1")
      expect(m2.documents.get("doc-1")?.replicaType).toEqual(["plain", 1, 0])

      const commands = flattenCommands(cmd)

      // Should send present to the established channel
      const presentCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "present",
      )
      expect(presentCmd).toBeDefined()

      // Should also send interest — essential for pulling data into
      // empty docs created via onUnresolvedDoc
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
      if (
        interestCmd &&
        interestCmd.type === "cmd/send-message" &&
        interestCmd.envelope.message.type === "interest"
      ) {
        expect(interestCmd.envelope.message.docId).toBe("doc-1")
        expect(interestCmd.envelope.message.version).toBe("v1")
        // Sequential does not reciprocate
        expect(interestCmd.envelope.message.reciprocate).toBe(false)
      }
    })

    it("doc-ensure is idempotent for same docId", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const [m1] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        model,
      )

      const [m2] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v2",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m1,
      )

      // Version should NOT change — idempotent
      expect(m2.documents.get("doc-1")?.version).toBe("v1")
    })
  })

  describe("present → interest flow", () => {
    it("receiving present for a known doc sends interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish channel, ensure doc
      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Receive present from bob saying they have doc-1
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
      const interestMsg = (
        interestCmd as Extract<Command, { type: "cmd/send-message" }>
      ).envelope.message
      expect(interestMsg.type).toBe("interest")
      if (interestMsg.type === "interest") {
        expect(interestMsg.docId).toBe("doc-1")
        expect(interestMsg.version).toBe("v1")
      }
    })

    it("receiving present for an unknown doc emits request-doc-creation", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const m = establishChannel(update, model, 1, bobIdentity)

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "unknown-doc",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(1)
      expect(commands[0].type).toBe("cmd/request-doc-creation")
      if (commands[0].type === "cmd/request-doc-creation") {
        expect(commands[0].docId).toBe("unknown-doc")
        expect(commands[0].peer.peerId).toBe("bob")
      }
    })

    it("receiving present with mixed known/unknown docs emits both interest and request-doc-creation", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "known-doc",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "known-doc",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
                {
                  docId: "unknown-doc",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(2)

      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()

      const creationCmd = commands.find(
        c => c.type === "cmd/request-doc-creation",
      )
      expect(creationCmd).toBeDefined()
      if (creationCmd && creationCmd.type === "cmd/request-doc-creation") {
        expect(creationCmd.docId).toBe("unknown-doc")
        expect(creationCmd.peer.peerId).toBe("bob")
      }
    })

    it("receiving present with all known docs produces no creation commands", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const creationCmds = commands.filter(
        c => c.type === "cmd/request-doc-creation",
      )
      expect(creationCmds).toHaveLength(0)
      // Should still have the interest command
      expect(commands.length).toBeGreaterThanOrEqual(1)
    })

    it("receiving present with incompatible replicaType for known doc skips sync (no interest)", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Local doc uses plain
      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Remote peer announces same doc but with Loro replicaType — mismatch
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["loro", 1, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      // Should produce NO commands — mismatch means skip
      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(0)
    })

    it("receiving present with major version mismatch skips sync", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["yjs", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      // Same name but different major version
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["yjs", 2, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(0)
    })

    it("receiving present with minor version mismatch is compatible — sends interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["yjs", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      // Same name, same major, different minor — compatible
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["yjs", 1, 3] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
    })

    it("receiving present with schema hash mismatch for known doc skips sync (no interest)", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00aaaa",
        },
        m,
      )

      // Remote peer announces same doc, same replicaType, but different schemaHash
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00bbbb",
                },
              ],
            },
          },
        },
        m,
      )

      // Should produce NO commands — schema hash mismatch means skip
      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(0)
    })

    it("request-doc-creation carries replicaType and mergeStrategy from present", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const m = establishChannel(update, model, 1, bobIdentity)

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "new-doc",
                  replicaType: ["loro", 1, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(1)
      const creation = commands.at(0)
      if (!creation) throw new Error("Expected at least one command")
      expect(creation.type).toBe("cmd/request-doc-creation")
      if (creation.type === "cmd/request-doc-creation") {
        expect(creation.docId).toBe("new-doc")
        expect(creation.replicaType).toEqual(["loro", 1, 0])
        expect(creation.mergeStrategy).toBe("causal")
      }
    })
  })

  describe("interest → offer (merge strategy dispatch)", () => {
    it("causal: interest produces send-offer + reciprocal interest when reciprocate=true", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "interest",
              docId: "doc-1",
              version: "v0",
              reciprocate: true,
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)

      // Should have a send-offer command
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        expect(offerCmd.sinceVersion).toBe("v0")
      }

      // Should have a reciprocal interest (since causal + reciprocate=true)
      const reciprocalInterest = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(reciprocalInterest).toBeDefined()
      if (
        reciprocalInterest &&
        reciprocalInterest.type === "cmd/send-message" &&
        reciprocalInterest.envelope.message.type === "interest"
      ) {
        expect(reciprocalInterest.envelope.message.reciprocate).toBe(false)
      }
    })

    it("sequential: interest produces send-offer with sinceVersion", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "interest",
              docId: "doc-1",
              version: "v0",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        expect(offerCmd.sinceVersion).toBe("v0")
      }

      // Sequential should NOT produce a reciprocal interest
      const reciprocal = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(reciprocal).toBeUndefined()
    })

    it("lww: interest produces send-offer WITHOUT sinceVersion (snapshot)", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "1000",
          mergeStrategy: "lww",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "interest",
              docId: "doc-1",
              // LWW initial — no version
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        expect(offerCmd.sinceVersion).toBeUndefined() // always snapshot
      }
    })
  })

  describe("offer handling", () => {
    it("receiving an offer produces cmd/import-doc-data", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "doc-1",
              payload: {
                kind: "entirety",
                encoding: "json",
                data: '{"title":"Hello"}',
              },
              version: "v1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const importCmd = commands.find(c => c.type === "cmd/import-doc-data")
      expect(importCmd).toBeDefined()
      if (importCmd && importCmd.type === "cmd/import-doc-data") {
        expect(importCmd.docId).toBe("doc-1")
        expect(importCmd.version).toBe("v1")
        expect(importCmd.fromPeerId).toBe("bob")
      }
    })

    it("offer for unknown doc is ignored", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const m = establishChannel(update, model, 1, bobIdentity)

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "unknown-doc",
              payload: { kind: "entirety", encoding: "json", data: "{}" },
              version: "v1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(
        commands.find(c => c.type === "cmd/import-doc-data"),
      ).toBeUndefined()
    })

    it("offer with reciprocate=true triggers interest back", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "doc-1",
              payload: {
                kind: "since",
                encoding: "binary",
                data: new Uint8Array([1, 2, 3]),
              },
              version: "v1",
              reciprocate: true,
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)

      // Should import
      expect(commands.find(c => c.type === "cmd/import-doc-data")).toBeDefined()

      // Should send interest back
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
      if (
        interestCmd &&
        interestCmd.type === "cmd/send-message" &&
        interestCmd.envelope.message.type === "interest"
      ) {
        expect(interestCmd.envelope.message.reciprocate).toBe(false)
      }
    })
  })

  describe("local-doc-change (merge strategy dispatch)", () => {
    it("causal: pushes delta offer to synced peers", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      // Simulate bob becoming synced by importing from bob
      ;[m] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v1",
          fromPeerId: "bob",
        },
        m,
      )

      // Now a local change happens
      const [_m2, cmd] = update(
        {
          type: "synchronizer/local-doc-change",
          docId: "doc-1",
          version: "v2",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        // sinceVersion should be the previous version
        expect(offerCmd.sinceVersion).toBe("v1")
      }
    })

    it("lww: broadcasts snapshot to ALL established peers", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "presence",
          version: "1000",
          mergeStrategy: "lww",
          schemaHash: "00test",
        },
        m,
      )

      // Local change — no need for bob to be synced, LWW broadcasts to all
      const [_m2, cmd] = update(
        {
          type: "synchronizer/local-doc-change",
          docId: "presence",
          version: "2000",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("presence")
        expect(offerCmd.sinceVersion).toBeUndefined() // always snapshot
        expect(offerCmd.toChannelIds).toContain(1)
      }
    })

    it("sequential with no synced peers produces no command", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Local change but bob hasn't synced
      const [_m2, cmd] = update(
        {
          type: "synchronizer/local-doc-change",
          docId: "doc-1",
          version: "v1",
        },
        m,
      )

      // No synced peers → no offer
      expect(cmd).toBeUndefined()
    })
  })

  describe("doc-imported", () => {
    it("updates version and peer sync state", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [m2] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v1",
          fromPeerId: "bob",
        },
        m,
      )

      expect(m2.documents.get("doc-1")?.version).toBe("v1")
      const bobState = m2.peers.get("bob")
      if (!bobState) throw new Error("Expected bob peer state to exist")
      const docSync = bobState.docSyncStates.get("doc-1")
      if (!docSync) throw new Error("Expected doc-1 sync state to exist")
      expect(docSync.status).toBe("synced")
      if (docSync.status === "synced") {
        expect(docSync.lastKnownVersion).toBe("v1")
      }
    })

    it("causal: relays to other synced peers, excluding sender", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish two peers: Bob (channel 1) and Carol (channel 2)
      let m = establishChannel(update, model, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      // Register doc as causal
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      // Mark both peers as synced for this doc
      ;[m] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v1",
          fromPeerId: "bob",
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v2",
          fromPeerId: "carol",
        },
        m,
      )

      // Now the actual test: import from Bob at v3
      const [_m2, cmd] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v3",
          fromPeerId: "bob",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        // Should target Carol's channel, NOT Bob's
        expect(offerCmd.toChannelIds).toContain(2)
        expect(offerCmd.toChannelIds).not.toContain(1)
        // sinceVersion must be the pre-import version (v2), not the new version (v3)
        expect(offerCmd.sinceVersion).toBe("v2")
      }
    })

    it("lww: relays to all established peers, excluding sender", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish two peers: Bob (channel 1) and Carol (channel 2)
      let m = establishChannel(update, model, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      // Register doc as lww
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "1000",
          mergeStrategy: "lww",
          schemaHash: "00test",
        },
        m,
      )

      // Import from Bob — LWW broadcasts to ALL established, minus sender
      const [_m2, cmd] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "2000",
          fromPeerId: "bob",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmd = commands.find(c => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        // Should target Carol's channel, NOT Bob's
        expect(offerCmd.toChannelIds).toContain(2)
        expect(offerCmd.toChannelIds).not.toContain(1)
        expect(offerCmd.sinceVersion).toBeUndefined()
      }
    })

    it("no other synced peers returns no command", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Only Bob established — no other peers
      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      // Mark Bob as synced
      ;[m] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v1",
          fromPeerId: "bob",
        },
        m,
      )

      // Import from Bob again — he's the only peer, so no relay target
      const [_m2, cmd] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v2",
          fromPeerId: "bob",
        },
        m,
      )

      expect(cmd).toBeUndefined()
    })
  })

  describe("doc-delete", () => {
    it("removes document from model", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let [m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        model,
      )
      expect(m.documents.has("doc-1")).toBe(true)

      ;[m] = update({ type: "synchronizer/doc-delete", docId: "doc-1" }, m)
      expect(m.documents.has("doc-1")).toBe(false)
    })
  })

  describe("present sends interest with reciprocate based on merge strategy", () => {
    it("causal doc: present triggers interest with reciprocate=true", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
      if (
        interestCmd &&
        interestCmd.type === "cmd/send-message" &&
        interestCmd.envelope.message.type === "interest"
      ) {
        expect(interestCmd.envelope.message.reciprocate).toBe(true)
      }
    })

    it("sequential doc: present triggers interest with reciprocate=false", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
      if (
        interestCmd &&
        interestCmd.type === "cmd/send-message" &&
        interestCmd.envelope.message.type === "interest"
      ) {
        expect(interestCmd.envelope.message.reciprocate).toBe(false)
      }
    })
  })

  // =========================================================================
  // Route predicate
  // =========================================================================

  describe("route predicate", () => {
    it("handleEstablishRequest filters present by route", () => {
      // Route denies "secret-doc" for bob
      const update = createSynchronizerUpdate({
        route: docId => docId !== "secret-doc",
      })
      const [model] = init(aliceIdentity)

      // Add two docs
      let m = model
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "public-doc",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "secret-doc",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Add a connected channel
      const channel = makeConnectedChannel(1)
      ;[m] = update({ type: "synchronizer/channel-added", channel }, m)

      // Receive establish-request from bob
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const presentCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "present",
      )
      expect(presentCmd).toBeDefined()
      if (
        presentCmd &&
        presentCmd.type === "cmd/send-message" &&
        presentCmd.envelope.message.type === "present"
      ) {
        expect(
          presentCmd.envelope.message.docs.map((d: any) => d.docId),
        ).toContain("public-doc")
        expect(
          presentCmd.envelope.message.docs.map((d: any) => d.docId),
        ).not.toContain("secret-doc")
      }
    })

    it("handleEstablishResponse filters present by route", () => {
      const update = createSynchronizerUpdate({
        route: docId => docId !== "secret-doc",
      })
      const [model] = init(aliceIdentity)

      let m = model
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "public-doc",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "secret-doc",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const channel = makeConnectedChannel(1)
      ;[m] = update({ type: "synchronizer/channel-added", channel }, m)

      // Receive establish-response (the other side initiated)
      const [, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "establish-response", identity: bobIdentity },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const presentCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "present",
      )
      expect(presentCmd).toBeDefined()
      if (
        presentCmd &&
        presentCmd.type === "cmd/send-message" &&
        presentCmd.envelope.message.type === "present"
      ) {
        expect(
          presentCmd.envelope.message.docs.map((d: any) => d.docId),
        ).toContain("public-doc")
        expect(
          presentCmd.envelope.message.docs.map((d: any) => d.docId),
        ).not.toContain("secret-doc")
      }
    })

    it("handleDocEnsure filters channels by route", () => {
      // Route allows "doc-1" for bob but not carol
      const update = createSynchronizerUpdate({
        route: (_docId, peer) => peer.peerId !== "carol",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      const [_m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      // All outbound messages should target channel 1 (bob), not channel 2 (carol)
      const sendMsgs = commands.filter(c => c.type === "cmd/send-message")
      for (const c of sendMsgs) {
        if (c.type === "cmd/send-message") {
          expect(c.envelope.toChannelIds).toContain(1)
          expect(c.envelope.toChannelIds).not.toContain(2)
        }
      }
    })

    it("buildPush respects route for LWW relay", () => {
      // Route denies carol
      const update = createSynchronizerUpdate({
        route: (_docId, peer) => peer.peerId !== "carol",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      // Register an LWW doc
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "presence",
          version: "0",
          mergeStrategy: "lww",
          schemaHash: "00test",
        },
        m,
      )

      // Import from bob → relay should skip carol
      const [, cmd] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "presence",
          version: "1",
          fromPeerId: "bob",
        },
        m,
      )

      // Should produce no relay since carol is denied and bob is excluded as sender
      const commands = flattenCommands(cmd)
      const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
      // No offer should target carol's channel
      for (const c of offerCmds) {
        if (c.type === "cmd/send-offer") {
          expect(c.toChannelIds).not.toContain(2)
        }
      }
    })

    it("buildPush respects route for local change", () => {
      const update = createSynchronizerUpdate({
        route: (_docId, peer) => peer.peerId !== "carol",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "lww",
          schemaHash: "00test",
        },
        m,
      )

      const [, cmd] = update(
        {
          type: "synchronizer/local-doc-change",
          docId: "doc-1",
          version: "1",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmds = commands.filter(c => c.type === "cmd/send-offer")
      expect(offerCmds.length).toBe(1)
      if (offerCmds[0] && offerCmds[0].type === "cmd/send-offer") {
        expect(offerCmds[0].toChannelIds).toContain(1) // bob allowed
        expect(offerCmds[0].toChannelIds).not.toContain(2) // carol denied
      }
    })

    it("handleDiscover checks route before request-doc-creation", () => {
      // Route denies "forbidden" doc from bob
      const update = createSynchronizerUpdate({
        route: docId => docId !== "forbidden",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      const [, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "forbidden",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "00test",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const creationCmds = commands.filter(
        c => c.type === "cmd/request-doc-creation",
      )
      expect(creationCmds).toHaveLength(0)
    })

    it("default route/authorize preserves existing behavior", () => {
      // Default update (no route/authorize) should work identically to before
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      // Use LWW — broadcasts to all established peers (no sync state required)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "lww",
          schemaHash: "00test",
        },
        m,
      )

      // Local change should broadcast to bob
      const [, cmd] = update(
        { type: "synchronizer/local-doc-change", docId: "doc-1", version: "1" },
        m,
      )
      expect(cmd).toBeDefined()
    })

    // Note: "storage channels bypass route filtering" test removed —
    // storage is no longer a channel in the sync protocol.
  })

  // =========================================================================
  // Authorize predicate
  // =========================================================================

  describe("authorize predicate", () => {
    it("handleOffer rejects import but still processes reciprocation", () => {
      const update = createSynchronizerUpdate({
        authorize: () => false,
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "doc-1",
              payload: {
                kind: "entirety" as const,
                encoding: "json" as const,
                data: "{}",
              },
              version: "1",
              reciprocate: true,
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      // Import should be blocked
      const importCmds = commands.filter(c => c.type === "cmd/import-doc-data")
      expect(importCmds).toHaveLength(0)

      // But reciprocation (interest back) should still happen
      const interestCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmds).toHaveLength(1)
    })

    it("handleOffer allows import when authorize returns true", () => {
      const update = createSynchronizerUpdate({
        authorize: () => true,
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "doc-1",
              payload: {
                kind: "entirety" as const,
                encoding: "json" as const,
                data: "{}",
              },
              version: "1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const importCmds = commands.filter(c => c.type === "cmd/import-doc-data")
      expect(importCmds).toHaveLength(1)
    })
  })

  // =========================================================================
  // Dismiss
  // =========================================================================

  describe("dismiss", () => {
    it("handleDismiss emits notify-doc-dismissed", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "dismiss", docId: "doc-1" },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const dismissCmd = commands.find(
        c => c.type === "cmd/notify-doc-dismissed",
      )
      expect(dismissCmd).toBeDefined()
      if (dismissCmd && dismissCmd.type === "cmd/notify-doc-dismissed") {
        expect(dismissCmd.docId).toBe("doc-1")
        expect(dismissCmd.peer.peerId).toBe("bob")
      }
    })

    it("handleDismiss cleans up peer sync state", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      // Ensure doc and simulate bob having synced it
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Simulate bob having imported (so peer state is tracked)
      ;[m] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "1",
          fromPeerId: "bob",
        },
        m,
      )

      // Verify bob has doc sync state
      expect(m.peers.get("bob")?.docSyncStates.has("doc-1")).toBe(true)

      // Bob dismisses
      const [m2] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "dismiss", docId: "doc-1" },
          },
        },
        m,
      )

      // Bob's sync state for doc-1 should be cleaned up
      expect(m2.peers.get("bob")?.docSyncStates.has("doc-1")).toBe(false)
    })

    it("handleDocDismiss broadcasts dismiss to routed peers and removes doc", () => {
      // Route allows bob but not carol
      const update = createSynchronizerUpdate({
        route: (_docId, peer) => peer.peerId !== "carol",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [m2, cmd] = update(
        { type: "synchronizer/doc-dismiss", docId: "doc-1" },
        m,
      )

      // Doc should be removed from model
      expect(m2.documents.has("doc-1")).toBe(false)

      // Dismiss should only be sent to bob (channel 1), not carol (channel 2)
      const commands = flattenCommands(cmd)
      const sendCmds = commands.filter(c => c.type === "cmd/send-message")
      expect(sendCmds.length).toBe(1)
      if (sendCmds[0] && sendCmds[0].type === "cmd/send-message") {
        expect(sendCmds[0].envelope.toChannelIds).toContain(1)
        expect(sendCmds[0].envelope.toChannelIds).not.toContain(2)
        expect(sendCmds[0].envelope.message.type).toBe("dismiss")
      }
    })
  })

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // Replicate mode — doc-ensure, offer handling, version tracking
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  describe("replicate mode", () => {
    it("doc-ensure with mode 'replicate' sends present + interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const m = establishChannel(update, model, 1, bobIdentity)

      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "replicate",
          docId: "replicated-doc",
          version: "0",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      expect(m2.documents.has("replicated-doc")).toBe(true)
      expect(m2.documents.get("replicated-doc")?.mode).toBe("replicate")
      expect(m2.documents.get("replicated-doc")?.version).toBe("0")

      const commands = flattenCommands(cmd)

      // Should send present
      const presentCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "present",
      )
      expect(presentCmd).toBeDefined()

      // Should send interest with reciprocate (causal)
      const interestCmd = commands.find(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()
      if (
        interestCmd &&
        interestCmd.type === "cmd/send-message" &&
        interestCmd.envelope.message.type === "interest"
      ) {
        expect(interestCmd.envelope.message.docId).toBe("replicated-doc")
        expect(interestCmd.envelope.message.version).toBe("0")
        expect(interestCmd.envelope.message.reciprocate).toBe(true)
      }
    })

    it("doc-imported for replicated doc updates version and relays", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Two peers connected
      let m = establishChannel(update, model, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      // Register a replicated causal doc
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "replicate",
          docId: "rep-doc",
          version: "0",
          mergeStrategy: "causal",
          schemaHash: "00test",
        },
        m,
      )

      // Simulate successful import from bob
      // First, get both peers into synced state by handling interests
      ;[m] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "interest",
              docId: "rep-doc",
              version: "0",
              reciprocate: false,
            },
          },
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 2,
            message: {
              type: "interest",
              docId: "rep-doc",
              version: "0",
              reciprocate: false,
            },
          },
        },
        m,
      )

      // doc-imported from bob
      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "rep-doc",
          version: "v2",
          fromPeerId: "bob",
        },
        m,
      )

      // Version updated
      expect(m2.documents.get("rep-doc")?.version).toBe("v2")

      // Should relay to carol (excluding bob)
      const commands = flattenCommands(cmd)
      const sendOffer = commands.find(c => c.type === "cmd/send-offer")
      expect(sendOffer).toBeDefined()
      if (sendOffer && sendOffer.type === "cmd/send-offer") {
        expect(sendOffer.docId).toBe("rep-doc")
        // Should include carol's channel (2), not bob's (1)
        expect(sendOffer.toChannelIds).toContain(2)
        expect(sendOffer.toChannelIds).not.toContain(1)
      }
    })
  })

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // Notification co-product — ready-state invalidation
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  describe("notification co-product", () => {
    it("doc-imported returns ready-state-changed notification for the imported docId", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/doc-imported",
          docId: "doc-1",
          version: "v2",
          fromPeerId: "bob",
        },
        m,
      )

      const docIds = collectNotifiedDocIds(notification)
      expect(docIds).toEqual(new Set(["doc-1"]))
    })

    it("interest for known doc returns ready-state-changed notification", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "interest", docId: "doc-1", version: "v0" },
          },
        },
        m,
      )

      const docIds = collectNotifiedDocIds(notification)
      expect(docIds).toEqual(new Set(["doc-1"]))
    })

    it("dismiss returns ready-state-changed notification for the dismissed docId", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "dismiss", docId: "doc-1" },
          },
        },
        m,
      )

      const docIds = collectNotifiedDocIds(notification)
      expect(docIds).toEqual(new Set(["doc-1"]))
    })

    it("channel-removed for last channel of a peer notifies all docs the peer had sync state for", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)

      // Ensure two docs so bob gets sync state for both
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-2",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      // Bob sends interest for both docs → creates pending sync state
      ;[m] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "interest", docId: "doc-1", version: "v0" },
          },
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "interest", docId: "doc-2", version: "v0" },
          },
        },
        m,
      )

      // Remove the channel — bob's only channel
      const channel = m.channels.get(1)
      if (!channel) throw new Error("Expected channel 1 to exist")
      const [_m2, _cmd, notification] = update(
        { type: "synchronizer/channel-removed", channel },
        m,
      )

      const docIds = collectNotifiedDocIds(notification)
      expect(docIds).toEqual(new Set(["doc-1", "doc-2"]))
    })

    it("channel-added returns no notification", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const channel = makeConnectedChannel(1)

      const [_m, _cmd, notification] = update(
        { type: "synchronizer/channel-added", channel },
        model,
      )

      expect(notification).toBeUndefined()
    })

    it("doc-ensure returns no notification", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const m = establishChannel(update, model, 1, bobIdentity)

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      expect(notification).toBeUndefined()
    })

    it("local-doc-change returns no notification", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "00test",
        },
        m,
      )

      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/local-doc-change",
          docId: "doc-1",
          version: "v2",
        },
        m,
      )

      // local-doc-change now emits notify/state-advanced for unified
      // persistence (jj:smmulzkm). Verify it notifies the correct docId.
      expect(notification).toBeDefined()
      expect(notification?.type).toBe("notify/state-advanced")
      const docIds = collectNotifiedDocIds(notification)
      expect(docIds).toEqual(new Set(["doc-1"]))
    })
  })

  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
  // Peer lifecycle notifications — peer-joined / peer-left
  // =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

  describe("peer lifecycle notifications", () => {
    it("peer-joined fires on first channel establishment", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Add channel 1
      const channel = makeConnectedChannel(1)
      const [m] = update({ type: "synchronizer/channel-added", channel }, model)

      // Receive establish-request from bob
      const [_m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m,
      )

      if (!notification) throw new Error("Expected notification to be defined")
      const peerJoined = findNotification(notification, "notify/peer-joined")
      if (!peerJoined) throw new Error("Expected peer-joined notification")
      expect(peerJoined.peer).toEqual(bobIdentity)
    })

    it("peer-joined does NOT fire on second channel for same peer", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish bob on channel 1
      const m = establishChannel(update, model, 1, bobIdentity)

      // Add a second channel for bob
      const channel2 = makeConnectedChannel(2)
      const [m2] = update(
        { type: "synchronizer/channel-added", channel: channel2 },
        m,
      )

      const [_m3, _cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 2,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m2,
      )

      // Should have no peer-joined (may have a duplicate-peerId warning)
      const peerJoined = notification
        ? findNotification(notification, "notify/peer-joined")
        : undefined
      expect(peerJoined).toBeUndefined()
    })

    it("peer-left fires when last channel for a peer is removed", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish bob on channel 1
      const m = establishChannel(update, model, 1, bobIdentity)

      // Remove the channel — bob's only channel
      const channel = m.channels.get(1)
      if (!channel) throw new Error("Expected channel 1 to exist")

      const [_m2, _cmd, notification] = update(
        { type: "synchronizer/channel-removed", channel },
        m,
      )

      if (!notification) throw new Error("Expected notification to be defined")
      const peerLeft = findNotification(notification, "notify/peer-left")
      if (!peerLeft) throw new Error("Expected peer-left notification")
      expect(peerLeft.peer).toEqual(bobIdentity)
    })

    it("peer-left does NOT fire when peer still has remaining channels", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish bob on channel 1
      let m = establishChannel(update, model, 1, bobIdentity)

      // Add second channel for bob
      const channel2 = makeConnectedChannel(2)
      ;[m] = update(
        { type: "synchronizer/channel-added", channel: channel2 },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 2,
            message: { type: "establish-request", identity: bobIdentity },
          },
        },
        m,
      )

      // Remove channel 1 — bob still has channel 2
      const channel1 = m.channels.get(1)
      if (!channel1) throw new Error("Expected channel 1 to exist")

      const [_m2, _cmd, notification] = update(
        { type: "synchronizer/channel-removed", channel: channel1 },
        m,
      )

      // Should have no peer-left notification (may have readyStateChanged)
      const peerLeft = notification
        ? findNotification(notification, "notify/peer-left")
        : undefined
      expect(peerLeft).toBeUndefined()
    })

    it("peer-left composes with readyStateChanged notification", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish bob on channel 1
      let m = establishChannel(update, model, 1, bobIdentity)

      // Register a doc so bob can get doc sync state
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          docId: "doc-1",
          mode: "interpret",
          version: "v1",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "causal",
          schemaHash: "hash1",
        },
        m,
      )

      // Simulate interest from bob so he gets doc sync state
      ;[m] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "interest", docId: "doc-1", version: "v1" },
          },
        },
        m,
      )

      // Remove bob's channel
      const channel = m.channels.get(1)
      if (!channel) throw new Error("Expected channel 1 to exist")
      const [_m2, _cmd, notification] = update(
        { type: "synchronizer/channel-removed", channel },
        m,
      )

      if (!notification) throw new Error("Expected notification to be defined")
      // Should have both peer-left and ready-state-changed
      const peerLeft = findNotification(notification, "notify/peer-left")
      const readyState = findNotification(
        notification,
        "notify/ready-state-changed",
      )
      if (!peerLeft) throw new Error("Expected peer-left notification")
      expect(peerLeft.peer).toEqual(bobIdentity)
      expect(readyState).toBeDefined()
    })

    it("channel-removed with stale 'connected' reference still cleans up peer", () => {
      // Regression: transports hold the original "connected" channel object
      // in their ChannelDirectory. When a transport shuts down, onReset
      // passes that stale reference to channelRemoved — not the model's
      // upgraded "established" version. handleChannelRemoved must look up
      // the channel from the model to find the correct type and peerId.
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish bob — model upgrades channel 1 to "established"
      const m = establishChannel(update, model, 1, bobIdentity)
      expect(m.channels.get(1)?.type).toBe("established")
      expect(m.peers.has("bob")).toBe(true)

      // Simulate transport shutdown: pass the ORIGINAL connected channel,
      // not the model's established version. This is what the transport's
      // ChannelDirectory holds.
      const staleConnectedChannel = makeConnectedChannel(1)

      const [m2, _cmd, notification] = update(
        {
          type: "synchronizer/channel-removed",
          channel: staleConnectedChannel,
        },
        m,
      )

      // Peer must still be cleaned up despite the stale reference
      expect(m2.peers.has("bob")).toBe(false)
      expect(m2.channels.has(1)).toBe(false)

      // And peer-left must still fire
      const peerLeft = notification
        ? findNotification(notification, "notify/peer-left")
        : undefined
      if (!peerLeft) throw new Error("Expected peer-left notification")
      expect(peerLeft.peer).toEqual(bobIdentity)
    })
  })

  describe("capability gate and deferred documents", () => {
    it("handlePresent for unknown doc emits request-doc-creation regardless of replicaType", () => {
      // No supports gate — all unknown docs flow through to creation request
      const update = createSynchronizerUpdate()
      const [model] = init(aliceIdentity)

      const m = establishChannel(update, model, 1, bobIdentity)

      // Bob announces a Loro doc — no supports gate to block it
      const [_result, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "loro-doc",
                  replicaType: ["loro", 1, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "abc",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const creationCmds = commands.filter(
        c => c.type === "cmd/request-doc-creation",
      )
      // Should have a creation command — no gate to block it
      expect(creationCmds).toHaveLength(1)
      expect(creationCmds[0]).toMatchObject({
        type: "cmd/request-doc-creation",
        docId: "loro-doc",
        replicaType: ["loro", 1, 0],
        mergeStrategy: "causal",
        schemaHash: "abc",
      })
    })

    it("handlePresent for known doc with mismatched mergeStrategy emits warning, no interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          replicaType: ["plain", 1, 0] as const,
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
          schemaHash: "hash1",
        },
        m,
      )

      // Bob announces the same doc but claims "causal" mergeStrategy
      const [_result, cmd, notification] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "doc-1",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "causal" as const,
                  schemaHash: "hash1",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmds).toHaveLength(0)

      // Notification should be a warning about mergeStrategy mismatch
      expect(notification).toBeDefined()
      expect(notification?.type).toBe("notify/warning")
      if (notification?.type === "notify/warning") {
        expect(notification.message).toContain("mergeStrategy mismatch")
      }
    })

    it("handleDocDefer adds deferred doc, sends present without interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const m = establishChannel(update, model, 1, bobIdentity)

      const [result, cmd] = update(
        {
          type: "synchronizer/doc-defer",
          docId: "deferred-doc",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
          schemaHash: "hash1",
        },
        m,
      )

      // Doc is in the model with mode "deferred"
      const entry = result.documents.get("deferred-doc")
      expect(entry).toBeDefined()
      expect(entry?.mode).toBe("deferred")
      expect(entry?.version).toBe("")

      // present was sent (for routing)
      const commands = flattenCommands(cmd)
      const presentCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "present",
      )
      expect(presentCmds.length).toBeGreaterThan(0)

      // But no interest was sent
      const interestCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmds).toHaveLength(0)
    })

    it("handlePresent for deferred doc does not send interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-defer",
          docId: "deferred-doc",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
          schemaHash: "hash1",
        },
        m,
      )

      // Peer announces the same doc
      const [_result, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "present",
              docs: [
                {
                  docId: "deferred-doc",
                  replicaType: ["plain", 1, 0] as const,
                  mergeStrategy: "sequential" as const,
                  schemaHash: "hash1",
                },
              ],
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmds).toHaveLength(0)
    })

    it("handleDocEnsure promotes deferred doc to interpret, sends present + interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-defer",
          docId: "deferred-doc",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
          schemaHash: "hash1",
        },
        m,
      )

      const [result, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          docId: "deferred-doc",
          mode: "interpret",
          version: "1",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
          schemaHash: "hash1",
        },
        m,
      )

      // Doc is now in "interpret" mode
      const entry = result.documents.get("deferred-doc")
      expect(entry).toBeDefined()
      expect(entry?.mode).toBe("interpret")
      expect(entry?.version).toBe("1")

      // Both present and interest were sent
      const commands = flattenCommands(cmd)
      const presentCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "present",
      )
      const interestCmds = commands.filter(
        c =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(presentCmds.length).toBeGreaterThan(0)
      expect(interestCmds.length).toBeGreaterThan(0)
    })

    it("handleOffer for deferred doc returns model unchanged", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-defer",
          docId: "deferred-doc",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
          schemaHash: "hash1",
        },
        m,
      )

      const [result, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "deferred-doc",
              payload: { kind: "entirety", encoding: "json", data: "{}" },
              version: "v1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const importCmds = commands.filter(c => c.type === "cmd/import-doc-data")
      expect(importCmds).toHaveLength(0)

      // Model should be unchanged — deferred doc still deferred
      expect(result.documents.get("deferred-doc")?.mode).toBe("deferred")
    })

    it("handleInterest for deferred doc returns model unchanged", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-defer",
          docId: "deferred-doc",
          replicaType: ["plain", 1, 0] as const,
          mergeStrategy: "sequential" as const,
          schemaHash: "hash1",
        },
        m,
      )

      const [result, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "interest",
              docId: "deferred-doc",
              version: "v0",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const sendOfferCmds = commands.filter(c => c.type === "cmd/send-offer")
      expect(sendOfferCmds).toHaveLength(0)

      // Model should be unchanged — deferred doc still deferred
      expect(result.documents.get("deferred-doc")?.mode).toBe("deferred")
    })
  })
})
