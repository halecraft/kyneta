// storage-backend — unit tests for InMemoryStorageBackend.
//
// These tests validate the StorageBackend contract through the
// InMemoryStorageBackend implementation. Any conforming backend
// should pass the same tests.

import { describe, expect, it } from "vitest"
import { InMemoryStorageBackend } from "../storage/in-memory-storage-backend.js"
import type { StorageBackend, StorageEntry } from "../storage/storage-backend.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(kind: "entirety" | "since", version: string): StorageEntry {
  return {
    payload: {
      kind,
      encoding: "json",
      data: JSON.stringify({ v: version }),
    },
    version,
  }
}

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) {
    results.push(item)
  }
  return results
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryStorageBackend", () => {
  it("append + loadAll round-trip: entries returned in insertion order", async () => {
    const backend = new InMemoryStorageBackend()
    const e1 = makeEntry("entirety", "1")
    const e2 = makeEntry("since", "2")
    const e3 = makeEntry("since", "3")

    await backend.append("doc-1", e1)
    await backend.append("doc-1", e2)
    await backend.append("doc-1", e3)

    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual(e1)
    expect(entries[1]).toEqual(e2)
    expect(entries[2]).toEqual(e3)
  })

  it("has returns true after append, false after delete", async () => {
    const backend = new InMemoryStorageBackend()

    expect(await backend.has("doc-1")).toBe(false)

    await backend.append("doc-1", makeEntry("entirety", "1"))
    expect(await backend.has("doc-1")).toBe(true)

    await backend.delete("doc-1")
    expect(await backend.has("doc-1")).toBe(false)
  })

  it("replace atomically swaps entries: loadAll yields exactly one entry", async () => {
    const backend = new InMemoryStorageBackend()
    const e1 = makeEntry("since", "1")
    const e2 = makeEntry("since", "2")
    const e3 = makeEntry("since", "3")
    const replacement = makeEntry("entirety", "4")

    await backend.append("doc-1", e1)
    await backend.append("doc-1", e2)
    await backend.append("doc-1", e3)

    // Before replace: 3 entries
    let entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(3)

    // After replace: exactly 1 entry
    await backend.replace("doc-1", replacement)
    entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(replacement)
  })

  it("listDocIds enumerates all docs after mixed operations", async () => {
    const backend = new InMemoryStorageBackend()

    await backend.append("doc-a", makeEntry("entirety", "1"))
    await backend.append("doc-b", makeEntry("entirety", "1"))
    await backend.append("doc-c", makeEntry("entirety", "1"))

    // Delete one
    await backend.delete("doc-b")

    const docIds = await collectAll(backend.listDocIds())
    expect(docIds.sort()).toEqual(["doc-a", "doc-c"])
  })

  it("delete removes all entries: has returns false, loadAll yields nothing", async () => {
    const backend = new InMemoryStorageBackend()

    await backend.append("doc-1", makeEntry("entirety", "1"))
    await backend.append("doc-1", makeEntry("since", "2"))

    await backend.delete("doc-1")

    expect(await backend.has("doc-1")).toBe(false)
    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(0)
  })

  it("loadAll of nonexistent doc yields nothing (no crash)", async () => {
    const backend = new InMemoryStorageBackend()

    const entries = await collectAll(backend.loadAll("nonexistent"))
    expect(entries).toHaveLength(0)
  })

  it("replace on nonexistent doc creates it: has returns true", async () => {
    const backend = new InMemoryStorageBackend()

    expect(await backend.has("doc-1")).toBe(false)

    const entry = makeEntry("entirety", "1")
    await backend.replace("doc-1", entry)

    expect(await backend.has("doc-1")).toBe(true)
    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(entry)
  })

  it("shared state via constructor arg or getStorage() is visible across instances", async () => {
    // Constructor injection
    const sharedData = new Map()
    const backend1 = new InMemoryStorageBackend(sharedData)
    const backend2 = new InMemoryStorageBackend(sharedData)

    await backend1.append("doc-1", makeEntry("entirety", "1"))
    expect(await backend2.has("doc-1")).toBe(true)

    // getStorage() returns the same map for late sharing
    const backend3 = new InMemoryStorageBackend(backend1.getStorage())
    const entries = await collectAll(backend3.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.version).toBe("1")
  })
})

// ---------------------------------------------------------------------------
// Per-doc serialization via StorageAdapter
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// StorageAdapter behavioral tests
// ---------------------------------------------------------------------------

