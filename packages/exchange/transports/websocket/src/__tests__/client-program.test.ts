// client-program.test — deterministic tests for the websocket client connection
// lifecycle state machine.
//
// Every status × event combination is tested. Pure data in, pure data out —
// no sockets, no timing, never flaky.

import { describe, expect, it } from "vitest"
import { createWsClientProgram, type WsClientMsg } from "../client-program.js"
import type { WebsocketClientState } from "../types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(opts: { maxAttempts?: number; enabled?: boolean } = {}) {
  const program = createWsClientProgram({
    jitterFn: () => 0,
    reconnect: {
      enabled: opts.enabled ?? true,
      maxAttempts: opts.maxAttempts ?? 10,
      baseDelay: 1000,
      maxDelay: 30000,
    },
  })
  return { program, update: program.update }
}

// Canonical model values for each status
const disconnected: WebsocketClientState = { status: "disconnected" }
const connecting: WebsocketClientState = { status: "connecting", attempt: 1 }
const connected: WebsocketClientState = { status: "connected" }
const ready: WebsocketClientState = { status: "ready" }
const reconnecting: WebsocketClientState = {
  status: "reconnecting",
  attempt: 2,
  nextAttemptMs: 2000,
}

const err = new Error("boom")

// computeBackoffDelay(attempt, 1000, 30000, 0) = min(1000 * 2^(attempt-1), 30000)
// tryReconnect(currentAttempt, ...) → attempt = currentAttempt + 1,
//   delay = computeBackoffDelay(currentAttempt + 1, 1000, 30000, 0)

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

describe("ws client program — init", () => {
  it("starts disconnected with no effects", () => {
    const { program } = setup()
    const [model, ...effects] = program.init

    expect(model).toEqual({ status: "disconnected" })
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe("ws client program — start", () => {
  it("while disconnected → connecting(attempt: 1) + create-websocket effect", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, disconnected)

    expect(model).toEqual({ status: "connecting", attempt: 1 })
    expect(effects).toEqual([{ type: "create-websocket", attempt: 1 }])
  })

  it("while connecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, connecting)

    expect(model).toEqual(connecting)
    expect(effects).toEqual([])
  })

  it("while connected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, connected)

    expect(model).toEqual(connected)
    expect(effects).toEqual([])
  })

  it("while ready → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, ready)

    expect(model).toEqual(ready)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, reconnecting)

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// socket-opened
// ---------------------------------------------------------------------------

describe("ws client program — socket-opened", () => {
  it("while connecting → connected + start-keepalive (NOT add-channel-and-establish)", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "socket-opened" }, connecting)

    expect(model).toEqual({ status: "connected" })
    expect(effects).toEqual([{ type: "start-keepalive" }])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "socket-opened" }, disconnected)

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while connected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "socket-opened" }, connected)

    expect(model).toEqual(connected)
    expect(effects).toEqual([])
  })

  it("while ready → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "socket-opened" }, ready)

    expect(model).toEqual(ready)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "socket-opened" }, reconnecting)

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// server-ready
// ---------------------------------------------------------------------------

describe("ws client program — server-ready", () => {
  it("while connected → ready + add-channel-and-establish", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "server-ready" }, connected)

    expect(model).toEqual({ status: "ready" })
    expect(effects).toEqual([{ type: "add-channel-and-establish" }])
  })

  it("while connecting (race condition) → ready + start-keepalive + add-channel-and-establish", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "server-ready" }, connecting)

    expect(model).toEqual({ status: "ready" })
    expect(effects).toEqual([
      { type: "start-keepalive" },
      { type: "add-channel-and-establish" },
    ])
  })

  it("while already ready → no change (duplicate ignored)", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "server-ready" }, ready)

    expect(model).toEqual(ready)
    expect(effects).toEqual([])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "server-ready" }, disconnected)

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "server-ready" }, reconnecting)

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// socket-closed
// ---------------------------------------------------------------------------

