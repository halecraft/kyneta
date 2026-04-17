// session-program — unit tests for the pure TEA update function.

import { describe, expect, it } from "vitest"
import {
  createSessionUpdate,
  initSession,
  type SessionEffect,
  type SessionModel,
  type SessionNotification,
  type SessionUpdate,
} from "../session-program.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Assert a Map.get() result is defined and return it narrowed. */
function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  return value as T
}

function makeUpdate(): SessionUpdate {
  return createSessionUpdate()
}

// Helper identity objects
const alice = { peerId: "alice", type: "user" as const }
const bob = { peerId: "bob", type: "user" as const }
const carol = { peerId: "carol", type: "user" as const }

// Helper to flatten batch effects
function flattenEffects(effect: SessionEffect | undefined): SessionEffect[] {
  if (!effect) return []
  if (effect.type === "batch") return effect.effects.flatMap(flattenEffects)
  return [effect]
}

// Helper to flatten batch notifications
function flattenNotifications(
  notification: SessionNotification | undefined,
): SessionNotification[] {
  if (!notification) return []
  if (notification.type === "notify/batch")
    return notification.notifications.flatMap(flattenNotifications)
  return [notification]
}

// Helper to establish a channel (sends establish, receives establish back)
function establishChannel(
  update: SessionUpdate,
  model: SessionModel,
  channelId: number,
  remoteIdentity: { peerId: string; type: "user" | "bot" | "service" },
): [SessionModel, SessionEffect[], SessionNotification[]] {
  const allEffects: SessionEffect[] = []
  const allNotifications: SessionNotification[] = []

  // Step 1: channel-added
  let [m, e, n] = update(
    { type: "sess/channel-added", channelId, transportType: "test" },
    model,
  )
  allEffects.push(...flattenEffects(e))
  allNotifications.push(...flattenNotifications(n))

  // Step 2: channel-establish (local side sends)
  ;[m, e, n] = update({ type: "sess/channel-establish", channelId }, m)
  allEffects.push(...flattenEffects(e))
  allNotifications.push(...flattenNotifications(n))

  // Step 3: receive establish from remote
  ;[m, e, n] = update(
    {
      type: "sess/message-received",
      fromChannelId: channelId,
      message: { type: "establish", identity: remoteIdentity },
    },
    m,
  )
  allEffects.push(...flattenEffects(e))
  allNotifications.push(...flattenNotifications(n))

  return [m, allEffects, allNotifications]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-program", () => {
  // =========================================================================
  // init
  // =========================================================================

  describe("init", () => {
    it("initializes with empty channels and peers", () => {
      const model = initSession(alice)

      expect(model.identity).toEqual(alice)
      expect(model.channels.size).toBe(0)
      expect(model.peers.size).toBe(0)
      expect(model.departureTimeout).toBe(30_000)
    })

    it("accepts custom departure timeout", () => {
      const model = initSession(alice, 5_000)
      expect(model.departureTimeout).toBe(5_000)
    })

    it("accepts zero departure timeout", () => {
      const model = initSession(alice, 0)
      expect(model.departureTimeout).toBe(0)
    })
  })

  // =========================================================================
  // establish handshake
  // =========================================================================

  describe("establish handshake", () => {
    it("channel-added registers channel entry", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      const [m, effect, notification] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )

      // Channel is registered
      expect(m.channels.size).toBe(1)
      const entry = defined(m.channels.get(1))
      expect(entry.channelId).toBe(1)
      expect(entry.localEstablishSent).toBe(false)
      expect(entry.remoteIdentity).toBeUndefined()
      expect(entry.transportType).toBe("test")

      // No effects or notifications from just adding
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()

      // Peers unchanged
      expect(m.peers.size).toBe(0)
    })

    it("channel-establish sends establish message", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Add the channel first
      ;[model] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )

      // Now trigger establish
      const [m, effect, notification] = update(
        { type: "sess/channel-establish", channelId: 1 },
        model,
      )

      // localEstablishSent is now true
      const entry = defined(m.channels.get(1))
      expect(entry.localEstablishSent).toBe(true)

      // Should emit a send effect with our identity
      const effects = flattenEffects(effect)
      expect(effects).toHaveLength(1)
      expect(effects[0]).toEqual({
        type: "send",
        to: 1,
        message: { type: "establish", identity: alice },
      })

      // No notification yet — handshake not complete
      expect(notification).toBeUndefined()
    })

    it("receiving establish echoes back and completes handshake", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // channel-added → channel-establish → receive establish from bob
      ;[model] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )
      ;[model] = update({ type: "sess/channel-establish", channelId: 1 }, model)

      const [m, effect, notification] = update(
        {
          type: "sess/message-received",
          fromChannelId: 1,
          message: { type: "establish", identity: bob },
        },
        model,
      )

      // Channel is now fully established
      const entry = defined(m.channels.get(1))
      expect(entry.localEstablishSent).toBe(true)
      expect(entry.remoteIdentity).toEqual(bob)

      // Peer registered
      expect(m.peers.size).toBe(1)
      const peer = defined(m.peers.get("bob"))
      expect(peer.identity).toEqual(bob)
      expect(peer.channels.has(1)).toBe(true)
      expect(peer.departing).toBe(false)

      // Effects: echo establish back + sync/peer-available
      const effects = flattenEffects(effect)
      const echoEffect = effects.find(
        e =>
          e.type === "send" &&
          e.message.type === "establish" &&
          e.message.identity === alice,
      )
      expect(echoEffect).toBeDefined()

      // Notification: peer-established
      const notifications = flattenNotifications(notification)
      expect(notifications).toContainEqual({
        type: "notify/peer-established",
        peer: bob,
      })
    })

    it("establish completes when local sends first, then remote arrives", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      // This is the standard flow: add → establish → receive establish
      const [m, allEffects, allNotifications] = establishChannel(
        update,
        model,
        1,
        bob,
      )

      // Channel fully established
      const entry = defined(m.channels.get(1))
      expect(entry.localEstablishSent).toBe(true)
      expect(entry.remoteIdentity).toEqual(bob)

      // Peer created
      expect(m.peers.has("bob")).toBe(true)
      expect(defined(m.peers.get("bob")).channels.has(1)).toBe(true)

      // peer-established notification emitted
      expect(allNotifications).toContainEqual({
        type: "notify/peer-established",
        peer: bob,
      })

      // sync/peer-available effect emitted
      const syncEffects = allEffects.filter(e => e.type === "sync-event")
      expect(syncEffects).toContainEqual({
        type: "sync-event",
        event: {
          type: "sync/peer-available",
          peerId: "bob",
          identity: bob,
        },
      })
    })

    it("simultaneous open — remote establish arrives before local channel-establish", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Step 1: channel-added
      ;[model] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )

      // Step 2: receive establish from remote BEFORE local channel-establish
      const [m, effect, notification] = update(
        {
          type: "sess/message-received",
          fromChannelId: 1,
          message: { type: "establish", identity: bob },
        },
        model,
      )

      // handleEstablishReceived sets both localEstablishSent=true and remoteIdentity
      const entry = defined(m.channels.get(1))
      expect(entry.localEstablishSent).toBe(true)
      expect(entry.remoteIdentity).toEqual(bob)

      // Channel is fully established — peer should exist
      expect(m.peers.size).toBe(1)
      const peer = defined(m.peers.get("bob"))
      expect(peer.identity).toEqual(bob)
      expect(peer.channels.has(1)).toBe(true)

      // An echo establish is sent back
      const effects = flattenEffects(effect)
      expect(effects).toContainEqual({
        type: "send",
        to: 1,
        message: { type: "establish", identity: alice },
      })

      // peer-established notification
      const notifications = flattenNotifications(notification)
      expect(notifications).toContainEqual({
        type: "notify/peer-established",
        peer: bob,
      })
    })

    it("second establish on already-established channel is a no-op", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Fully establish channel 1 with bob
      ;[model] = establishChannel(update, model, 1, bob)

      // Send another establish from bob on channel 1
      const [m, effect, notification] = update(
        {
          type: "sess/message-received",
          fromChannelId: 1,
          message: { type: "establish", identity: bob },
        },
        model,
      )

      // Model is unchanged (reference equality)
      expect(m).toBe(model)
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })

    it("duplicate channel-establish is a no-op", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      ;[model] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )
      ;[model] = update({ type: "sess/channel-establish", channelId: 1 }, model)

      // Second channel-establish — localEstablishSent is already true
      const [m, effect] = update(
        { type: "sess/channel-establish", channelId: 1 },
        model,
      )

      // Returns same model reference
      expect(m).toBe(model)
      expect(effect).toBeUndefined()
    })
  })

  // =========================================================================
  // peer-established
  // =========================================================================

  describe("peer-established", () => {
    it("fires peer-established on first establish for a new peer", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      const [m, , allNotifications] = establishChannel(update, model, 1, bob)

      expect(m.peers.has("bob")).toBe(true)
      expect(allNotifications).toContainEqual({
        type: "notify/peer-established",
        peer: bob,
      })
    })

    it("fires sync-event: sync/peer-available on new peer", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      const [, allEffects] = establishChannel(update, model, 1, bob)

      const syncEffects = allEffects.filter(e => e.type === "sync-event")
      expect(syncEffects).toContainEqual({
        type: "sync-event",
        event: {
          type: "sync/peer-available",
          peerId: "bob",
          identity: bob,
        },
      })
    })

    it("multi-channel peer: second channel does not fire peer-established", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish first channel with bob
      ;[model] = establishChannel(update, model, 1, bob)

      // Establish second channel with bob — collect only these effects/notifications
      const [m, allEffects, allNotifications] = establishChannel(
        update,
        model,
        2,
        bob,
      )

      // Bob now has two channels
      const peer = defined(m.peers.get("bob"))
      expect(peer.channels.size).toBe(2)
      expect(peer.channels.has(1)).toBe(true)
      expect(peer.channels.has(2)).toBe(true)

      // No peer-established notification for the second channel
      const joinNotifications = allNotifications.filter(
        n => n.type === "notify/peer-established",
      )
      expect(joinNotifications).toHaveLength(0)

      // No sync/peer-available for the second channel
      const syncAvailable = allEffects.filter(
        e =>
          e.type === "sync-event" &&
          "event" in e &&
          e.event.type === "sync/peer-available",
      )
      expect(syncAvailable).toHaveLength(0)
    })
  })

  // =========================================================================
  // channel removal
  // =========================================================================

  describe("channel removal", () => {
    it("channel-removed with remaining channels: no peer event", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob on two channels
      ;[model] = establishChannel(update, model, 1, bob)
      ;[model] = establishChannel(update, model, 2, bob)

      // Remove one channel
      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 1 },
        model,
      )

      // Channel removed from model
      expect(m.channels.has(1)).toBe(false)
      expect(m.channels.has(2)).toBe(true)

      // Peer still has channel 2
      const peer = defined(m.peers.get("bob"))
      expect(peer.channels.size).toBe(1)
      expect(peer.channels.has(2)).toBe(true)

      // No lifecycle effects or notifications
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })

    it("channel-removed for unestablished channel: no peer event", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Add a channel but never establish it
      ;[model] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )

      // Remove it
      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 1 },
        model,
      )

      // Channel is gone
      expect(m.channels.size).toBe(0)
      expect(m.peers.size).toBe(0)

      // No effects or notifications
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })

    it("channel-removed last channel, no depart, timeout > 0: peer-disconnected + start-departure-timer", () => {
      const update = makeUpdate()
      let model = initSession(alice) // default timeout = 30_000

      // Establish bob on channel 1
      ;[model] = establishChannel(update, model, 1, bob)

      // Remove the last channel
      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 1 },
        model,
      )

      // Peer stays in model with empty channels
      expect(m.peers.has("bob")).toBe(true)
      const peer = defined(m.peers.get("bob"))
      expect(peer.channels.size).toBe(0)
      expect(peer.identity).toEqual(bob)

      // Notification: peer-disconnected
      expect(notification).toEqual({
        type: "notify/peer-disconnected",
        peer: bob,
      })

      // Effects: sync/peer-unavailable + start-departure-timer
      const effects = flattenEffects(effect)
      expect(effects).toContainEqual({
        type: "sync-event",
        event: { type: "sync/peer-unavailable", peerId: "bob" },
      })
      expect(effects).toContainEqual({
        type: "start-departure-timer",
        peerId: "bob",
        delayMs: 30_000,
      })
    })

    it("channel-removed last channel, no depart, timeout = 0: peer-departed immediately", () => {
      const update = makeUpdate()
      let model = initSession(alice, 0) // immediate departure

      // Establish bob on channel 1
      ;[model] = establishChannel(update, model, 1, bob)

      // Remove the last channel
      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 1 },
        model,
      )

      // Peer deleted from model
      expect(m.peers.has("bob")).toBe(false)
      expect(m.peers.size).toBe(0)

      // Notification: peer-departed
      expect(notification).toEqual({
        type: "notify/peer-departed",
        peer: bob,
      })

      // Effect: sync/peer-departed
      const effects = flattenEffects(effect)
      expect(effects).toContainEqual({
        type: "sync-event",
        event: { type: "sync/peer-departed", peerId: "bob" },
      })

      // No departure timer started
      const timerEffects = effects.filter(
        e => e.type === "start-departure-timer",
      )
      expect(timerEffects).toHaveLength(0)
    })

    it("channel-removed for unknown channel is a no-op", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 999 },
        model,
      )

      expect(m).toBe(model)
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })
  })

  // =========================================================================
  // departure timer
  // =========================================================================

  describe("departure timer", () => {
    it("departure-timer-expired: peer deleted, peer-departed", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob, then remove channel (peer disconnected)
      ;[model] = establishChannel(update, model, 1, bob)
      ;[model] = update({ type: "sess/channel-removed", channelId: 1 }, model)

      // Verify peer is disconnected (still in model, empty channels)
      expect(model.peers.has("bob")).toBe(true)
      expect(defined(model.peers.get("bob")).channels.size).toBe(0)

      // Fire departure timer
      const [m, effect, notification] = update(
        { type: "sess/departure-timer-expired", peerId: "bob" },
        model,
      )

      // Peer deleted from model
      expect(m.peers.has("bob")).toBe(false)
      expect(m.peers.size).toBe(0)

      // Effect: sync/peer-departed
      const effects = flattenEffects(effect)
      expect(effects).toContainEqual({
        type: "sync-event",
        event: { type: "sync/peer-departed", peerId: "bob" },
      })

      // Notification: peer-departed
      expect(notification).toEqual({
        type: "notify/peer-departed",
        peer: bob,
      })
    })

    it("departure-timer-expired for reconnected peer: no-op", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob on channel 1
      ;[model] = establishChannel(update, model, 1, bob)

      // Remove channel 1 (disconnected)
      ;[model] = update({ type: "sess/channel-removed", channelId: 1 }, model)

      // Re-establish on channel 2 (reconnected)
      ;[model] = establishChannel(update, model, 2, bob)

      // Verify peer is reconnected (has channels again)
      expect(defined(model.peers.get("bob")).channels.size).toBe(1)

      // Fire stale departure timer
      const [m, effect, notification] = update(
        { type: "sess/departure-timer-expired", peerId: "bob" },
        model,
      )

      // Model unchanged
      expect(m).toBe(model)
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()

      // Peer still exists
      expect(m.peers.has("bob")).toBe(true)
      expect(defined(m.peers.get("bob")).channels.size).toBe(1)
    })

    it("departure-timer-expired for unknown peer: no-op", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      const [m, effect, notification] = update(
        { type: "sess/departure-timer-expired", peerId: "nobody" },
        model,
      )

      expect(m).toBe(model)
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })
  })

  // =========================================================================
  // reconnection
  // =========================================================================

  describe("reconnection", () => {
    it("reconnection: peer-reconnected + cancel-departure-timer + sync/peer-available", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob on channel 1
      ;[model] = establishChannel(update, model, 1, bob)

      // Remove channel 1 (disconnected)
      ;[model] = update({ type: "sess/channel-removed", channelId: 1 }, model)

      // Verify peer disconnected
      expect(defined(model.peers.get("bob")).channels.size).toBe(0)

      // Establish on channel 2 (reconnection)
      const [m, allEffects, allNotifications] = establishChannel(
        update,
        model,
        2,
        bob,
      )

      // Peer is reconnected
      expect(m.peers.has("bob")).toBe(true)
      const peer = defined(m.peers.get("bob"))
      expect(peer.channels.size).toBe(1)
      expect(peer.channels.has(2)).toBe(true)
      expect(peer.departing).toBe(false)

      // Notification: peer-reconnected
      expect(allNotifications).toContainEqual({
        type: "notify/peer-reconnected",
        peer: bob,
      })

      // Effects: cancel-departure-timer + sync/peer-available
      expect(allEffects).toContainEqual({
        type: "cancel-departure-timer",
        peerId: "bob",
      })
      expect(allEffects).toContainEqual({
        type: "sync-event",
        event: {
          type: "sync/peer-available",
          peerId: "bob",
          identity: bob,
        },
      })
    })

    it("reconnection clears departing flag", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob, receive depart, then remove channel (departed state)
      // But here we test: establish → remove channel (disconnected) →
      // re-establish should clear any lingering state
      ;[model] = establishChannel(update, model, 1, bob)
      ;[model] = update({ type: "sess/channel-removed", channelId: 1 }, model)

      // Re-establish
      ;[model] = establishChannel(update, model, 2, bob)

      const peer = defined(model.peers.get("bob"))
      expect(peer.departing).toBe(false)
    })
  })

  // =========================================================================
  // depart
  // =========================================================================

  describe("depart", () => {
    it("depart received then channel removed: peer-departed (not peer-disconnected)", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob on channel 1
      ;[model] = establishChannel(update, model, 1, bob)

      // Bob sends depart on channel 1
      const [departModel, departEffect, departNotification] = update(
        {
          type: "sess/message-received",
          fromChannelId: 1,
          message: { type: "depart" },
        },
        model,
      )

      // Peer is marked as departing
      expect(defined(departModel.peers.get("bob")).departing).toBe(true)

      // No immediate effects or notifications from just receiving depart
      // (peer still has channels)
      expect(departEffect).toBeUndefined()
      expect(departNotification).toBeUndefined()

      // Now remove the channel
      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 1 },
        departModel,
      )

      // Peer deleted immediately (departing = true)
      expect(m.peers.has("bob")).toBe(false)

      // Notification: peer-departed (NOT peer-disconnected)
      expect(notification).toEqual({
        type: "notify/peer-departed",
        peer: bob,
      })

      // Effect: sync/peer-departed
      const effects = flattenEffects(effect)
      expect(effects).toContainEqual({
        type: "sync-event",
        event: { type: "sync/peer-departed", peerId: "bob" },
      })

      // No departure timer started
      const timerEffects = effects.filter(
        e => e.type === "start-departure-timer",
      )
      expect(timerEffects).toHaveLength(0)
    })

    it("depart received while already disconnected: peer-departed immediately", () => {
      const update = makeUpdate()
      let model = initSession(alice)
      ;[model] = establishChannel(update, model, 10, bob)
      ;[model] = establishChannel(update, model, 20, bob)

      // Bob sends depart on channel 10
      ;[model] = update(
        {
          type: "sess/message-received",
          fromChannelId: 10,
          message: { type: "depart" },
        },
        model,
      )
      expect(defined(model.peers.get("bob")).departing).toBe(true)

      // Remove channel 10 — peer still has channel 20
      ;[model] = update({ type: "sess/channel-removed", channelId: 10 }, model)
      // Peer still alive with channel 20
      expect(model.peers.has("bob")).toBe(true)
      expect(defined(model.peers.get("bob")).channels.size).toBe(1)

      // Remove channel 20 — last channel, departing=true → immediate departure
      const [m, effect, notification] = update(
        { type: "sess/channel-removed", channelId: 20 },
        model,
      )

      expect(m.peers.has("bob")).toBe(false)
      expect(notification).toEqual({
        type: "notify/peer-departed",
        peer: bob,
      })
      const effects = flattenEffects(effect)
      expect(effects).toContainEqual({
        type: "sync-event",
        event: { type: "sync/peer-departed", peerId: "bob" },
      })
    })

    it("depart on unknown channel is a no-op", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      const [m, effect, notification] = update(
        {
          type: "sess/message-received",
          fromChannelId: 999,
          message: { type: "depart" },
        },
        model,
      )

      expect(m).toBe(model)
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })

    it("depart on unestablished channel is a no-op", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      ;[model] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )

      const [_m, effect, notification] = update(
        {
          type: "sess/message-received",
          fromChannelId: 1,
          message: { type: "depart" },
        },
        model,
      )

      // No remoteIdentity set → returns unchanged
      expect(effect).toBeUndefined()
      expect(notification).toBeUndefined()
    })
  })

  // =========================================================================
  // peer identity detection
  // =========================================================================

  describe("peer identity detection", () => {
    it("warns on self-connection (same peerId)", () => {
      const update = makeUpdate()
      const model = initSession(alice)

      // Establish a channel where the remote claims to be alice too
      const selfAlice = { peerId: "alice", type: "user" as const }
      const [, , allNotifications] = establishChannel(
        update,
        model,
        1,
        selfAlice,
      )

      const warnings = allNotifications.filter(n => n.type === "notify/warning")
      expect(warnings.length).toBeGreaterThanOrEqual(1)
      expect(
        warnings.some(
          w =>
            w.type === "notify/warning" &&
            w.message.includes("self-connection"),
        ),
      ).toBe(true)
    })

    it("warns on duplicate peerId (second channel from same peer)", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob on channel 1
      ;[model] = establishChannel(update, model, 1, bob)

      // Establish bob on channel 2 — should warn about duplicate peerId
      const [, , allNotifications] = establishChannel(update, model, 2, bob)

      const warnings = allNotifications.filter(n => n.type === "notify/warning")
      expect(warnings.length).toBeGreaterThanOrEqual(1)
      expect(
        warnings.some(
          w =>
            w.type === "notify/warning" &&
            w.message.includes("duplicate peerId"),
        ),
      ).toBe(true)
    })
  })

  // =========================================================================
  // multi-peer scenarios
  // =========================================================================

  describe("multi-peer scenarios", () => {
    it("multiple peers can coexist independently", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob on channel 1 and carol on channel 2
      ;[model] = establishChannel(update, model, 1, bob)
      ;[model] = establishChannel(update, model, 2, carol)

      expect(model.peers.size).toBe(2)
      expect(model.peers.has("bob")).toBe(true)
      expect(model.peers.has("carol")).toBe(true)

      // Remove bob's channel
      const [m, _effect, notification] = update(
        { type: "sess/channel-removed", channelId: 1 },
        model,
      )

      // Bob disconnected, carol unaffected
      expect(defined(m.peers.get("bob")).channels.size).toBe(0)
      expect(defined(m.peers.get("carol")).channels.size).toBe(1)

      expect(notification).toEqual({
        type: "notify/peer-disconnected",
        peer: bob,
      })
    })

    it("departure timer for one peer does not affect another", () => {
      const update = makeUpdate()
      let model = initSession(alice)

      // Establish bob and carol
      ;[model] = establishChannel(update, model, 1, bob)
      ;[model] = establishChannel(update, model, 2, carol)

      // Disconnect both
      ;[model] = update({ type: "sess/channel-removed", channelId: 1 }, model)
      ;[model] = update({ type: "sess/channel-removed", channelId: 2 }, model)

      // Fire bob's departure timer
      const [m] = update(
        { type: "sess/departure-timer-expired", peerId: "bob" },
        model,
      )

      // Bob gone, carol still disconnected
      expect(m.peers.has("bob")).toBe(false)
      expect(m.peers.has("carol")).toBe(true)
      expect(defined(m.peers.get("carol")).channels.size).toBe(0)
    })
  })

  // =========================================================================
  // immutability
  // =========================================================================

  describe("immutability", () => {
    it("update does not mutate the original model", () => {
      const update = makeUpdate()
      const model = initSession(alice)
      const channelsBefore = model.channels.size
      const peersBefore = model.peers.size

      // Add a channel
      const [m1] = update(
        { type: "sess/channel-added", channelId: 1, transportType: "test" },
        model,
      )

      // Original model is unmodified
      expect(model.channels.size).toBe(channelsBefore)
      expect(model.peers.size).toBe(peersBefore)
      expect(m1.channels.size).toBe(1)
    })

    it("establish does not mutate peer channels set", () => {
      const update = makeUpdate()
      let model = initSession(alice)
      ;[model] = establishChannel(update, model, 1, bob)

      const channelsBefore = new Set(defined(model.peers.get("bob")).channels)

      // Add another channel for bob
      ;[model] = establishChannel(update, model, 2, bob)

      // Original set was not mutated
      expect(channelsBefore.size).toBe(1)
      expect(channelsBefore.has(1)).toBe(true)
      expect(channelsBefore.has(2)).toBe(false)
    })
  })
})