describe("StorageAdapter", () => {
  // Shared helpers for adapter-level tests

  /** Minimal context to initialize an adapter outside an Exchange. */
  const minimalContext = {
    identity: { peerId: "test", type: "service" as const },
    onChannelReceive: () => {},
    onChannelAdded: () => {},
    onChannelRemoved: () => {},
    onChannelEstablish: () => {},
  }

  /** Start an adapter and return its single channel (post-establish). */
  async function startAdapter(backend: StorageBackend) {
    const { StorageAdapter } = await import("../storage/storage-adapter.js")
    const adapter = new StorageAdapter({ backend, adapterType: "test-storage" })
    adapter._initialize(minimalContext)
    await adapter._start()
    const channel = [...adapter.channels][0]!
    // Complete the establish handshake so messages are accepted
    channel.onReceive({
      type: "establish-request",
      identity: { peerId: "test-peer", type: "service" },
    })
    return { adapter, channel }
  }

  const payload = { kind: "entirety" as const, encoding: "json" as const, data: '{"v":1}' }

  // --- Per-doc serialization ---

  /**
   * A slow mock backend that records the start/end of each operation
   * with timestamps. Each operation takes `delayMs` to complete,
   * allowing us to detect whether operations overlap.
   */
  class SlowMockBackend implements StorageBackend {
    readonly log: { op: string; docId: string; phase: "start" | "end"; time: number }[] = []
    readonly delayMs: number

    constructor(delayMs = 10) {
      this.delayMs = delayMs
    }

    #record(op: string, docId: string, phase: "start" | "end") {
      this.log.push({ op, docId, phase, time: Date.now() })
    }

    async #delay() {
      await new Promise(r => setTimeout(r, this.delayMs))
    }

    async append(docId: string, _entry: StorageEntry): Promise<void> {
      this.#record("append", docId, "start")
      await this.#delay()
      this.#record("append", docId, "end")
    }

    async has(docId: string): Promise<boolean> {
      this.#record("has", docId, "start")
      await this.#delay()
      this.#record("has", docId, "end")
      return false
    }

    async *loadAll(_docId: string): AsyncIterable<StorageEntry> {
      // yields nothing
    }

    async replace(docId: string, _entry: StorageEntry): Promise<void> {
      this.#record("replace", docId, "start")
      await this.#delay()
      this.#record("replace", docId, "end")
    }

    async delete(docId: string): Promise<void> {
      this.#record("delete", docId, "start")
      await this.#delay()
      this.#record("delete", docId, "end")
    }

    async *listDocIds(): AsyncIterable<string> {
      // yields nothing
    }
  }

  it("operations on the same docId are serialized (no interleaving)", async () => {
    const backend = new SlowMockBackend(20)
    const { adapter, channel } = await startAdapter(backend)

    // Fire 3 offers for the SAME doc synchronously — async handlers must not interleave
    channel.send({ type: "offer", docId: "doc-A", payload, version: "1" })
    channel.send({ type: "offer", docId: "doc-A", payload, version: "2" })
    channel.send({ type: "offer", docId: "doc-A", payload, version: "3" })

    await adapter.flush()

    const docAOps = backend.log.filter(e => e.docId === "doc-A")
    expect(docAOps).toHaveLength(6) // 3 appends × (start + end)

    // Each operation's "start" must come after the previous operation's "end"
    for (let i = 0; i < docAOps.length - 1; i += 2) {
      const end = docAOps[i + 1]!
      expect(end.phase).toBe("end")
      if (i + 2 < docAOps.length) {
        const nextStart = docAOps[i + 2]!
        expect(nextStart.phase).toBe("start")
        expect(nextStart.time).toBeGreaterThanOrEqual(end.time)
      }
    }
  })

  it("operations on different docIds proceed concurrently", async () => {
    const backend = new SlowMockBackend(30)
    const { adapter, channel } = await startAdapter(backend)

    const before = Date.now()
    channel.send({ type: "offer", docId: "doc-X", payload, version: "1" })
    channel.send({ type: "offer", docId: "doc-Y", payload, version: "1" })

    await adapter.flush()
    const elapsed = Date.now() - before

    const docXOps = backend.log.filter(e => e.docId === "doc-X")
    const docYOps = backend.log.filter(e => e.docId === "doc-Y")
    expect(docXOps).toHaveLength(2)
    expect(docYOps).toHaveLength(2)

    // Total time ≈ one delay (concurrent), not two (sequential)
    expect(elapsed).toBeLessThan(backend.delayMs * 2)

    // Both starts before both ends = overlapping execution
    const xStart = docXOps.find(e => e.phase === "start")!
    const yStart = docYOps.find(e => e.phase === "start")!
    const xEnd = docXOps.find(e => e.phase === "end")!
    const yEnd = docYOps.find(e => e.phase === "end")!
    expect(xStart.time).toBeLessThanOrEqual(yEnd.time)
    expect(yStart.time).toBeLessThanOrEqual(xEnd.time)
  })

  it("a backend error does not block subsequent operations for the same doc", async () => {
    let callCount = 0
    const failOnceBackend: StorageBackend = {
      async append(_docId, _entry) {
        callCount++
        if (callCount === 1) throw new Error("simulated write failure")
        // second call succeeds
      },
      async has() { return false },
      async *loadAll() {},
      async replace() {},
      async delete() {},
      async *listDocIds() {},
    }

    const { adapter, channel } = await startAdapter(failOnceBackend)

    // First offer will fail internally; second should still proceed
    channel.send({ type: "offer", docId: "doc-A", payload, version: "1" })
    channel.send({ type: "offer", docId: "doc-A", payload, version: "2" })

    await adapter.flush()

    // Both appends were attempted (the queue didn't get stuck)
    expect(callCount).toBe(2)
  })

  // --- Conduit contract: round-trip fidelity ---

  it("hydration round-trips payload and version faithfully from persisted offers", async () => {
    const backend = new InMemoryStorageBackend()

    // Pre-populate storage with entries of varying shapes
    const binaryPayload = {
      kind: "since" as const,
      encoding: "binary" as const,
      data: new Uint8Array([1, 2, 3, 4]),
    }
    await backend.append("doc-1", { payload: binaryPayload, version: "abc-123" })
    await backend.append("doc-1", {
      payload: { kind: "entirety" as const, encoding: "json" as const, data: '{"x":1}' },
      version: "def-456",
    })

    // Capture what the adapter sends back during hydration
    const received: Array<{ type: string; docId?: string; payload?: any; version?: string }> = []
    const { adapter, channel } = await startAdapter(backend)

    // Intercept replies by replacing onReceive
    channel.onReceive = (msg: any) => { received.push(msg) }

    // Trigger hydration: send interest for doc-1
    channel.send({ type: "interest", docId: "doc-1", version: "", reciprocate: false })
    await adapter.flush()

    // Should have received 2 offers + 1 completion interest
    const offers = received.filter(m => m.type === "offer")
    const interests = received.filter(m => m.type === "interest")
    expect(offers).toHaveLength(2)
    expect(interests).toHaveLength(1)

    // First offer: binary payload round-tripped exactly
    expect(offers[0]!.version).toBe("abc-123")
    expect(offers[0]!.payload.kind).toBe("since")
    expect(offers[0]!.payload.encoding).toBe("binary")
    expect(offers[0]!.payload.data).toEqual(new Uint8Array([1, 2, 3, 4]))

    // Second offer: JSON payload round-tripped exactly
    expect(offers[1]!.version).toBe("def-456")
    expect(offers[1]!.payload.kind).toBe("entirety")
    expect(offers[1]!.payload.data).toBe('{"x":1}')
  })

  // --- Discover filtering ---

  it("discover replies with only the available docIds, omitting missing ones", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.append("doc-a", makeEntry("entirety", "1"))
    // doc-b is NOT in storage

    const received: Array<{ type: string; docIds?: string[] }> = []
    const { adapter, channel } = await startAdapter(backend)
    channel.onReceive = (msg: any) => { received.push(msg) }

    // Ask about two docs, only one exists
    channel.send({ type: "discover", docIds: ["doc-a", "doc-b"] })
    await adapter.flush()

    const discovers = received.filter(m => m.type === "discover")
    expect(discovers).toHaveLength(1)
    expect(discovers[0]!.docIds).toEqual(["doc-a"])
  })

  it("discover sends nothing when none of the requested docs exist", async () => {
    const backend = new InMemoryStorageBackend()

    const received: Array<{ type: string }> = []
    const { adapter, channel } = await startAdapter(backend)
    channel.onReceive = (msg: any) => { received.push(msg) }

    channel.send({ type: "discover", docIds: ["ghost-1", "ghost-2"] })
    await adapter.flush()

    // No reply at all — the adapter stays silent
    const discovers = received.filter(m => m.type === "discover")
    expect(discovers).toHaveLength(0)
  })
})