describe("ws client program — socket-closed", () => {
  it("while connected → stop-keepalive + reconnecting + start-reconnect-timer", () => {
    const { update } = setup()
    // tryReconnect(0, ...) → attempt = 1, delay = 1000
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1006, reason: "abnormal" },
      connected,
    )

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(effects).toEqual([
      { type: "stop-keepalive" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("while ready → stop-keepalive + remove-channel + reconnecting + start-reconnect-timer", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1006, reason: "abnormal" },
      ready,
    )

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(effects).toEqual([
      { type: "stop-keepalive" },
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1000, reason: "normal" },
      disconnected,
    )

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while connecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1000, reason: "normal" },
      connecting,
    )

    expect(model).toEqual(connecting)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1000, reason: "normal" },
      reconnecting,
    )

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// socket-error
// ---------------------------------------------------------------------------

describe("ws client program — socket-error", () => {
  it("while connecting, attempts < max → reconnecting + start-reconnect-timer", () => {
    const { update } = setup()
    // connecting with attempt: 1, tryReconnect(1, ...) →
    //   attempt = 2, delay = computeBackoffDelay(2, 1000, 30000, 0) = 2000
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      connecting,
    )

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 2,
      nextAttemptMs: 2000,
    })
    expect(effects).toEqual([{ type: "start-reconnect-timer", delayMs: 2000 }])
  })

  it("while connecting, attempts >= max → disconnected (max-retries-exceeded)", () => {
    const { update } = setup({ maxAttempts: 3 })
    const atMax: WebsocketClientState = { status: "connecting", attempt: 3 }
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      atMax,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 3 },
    })
    expect(effects).toEqual([])
  })

  it("while connected → stop-keepalive + reconnecting + start-reconnect-timer", () => {
    const { update } = setup()
    // tryReconnect(0, ...) → attempt = 1, delay = 1000
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      connected,
    )

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(effects).toEqual([
      { type: "stop-keepalive" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("while ready → stop-keepalive + remove-channel + reconnecting + start-reconnect-timer", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      ready,
    )

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(effects).toEqual([
      { type: "stop-keepalive" },
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      disconnected,
    )

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      reconnecting,
    )

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconnect-timer-fired
// ---------------------------------------------------------------------------

describe("ws client program — reconnect-timer-fired", () => {
  it("while reconnecting → connecting with attempt carried forward + create-websocket", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "reconnect-timer-fired" },
      reconnecting, // attempt: 2
    )

    expect(model).toEqual({ status: "connecting", attempt: 2 })
    expect(effects).toEqual([{ type: "create-websocket", attempt: 2 }])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "reconnect-timer-fired" },
      disconnected,
    )

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while connecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "reconnect-timer-fired" },
      connecting,
    )

    expect(model).toEqual(connecting)
    expect(effects).toEqual([])
  })

  it("while connected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "reconnect-timer-fired" },
      connected,
    )

    expect(model).toEqual(connected)
    expect(effects).toEqual([])
  })

  it("while ready → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "reconnect-timer-fired" }, ready)

    expect(model).toEqual(ready)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("ws client program — stop", () => {
  it("while ready → disconnected(intentional) + cancel-reconnect-timer + close-websocket + stop-keepalive + remove-channel", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, ready)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(effects).toEqual([
      { type: "cancel-reconnect-timer" },
      { type: "close-websocket" },
      { type: "stop-keepalive" },
      { type: "remove-channel" },
    ])
  })

  it("while connected → disconnected(intentional) + cancel-reconnect-timer + close-websocket + stop-keepalive", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, connected)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(effects).toEqual([
      { type: "cancel-reconnect-timer" },
      { type: "close-websocket" },
      { type: "stop-keepalive" },
    ])
  })

  it("while connecting → disconnected(intentional) + cancel-reconnect-timer + close-websocket", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, connecting)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(effects).toEqual([
      { type: "cancel-reconnect-timer" },
      { type: "close-websocket" },
    ])
  })

  it("while reconnecting → disconnected(intentional) + cancel-reconnect-timer", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, reconnecting)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(effects).toEqual([{ type: "cancel-reconnect-timer" }])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, disconnected)

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reconnect disabled
// ---------------------------------------------------------------------------

