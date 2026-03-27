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
import { createPermissions } from "../permissions.js"

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

function makeUpdate() {
  return createSynchronizerUpdate({
    permissions: createPermissions(),
  })
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
    it("registers document and announces via discover", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      // Set up an established channel first
      const m = establishChannel(update, model, 1, bobIdentity)

      // Ensure a doc
      const [m2, cmd] = update(
        {
          type: "synchronizer/doc-ensure",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "sequential" },
        },
        m,
      )

      expect(m2.documents.has("doc-1")).toBe(true)
      expect(m2.documents.get("doc-1")!.version).toBe("v1")

      // Should send discover to the established channel
      const commands = flattenCommands(cmd)
      const discoverCmd = commands.find(
        (c) =>
          c.type === "cmd/send-message" &&
          c.envelope.message.type === "discover",
      )
      expect(discoverCmd).toBeDefined()
    })

    it("doc-ensure is idempotent for same docId", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      const [m1] = update(
        {
          type: "synchronizer/doc-ensure",
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "sequential" },
        },
        model,
      )

      const [m2] = update(
        {
          type: "synchronizer/doc-ensure",
          docId: "doc-1",
          version: "v2",
          mergeStrategy: { type: "sequential" },
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
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "sequential" },
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

    it("receiving discover for an unknown doc is a no-op", () => {
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

      expect(cmd).toBeUndefined()
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
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "causal" },
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
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "sequential" },
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
          docId: "doc-1",
          version: "1000",
          mergeStrategy: { type: "lww" },
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
          docId: "doc-1",
          version: "v0",
          mergeStrategy: { type: "sequential" },
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
          docId: "doc-1",
          version: "v0",
          mergeStrategy: { type: "causal" },
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
          docId: "doc-1",
          version: "v0",
          mergeStrategy: { type: "causal" },
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
          docId: "presence",
          version: "1000",
          mergeStrategy: { type: "lww" },
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
          docId: "doc-1",
          version: "v0",
          mergeStrategy: { type: "sequential" },
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
          docId: "doc-1",
          version: "v0",
          mergeStrategy: { type: "sequential" },
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
  })

  describe("doc-delete", () => {
    it("removes document from model", () => {
      const update = makeUpdate()
      const [model] = init(aliceIdentity)

      let [m] = update(
        {
          type: "synchronizer/doc-ensure",
          docId: "doc-1",
          version: "v0",
          mergeStrategy: { type: "sequential" },
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
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "causal" },
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
          docId: "doc-1",
          version: "v1",
          mergeStrategy: { type: "sequential" },
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
})