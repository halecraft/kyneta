// persistent-peer-id — unit tests for the browser-only localStorage-backed
// peerId generation utility.

import { describe, expect, it, beforeEach } from "vitest"
import { persistentPeerId } from "../persistent-peer-id.js"

// ---------------------------------------------------------------------------
// localStorage mock — simple Map-backed shim
// ---------------------------------------------------------------------------

const storage = new Map<string, string>()

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
  configurable: true,
})

beforeEach(() => {
  storage.clear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("persistentPeerId", () => {
  it("returns a 16-char hex string", () => {
    const id = persistentPeerId("test-key")
    expect(id).toMatch(/^[0-9a-f]{16}$/)
  })

  it("returns the same value on repeated calls with the same key", () => {
    const first = persistentPeerId("stable-key")
    const second = persistentPeerId("stable-key")
    expect(first).toBe(second)
  })

  it("returns different values for different keys", () => {
    const a = persistentPeerId("key-a")
    const b = persistentPeerId("key-b")
    expect(a).not.toBe(b)
  })
})