describe("ws client program — reconnect disabled", () => {
  it("socket-error while connecting → disconnected (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      connecting,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "error", error: err },
    })
    expect(effects).toEqual([])
  })

  it("socket-error while connected → disconnected + stop-keepalive (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      connected,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "error", error: err },
    })
    expect(effects).toEqual([{ type: "stop-keepalive" }])
  })

  it("socket-error while ready → disconnected + stop-keepalive + remove-channel (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "socket-error", error: err },
      ready,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "error", error: err },
    })
    expect(effects).toEqual([
      { type: "stop-keepalive" },
      { type: "remove-channel" },
    ])
  })

  it("socket-closed while connected → disconnected + stop-keepalive (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1000, reason: "normal" },
      connected,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "closed", code: 1000, reason: "normal" },
    })
    expect(effects).toEqual([{ type: "stop-keepalive" }])
  })

  it("socket-closed while ready → disconnected + stop-keepalive + remove-channel (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "socket-closed", code: 1000, reason: "normal" },
      ready,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "closed", code: 1000, reason: "normal" },
    })
    expect(effects).toEqual([
      { type: "stop-keepalive" },
      { type: "remove-channel" },
    ])
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("ws client program — full lifecycle", () => {
  it("start → open → ready → close → reconnect → open → ready → stop", () => {
    const { program, update } = setup()

    // 1. Init: disconnected, no effects
    const [m0, ...fx0] = program.init
    expect(m0).toEqual({ status: "disconnected" })
    expect(fx0).toEqual([])

    // 2. Start → connecting
    const [m1, ...fx1] = update({ type: "start" }, m0)
    expect(m1).toEqual({ status: "connecting", attempt: 1 })
    expect(fx1).toEqual([{ type: "create-websocket", attempt: 1 }])

    // 3. Socket opened → connected + start-keepalive
    const [m2, ...fx2] = update({ type: "socket-opened" }, m1)
    expect(m2).toEqual({ status: "connected" })
    expect(fx2).toEqual([{ type: "start-keepalive" }])

    // 4. Server ready → ready + add-channel-and-establish
    const [m3, ...fx3] = update({ type: "server-ready" }, m2)
    expect(m3).toEqual({ status: "ready" })
    expect(fx3).toEqual([{ type: "add-channel-and-establish" }])

    // 5. Socket closed → reconnecting + stop-keepalive + remove-channel
    //    tryReconnect(0, ...) → attempt=1, delay=1000
    const [m4, ...fx4] = update(
      { type: "socket-closed", code: 1006, reason: "abnormal" },
      m3,
    )
    expect(m4).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(fx4).toEqual([
      { type: "stop-keepalive" },
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])

    // 6. Reconnect timer fires → connecting(attempt: 1)
    const [m5, ...fx5] = update({ type: "reconnect-timer-fired" }, m4)
    expect(m5).toEqual({ status: "connecting", attempt: 1 })
    expect(fx5).toEqual([{ type: "create-websocket", attempt: 1 }])

    // 7. Socket opened again → connected + start-keepalive
    const [m6, ...fx6] = update({ type: "socket-opened" }, m5)
    expect(m6).toEqual({ status: "connected" })
    expect(fx6).toEqual([{ type: "start-keepalive" }])

    // 8. Server ready again → ready + add-channel-and-establish
    const [m7, ...fx7] = update({ type: "server-ready" }, m6)
    expect(m7).toEqual({ status: "ready" })
    expect(fx7).toEqual([{ type: "add-channel-and-establish" }])

    // 9. Stop → disconnected(intentional) + cleanup
    const [m8, ...fx8] = update({ type: "stop" }, m7)
    expect(m8).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(fx8).toEqual([
      { type: "cancel-reconnect-timer" },
      { type: "close-websocket" },
      { type: "stop-keepalive" },
      { type: "remove-channel" },
    ])
  })

  it("race condition lifecycle: start → server-ready (before open) → close → reconnect", () => {
    const { program, update } = setup()

    const [m0] = program.init

    // 1. Start → connecting
    const [m1, ...fx1] = update({ type: "start" }, m0)
    expect(m1).toEqual({ status: "connecting", attempt: 1 })
    expect(fx1).toEqual([{ type: "create-websocket", attempt: 1 }])

    // 2. Server sends ready BEFORE open fires → skip connected, go to ready
    const [m2, ...fx2] = update({ type: "server-ready" }, m1)
    expect(m2).toEqual({ status: "ready" })
    expect(fx2).toEqual([
      { type: "start-keepalive" },
      { type: "add-channel-and-establish" },
    ])

    // 3. Socket closed → reconnecting + stop-keepalive + remove-channel
    const [m3, ...fx3] = update(
      { type: "socket-closed", code: 1006, reason: "abnormal" },
      m2,
    )
    expect(m3).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(fx3).toEqual([
      { type: "stop-keepalive" },
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("repeated connection errors escalate backoff until max retries", () => {
    const { program, update } = setup({ maxAttempts: 3 })

    // Start
    const [m0] = program.init
    const [m1] = update({ type: "start" }, m0)
    expect(m1).toEqual({ status: "connecting", attempt: 1 })

    // First error: attempt 1, tryReconnect(1) → attempt=2, delay=computeBackoffDelay(2)=2000
    const [m2, ...fx2] = update({ type: "socket-error", error: err }, m1)
    expect(m2).toEqual({
      status: "reconnecting",
      attempt: 2,
      nextAttemptMs: 2000,
    })
    expect(fx2).toEqual([{ type: "start-reconnect-timer", delayMs: 2000 }])

    // Timer fires → connecting(attempt: 2)
    const [m3] = update({ type: "reconnect-timer-fired" }, m2)
    expect(m3).toEqual({ status: "connecting", attempt: 2 })

    // Second error: attempt 2, tryReconnect(2) → attempt=3, delay=computeBackoffDelay(3)=4000
    const [m4, ...fx4] = update({ type: "socket-error", error: err }, m3)
    expect(m4).toEqual({
      status: "reconnecting",
      attempt: 3,
      nextAttemptMs: 4000,
    })
    expect(fx4).toEqual([{ type: "start-reconnect-timer", delayMs: 4000 }])

    // Timer fires → connecting(attempt: 3)
    const [m5] = update({ type: "reconnect-timer-fired" }, m4)
    expect(m5).toEqual({ status: "connecting", attempt: 3 })

    // Third error: attempt 3 >= maxAttempts 3 → disconnected
    const [m6, ...fx6] = update({ type: "socket-error", error: err }, m5)
    expect(m6).toEqual({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 3 },
    })
    expect(fx6).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Disconnected absorbs non-start messages
// ---------------------------------------------------------------------------

describe("ws client program — disconnected absorbs non-start messages", () => {
  const messages: WsClientMsg[] = [
    { type: "socket-opened" },
    { type: "server-ready" },
    { type: "socket-closed", code: 1000, reason: "normal" },
    { type: "socket-error", error: err },
    { type: "reconnect-timer-fired" },
    { type: "stop" },
  ]

  for (const msg of messages) {
    it(`${msg.type} while disconnected → no change`, () => {
      const { update } = setup()
      const [model, ...effects] = update(msg, disconnected)
      expect(model).toEqual(disconnected)
      expect(effects).toEqual([])
    })
  }
})
