// collaborative-text.test.ts — end-to-end collaborative text editing.
//
// Two peers connected via BridgeTransport, each with a <textarea> bound
// via attach(). Proves the full stack: schema → Loro substrate → Exchange
// sync → changefeed → attach() → DOM, in both directions.
//
// This is the integration test that no unit test can replace: it exercises
// the wiring between layers, not the layers themselves.

import { Exchange } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { change, Schema } from "@kyneta/schema"
import { Bridge, createBridgeTransport } from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"
import { attach, type TextRefLike } from "../text-adapter.js"

// ---------------------------------------------------------------------------
// Schema — a document with a single collaborative text field
// ---------------------------------------------------------------------------

const NoteSchema = Schema.struct({
  body: Schema.text(),
})

const NoteDoc = loro.bind(NoteSchema)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask + promise queues so BridgeTransport delivers messages.
 * Mirrors the pattern in @kyneta/exchange integration tests.
 */
async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

/** Active exchanges for cleanup. */
const active: Exchange[] = []

function createPeer(
  peerId: string,
  bridge: Bridge,
): { exchange: Exchange; doc: any } {
  const exchange = new Exchange({
    id: peerId,
    transports: [createBridgeTransport({ transportType: peerId, bridge })],
    schemas: [NoteDoc],
  })
  active.push(exchange)
  const doc = exchange.get("note-1", NoteDoc)
  return { exchange, doc }
}

afterEach(async () => {
  for (const ex of active) {
    try {
      await ex.shutdown()
    } catch {
      // ignore
    }
  }
  active.length = 0
})

/** Create a jsdom textarea. */
function createTextarea(): HTMLTextAreaElement {
  return document.createElement("textarea")
}

/**
 * Simulate a user typing into a textarea: set value, position cursor,
 * fire `input` event — exactly what a browser does.
 */
