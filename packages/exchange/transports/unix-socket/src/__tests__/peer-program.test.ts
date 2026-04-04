// peer-program.test — deterministic tests for the peer negotiation state machine.
//
// Every state × event combination is tested. Pure data in, pure data out —
// no sockets, no timing, never flaky.

import { describe, expect, it } from "vitest"
import {
  createPeerProgram,
  type PeerModel,
  type PeerMsg,
} from "../peer-program.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATH = "/tmp/test.sock"
const RETRY_MS = 200

function setup(retryDelayMs = RETRY_MS) {
  const program = createPeerProgram({ path: PATH, retryDelayMs })
  return { program, update: program.update }
}

const negotiating: PeerModel = { role: "negotiating", transportId: undefined }
const listener: PeerModel = { role: "listener", transportId: "t1" }
const connector: PeerModel = { role: "connector", transportId: "t2" }
const disposed: PeerModel = { role: "disposed", transportId: undefined }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

describe("peer program — init", () => {
  it("starts negotiating with a probe effect", () => {
    const { program } = setup()
    const [model, ...effects] = program.init

    expect(model).toEqual({ role: "negotiating", transportId: undefined })
    expect(effects).toEqual([{ type: "probe", path: PATH }])
  })
})

// ---------------------------------------------------------------------------
// Probe results (while negotiating)
// ---------------------------------------------------------------------------

describe("peer program — probe-result", () => {
  it('"connected" → start-connector', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "connected" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "start-connector", path: PATH, reconnect: undefined },
    ])
  })

  it('"enoent" → start-listener', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "enoent" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([{ type: "start-listener", path: PATH }])
  })

  it('"econnrefused" → start-listener', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "econnrefused" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([{ type: "start-listener", path: PATH }])
  })

  it('"eaddrinuse" → delay-then-probe', () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "eaddrinuse" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "delay-then-probe", ms: RETRY_MS, path: PATH },
    ])
  })

  it("probe-result while listener → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "probe-result", result: "connected" },
      listener,
    )
    expect(model).toEqual(listener)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Transport lifecycle
// ---------------------------------------------------------------------------

describe("peer program — transport-added", () => {
  it("as listener → role is listener", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "transport-added", transportId: "t1", role: "listener" },
      negotiating,
    )
    expect(model).toEqual({ role: "listener", transportId: "t1" })
    expect(effects).toEqual([])
  })

  it("as connector → role is connector", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "transport-added", transportId: "t2", role: "connector" },
      negotiating,
    )
    expect(model).toEqual({ role: "connector", transportId: "t2" })
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Listen failed
// ---------------------------------------------------------------------------

describe("peer program — listen-failed", () => {
  it("→ negotiating + delay-then-probe", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "listen-failed" }, negotiating)
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "delay-then-probe", ms: RETRY_MS, path: PATH },
    ])
  })
})

// ---------------------------------------------------------------------------
// Transport disconnected (healing)
// ---------------------------------------------------------------------------

describe("peer program — transport-disconnected", () => {
  it("while connector → remove-transport + probe (healing)", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "transport-disconnected" },
      connector,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "remove-transport", transportId: "t2" },
      { type: "probe", path: PATH },
    ])
  })

  it("while listener → remove-transport + probe", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "transport-disconnected" },
      listener,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([
      { type: "remove-transport", transportId: "t1" },
      { type: "probe", path: PATH },
    ])
  })

  it("while negotiating → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "transport-disconnected" },
      negotiating,
    )
    expect(model).toEqual(negotiating)
    expect(effects).toEqual([])
  })

  it("while disposed → no change", () => {
    const { update } = setup()
    const [model, ...effects] = update(
      { type: "transport-disconnected" },
      disposed,
    )
    expect(model).toEqual(disposed)
    expect(effects).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("peer program — dispose", () => {
  it("while negotiating → disposed, no transport to remove", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "dispose" }, negotiating)
    expect(model).toEqual(disposed)
    expect(effects).toEqual([])
  })

  it("while listener → disposed + remove-transport", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "dispose" }, listener)
    expect(model).toEqual(disposed)
    expect(effects).toEqual([{ type: "remove-transport", transportId: "t1" }])
  })

  it("while connector → disposed + remove-transport", () => {
    const { update } = setup()
    const [model, ...effects] = update({ type: "dispose" }, connector)
    expect(model).toEqual(disposed)
    expect(effects).toEqual([{ type: "remove-transport", transportId: "t2" }])
  })
})

