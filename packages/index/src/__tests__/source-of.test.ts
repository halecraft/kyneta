import { change, createDoc, json, Schema } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import type { SourceEvent } from "../source.js"
import { Source } from "../source.js"
import { toAdded, toRemoved } from "../zset.js"

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const taskSchema = Schema.struct({
  id: Schema.string(),
  name: Schema.string(),
  ownerId: Schema.string(),
})

const projectSchema = Schema.struct({
  tasks: Schema.list(taskSchema),
})

const ProjectDoc = json.bind(projectSchema)

const memberSchema = Schema.struct({
  role: Schema.string(),
})

const teamSchema = Schema.struct({
  members: Schema.record(memberSchema),
})

const TeamDoc = json.bind(teamSchema)

// ---------------------------------------------------------------------------
// Mock exchange
// ---------------------------------------------------------------------------

function createMockExchange() {
  const docs = new Map<string, { ref: any; schemaHash: string }>()
  const policies: Array<{
    onDocCreated?: (...args: any[]) => void
    onDocDismissed?: (...args: any[]) => void
  }> = []
  const schemas = new Map<string, any>()

  return {
    registerSchema(bound: any) {
      schemas.set(bound.schemaHash, bound)
    },

    documentIds(): ReadonlySet<string> {
      return new Set(docs.keys())
    },

    getDocSchemaHash(docId: string): string | undefined {
      return docs.get(docId)?.schemaHash
    },

    get(docId: string, bound: any): any {
      if (docs.has(docId)) return docs.get(docId)?.ref
      const doc = (createDoc as any)(bound)
      docs.set(docId, { ref: doc, schemaHash: bound.schemaHash })
      return doc
    },

    register(policy: any): () => void {
      policies.push(policy)
      return () => {
        const idx = policies.indexOf(policy)
        if (idx !== -1) policies.splice(idx, 1)
      }
    },

    dismiss(docId: string) {
      docs.delete(docId)
      const peer = {} as any
      for (const policy of [...policies]) {
        policy.onDocDismissed?.(docId, peer, "local")
      }
    },

    // Test helper: simulate a doc being created (triggers onDocCreated)
    simulateDocCreated(docId: string, bound: any): any {
      const doc = (createDoc as any)(bound)
      docs.set(docId, { ref: doc, schemaHash: bound.schemaHash })
      const peer = {} as any
      for (const policy of [...policies]) {
        policy.onDocCreated?.(docId, peer, "interpret", "local")
      }
      return doc
    },
  }
}

// ---------------------------------------------------------------------------
// Source.of
// ---------------------------------------------------------------------------

