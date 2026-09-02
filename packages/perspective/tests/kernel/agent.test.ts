// === Agent Tests ===
// Tests for the Agent: monotonic counters and lamport, refs tracking,
// constraint production for all 6 types, observation, safe-integer overflow.

import { describe, expect, it } from "vitest"
import {
  createAgent,
  produceMapChild,
  produceRoot,
  produceSeqChild,
} from "../../src/kernel/agent.js"
import { cnIdEquals, createCnId } from "../../src/kernel/cnid.js"
import { STUB_PRIVATE_KEY } from "../../src/kernel/signature.js"
import type { Constraint } from "../../src/kernel/types.js"
import { vvFromObject, vvGet } from "../../src/kernel/version-vector.js"

describe("Agent", () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe("createAgent", () => {
    it("creates an agent with the given peerId", () => {
      const agent = createAgent("alice")
      expect(agent.peerId).toBe("alice")
    })

    it("starts with counter 0 by default", () => {
      const agent = createAgent("alice")
      expect(agent.counter).toBe(0)
    })

    it("starts with lamport 0 by default", () => {
      const agent = createAgent("alice")
      expect(agent.lamportValue).toBe(0)
    })

    it("starts with empty version vector", () => {
      const agent = createAgent("alice")
      expect(agent.versionVector.size).toBe(0)
    })

    it("accepts a custom initial counter", () => {
      const agent = createAgent("alice", STUB_PRIVATE_KEY, 10)
      expect(agent.counter).toBe(10)
    })

    it("accepts a custom initial lamport", () => {
      const agent = createAgent("alice", STUB_PRIVATE_KEY, 0, 50)
      expect(agent.lamportValue).toBe(50)
    })
  })

  // -------------------------------------------------------------------------
  // Counter monotonicity
  // -------------------------------------------------------------------------

  describe("counter monotonicity", () => {
    it("produces constraints with monotonically increasing counters", () => {
      const agent = createAgent("alice")
      const c1 = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const c2 = agent.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })
      const c3 = agent.produceStructure({
        kind: "root",
        containerId: "c",
        policy: "map",
      })

      expect(c1.id.counter).toBe(0)
      expect(c2.id.counter).toBe(1)
      expect(c3.id.counter).toBe(2)
    })

    it("counter advances across different constraint types", () => {
      const agent = createAgent("alice")
      const rootId = createCnId("alice", 0)

      const c1 = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const c2 = agent.produceValue(rootId, "hello")
      const c3 = agent.produceRetract(rootId)

      expect(c1.id.counter).toBe(0)
      expect(c2.id.counter).toBe(1)
      expect(c3.id.counter).toBe(2)
      expect(agent.counter).toBe(3)
    })

    it("all produced constraints have the agent peerId", () => {
      const agent = createAgent("alice")
      const c = agent.produceStructure({
        kind: "root",
        containerId: "test",
        policy: "map",
      })
      expect(c.id.peer).toBe("alice")
    })

    it("counter starts from custom initial value", () => {
      const agent = createAgent("alice", STUB_PRIVATE_KEY, 100)
      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      expect(c.id.counter).toBe(100)
      expect(agent.counter).toBe(101)
    })
  })

  // -------------------------------------------------------------------------
  // Lamport monotonicity
  // -------------------------------------------------------------------------

  describe("lamport monotonicity", () => {
    it("produces constraints with monotonically increasing lamport", () => {
      const agent = createAgent("alice")
      const c1 = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const c2 = agent.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })
      const c3 = agent.produceStructure({
        kind: "root",
        containerId: "c",
        policy: "map",
      })

      expect(c1.lamport).toBe(1)
      expect(c2.lamport).toBe(2)
      expect(c3.lamport).toBe(3)
    })

    it("lamport starts from custom initial + 1 on first produce", () => {
      const agent = createAgent("alice", STUB_PRIVATE_KEY, 0, 50)
      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      expect(c.lamport).toBe(51)
    })

    it("lamport values are strictly increasing across many produces", () => {
      const agent = createAgent("alice")
      const lamports: number[] = []
      for (let i = 0; i < 50; i++) {
        const c = agent.produceStructure({
          kind: "root",
          containerId: `c${i}`,
          policy: "map",
        })
        lamports.push(c.lamport)
      }

      for (let i = 1; i < lamports.length; i++) {
        expect(lamports[i]!).toBeGreaterThan(lamports[i - 1]!)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Refs tracking
  // -------------------------------------------------------------------------

  describe("refs tracking", () => {
    it("first constraint has empty refs (nothing observed)", () => {
      const agent = createAgent("alice")
      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      expect(c.refs).toEqual([])
    })

    it("second constraint refs the first (self-observation)", () => {
      const agent = createAgent("alice")
      const _c1 = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const c2 = agent.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })

      // After producing c1, the agent has seen alice@0
      // So c2 should ref alice@0
      expect(c2.refs.length).toBe(1)
      expect(cnIdEquals(c2.refs[0]!, createCnId("alice", 0))).toBe(true)
    })

    it("third constraint refs only the latest per peer", () => {
      const agent = createAgent("alice")
      agent.produceStructure({ kind: "root", containerId: "a", policy: "map" }) // alice@0
      agent.produceStructure({ kind: "root", containerId: "b", policy: "map" }) // alice@1
      const c3 = agent.produceStructure({
        kind: "root",
        containerId: "c",
        policy: "map",
      }) // alice@2

      // Should ref alice@1 (the last one before c3)
      expect(c3.refs.length).toBe(1)
      expect(cnIdEquals(c3.refs[0]!, createCnId("alice", 1))).toBe(true)
    })

    it("refs include observed constraints from other peers", () => {
      const agent = createAgent("alice")

      // Observe some constraints from bob
      const bobConstraint: Constraint = {
        id: createCnId("bob", 5),
        lamport: 10,
        refs: [],
        sig: new Uint8Array(0),
        type: "structure",
        payload: { kind: "root", containerId: "test", policy: "map" },
      }
      agent.observe(bobConstraint)

      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })

      // Should have ref to bob@5
      const bobRef = c.refs.find(r => r.peer === "bob")
      expect(bobRef).toBeDefined()
      expect(bobRef?.counter).toBe(5)
    })

    it("refs contain one entry per observed peer (frontier)", () => {
      const agent = createAgent("alice")

      // Observe from multiple peers
      const peers = ["bob", "charlie", "dave"]
      for (const peer of peers) {
        const constraint: Constraint = {
          id: createCnId(peer, 3),
          lamport: 5,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "test", policy: "map" },
        }
        agent.observe(constraint)
      }

      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })

      // Should have refs to bob@3, charlie@3, dave@3
      expect(c.refs.length).toBe(3)
      for (const peer of peers) {
        const ref = c.refs.find(r => r.peer === peer)
        expect(ref).toBeDefined()
        expect(ref?.counter).toBe(3)
      }
    })

    it("observation of multiple constraints from same peer uses latest", () => {
      const agent = createAgent("alice")

      for (let i = 0; i < 5; i++) {
        agent.observe({
          id: createCnId("bob", i),
          lamport: i + 1,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "test", policy: "map" },
        })
      }

      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })

      const bobRef = c.refs.find(r => r.peer === "bob")
      expect(bobRef).toBeDefined()
      expect(bobRef?.counter).toBe(4) // last seen was bob@4
    })
  })

  // -------------------------------------------------------------------------
  // Observation
  // -------------------------------------------------------------------------

  describe("observe", () => {
    it("updates version vector on observe", () => {
      const agent = createAgent("alice")

      agent.observe({
        id: createCnId("bob", 3),
        lamport: 5,
        refs: [],
        sig: new Uint8Array(0),
        type: "structure",
        payload: { kind: "root", containerId: "test", policy: "map" },
      })

      expect(vvGet(agent.versionVector, "bob")).toBe(4) // 3 + 1
    })

    it("updates lamport clock on observe", () => {
      const agent = createAgent("alice")

      agent.observe({
        id: createCnId("bob", 0),
        lamport: 100,
        refs: [],
        sig: new Uint8Array(0),
        type: "structure",
        payload: { kind: "root", containerId: "test", policy: "map" },
      })

      // Lamport should now be at least 100
      expect(agent.lamportValue).toBeGreaterThanOrEqual(100)
    })

    it("next produce after observe has lamport > observed", () => {
      const agent = createAgent("alice")

      agent.observe({
        id: createCnId("bob", 0),
        lamport: 100,
        refs: [],
        sig: new Uint8Array(0),
        type: "structure",
        payload: { kind: "root", containerId: "test", policy: "map" },
      })

      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      expect(c.lamport).toBeGreaterThan(100)
    })
  })

  describe("observeMany", () => {
    it("updates version vector for all observed constraints", () => {
      const agent = createAgent("alice")

      const constraints: Constraint[] = [
        {
          id: createCnId("bob", 0),
          lamport: 1,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "test", policy: "map" },
        },
        {
          id: createCnId("bob", 1),
          lamport: 2,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "test2", policy: "map" },
        },
        {
          id: createCnId("charlie", 0),
          lamport: 3,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "test3", policy: "map" },
        },
      ]

      agent.observeMany(constraints)

      expect(vvGet(agent.versionVector, "bob")).toBe(2) // bob@0, bob@1 → next=2
      expect(vvGet(agent.versionVector, "charlie")).toBe(1) // charlie@0 → next=1
    })

    it("updates lamport to max across all observed", () => {
      const agent = createAgent("alice")

      agent.observeMany([
        {
          id: createCnId("bob", 0),
          lamport: 10,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "a", policy: "map" },
        },
        {
          id: createCnId("charlie", 0),
          lamport: 50,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "b", policy: "map" },
        },
        {
          id: createCnId("dave", 0),
          lamport: 30,
          refs: [],
          sig: new Uint8Array(0),
          type: "structure",
          payload: { kind: "root", containerId: "c", policy: "map" },
        },
      ])

      expect(agent.lamportValue).toBeGreaterThanOrEqual(50)
    })
  })

  describe("mergeVersionVector", () => {
    it("merges external VV into observed set", () => {
      const agent = createAgent("alice")
      agent.mergeVersionVector(vvFromObject({ bob: 5, charlie: 3 }))

      expect(vvGet(agent.versionVector, "bob")).toBe(5)
      expect(vvGet(agent.versionVector, "charlie")).toBe(3)
    })

    it("takes max when merging with existing observations", () => {
      const agent = createAgent("alice")

      agent.observe({
        id: createCnId("bob", 9),
        lamport: 1,
        refs: [],
        sig: new Uint8Array(0),
        type: "structure",
        payload: { kind: "root", containerId: "test", policy: "map" },
      })
      // bob now at 10 (9+1)

      agent.mergeVersionVector(vvFromObject({ bob: 5, charlie: 3 }))
      expect(vvGet(agent.versionVector, "bob")).toBe(10) // max(10, 5)
      expect(vvGet(agent.versionVector, "charlie")).toBe(3)
    })
  })

  // -------------------------------------------------------------------------
  // Constraint production — all 6 types
  // -------------------------------------------------------------------------

  describe("produceStructure", () => {
    it("produces a structure constraint with correct fields", () => {
      const agent = createAgent("alice")
      const c = agent.produceStructure({
        kind: "root",
        containerId: "profile",
        policy: "map",
      })

      expect(c.type).toBe("structure")
      expect(c.id.peer).toBe("alice")
      expect(c.id.counter).toBe(0)
      expect(c.lamport).toBe(1)
      expect(c.refs).toEqual([])
      expect(c.sig).toBeInstanceOf(Uint8Array)
      expect(c.payload.kind).toBe("root")
      if (c.payload.kind === "root") {
        expect(c.payload.containerId).toBe("profile")
        expect(c.payload.policy).toBe("map")
      }
    })

    it("produces map child structure", () => {
      const agent = createAgent("alice")
      const parent = createCnId("alice", 0)
      const c = agent.produceStructure({ kind: "map", parent, key: "name" })

      expect(c.type).toBe("structure")
      expect(c.payload.kind).toBe("map")
      if (c.payload.kind === "map") {
        expect(cnIdEquals(c.payload.parent, parent)).toBe(true)
        expect(c.payload.key).toBe("name")
      }
    })

    it("produces seq child structure", () => {
      const agent = createAgent("alice")
      const parent = createCnId("alice", 0)
      const left = createCnId("bob", 3)

      const c = agent.produceStructure({
        kind: "seq",
        parent,
        originLeft: left,
        originRight: null,
      })

      expect(c.type).toBe("structure")
      expect(c.payload.kind).toBe("seq")
      if (c.payload.kind === "seq") {
        expect(cnIdEquals(c.payload.parent, parent)).toBe(true)
        expect(c.payload.originLeft).not.toBeNull()
        expect(cnIdEquals(c.payload.originLeft!, left)).toBe(true)
        expect(c.payload.originRight).toBeNull()
      }
    })
  })

  describe("produceValue", () => {
    it("produces a value constraint with correct fields", () => {
      const agent = createAgent("alice")
      const target = createCnId("alice", 0)
      const c = agent.produceValue(target, "hello world")

      expect(c.type).toBe("value")
      expect(c.payload.target).toEqual(target)
      expect(c.payload.content).toBe("hello world")
    })

    it("supports all Value types", () => {
      const agent = createAgent("alice")
      const target = createCnId("alice", 0)

      // null
      const c1 = agent.produceValue(target, null)
      expect(c1.payload.content).toBeNull()

      // boolean
      const c2 = agent.produceValue(target, true)
      expect(c2.payload.content).toBe(true)

      // number (float)
      const c3 = agent.produceValue(target, 3.14)
      expect(c3.payload.content).toBe(3.14)

      // bigint
      const c4 = agent.produceValue(target, 42n)
      expect(c4.payload.content).toBe(42n)

      // string
      const c5 = agent.produceValue(target, "test")
      expect(c5.payload.content).toBe("test")

      // Uint8Array
      const bytes = new Uint8Array([1, 2, 3])
      const c6 = agent.produceValue(target, bytes)
      expect(c6.payload.content).toBe(bytes)

      // ref
      const ref = { ref: createCnId("bob", 0) }
      const c7 = agent.produceValue(target, ref)
      expect(c7.payload.content).toEqual(ref)
    })
  })

  describe("produceRetract", () => {
    it("produces a retract constraint with correct fields", () => {
      const agent = createAgent("alice")
      const target = createCnId("bob", 3)
      const c = agent.produceRetract(target)

      expect(c.type).toBe("retract")
      expect(cnIdEquals(c.payload.target, target)).toBe(true)
    })
  })

  describe("produceRule", () => {
    it("produces a rule constraint with correct fields", () => {
      const agent = createAgent("alice")
      const head = { predicate: "winner", terms: [] }
      const body = [
        {
          kind: "atom" as const,
          atom: { predicate: "active_value", terms: [] },
        },
      ]

      const c = agent.produceRule(2, head, body)

      expect(c.type).toBe("rule")
      expect(c.payload.layer).toBe(2)
      expect(c.payload.head.predicate).toBe("winner")
      expect(c.payload.body).toHaveLength(1)
    })

    it("throws for layer < 2", () => {
      const agent = createAgent("alice")
      const head = { predicate: "test", terms: [] }

      expect(() => agent.produceRule(0, head, [])).toThrow("layer ≥ 2")
      expect(() => agent.produceRule(1, head, [])).toThrow("layer ≥ 2")
    })

    it("accepts layer = 2 (boundary)", () => {
      const agent = createAgent("alice")
      const head = { predicate: "test", terms: [] }
      const c = agent.produceRule(2, head, [])
      expect(c.payload.layer).toBe(2)
    })

    it("accepts layer > 2", () => {
      const agent = createAgent("alice")
      const head = { predicate: "test", terms: [] }
      const c = agent.produceRule(5, head, [])
      expect(c.payload.layer).toBe(5)
    })
  })

  describe("produceAuthority", () => {
    it("produces an authority constraint with grant", () => {
      const agent = createAgent("alice")
      const c = agent.produceAuthority("bob", "grant", { kind: "admin" })

      expect(c.type).toBe("authority")
      expect(c.payload.targetPeer).toBe("bob")
      expect(c.payload.action).toBe("grant")
      expect(c.payload.capability.kind).toBe("admin")
    })

    it("produces an authority constraint with revoke", () => {
      const agent = createAgent("alice")
      const c = agent.produceAuthority("bob", "revoke", {
        kind: "write",
        pathPattern: ["docs", "*"],
      })

      expect(c.type).toBe("authority")
      expect(c.payload.action).toBe("revoke")
      expect(c.payload.capability.kind).toBe("write")
      if (c.payload.capability.kind === "write") {
        expect(c.payload.capability.pathPattern).toEqual(["docs", "*"])
      }
    })

    it("supports nested capability (Authority(Capability))", () => {
      const agent = createAgent("alice")
      const c = agent.produceAuthority("bob", "grant", {
        kind: "authority",
        capability: { kind: "write", pathPattern: ["docs"] },
      })

      expect(c.payload.capability.kind).toBe("authority")
      if (c.payload.capability.kind === "authority") {
        expect(c.payload.capability.capability.kind).toBe("write")
      }
    })
  })

  describe("produceBookmark", () => {
    it("produces a bookmark constraint with correct fields", () => {
      const agent = createAgent("alice")
      const version = vvFromObject({ alice: 5, bob: 3 })
      const c = agent.produceBookmark("v1.0", version)

      expect(c.type).toBe("bookmark")
      expect(c.payload.name).toBe("v1.0")
      expect(c.payload.version).toBe(version)
    })
  })

  // -------------------------------------------------------------------------
  // Convenience helpers
  // -------------------------------------------------------------------------

  describe("produceRoot", () => {
    it("produces a root structure and returns constraint + id", () => {
      const agent = createAgent("alice")
      const { constraint, id } = produceRoot(agent, "profile", "map")

      expect(constraint.type).toBe("structure")
      expect(constraint.payload.kind).toBe("root")
      if (constraint.payload.kind === "root") {
        expect(constraint.payload.containerId).toBe("profile")
        expect(constraint.payload.policy).toBe("map")
      }
      expect(cnIdEquals(id, constraint.id)).toBe(true)
    })
  })

  describe("produceMapChild", () => {
    it("produces a map child structure and returns constraint + id", () => {
      const agent = createAgent("alice")
      const parent = createCnId("alice", 0)
      const { constraint, id } = produceMapChild(agent, parent, "name")

      expect(constraint.type).toBe("structure")
      expect(constraint.payload.kind).toBe("map")
      if (constraint.payload.kind === "map") {
        expect(constraint.payload.key).toBe("name")
        expect(cnIdEquals(constraint.payload.parent, parent)).toBe(true)
      }
      expect(cnIdEquals(id, constraint.id)).toBe(true)
    })
  })

  describe("produceSeqChild", () => {
    it("produces a seq child structure and returns constraint + id", () => {
      const agent = createAgent("alice")
      const parent = createCnId("alice", 0)
      const left = createCnId("bob", 1)
      const right = createCnId("charlie", 2)

      const { constraint, id } = produceSeqChild(agent, parent, left, right)

      expect(constraint.type).toBe("structure")
      expect(constraint.payload.kind).toBe("seq")
      if (constraint.payload.kind === "seq") {
        expect(cnIdEquals(constraint.payload.parent, parent)).toBe(true)
        expect(constraint.payload.originLeft).not.toBeNull()
        expect(cnIdEquals(constraint.payload.originLeft!, left)).toBe(true)
        expect(constraint.payload.originRight).not.toBeNull()
        expect(cnIdEquals(constraint.payload.originRight!, right)).toBe(true)
      }
      expect(cnIdEquals(id, constraint.id)).toBe(true)
    })

    it("supports null origins", () => {
      const agent = createAgent("alice")
      const parent = createCnId("alice", 0)
      const { constraint } = produceSeqChild(agent, parent, null, null)

      if (constraint.payload.kind === "seq") {
        expect(constraint.payload.originLeft).toBeNull()
        expect(constraint.payload.originRight).toBeNull()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Version vector updates from own production
  // -------------------------------------------------------------------------

  describe("version vector updates from own production", () => {
    it("updates own entry in VV after producing constraints", () => {
      const agent = createAgent("alice")

      agent.produceStructure({ kind: "root", containerId: "a", policy: "map" }) // alice@0
      expect(vvGet(agent.versionVector, "alice")).toBe(1) // seen 0, next=1

      agent.produceStructure({ kind: "root", containerId: "b", policy: "map" }) // alice@1
      expect(vvGet(agent.versionVector, "alice")).toBe(2) // seen 0,1, next=2

      agent.produceStructure({ kind: "root", containerId: "c", policy: "map" }) // alice@2
      expect(vvGet(agent.versionVector, "alice")).toBe(3) // seen 0,1,2, next=3
    })
  })

  // -------------------------------------------------------------------------
  // Signature
  // -------------------------------------------------------------------------

  describe("signature", () => {
    it("all produced constraints have a Uint8Array sig", () => {
      const agent = createAgent("alice")
      const c = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      expect(c.sig).toBeInstanceOf(Uint8Array)
    })
  })

  // -------------------------------------------------------------------------
  // Immutability of produced constraints
  // -------------------------------------------------------------------------

  describe("immutability", () => {
    it("produced constraints are independent objects", () => {
      const agent = createAgent("alice")
      const c1 = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const c2 = agent.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })

      expect(c1).not.toBe(c2)
      expect(c1.id).not.toBe(c2.id)
      expect(c1.refs).not.toBe(c2.refs)
    })

    it("refs array is a snapshot (not updated retroactively)", () => {
      const agent = createAgent("alice")
      const c1 = agent.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const refsAtCreation = [...c1.refs]

      // Produce more constraints — c1.refs should not change
      agent.produceStructure({ kind: "root", containerId: "b", policy: "map" })
      agent.produceStructure({ kind: "root", containerId: "c", policy: "map" })

      expect(c1.refs).toEqual(refsAtCreation)
    })
  })

  // -------------------------------------------------------------------------
  // Two-agent interaction
  // -------------------------------------------------------------------------

  describe("two-agent interaction", () => {
    it("two agents produce constraints with different CnIds", () => {
      const alice = createAgent("alice")
      const bob = createAgent("bob")

      const a1 = alice.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const b1 = bob.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })

      expect(cnIdEquals(a1.id, b1.id)).toBe(false)
      expect(a1.id.peer).toBe("alice")
      expect(b1.id.peer).toBe("bob")
    })

    it("agents that observe each other produce causally ordered constraints", () => {
      const alice = createAgent("alice")
      const bob = createAgent("bob")

      // Alice produces c1
      const c1 = alice.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })

      // Bob observes c1, then produces c2
      bob.observe(c1)
      const c2 = bob.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })

      // c2 should have higher lamport than c1
      expect(c2.lamport).toBeGreaterThan(c1.lamport)

      // c2 should reference alice@0
      const aliceRef = c2.refs.find(r => r.peer === "alice")
      expect(aliceRef).toBeDefined()
      expect(aliceRef?.counter).toBe(0)
    })

    it("concurrent constraints (no observation) have independent lamports", () => {
      const alice = createAgent("alice")
      const bob = createAgent("bob")

      const a1 = alice.produceStructure({
        kind: "root",
        containerId: "a",
        policy: "map",
      })
      const b1 = bob.produceStructure({
        kind: "root",
        containerId: "b",
        policy: "map",
      })

      // Both start from 0, so both get lamport=1
      expect(a1.lamport).toBe(1)
      expect(b1.lamport).toBe(1)

      // No refs to each other
      expect(a1.refs.find(r => r.peer === "bob")).toBeUndefined()
      expect(b1.refs.find(r => r.peer === "alice")).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Safe-integer overflow
  // -------------------------------------------------------------------------

  describe("safe-integer overflow", () => {
    it("throws when counter would exceed MAX_SAFE_INTEGER", () => {
      // Create agent at MAX_SAFE_INTEGER + 1 counter — next produce should throw
      // Actually, the check is on the counter value being used.
      // Let's create at MAX_SAFE_INTEGER — the produce will use that value,
      // which IS safe, but then counter becomes MAX_SAFE_INTEGER + 1 for next time.
      const agent = createAgent(
        "alice",
        STUB_PRIVATE_KEY,
        Number.MAX_SAFE_INTEGER + 1,
      )

      expect(() => {
        agent.produceStructure({
          kind: "root",
          containerId: "a",
          policy: "map",
        })
      }).toThrow("counter overflow")
    })

    it("does not throw at MAX_SAFE_INTEGER counter", () => {
      // MAX_SAFE_INTEGER is safe, should not throw
      const agent = createAgent(
        "alice",
        STUB_PRIVATE_KEY,
        Number.MAX_SAFE_INTEGER,
      )

      // This should work (counter = MAX_SAFE_INTEGER is still safe)
      expect(() => {
        agent.produceStructure({
          kind: "root",
          containerId: "a",
          policy: "map",
        })
      }).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Stress / realistic scenario
  // -------------------------------------------------------------------------

  describe("realistic scenario", () => {
    it("simulates a multi-agent editing session", () => {
      const alice = createAgent("alice")
      const bob = createAgent("bob")

      // Alice creates a document structure
      const { constraint: rootConstraint, id: rootId } = produceRoot(
        alice,
        "doc",
        "map",
      )
      const { constraint: titleSlot, id: titleSlotId } = produceMapChild(
        alice,
        rootId,
        "title",
      )
      const titleValue = alice.produceValue(titleSlotId, "Untitled")

      // Bob observes Alice's constraints
      bob.observeMany([rootConstraint, titleSlot, titleValue])

      // Bob changes the title
      const bobTitleValue = bob.produceValue(titleSlotId, "My Document")

      // Bob's title value should have higher lamport than Alice's
      expect(bobTitleValue.lamport).toBeGreaterThan(titleValue.lamport)

      // Bob's refs should include Alice's latest
      expect(bobTitleValue.refs.some(r => r.peer === "alice")).toBe(true)

      // Alice observes Bob's change
      alice.observe(bobTitleValue)

      // Alice adds a body field
      const { constraint: bodySlot, id: bodySlotId } = produceMapChild(
        alice,
        rootId,
        "body",
      )
      const bodyValue = alice.produceValue(bodySlotId, "Hello world")

      // Alice's new constraints should reference Bob
      expect(bodySlot.refs.some(r => r.peer === "bob")).toBe(true)
      expect(bodyValue.refs.some(r => r.peer === "bob")).toBe(true)

      // All constraint IDs are unique
      const allIds = [
        rootConstraint.id,
        titleSlot.id,
        titleValue.id,
        bobTitleValue.id,
        bodySlot.id,
        bodyValue.id,
      ]

      const idStrings = allIds.map(id => `${id.peer}@${id.counter}`)
      const unique = new Set(idStrings)
      expect(unique.size).toBe(allIds.length)
    })
  })
})
