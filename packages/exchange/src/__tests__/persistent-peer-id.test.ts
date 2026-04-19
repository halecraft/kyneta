// persistent-peer-id — unit tests for the per-tab unique peerId lease protocol.
//
// Tests are split into two groups following the FC/IS architecture:
//
//   1. resolveLease (functional core) — pure decision function, no mocks needed
//   2. persistentPeerId / releasePeerId (imperative shell) — Map-backed storage mocks

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { LeaseState } from "../persistent-peer-id.js"
import {
  persistentPeerId,
  releasePeerId,
  resolveLease,
} from "../persistent-peer-id.js"

// ---------------------------------------------------------------------------
// Storage mocks — Map-backed shims for localStorage and sessionStorage
// ---------------------------------------------------------------------------

const local = new Map<string, string>()
const session = new Map<string, string>()

function createStorageShim(backing: Map<string, string>): Storage {
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => backing.set(key, value),
    removeItem: (key: string) => {
      backing.delete(key)
    },
    clear: () => backing.clear(),
    get length() {
      return backing.size
    },
    key: (_index: number) => null,
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: createStorageShim(local),
  configurable: true,
})

Object.defineProperty(globalThis, "sessionStorage", {
  value: createStorageShim(session),
  configurable: true,
})

// ---------------------------------------------------------------------------
// pagehide listener tracking — standalone mock (no real addEventListener in Node)
// ---------------------------------------------------------------------------

const pagehideListeners: EventListener[] = []

globalThis.addEventListener = ((
  type: string,
  listener: EventListenerOrEventListenerObject,
) => {
  if (type === "pagehide") {
    pagehideListeners.push(listener as EventListener)
  }
}) as typeof globalThis.addEventListener

function dispatchPagehide() {
  const event = new Event("pagehide")
  for (const listener of pagehideListeners) {
    listener(event)
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  local.clear()
  session.clear()
})

afterEach(() => {
  pagehideListeners.length = 0
})

// ═══════════════════════════════════════════════════════════════════════════
// Functional Core: resolveLease
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveLease", () => {
  const base: LeaseState = {
    devicePeerId: "abcdef0123456789",
    sessionToken: "my-session-token",
    cachedPeerId: null,
    holder: null,
    casReadback: null,
  }

  it("cached peerId returned immediately", () => {
    const decision = resolveLease({
      ...base,
      cachedPeerId: "cached-peer-id-00",
    })
    expect(decision).toEqual({ action: "cached", peerId: "cached-peer-id-00" })
  })

  it("cached peerId takes priority over everything else", () => {
    const decision = resolveLease({
      ...base,
      cachedPeerId: "cached-peer-id-00",
      holder: "foreign-token",
      casReadback: "foreign-token",
    })
    expect(decision).toEqual({ action: "cached", peerId: "cached-peer-id-00" })
  })

  it("holder matches our token → claim-primary", () => {
    const decision = resolveLease({
      ...base,
      holder: "my-session-token",
    })
    expect(decision).toEqual({
      action: "claim-primary",
      peerId: "abcdef0123456789",
    })
  })

  it("CAS won — holder null, readback matches our token", () => {
    const decision = resolveLease({
      ...base,
      holder: null,
      casReadback: "my-session-token",
    })
    expect(decision).toEqual({
      action: "claim-primary",
      peerId: "abcdef0123456789",
    })
  })

  it("CAS lost — holder null, readback is foreign", () => {
    const decision = resolveLease({
      ...base,
      holder: null,
      casReadback: "other-tab-token",
    })
    expect(decision).toEqual({ action: "generate-fresh" })
  })

  it("foreign holder → generate-fresh", () => {
    const decision = resolveLease({
      ...base,
      holder: "foreign-holder-token",
    })
    expect(decision).toEqual({ action: "generate-fresh" })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Imperative Shell: persistentPeerId / releasePeerId
// ═══════════════════════════════════════════════════════════════════════════

describe("persistentPeerId", () => {
  it("returns a 16-char hex string", () => {
    const id = persistentPeerId("test-key")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("reload stability — calling twice in the same tab returns the same value", () => {
    const first = persistentPeerId("stable-key")
    const second = persistentPeerId("stable-key")
    expect(first).toBe(second)
  })

  it("different keys produce different peerIds", () => {
    const a = persistentPeerId("key-a")
    const b = persistentPeerId("key-b")
    expect(a).not.toBe(b)
  })

  it("first tab gets the device peerId", () => {
    // No holder exists — first tab should win the CAS and get the device peerId.
    const id = persistentPeerId("primary-test")
    const devicePeerId = local.get("primary-test")
    expect(id).toBe(devicePeerId)
  })

  it("second tab gets a fresh peerId (different from device)", () => {
    // Simulate a foreign tab already holding the lease.
    local.set("second-tab-test", "device-peer-id-00")
    local.set("second-tab-test:held", "foreign-tab-session-token")

    const id = persistentPeerId("second-tab-test")

    // Should NOT be the device peerId — a fresh one was generated.
    expect(id).not.toBe("device-peer-id-00")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("releasePeerId clears holder only", () => {
    const id = persistentPeerId("release-test")

    // Verify holder is set.
    expect(local.get("release-test:held")).toBeTruthy()
    // Verify sessionStorage keys exist.
    expect(session.get("release-test")).toBe(id)
    expect(session.get("release-test:tk")).toBeTruthy()

    releasePeerId("release-test")

    // Holder is cleared.
    expect(local.get("release-test:held")).toBeUndefined()
    // sessionStorage keys survive.
    expect(session.get("release-test")).toBe(id)
    expect(session.get("release-test:tk")).toBeTruthy()
  })

  it("release is idempotent — no throw when not holding", () => {
    expect(() => releasePeerId("nonexistent-key")).not.toThrow()
    expect(() => releasePeerId("nonexistent-key")).not.toThrow()
  })

  it("after release, next call returns cached peerId from sessionStorage", () => {
    const first = persistentPeerId("cache-after-release")

    releasePeerId("cache-after-release")

    // sessionStorage still has the cached peerId — resolveLease returns "cached".
    const second = persistentPeerId("cache-after-release")
    expect(second).toBe(first)
  })

  it("pagehide triggers release", () => {
    persistentPeerId("pagehide-test")

    // Holder should be set.
    expect(local.get("pagehide-test:held")).toBeTruthy()

    // Dispatch pagehide.
    dispatchPagehide()

    // Holder should be cleared.
    expect(local.get("pagehide-test:held")).toBeUndefined()
    // sessionStorage survives.
    expect(session.get("pagehide-test")).toBeTruthy()
    expect(session.get("pagehide-test:tk")).toBeTruthy()
  })
})
