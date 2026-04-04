// client-program.test — deterministic tests for the client connection lifecycle
// state machine.
//
// Every status × event combination is tested. Pure data in, pure data out —
// no sockets, no timing, never flaky.

import { describe, expect, it } from "vitest"
import {
  createUnixSocketClientProgram,
  type UnixSocketClientMsg,
} from "../client-program.js"
import type { UnixSocketClientState } from "../types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATH = "/tmp/test.sock"

function setup(opts: { maxAttempts?: number; enabled?: boolean } = {}) {
  const program = createUnixSocketClientProgram({
    path: PATH,
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
const disconnected: UnixSocketClientState = { status: "disconnected" }
const connecting: UnixSocketClientState = { status: "connecting", attempt: 1 }
const connected: UnixSocketClientState = { status: "connected" }
const reconnecting: UnixSocketClientState = {
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

describe("client program — init", () => {
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

describe("client program — start", () => {
  it("while disconnected → connecting(attempt: 1) + connect effect", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, disconnected)

    expect(model).toEqual({ status: "connecting", attempt: 1 })
    expect(effects).toEqual([{ type: "connect", path: PATH, attempt: 1 }])
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

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "start" }, reconnecting)

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// connection-opened
// ---------------------------------------------------------------------------

describe("client program — connection-opened", () => {
  it("while connecting → connected + add-channel-and-establish", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-opened" },
      connecting,
    )

    expect(model).toEqual({ status: "connected" })
    expect(effects).toEqual([{ type: "add-channel-and-establish" }])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-opened" },
      disconnected,
    )

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while connected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "connection-opened" }, connected)

    expect(model).toEqual(connected)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-opened" },
      reconnecting,
    )

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// connection-error
// ---------------------------------------------------------------------------

describe("client program — connection-error", () => {
  it("while connecting, attempts < max → reconnecting + start-reconnect-timer", () => {
    const { update } = setup()
    // connecting with attempt: 1, tryReconnect(1, ...) →
    //   attempt = 2, delay = computeBackoffDelay(2, 1000, 30000, 0) = 2000
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
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
    const atMax: UnixSocketClientState = { status: "connecting", attempt: 3 }
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
      atMax,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 3 },
    })
    expect(effects).toEqual([])
  })

  it("while connecting, preserves errno on disconnect reason", () => {
    const { update } = setup({ maxAttempts: 1 })
    const [model] = update(
      { type: "connection-error", error: err, errno: "ECONNREFUSED" },
      connecting,
    )

    // attempts >= max → disconnected, but the reason still carries errno
    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "max-retries-exceeded", attempts: 1 },
    })
  })

  it("while connected → reconnecting + remove-channel + start-reconnect-timer", () => {
    const { update } = setup()
    // tryReconnect(0, ...) → attempt = 1,
    //   delay = computeBackoffDelay(1, 1000, 30000, 0) = 1000
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
      connected,
    )

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(effects).toEqual([
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
      disconnected,
    )

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
      reconnecting,
    )

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// connection-closed
// ---------------------------------------------------------------------------

describe("client program — connection-closed", () => {
  it("while connected → reconnecting + remove-channel + start-reconnect-timer", () => {
    const { update } = setup()
    // tryReconnect(0, { type: "closed" }, remove-channel) →
    //   attempt = 1, delay = 1000
    const [model, ...effects] = update({ type: "connection-closed" }, connected)

    expect(model).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(effects).toEqual([
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])
  })

  it("while disconnected → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-closed" },
      disconnected,
    )

    expect(model).toEqual(disconnected)
    expect(effects).toEqual([])
  })

  it("while connecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-closed" },
      connecting,
    )

    expect(model).toEqual(connecting)
    expect(effects).toEqual([])
  })

  it("while reconnecting → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "connection-closed" },
      reconnecting,
    )

    expect(model).toEqual(reconnecting)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// reconnect-timer-fired
// ---------------------------------------------------------------------------

describe("client program — reconnect-timer-fired", () => {
  it("while reconnecting → connecting with attempt carried forward + connect", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "reconnect-timer-fired" },
      reconnecting, // attempt: 2
    )

    expect(model).toEqual({ status: "connecting", attempt: 2 })
    expect(effects).toEqual([{ type: "connect", path: PATH, attempt: 2 }])
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
})

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe("client program — stop", () => {
  it("while connected → disconnected(intentional) + cancel-reconnect-timer + close-connection + remove-channel", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, connected)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(effects).toEqual([
      { type: "cancel-reconnect-timer" },
      { type: "close-connection" },
      { type: "remove-channel" },
    ])
  })

  it("while connecting → disconnected(intentional) + cancel-reconnect-timer", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "stop" }, connecting)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(effects).toEqual([{ type: "cancel-reconnect-timer" }])
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

