// synchronizer-program — unit tests for the pure TEA update function.

import { describe, expect, it } from "vitest"
import {
  type Command,
  createSynchronizerUpdate,
  init,
  type SynchronizerMessage,
  type SynchronizerModel,
} from "../synchronizer-program.js"
import type { PeerIdentityDetails } from "../types.js"
import type { ConnectedChannel, EstablishedChannel } from "../channel.js"

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

/**
 * Apply a sequence of messages to a model and return the final model + last command.
 */
function applyMessages(
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
 * Establish a channel in the model by running the full handshake:
 * channel-added → establish-channel → receive establish-request → receive establish-response
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
      expect(m.channels.get(1)!.type).toBe("connected")
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
      expect(cmd!.type).toBe("cmd/send-message")
      const sendCmd = cmd as Extract<Command, { type: "cmd/send-message" }>
      expect(sendCmd.envelope.message.type).toBe("establish-request")
    })

    it("channel-removed cleans up channel and peer state", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish a channel with bob
      const m = establishChannel(update, model, 1, bobIdentity)
      expect(m.channels.get(1)!.type).toBe("established")
      expect(m.peers.has("bob")).toBe(true)

      // Remove the channel
      const channel = m.channels.get(1)!
      const [m2] = update(
        { type: "synchronizer/channel-removed", channel },
        m,
      )
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
      expect(m2.channels.get(1)!.type).toBe("established")
      const established = m2.channels.get(1) as EstablishedChannel
      expect(established.peerId).toBe("bob")

      // Peer should be tracked
      expect(m2.peers.has("bob")).toBe(true)
      expect(m2.peers.get("bob")!.channels.has(1)).toBe(true)

      // Should send establish-response
      const commands = flattenCommands(cmd)
      const responseCmd = commands.find(
        (c) =>
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

      expect(m2.channels.get(1)!.type).toBe("established")
      expect(m2.peers.has("bob")).toBe(true)
    })
  })

  describe("doc-ensure", () => {
    it("registers document and sends discover + interest to established channels", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Set up an established channel first
      const m = establishChannel(update, model, 1, bobIdentity)

      // Ensure a doc
      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
        },
        m,
      )

      expect(m2.documents.has("doc-1")).toBe(true)
      expect(m2.documents.get("doc-1")!.version).toBe("v1")

      const commands = flattenCommands(cmd)

      // Should send discover to the established channel
      const discoverCmd = commands.find(
        (c) =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "discover",
      )
      expect(discoverCmd).toBeDefined()

      // Should also send interest — essential for pulling data into
      // empty docs created via onDocDiscovered
      const interestCmd = commands.find(
        (c) =>
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
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
        },
        model,
      )

      const [m2] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v2",
          mergeStrategy: "sequential",
        },
        m1,
      )

      // Version should NOT change — idempotent
      expect(m2.documents.get("doc-1")!.version).toBe("v1")
    })
  })

  describe("discover → interest flow", () => {
    it("receiving discover for a known doc sends interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Establish channel, ensure doc
      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
        },
        m,
      )

      // Receive discover from bob saying they have doc-1
      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["doc-1"] },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        (c) =>
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

    it("receiving discover for an unknown doc emits request-doc-creation", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["unknown-doc"] },
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

    it("receiving discover with mixed known/unknown docs emits both interest and request-doc-creation", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "known-doc",
          version: "v1",
          mergeStrategy: "sequential",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["known-doc", "unknown-doc"] },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(commands).toHaveLength(2)

      const interestCmd = commands.find(
        (c) =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "interest",
      )
      expect(interestCmd).toBeDefined()

      const creationCmd = commands.find(
        (c) => c.type === "cmd/request-doc-creation",
      )
      expect(creationCmd).toBeDefined()
      if (creationCmd && creationCmd.type === "cmd/request-doc-creation") {
        expect(creationCmd.docId).toBe("unknown-doc")
        expect(creationCmd.peer.peerId).toBe("bob")
      }
    })

    it("receiving discover with all known docs produces no creation commands", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["doc-1"] },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const creationCmds = commands.filter(
        (c) => c.type === "cmd/request-doc-creation",
      )
      expect(creationCmds).toHaveLength(0)
      // Should still have the interest command
      expect(commands.length).toBeGreaterThanOrEqual(1)
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
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "causal",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        expect(offerCmd.sinceVersion).toBe("v0")
      }

      // Should have a reciprocal interest (since causal + reciprocate=true)
      const reciprocalInterest = commands.find(
        (c) =>
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
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        expect(offerCmd.sinceVersion).toBe("v0")
      }

      // Sequential should NOT produce a reciprocal interest
      const reciprocal = commands.find(
        (c) =>
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
          mode: "interpret",
          docId: "doc-1",
          version: "1000",
          mergeStrategy: "lww",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
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
              offerType: "snapshot",
              payload: { encoding: "json", data: '{"title":"Hello"}' },
              version: "v1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const importCmd = commands.find((c) => c.type === "cmd/import-doc-data")
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

      let m = establishChannel(update, model, 1, bobIdentity)

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: {
              type: "offer",
              docId: "unknown-doc",
              offerType: "snapshot",
              payload: { encoding: "json", data: "{}" },
              version: "v1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      expect(commands.find((c) => c.type === "cmd/import-doc-data")).toBeUndefined()
    })

    it("offer with reciprocate=true triggers interest back", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
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
              offerType: "delta",
              payload: { encoding: "binary", data: new Uint8Array([1, 2, 3]) },
              version: "v1",
              reciprocate: true,
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)

      // Should import
      expect(commands.find((c) => c.type === "cmd/import-doc-data")).toBeDefined()

      // Should send interest back
      const interestCmd = commands.find(
        (c) =>
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
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
          mode: "interpret",
          docId: "presence",
          version: "1000",
          mergeStrategy: "lww",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
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

      expect(m2.documents.get("doc-1")!.version).toBe("v1")
      const bobState = m2.peers.get("bob")!
      const docSync = bobState.docSyncStates.get("doc-1")!
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        // Should target Carol's channel, NOT Bob's
        expect(offerCmd.toChannelIds).toContain(2)
        expect(offerCmd.toChannelIds).not.toContain(1)
        // sinceVersion must be the pre-import version (v2), not the new version (v3)
        expect(offerCmd.sinceVersion).toBe("v2")
        expect(offerCmd.forceSnapshot).toBeFalsy()
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
          mode: "interpret",
          docId: "doc-1",
          version: "1000",
          mergeStrategy: "lww",
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
      const offerCmd = commands.find((c) => c.type === "cmd/send-offer")
      expect(offerCmd).toBeDefined()
      if (offerCmd && offerCmd.type === "cmd/send-offer") {
        expect(offerCmd.docId).toBe("doc-1")
        // Should target Carol's channel, NOT Bob's
        expect(offerCmd.toChannelIds).toContain(2)
        expect(offerCmd.toChannelIds).not.toContain(1)
        expect(offerCmd.forceSnapshot).toBe(true)
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "causal",
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
          mode: "interpret",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: "sequential",
        },
        model,
      )
      expect(m.documents.has("doc-1")).toBe(true)

      ;[m] = update({ type: "synchronizer/doc-delete", docId: "doc-1" }, m)
      expect(m.documents.has("doc-1")).toBe(false)
    })
  })

  describe("discover sends interest with reciprocate based on merge strategy", () => {
    it("causal doc: discover triggers interest with reciprocate=true", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "causal",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["doc-1"] },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        (c) =>
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

    it("sequential doc: discover triggers interest with reciprocate=false", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let m = establishChannel(update, model, 1, bobIdentity)
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: "sequential",
        },
        m,
      )

      const [_m2, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["doc-1"] },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const interestCmd = commands.find(
        (c) =>
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
    it("handleEstablishRequest filters discover by route", () => {
      // Route denies "secret-doc" for bob
      const update = createSynchronizerUpdate({
        route: (docId) => docId !== "secret-doc",
      })
      const [model] = init(aliceIdentity)

      // Add two docs
      let m = model
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "public-doc",
          version: "0",
          mergeStrategy: "sequential",
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "secret-doc",
          version: "0",
          mergeStrategy: "sequential",
        },
        m,
      )

      // Add a connected channel
      const channel = makeConnectedChannel(1)
      ;[m] = update({ type: "synchronizer/channel-added", channel }, m)

      // Receive establish-request from bob
      const [m2, cmd] = update(
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
      const discoverCmd = commands.find(
        (c) =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "discover",
      )
      expect(discoverCmd).toBeDefined()
      if (
        discoverCmd &&
        discoverCmd.type === "cmd/send-message" &&
        discoverCmd.envelope.message.type === "discover"
      ) {
        expect(discoverCmd.envelope.message.docIds).toContain("public-doc")
        expect(discoverCmd.envelope.message.docIds).not.toContain("secret-doc")
      }
    })

    it("handleEstablishResponse filters discover by route", () => {
      const update = createSynchronizerUpdate({
        route: (docId) => docId !== "secret-doc",
      })
      const [model] = init(aliceIdentity)

      let m = model
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "public-doc",
          version: "0",
          mergeStrategy: "sequential",
        },
        m,
      )
      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "secret-doc",
          version: "0",
          mergeStrategy: "sequential",
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
      const discoverCmd = commands.find(
        (c) =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "discover",
      )
      expect(discoverCmd).toBeDefined()
      if (
        discoverCmd &&
        discoverCmd.type === "cmd/send-message" &&
        discoverCmd.envelope.message.type === "discover"
      ) {
        expect(discoverCmd.envelope.message.docIds).toContain("public-doc")
        expect(discoverCmd.envelope.message.docIds).not.toContain("secret-doc")
      }
    })

    it("handleDocEnsure filters channels by route", () => {
      // Route allows "doc-1" for bob but not carol
      const update = createSynchronizerUpdate({
        route: (docId, peer) => peer.peerId !== "carol",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)
      m = establishChannel(update, m, 2, carolIdentity)

      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
        },
        m,
      )

      const commands = flattenCommands(cmd)
      // All outbound messages should target channel 1 (bob), not channel 2 (carol)
      const sendMsgs = commands.filter((c) => c.type === "cmd/send-message")
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
          mode: "interpret",
          docId: "presence",
          version: "0",
          mergeStrategy: "lww",
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
      const offerCmds = commands.filter((c) => c.type === "cmd/send-offer")
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "lww",
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
      const offerCmds = commands.filter((c) => c.type === "cmd/send-offer")
      expect(offerCmds.length).toBe(1)
      if (offerCmds[0] && offerCmds[0].type === "cmd/send-offer") {
        expect(offerCmds[0].toChannelIds).toContain(1) // bob allowed
        expect(offerCmds[0].toChannelIds).not.toContain(2) // carol denied
      }
    })

    it("handleDiscover checks route before request-doc-creation", () => {
      // Route denies "forbidden" doc from bob
      const update = createSynchronizerUpdate({
        route: (docId) => docId !== "forbidden",
      })
      const [model] = init(aliceIdentity)

      let m = model
      m = establishChannel(update, m, 1, bobIdentity)

      const [, cmd] = update(
        {
          type: "synchronizer/channel-receive-message",
          envelope: {
            fromChannelId: 1,
            message: { type: "discover", docIds: ["forbidden"] },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const creationCmds = commands.filter(
        (c) => c.type === "cmd/request-doc-creation",
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "lww",
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

    it("storage channels bypass route filtering", () => {
      // Route denies everything — but storage should still be included
      const update = createSynchronizerUpdate({
        route: () => false,
      })
      const [model] = init(aliceIdentity)

      let m = model
      // Establish a storage channel (bypasses route)
      m = establishChannel(update, m, 1, bobIdentity, "storage")
      // Establish a network channel (should be filtered)
      m = establishChannel(update, m, 2, carolIdentity, "network")

      ;[m] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "lww",
        },
        m,
      )

      const [, cmd] = update(
        { type: "synchronizer/local-doc-change", docId: "doc-1", version: "1" },
        m,
      )

      const commands = flattenCommands(cmd)
      const offerCmds = commands.filter((c) => c.type === "cmd/send-offer")
      expect(offerCmds.length).toBe(1)
      if (offerCmds[0] && offerCmds[0].type === "cmd/send-offer") {
        // Storage channel kept despite route: () => false
        expect(offerCmds[0].toChannelIds).toContain(1)
        // Network channel filtered out
        expect(offerCmds[0].toChannelIds).not.toContain(2)
      }
    })
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
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
              offerType: "snapshot" as const,
              payload: { encoding: "json" as const, data: "{}" },
              version: "1",
              reciprocate: true,
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      // Import should be blocked
      const importCmds = commands.filter(
        (c) => c.type === "cmd/import-doc-data",
      )
      expect(importCmds).toHaveLength(0)

      // But reciprocation (interest back) should still happen
      const interestCmds = commands.filter(
        (c) =>
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
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
              offerType: "snapshot" as const,
              payload: { encoding: "json" as const, data: "{}" },
              version: "1",
            },
          },
        },
        m,
      )

      const commands = flattenCommands(cmd)
      const importCmds = commands.filter(
        (c) => c.type === "cmd/import-doc-data",
      )
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
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
        (c) => c.type === "cmd/notify-doc-dismissed",
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
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
          mode: "interpret",
          docId: "doc-1",
          version: "0",
          mergeStrategy: "sequential",
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
      const sendCmds = commands.filter((c) => c.type === "cmd/send-message")
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
    it("doc-ensure with mode 'replicate' sends discover + interest", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)
      const m = establishChannel(update, model, 1, bobIdentity)

      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          mode: "replicate",
          docId: "replicated-doc",
          version: "0",
          mergeStrategy: "causal",
        },
        m,
      )

      expect(m2.documents.has("replicated-doc")).toBe(true)
      expect(m2.documents.get("replicated-doc")!.mode).toBe("replicate")
      expect(m2.documents.get("replicated-doc")!.version).toBe("0")

      const commands = flattenCommands(cmd)

      // Should send discover
      const discoverCmd = commands.find(
        (c) =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "discover",
      )
      expect(discoverCmd).toBeDefined()

      // Should send interest with reciprocate (causal)
      const interestCmd = commands.find(
        (c) =>
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
          mode: "replicate",
          docId: "rep-doc",
          version: "0",
          mergeStrategy: "causal",
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
      expect(m2.documents.get("rep-doc")!.version).toBe("v2")

      // Should relay to carol (excluding bob)
      const commands = flattenCommands(cmd)
      const sendOffer = commands.find((c) => c.type === "cmd/send-offer")
      expect(sendOffer).toBeDefined()
      if (sendOffer && sendOffer.type === "cmd/send-offer") {
        expect(sendOffer.docId).toBe("rep-doc")
        // Should include carol's channel (2), not bob's (1)
        expect(sendOffer.toChannelIds).toContain(2)
        expect(sendOffer.toChannelIds).not.toContain(1)
      }
    })


  })
})