function simulateTyping(
  el: HTMLTextAreaElement,
  newValue: string,
  cursorPos: number,
): void {
  el.value = newValue
  el.selectionStart = cursorPos
  el.selectionEnd = cursorPos
  el.dispatchEvent(new Event("input"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collaborative text editing: two peers with attach()", () => {
  it("typing on peer A appears on peer B's textarea", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    // Initial sync — both empty
    await drain()
    expect(textareaA.value).toBe("")
    expect(textareaB.value).toBe("")

    // Alice types "hello"
    simulateTyping(textareaA, "hello", 5)
    expect(alice.doc.body()).toBe("hello")

    // Let sync propagate
    await drain()

    // Bob sees it
    expect(bob.doc.body()).toBe("hello")
    expect(textareaB.value).toBe("hello")

    detachA()
    detachB()
  })

  it("typing on peer B appears on peer A's textarea", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    await drain()

    // Bob types "world"
    simulateTyping(textareaB, "world", 5)
    await drain()

    // Alice sees it
    expect(alice.doc.body()).toBe("world")
    expect(textareaA.value).toBe("world")

    detachA()
    detachB()
  })

  it("sequential edits from both peers converge", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    await drain()

    // Alice types "Hello"
    simulateTyping(textareaA, "Hello", 5)
    await drain()

    // Bob appends " World" (sees "Hello", types at end)
    expect(textareaB.value).toBe("Hello")
    simulateTyping(textareaB, "Hello World", 11)
    await drain()

    // Both converge
    expect(alice.doc.body()).toBe("Hello World")
    expect(bob.doc.body()).toBe("Hello World")
    expect(textareaA.value).toBe("Hello World")
    expect(textareaB.value).toBe("Hello World")

    detachA()
    detachB()
  })

  it("concurrent edits from both peers converge to the same value", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    // Seed with initial text via programmatic change so both start aligned
    change(alice.doc, (d: any) => {
      d.body.insert(0, "base")
    })
    await drain()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    expect(textareaA.value).toBe("base")
    expect(textareaB.value).toBe("base")

    // Alice inserts at the beginning, Bob inserts at the end — concurrently
    simulateTyping(textareaA, "AAbase", 2)
    simulateTyping(textareaB, "baseBB", 6)

    // Let sync converge
    await drain()

    // Both CRDTs must agree
    const valueA = alice.doc.body() as string
    const valueB = bob.doc.body() as string
    expect(valueA).toBe(valueB)

    // Both substrings must be present (CRDT merge preserves both edits)
    expect(valueA).toContain("AA")
    expect(valueA).toContain("BB")
    expect(valueA).toContain("base")

    // Textareas must reflect the converged CRDT state
    expect(textareaA.value).toBe(valueA)
    expect(textareaB.value).toBe(valueA)

    detachA()
    detachB()
  })

  it("cursor position is preserved through remote edits", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    change(alice.doc, (d: any) => {
      d.body.insert(0, "abcdef")
    })
    await drain()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    // Bob places cursor at position 4 (between "d" and "e")
    textareaB.selectionStart = 4
    textareaB.selectionEnd = 4

    // Alice inserts "XX" at position 0 — Bob's cursor should shift right by 2
    simulateTyping(textareaA, "XXabcdef", 2)
    await drain()

    expect(textareaB.value).toBe("XXabcdef")
    expect(textareaB.selectionStart).toBe(6)
    expect(textareaB.selectionEnd).toBe(6)

    detachA()
    detachB()
  })

  it("echo suppression: local edits do not double-apply", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)

    const textareaA = createTextarea()
    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)

    await drain()

    // Alice types "hello"
    simulateTyping(textareaA, "hello", 5)
    await drain()

    // The textarea should show exactly "hello" — not "hellohello" from
    // the changefeed echoing the local edit back.
    expect(textareaA.value).toBe("hello")
    expect(alice.doc.body()).toBe("hello")

    detachA()
  })

  it("detach stops bidirectional flow", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    await drain()

    // Alice types, Bob sees it
    simulateTyping(textareaA, "live", 4)
    await drain()
    expect(textareaB.value).toBe("live")

    // Detach Bob's textarea
    detachB()

    // Alice types more
    simulateTyping(textareaA, "live!", 5)
    await drain()

    // Bob's CRDT gets it (sync still works), but his textarea is frozen
    expect(bob.doc.body()).toBe("live!")
    expect(textareaB.value).toBe("live") // unchanged — detached

    detachA()
  })

  it("multi-round editing: alternating inserts and deletes", async () => {
    const bridge = new Bridge()
    const alice = createPeer("alice", bridge)
    const bob = createPeer("bob", bridge)

    const textareaA = createTextarea()
    const textareaB = createTextarea()

    const detachA = attach(textareaA, alice.doc.body as unknown as TextRefLike)
    const detachB = attach(textareaB, bob.doc.body as unknown as TextRefLike)

    await drain()

    // Round 1: Alice writes
    simulateTyping(textareaA, "Hello", 5)
    await drain()

    // Round 2: Bob edits Alice's text — insert comma
    expect(textareaB.value).toBe("Hello")
    simulateTyping(textareaB, "Hello,", 6)
    await drain()

    // Round 3: Alice appends (sees "Hello,")
    expect(textareaA.value).toBe("Hello,")
    simulateTyping(textareaA, "Hello, World", 12)
    await drain()

    // Round 4: Bob deletes "World" and types "Everyone"
    expect(textareaB.value).toBe("Hello, World")
    simulateTyping(textareaB, "Hello, Everyone", 15)
    await drain()

    // Both agree
    expect(alice.doc.body()).toBe("Hello, Everyone")
    expect(bob.doc.body()).toBe("Hello, Everyone")
    expect(textareaA.value).toBe("Hello, Everyone")
    expect(textareaB.value).toBe("Hello, Everyone")

    detachA()
    detachB()
  })
})