describe("client program — reconnect disabled", () => {
  it("connection-error while connecting → disconnected (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
      connecting,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "error", error: err },
    })
    expect(effects).toEqual([])
  })

  it("connection-error while connected → disconnected + remove-channel (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update(
      { type: "connection-error", error: err },
      connected,
    )

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "error", error: err },
    })
    expect(effects).toEqual([{ type: "remove-channel" }])
  })

  it("connection-closed while connected → disconnected + remove-channel (no reconnecting state)", () => {
    const { update } = setup({ enabled: false })
    const [model, ...effects] = update({ type: "connection-closed" }, connected)

    expect(model).toEqual({
      status: "disconnected",
      reason: { type: "closed" },
    })
    expect(effects).toEqual([{ type: "remove-channel" }])
  })
})

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("client program — full lifecycle", () => {
  it("start → connect → close → reconnect → connect → stop", () => {
    const { program, update } = setup()

    // 1. Init: disconnected, no effects
    const [m0, ...fx0] = program.init
    expect(m0).toEqual({ status: "disconnected" })
    expect(fx0).toEqual([])

    // 2. Start → connecting
    const [m1, ...fx1] = update({ type: "start" }, m0)
    expect(m1).toEqual({ status: "connecting", attempt: 1 })
    expect(fx1).toEqual([{ type: "connect", path: PATH, attempt: 1 }])

    // 3. Connection opened → connected
    const [m2, ...fx2] = update({ type: "connection-opened" }, m1)
    expect(m2).toEqual({ status: "connected" })
    expect(fx2).toEqual([{ type: "add-channel-and-establish" }])

    // 4. Connection closed → reconnecting
    //    tryReconnect(0, ...) → attempt=1, delay=1000
    const [m3, ...fx3] = update({ type: "connection-closed" }, m2)
    expect(m3).toEqual({
      status: "reconnecting",
      attempt: 1,
      nextAttemptMs: 1000,
    })
    expect(fx3).toEqual([
      { type: "remove-channel" },
      { type: "start-reconnect-timer", delayMs: 1000 },
    ])

    // 5. Reconnect timer fires → connecting(attempt: 1)
    const [m4, ...fx4] = update({ type: "reconnect-timer-fired" }, m3)
    expect(m4).toEqual({ status: "connecting", attempt: 1 })
    expect(fx4).toEqual([{ type: "connect", path: PATH, attempt: 1 }])

    // 6. Connection opened again → connected
    const [m5, ...fx5] = update({ type: "connection-opened" }, m4)
    expect(m5).toEqual({ status: "connected" })
    expect(fx5).toEqual([{ type: "add-channel-and-establish" }])

    // 7. Stop → disconnected(intentional) + cleanup
    const [m6, ...fx6] = update({ type: "stop" }, m5)
    expect(m6).toEqual({
      status: "disconnected",
      reason: { type: "intentional" },
    })
    expect(fx6).toEqual([
      { type: "cancel-reconnect-timer" },
      { type: "close-connection" },
      { type: "remove-channel" },
    ])

    // 8. Further messages absorbed
    const [m7, ...fx7] = update({ type: "start" }, m6)
    expect(m7).toEqual({ status: "connecting", attempt: 1 })
    expect(fx7).toEqual([{ type: "connect", path: PATH, attempt: 1 }])
  })

  it("repeated connection errors escalate backoff until max retries", () => {
    const { program, update } = setup({ maxAttempts: 3 })

    // Start
    const [m0] = program.init
    const [m1] = update({ type: "start" }, m0)
    expect(m1).toEqual({ status: "connecting", attempt: 1 })

    // First error: attempt 1, tryReconnect(1) → attempt=2, delay=computeBackoffDelay(2)=2000
    const [m2, ...fx2] = update({ type: "connection-error", error: err }, m1)
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
    const [m4, ...fx4] = update({ type: "connection-error", error: err }, m3)
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
    const [m6, ...fx6] = update({ type: "connection-error", error: err }, m5)
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

describe("client program — disconnected absorbs non-start messages", () => {
  const messages: UnixSocketClientMsg[] = [
    { type: "connection-opened" },
    { type: "connection-closed" },
    { type: "connection-error", error: err },
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