// ---------------------------------------------------------------------------
// Disposed absorbs all messages
// ---------------------------------------------------------------------------

describe("peer program — disposed state absorbs all", () => {
  const messages: PeerMsg[] = [
    { type: "probe-result", result: "connected" },
    { type: "transport-added", transportId: "x", role: "listener" },
    { type: "listen-failed" },
    { type: "transport-disconnected" },
    { type: "dispose" },
  ]

  for (const msg of messages) {
    it(`${msg.type} while disposed → no change`, () => {
      const { update } = setup()
      const [model, ...effects] = update(msg, disposed)
      expect(model).toEqual(disposed)
      expect(effects).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Multi-step lifecycle sequence
// ---------------------------------------------------------------------------

describe("peer program — lifecycle sequence", () => {
  it("init → probe → listener → disconnect → re-probe → connector → dispose", () => {
    const { program, update } = setup()

    // 1. Init: negotiating + probe
    const [m0, ...fx0] = program.init
    expect(m0.role).toBe("negotiating")
    expect(fx0).toEqual([{ type: "probe", path: PATH }])

    // 2. Probe finds no socket → start listener
    const [m1, ...fx1] = update({ type: "probe-result", result: "enoent" }, m0)
    expect(fx1[0]).toEqual({ type: "start-listener", path: PATH })

    // 3. Listener added
    const [m2, ...fx2] = update(
      { type: "transport-added", transportId: "srv-1", role: "listener" },
      m1,
    )
    expect(m2).toEqual({ role: "listener", transportId: "srv-1" })
    expect(fx2).toEqual([])

    // 4. Listener dies → remove old transport + re-probe
    const [m3, ...fx3] = update({ type: "transport-disconnected" }, m2)
    expect(m3.role).toBe("negotiating")
    expect(m3.transportId).toBeUndefined()
    expect(fx3).toEqual([
      { type: "remove-transport", transportId: "srv-1" },
      { type: "probe", path: PATH },
    ])

    // 5. Re-probe finds a new listener → become connector
    const [m4, ...fx4] = update(
      { type: "probe-result", result: "connected" },
      m3,
    )
    expect(fx4[0]).toMatchObject({ type: "start-connector" })

    // 6. Connector added
    const [m5, ...fx5] = update(
      { type: "transport-added", transportId: "cli-1", role: "connector" },
      m4,
    )
    expect(m5).toEqual({ role: "connector", transportId: "cli-1" })
    expect(fx5).toEqual([])

    // 7. Dispose while connector → remove transport
    const [m6, ...fx6] = update({ type: "dispose" }, m5)
    expect(m6).toEqual({ role: "disposed", transportId: undefined })
    expect(fx6).toEqual([{ type: "remove-transport", transportId: "cli-1" }])

    // 8. Further messages are absorbed
    const [m7, ...fx7] = update(
      { type: "probe-result", result: "connected" },
      m6,
    )
    expect(m7).toEqual(m6)
    expect(fx7).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reconnect options pass-through
// ---------------------------------------------------------------------------

describe("peer program — reconnect options", () => {
  it("passes reconnect options to start-connector effect", () => {
    const reconnect = { maxAttempts: 3, baseDelay: 50, maxDelay: 100 }
    const program = createPeerProgram({ path: PATH, reconnect })
    const [, ...effects] = program.update(
      { type: "probe-result", result: "connected" },
      negotiating,
    )
    expect(effects).toEqual([
      { type: "start-connector", path: PATH, reconnect },
    ])
  })
})