describe("Source.of", () => {
  // -------------------------------------------------------------------------
  // Document-level (2 args)
  // -------------------------------------------------------------------------

  describe("document-level", () => {
    it("snapshot reflects existing docs", () => {
      const exchange = createMockExchange()
      // Pre-populate a doc before creating the source
      const docRef = exchange.get("proj-1", ProjectDoc)

      const source = Source.of(exchange, ProjectDoc)
      const snap = source.snapshot()

      expect(snap.size).toBe(1)
      expect(snap.has("proj-1")).toBe(true)
      expect(snap.get("proj-1")).toBe(docRef)

      source.dispose()
    })

    it("new doc arrival emits +1 delta", () => {
      const exchange = createMockExchange()

      const source = Source.of(exchange, ProjectDoc)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      const docRef = exchange.simulateDocCreated("proj-2", ProjectDoc)

      expect(events.length).toBeGreaterThanOrEqual(1)
      const allAdded = events.flatMap(e => toAdded(e.delta))
      expect(allAdded).toContain("proj-2")

      // The value should be the doc ref
      const allValues = new Map(events.flatMap(e => [...e.values]))
      expect(allValues.get("proj-2")).toBe(docRef)

      // Snapshot should also have it
      expect(source.snapshot().has("proj-2")).toBe(true)

      source.dispose()
    })

    it("doc dismissed emits -1 delta", () => {
      const exchange = createMockExchange()
      exchange.get("proj-1", ProjectDoc)

      const source = Source.of(exchange, ProjectDoc)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      exchange.dismiss("proj-1")

      expect(events.length).toBeGreaterThanOrEqual(1)
      const allRemoved = events.flatMap(e => toRemoved(e.delta))
      expect(allRemoved).toContain("proj-1")

      expect(source.snapshot().has("proj-1")).toBe(false)

      source.dispose()
    })

    it("ignores docs with non-matching schemaHash", () => {
      const exchange = createMockExchange()
      // Add a TeamDoc — different schema hash
      exchange.get("team-1", TeamDoc)
      // Add a ProjectDoc
      exchange.get("proj-1", ProjectDoc)

      const source = Source.of(exchange, ProjectDoc)
      const snap = source.snapshot()

      // Only the ProjectDoc should be present
      expect(snap.size).toBe(1)
      expect(snap.has("proj-1")).toBe(true)
      expect(snap.has("team-1")).toBe(false)

      source.dispose()
    })
  })

  // -------------------------------------------------------------------------
  // List-level (4 args)
  // -------------------------------------------------------------------------

  describe("list-level", () => {
    it("entities from list inside doc appear in snapshot", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("proj-1", ProjectDoc)
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t1", name: "Task 1", ownerId: "alice" })
        d.tasks.push({ id: "t2", name: "Task 2", ownerId: "bob" })
      })

      const source = Source.of(
        exchange,
        ProjectDoc,
        (doc: any) => doc.tasks,
        (item: any) => item.id,
      )
      const snap = source.snapshot()

      expect(snap.size).toBe(2)
      expect(snap.has("proj-1\0t1")).toBe(true)
      expect(snap.has("proj-1\0t2")).toBe(true)

      source.dispose()
    })

    it("new doc arrives → its entities appear", () => {
      const exchange = createMockExchange()

      const source = Source.of(
        exchange,
        ProjectDoc,
        (doc: any) => doc.tasks,
        (item: any) => item.id,
      )
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      // Simulate a new doc being created
      const docRef = exchange.simulateDocCreated("proj-2", ProjectDoc)

      // Populate the doc with tasks
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t3", name: "Task 3", ownerId: "carol" })
        d.tasks.push({ id: "t4", name: "Task 4", ownerId: "dave" })
      })

      const allAdded = events.flatMap(e => toAdded(e.delta))
      expect(allAdded).toContain("proj-2\0t3")
      expect(allAdded).toContain("proj-2\0t4")

      // Snapshot should reflect everything
      const snap = source.snapshot()
      expect(snap.has("proj-2\0t3")).toBe(true)
      expect(snap.has("proj-2\0t4")).toBe(true)

      source.dispose()
    })

    it("item added to existing doc list → appears in stream", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("proj-1", ProjectDoc)
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t1", name: "Task 1", ownerId: "alice" })
      })

      const source = Source.of(
        exchange,
        ProjectDoc,
        (doc: any) => doc.tasks,
        (item: any) => item.id,
      )
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      // Add a new task to the existing doc
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t-new", name: "New Task", ownerId: "alice" })
      })

      expect(events.length).toBeGreaterThanOrEqual(1)
      const allAdded = events.flatMap(e => toAdded(e.delta))
      expect(allAdded).toContain("proj-1\0t-new")

      const snap = source.snapshot()
      expect(snap.has("proj-1\0t-new")).toBe(true)

      source.dispose()
    })

    it("doc dismissed → its list entities retracted", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("proj-1", ProjectDoc)
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t1", name: "Task 1", ownerId: "alice" })
        d.tasks.push({ id: "t2", name: "Task 2", ownerId: "bob" })
      })

      const source = Source.of(
        exchange,
        ProjectDoc,
        (doc: any) => doc.tasks,
        (item: any) => item.id,
      )
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      exchange.dismiss("proj-1")

      const allRemoved = events.flatMap(e => toRemoved(e.delta))
      expect(allRemoved).toContain("proj-1\0t1")
      expect(allRemoved).toContain("proj-1\0t2")

      expect(source.snapshot().size).toBe(0)

      source.dispose()
    })
  })

  // -------------------------------------------------------------------------
  // Record-level (3 args)
  // -------------------------------------------------------------------------

  describe("record-level", () => {
    it("record keys across docs appear in snapshot", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("team-1", TeamDoc)
      change(docRef, (d: any) => {
        d.members.set("alice", { role: "admin" })
        d.members.set("bob", { role: "viewer" })
      })

      const source = Source.of(exchange, TeamDoc, (doc: any) => doc.members)
      const snap = source.snapshot()

      expect(snap.size).toBe(2)
      expect(snap.has("team-1\0alice")).toBe(true)
      expect(snap.has("team-1\0bob")).toBe(true)

      source.dispose()
    })

    it("record keys from multiple docs are namespaced independently", () => {
      const exchange = createMockExchange()

      const doc1 = exchange.get("team-1", TeamDoc)
      change(doc1, (d: any) => {
        d.members.set("alice", { role: "admin" })
      })

      const doc2 = exchange.get("team-2", TeamDoc)
      change(doc2, (d: any) => {
        d.members.set("alice", { role: "member" })
        d.members.set("carol", { role: "admin" })
      })

      const source = Source.of(exchange, TeamDoc, (doc: any) => doc.members)
      const snap = source.snapshot()

      // Same member name under different docs → distinct namespaced keys
      expect(snap.size).toBe(3)
      expect(snap.has("team-1\0alice")).toBe(true)
      expect(snap.has("team-2\0alice")).toBe(true)
      expect(snap.has("team-2\0carol")).toBe(true)

      source.dispose()
    })

    it("new doc arrives → its record keys appear", () => {
      const exchange = createMockExchange()

      const source = Source.of(exchange, TeamDoc, (doc: any) => doc.members)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      const docRef = exchange.simulateDocCreated("team-3", TeamDoc)
      change(docRef, (d: any) => {
        d.members.set("dave", { role: "viewer" })
      })

      const allAdded = events.flatMap(e => toAdded(e.delta))
      expect(allAdded).toContain("team-3\0dave")

      source.dispose()
    })

    it("record key added to existing doc → appears in stream", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("team-1", TeamDoc)
      change(docRef, (d: any) => {
        d.members.set("alice", { role: "admin" })
      })

      const source = Source.of(exchange, TeamDoc, (doc: any) => doc.members)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      change(docRef, (d: any) => {
        d.members.set("bob", { role: "viewer" })
      })

      expect(events.length).toBeGreaterThanOrEqual(1)
      const allAdded = events.flatMap(e => toAdded(e.delta))
      expect(allAdded).toContain("team-1\0bob")

      source.dispose()
    })

    it("record key removed from existing doc → retracted in stream", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("team-1", TeamDoc)
      change(docRef, (d: any) => {
        d.members.set("alice", { role: "admin" })
        d.members.set("bob", { role: "viewer" })
      })

      const source = Source.of(exchange, TeamDoc, (doc: any) => doc.members)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      change(docRef, (d: any) => {
        d.members.delete("alice")
      })

      expect(events.length).toBeGreaterThanOrEqual(1)
      const allRemoved = events.flatMap(e => toRemoved(e.delta))
      expect(allRemoved).toContain("team-1\0alice")

      source.dispose()
    })
  })

  // -------------------------------------------------------------------------
  // Dispose chain
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    it("document-level: after dispose, new docs do not produce events", () => {
      const exchange = createMockExchange()

      const source = Source.of(exchange, ProjectDoc)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      source.dispose()

      exchange.simulateDocCreated("proj-late", ProjectDoc)

      expect(events).toHaveLength(0)
    })

    it("list-level: after dispose, mutations do not produce events", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("proj-1", ProjectDoc)
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t1", name: "Task 1", ownerId: "alice" })
      })

      const source = Source.of(
        exchange,
        ProjectDoc,
        (doc: any) => doc.tasks,
        (item: any) => item.id,
      )
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      source.dispose()

      // Mutate the doc after dispose — should not produce events
      change(docRef, (d: any) => {
        d.tasks.push({ id: "t-after", name: "After dispose", ownerId: "bob" })
      })

      expect(events).toHaveLength(0)
    })

    it("record-level: after dispose, mutations do not produce events", () => {
      const exchange = createMockExchange()
      const docRef = exchange.get("team-1", TeamDoc)
      change(docRef, (d: any) => {
        d.members.set("alice", { role: "admin" })
      })

      const source = Source.of(exchange, TeamDoc, (doc: any) => doc.members)
      const events: SourceEvent<any>[] = []
      source.subscribe(e => events.push(e))

      source.dispose()

      change(docRef, (d: any) => {
        d.members.set("bob", { role: "viewer" })
      })

      expect(events).toHaveLength(0)
    })
  })
})
