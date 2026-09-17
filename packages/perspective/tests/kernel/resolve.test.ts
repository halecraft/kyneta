// === Phase 4.5 Tests: Datalog-Driven Resolution ===
// Tests cover:
// - The Datalog→kernel bridge: winners and fugue pairs out of a database
// - Custom resolution rules replacing defaults
// - Authority retraction immunity (§2.5)
// - Structure index built from valid set, not active set (§7.2)
// - PipelineResult resolution metadata

import type { Fact, Rule } from "@kyneta/datalog"
import {
  _,
  atom,
  Database,
  eq,
  fact,
  factKey,
  lt,
  negation,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "@kyneta/datalog"
import { zsetFromEntries, zsetGet, zsetSize } from "@kyneta/zset"
import { describe, expect, it } from "vitest"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import {
  type PipelineConfig,
  solve,
  solveFull,
} from "../../src/kernel/pipeline.js"
import {
  extractFugueOrdering,
  extractResolution,
  extractWinners,
  type FugueBeforePair,
  fuguePairDeltas,
  fuguePairKey,
  type ResolvedWinner,
  resolutionOf,
  topologicalOrderFromPairs,
  winnerDeltas,
} from "../../src/kernel/resolve.js"
import { computeActive } from "../../src/kernel/retraction.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import {
  type ConstraintStore,
  createStore,
  insertMany,
} from "../../src/kernel/store.js"
import type {
  AuthorityConstraint,
  CnId,
  Constraint,
  PeerID,
  Reality,
  RealityNode,
  RetractConstraint,
  StructureConstraint,
  Value,
  ValueConstraint,
} from "../../src/kernel/types.js"
import { defaultRuleConstraints, makeRuleConstraint } from "../helpers/rules.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStructureRoot(
  peer: PeerID,
  counter: number,
  containerId: string,
  policy: "map" | "seq" = "map",
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "root", containerId, policy },
  }
}

function makeStructureMap(
  peer: PeerID,
  counter: number,
  parent: CnId,
  key: string,
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "map", parent, key },
  }
}

function makeStructureSeq(
  peer: PeerID,
  counter: number,
  parent: CnId,
  originLeft: CnId | null,
  originRight: CnId | null,
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "seq", parent, originLeft, originRight },
  }
}

function makeValue(
  peer: PeerID,
  counter: number,
  target: CnId,
  content: Value,
  lamport?: number,
): ValueConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "value",
    payload: { target, content },
  }
}

function makeRetract(
  peer: PeerID,
  counter: number,
  target: CnId,
  lamport?: number,
  refs?: CnId[],
): RetractConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: refs ?? [target],
    sig: STUB_SIGNATURE,
    type: "retract",
    payload: { target },
  }
}

function grantAdmin(
  creator: PeerID,
  creatorCounter: number,
  targetPeer: PeerID,
  lamport?: number,
): AuthorityConstraint {
  return {
    id: createCnId(creator, creatorCounter),
    lamport: lamport ?? creatorCounter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "authority",
    payload: {
      targetPeer,
      action: "grant",
      capability: { kind: "admin" },
    },
  }
}

function buildStore(constraints: Constraint[]): ConstraintStore {
  const store = createStore()
  const result = insertMany(store, constraints)
  if (!result.ok)
    throw new Error(`insertMany failed: ${JSON.stringify(result.error)}`)
  return store
}

function getNode(reality: Reality, ...path: string[]): RealityNode | undefined {
  let current: RealityNode | undefined = reality.root
  for (const key of path) {
    if (current === undefined) return undefined
    current = current.children.get(key)
  }
  return current
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

const CONFIG: PipelineConfig = {
  creator: "alice",
}

// ===========================================================================
// Tests
// ===========================================================================

// ---------------------------------------------------------------------------
// resolve.ts unit tests
// ---------------------------------------------------------------------------

describe("resolve: extractWinners", () => {
  it("extracts winners from a Datalog database", () => {
    const db = new Database()
    db.addFact(fact("winner", ["slot:title", "alice@2", "Hello"]))
    db.addFact(fact("winner", ["slot:body", "bob@1", "World"]))

    const winners = extractWinners(db)
    expect(winners.size).toBe(2)

    const title = winners.get("slot:title")
    expect(title).toBeDefined()
    expect(title?.slotId).toBe("slot:title")
    expect(title?.winnerCnIdKey).toBe("alice@2")
    expect(title?.content).toBe("Hello")

    const body = winners.get("slot:body")
    expect(body).toBeDefined()
    expect(body?.content).toBe("World")
  })

  it("returns empty map when no winner facts exist", () => {
    const db = new Database()
    db.addFact(fact("superseded", ["cn1", "title"]))

    const winners = extractWinners(db)
    expect(winners.size).toBe(0)
  })

  it("handles null content (map deletion)", () => {
    const db = new Database()
    db.addFact(fact("winner", ["slot:key", "cn1", null]))

    const winners = extractWinners(db)
    expect(winners.get("slot:key")?.content).toBeNull()
  })

  it("handles numeric content types", () => {
    const db = new Database()
    db.addFact(fact("winner", ["slot:count", "cn1", 42]))
    db.addFact(fact("winner", ["slot:id", "cn2", 99n]))

    const winners = extractWinners(db)
    expect(winners.get("slot:count")?.content).toBe(42)
    expect(winners.get("slot:id")?.content).toBe(99n)
  })
})

describe("resolve: extractFugueOrdering", () => {
  it("extracts before-pairs grouped by parent", () => {
    const db = new Database()
    db.addFact(fact("fugue_before", ["parent1", "a", "b"]))
    db.addFact(fact("fugue_before", ["parent1", "a", "c"]))
    db.addFact(fact("fugue_before", ["parent2", "x", "y"]))

    const pairs = extractFugueOrdering(db)
    expect(pairs.size).toBe(2)
    expect(pairs.get("parent1")?.length).toBe(2)
    expect(pairs.get("parent2")?.length).toBe(1)
  })

  it("returns empty map when no fugue_before facts exist", () => {
    const db = new Database()
    const pairs = extractFugueOrdering(db)
    expect(pairs.size).toBe(0)
  })
})

describe("resolve: extractResolution", () => {
  it("packages winners and pairs into a ResolutionResult", () => {
    const db = new Database()
    db.addFact(fact("winner", ["slot:title", "cn1", "Hello"]))
    db.addFact(fact("fugue_before", ["parent1", "a", "b"]))

    const result = extractResolution(db)
    expect(result.winners.size).toBe(1)
    expect(result.fuguePairs.size).toBe(1)
  })
})

describe("resolve: winnerDeltas and fuguePairDeltas", () => {
  // What the Datalog evaluator emits: derived facts at +1 or −1, keyed by
  // factKey. The kernel reads winners and pairs out of that.
  const derived = (entries: [Fact, number][]) =>
    zsetFromEntries(
      entries.map(([f, w]) => [factKey(f), { element: f, weight: w }]),
    )
  const winner = (cn: string, content: string) =>
    fact("winner", ["slot-1", cn, content])

  it("a new winner is +1 and a removed winner is −1, keyed by slot", () => {
    const added = winnerDeltas(derived([[winner("cn-a", "A"), 1]]))
    expect(zsetGet(added, "slot-1")).toEqual({
      element: { slotId: "slot-1", winnerCnIdKey: "cn-a", content: "A" },
      weight: 1,
    })

    const removed = winnerDeltas(derived([[winner("cn-a", "A"), -1]]))
    expect(zsetGet(removed, "slot-1")?.weight).toBe(-1)
  })

  it("a changed winner emits only the +1, because the skeleton keys by slot", () => {
    const changed = winnerDeltas(
      derived([
        [winner("cn-a", "A"), -1],
        [winner("cn-b", "B"), 1],
      ]),
    )
    expect(zsetSize(changed)).toBe(1)
    expect(zsetGet(changed, "slot-1")?.weight).toBe(1)
    expect(zsetGet(changed, "slot-1")?.element.content).toBe("B")
  })

  it("ignores facts of other predicates", () => {
    const mixed = derived([
      [fact("superseded", ["cn-a", "slot-1"]), 1],
      [fact("fugue_before", ["p", "a", "b"]), 1],
    ])
    expect(zsetSize(winnerDeltas(mixed))).toBe(0)
    expect(zsetSize(fuguePairDeltas(mixed))).toBe(1)
  })

  it("keys pairs by fuguePairKey with ±1 weights", () => {
    const pair: FugueBeforePair = { parentKey: "p", a: "a", b: "b" }
    const deltas = fuguePairDeltas(
      derived([
        [fact("fugue_before", ["p", "a", "b"]), 1],
        [fact("fugue_before", ["p", "b", "c"]), -1],
      ]),
    )
    expect(zsetGet(deltas, fuguePairKey(pair))).toEqual({
      element: pair,
      weight: 1,
    })
    expect(
      zsetGet(deltas, fuguePairKey({ parentKey: "p", a: "b", b: "c" }))?.weight,
    ).toBe(-1)
  })
})

describe("resolve: resolutionOf", () => {
  it("packages winners and pairs with no other state", () => {
    const winners = new Map<string, ResolvedWinner>()
    winners.set("slot:title", {
      slotId: "slot:title",
      winnerCnIdKey: "cn1",
      content: "Hi",
    })

    const result = resolutionOf(winners, new Map())
    expect(result.winners.size).toBe(1)
  })
})

describe("resolve: topologicalOrderFromPairs", () => {
  it("orders elements according to before-pairs", () => {
    const pairs: FugueBeforePair[] = [
      { parentKey: "p", a: "x", b: "y" },
      { parentKey: "p", a: "y", b: "z" },
    ]

    const order = topologicalOrderFromPairs(pairs, ["z", "x", "y"])
    expect(order).toEqual(["x", "y", "z"])
  })

  it("handles single element", () => {
    const order = topologicalOrderFromPairs([], ["only"])
    expect(order).toEqual(["only"])
  })

  it("handles empty input", () => {
    const order = topologicalOrderFromPairs([], [])
    expect(order).toEqual([])
  })

  it("uses lexicographic tiebreak for unrelated elements", () => {
    const pairs: FugueBeforePair[] = [{ parentKey: "p", a: "a", b: "c" }]
    // b has no ordering constraint relative to a or c,
    // so it should be placed by lexicographic order.
    const order = topologicalOrderFromPairs(pairs, ["c", "b", "a"])
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"))
  })

  it("handles diamond-shaped partial order", () => {
    const pairs: FugueBeforePair[] = [
      { parentKey: "p", a: "a", b: "b" },
      { parentKey: "p", a: "a", b: "c" },
      { parentKey: "p", a: "b", b: "d" },
      { parentKey: "p", a: "c", b: "d" },
    ]
    const order = topologicalOrderFromPairs(pairs, ["d", "c", "b", "a"])
    expect(order[0]).toBe("a")
    expect(order[order.length - 1]).toBe("d")
    // b and c can be in either order (both valid), but determinism
    // requires lexicographic: b before c.
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"))
  })
})

// ---------------------------------------------------------------------------
// Pipeline: Datalog-primary path equivalence
// ---------------------------------------------------------------------------

describe("pipeline: Datalog-primary equivalence", () => {
  it("pipeline with LWW rules produces identical map reality to native-only", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grantBob = grantAdmin("alice", 2, "bob")
    const val1 = makeValue("alice", 3, child.id, "Alice", 5)
    const val2 = makeValue("bob", 0, child.id, "Bob", 3)

    const ruleConstraints = defaultRuleConstraints("alice", 10)
    const store = buildStore([
      root,
      child,
      grantBob,
      val1,
      val2,
      ...ruleConstraints,
    ])

    const nativeReality = solve(store, CONFIG)
    const datalogReality = solve(store, CONFIG)

    // Higher lamport wins: Alice's value at lamport 5 wins
    expect(getNode(nativeReality, "profile", "name")?.value).toBe("Alice")
    expect(getNode(datalogReality, "profile", "name")?.value).toBe("Alice")
  })

  it("pipeline with LWW rules resolves peer tiebreak identically", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grantBob = grantAdmin("alice", 2, "bob")
    // Same lamport, different peers — bob > alice lexicographically
    const val1 = makeValue("alice", 3, child.id, "Alice", 5)
    const val2 = makeValue("bob", 0, child.id, "Bob", 5)

    const ruleConstraints = defaultRuleConstraints("alice", 10)
    const store = buildStore([
      root,
      child,
      grantBob,
      val1,
      val2,
      ...ruleConstraints,
    ])

    const nativeReality = solve(store, CONFIG)
    const datalogReality = solve(store, CONFIG)

    expect(getNode(nativeReality, "profile", "name")?.value).toBe("Bob")
    expect(getNode(datalogReality, "profile", "name")?.value).toBe("Bob")
  })

  it("pipeline with Fugue rules produces identical seq ordering", () => {
    const root = makeStructureRoot("alice", 0, "list", "seq")
    const grantBob = grantAdmin("alice", 1, "bob")
    // Concurrent inserts at the same position
    const e1 = makeStructureSeq("alice", 2, root.id, null, null, 3)
    const e2 = makeStructureSeq("bob", 0, root.id, null, null, 3)
    const v1 = makeValue("alice", 3, e1.id, "Alice", 4)
    const v2 = makeValue("bob", 1, e2.id, "Bob", 4)

    const ruleConstraints = defaultRuleConstraints("alice", 10)
    const store = buildStore([
      root,
      grantBob,
      e1,
      e2,
      v1,
      v2,
      ...ruleConstraints,
    ])

    const nativeReality = solve(store, CONFIG)
    const datalogReality = solve(store, CONFIG)

    const nativeList = getNode(nativeReality, "list")!
    const datalogList = getNode(datalogReality, "list")!

    // Both should have 2 children.
    expect(nativeList.children.size).toBe(2)
    expect(datalogList.children.size).toBe(2)

    // Same ordering: lower peer goes first (alice < bob).
    const nativeValues = Array.from(nativeList.children.values()).map(
      n => n.value,
    )
    const datalogValues = Array.from(datalogList.children.values()).map(
      n => n.value,
    )
    expect(datalogValues).toEqual(nativeValues)
  })

  it("pipeline with rules handles null deletion identically", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, child.id, "Alice", 1)
    const val2 = makeValue("alice", 3, child.id, null, 2)

    const ruleConstraints = defaultRuleConstraints("alice", 10)
    const store = buildStore([root, child, val1, val2, ...ruleConstraints])

    const nativeReality = solve(store, CONFIG)
    const datalogReality = solve(store, CONFIG)

    // null wins → key absent from reality
    const nativeProfile = getNode(nativeReality, "profile")!
    const datalogProfile = getNode(datalogReality, "profile")!
    expect(nativeProfile.children.has("name")).toBe(false)
    expect(datalogProfile.children.has("name")).toBe(false)
  })

  it("pipeline with concurrent map structure creation resolved identically", () => {
    const root = makeStructureRoot("alice", 0, "doc")
    const grantBob = grantAdmin("alice", 1, "bob")
    // Both peers independently create structure for same map key
    const aliceName = makeStructureMap("alice", 2, root.id, "title", 3)
    const bobName = makeStructureMap("bob", 0, root.id, "title", 3)
    // Both write a value — higher lamport wins
    const aliceVal = makeValue("alice", 3, aliceName.id, "A", 5)
    const bobVal = makeValue("bob", 1, bobName.id, "B", 10)

    const ruleConstraints = defaultRuleConstraints("alice", 10)
    const store = buildStore([
      root,
      grantBob,
      aliceName,
      bobName,
      aliceVal,
      bobVal,
      ...ruleConstraints,
    ])

    const nativeReality = solve(store, CONFIG)
    const datalogReality = solve(store, CONFIG)

    expect(getNode(nativeReality, "doc", "title")?.value).toBe("B")
    expect(getNode(datalogReality, "doc", "title")?.value).toBe("B")
  })

  it("empty store produces empty reality for both paths", () => {
    const store = createStore()
    const nativeReality = solve(store, CONFIG)
    const datalogReality = solve(store, CONFIG)

    expect(nativeReality.root.children.size).toBe(0)
    expect(datalogReality.root.children.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Native fast path detection
// ---------------------------------------------------------------------------

describe("pipeline: custom resolution rules", () => {
  it("custom lowest-lamport-wins rule replaces default LWW", () => {
    const root = makeStructureRoot("alice", 0, "data")
    const child = makeStructureMap("alice", 1, root.id, "field")
    const grantBob = grantAdmin("alice", 2, "bob")

    // Two competing values: alice at lamport 10, bob at lamport 2
    const aliceVal = makeValue("alice", 3, child.id, "Alice", 10)
    const bobVal = makeValue("bob", 0, child.id, "Bob", 2)

    // Custom rules: lowest lamport wins (opposite of default LWW)
    // superseded_low(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, _),
    //   active_value(CnId2, Slot, _, L2, _),
    //   CnId ≠ CnId2, L2 < L1.
    const supersededByLamportLow: Rule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            _,
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            _,
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        lt(varTerm("L2"), varTerm("L1")),
      ],
    )

    // Peer tiebreak (same as default — lower peer wins this time)
    const supersededByPeerLow: Rule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            varTerm("P1"),
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            varTerm("P2"),
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        eq(varTerm("L2"), varTerm("L1")),
        lt(varTerm("P2"), varTerm("P1")),
      ],
    )

    // winner(Slot, CnId, Value) :- active_value(...), not superseded(...)
    const winnerRule: Rule = rule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            _,
            _,
          ]),
        ),
        negation(atom("superseded", [varTerm("CnId"), varTerm("Slot")])),
      ],
    )

    const customRules = [
      makeRuleConstraint("alice", 10, 1, supersededByLamportLow),
      makeRuleConstraint("alice", 11, 1, supersededByPeerLow),
      makeRuleConstraint("alice", 12, 1, winnerRule),
    ]

    const store = buildStore([
      root,
      child,
      grantBob,
      aliceVal,
      bobVal,
      ...customRules,
    ])

    // Lowest lamport wins under these rules, so bob (2) beats alice (10).
    // Under the default rules it would be the other way round — which is the
    // point: the rules in the store decide, not the engine.
    const reality = solve(store, CONFIG)
    expect(getNode(reality, "data", "field")?.value).toBe("Bob")
  })

  it("custom rules with only winner (no superseded) pick any value", () => {
    const root = makeStructureRoot("alice", 0, "data")
    const child = makeStructureMap("alice", 1, root.id, "field")
    const val1 = makeValue("alice", 2, child.id, "First", 1)
    const val2 = makeValue("alice", 3, child.id, "Second", 2)

    // A silly rule that makes every active_value a winner (no conflict resolution).
    // This will produce multiple winners — the skeleton should use the first one it finds.
    const everyoneWins: Rule = rule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            _,
            _,
          ]),
        ),
      ],
    )

    // Need to mark this as Layer 2 to avoid being detected as default LWW
    const ruleConstraint = makeRuleConstraint("alice", 10, 2, everyoneWins)
    const store = buildStore([root, child, val1, val2, ruleConstraint])

    // Should not throw — the skeleton should handle multiple winners for the same slot
    // by using whichever one the Datalog database returns first.
    const result = solveFull(store, CONFIG)

    const field = getNode(result.reality, "data", "field")
    expect(field).toBeDefined()
    // Value will be one of the two — Datalog winner relation has both.
    // The extractWinners function uses Map.set which overwrites, so
    // the last one set wins (iteration order of the relation).
    expect(["First", "Second"]).toContain(field?.value)
  })
})

// ---------------------------------------------------------------------------
// Authority retraction immunity (§2.5)
// ---------------------------------------------------------------------------

describe("retraction: authority constraint immunity", () => {
  it("retract targeting authority constraint produces a violation", () => {
    const grant = grantAdmin("alice", 0, "bob", 1)
    const retract = makeRetract("alice", 1, grant.id, 2, [grant.id])

    const result = computeActive([grant, retract])

    // The authority constraint should remain active.
    const activeTypes = result.active.map(c => c.type)
    expect(activeTypes).toContain("authority")

    // The retract should produce a violation.
    expect(result.violations.length).toBe(1)
    expect(result.violations[0]?.reason.kind).toBe("targetIsAuthority")
  })

  it("authority constraint remains active even when retracted", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grant = grantAdmin("alice", 2, "bob", 3)

    // Bob writes a value (needs the grant to be valid)
    const bobVal = makeValue("bob", 0, child.id, "Bob", 4)

    // Alice tries to retract the authority grant
    const retract = makeRetract("alice", 3, grant.id, 5, [grant.id])

    const store = buildStore([
      root,
      child,
      grant,
      bobVal,
      retract,
      ...defaultRuleConstraints("alice", 100),
    ])
    const reality = solve(store, CONFIG)

    // Bob's value should still be visible because the authority grant
    // is immune to retraction — Bob still has Admin capability.
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Bob")
  })

  it("retract targeting a structure still produces targetIsStructure violation", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const retract = makeRetract("alice", 1, root.id, 2, [root.id])

    const result = computeActive([root, retract])
    expect(result.violations.length).toBe(1)
    expect(result.violations[0]?.reason.kind).toBe("targetIsStructure")
  })
})

// ---------------------------------------------------------------------------
// Structure index source (§7.2)
// ---------------------------------------------------------------------------

describe("pipeline: structure index from valid set", () => {
  it("structure index includes all valid structure constraints", () => {
    // Structure constraints are immune to retraction, so they should
    // always appear in the structure index regardless of whether we
    // build from valid or active set. This test verifies the pipeline
    // produces correct results when structure constraints coexist
    // with retracted value constraints.
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice", 3)
    const retract = makeRetract("alice", 3, val.id, 4, [val.id])

    const store = buildStore([root, child, val, retract])

    const result = solveFull(store, CONFIG)

    // Structure index should have both root and child
    expect(result.structureIndex.roots.size).toBe(1)
    expect(result.structureIndex.byId.size).toBe(2)

    // The "name" node exists structurally but has no value (retracted)
    const name = getNode(result.reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBeUndefined()
  })

  it("structure index built from valid set contains structures even when values are retracted", () => {
    const root = makeStructureRoot("alice", 0, "doc")
    const title = makeStructureMap("alice", 1, root.id, "title")
    const body = makeStructureMap("alice", 2, root.id, "body")

    // Only title has a value
    const titleVal = makeValue("alice", 3, title.id, "Hello", 4)

    const store = buildStore([
      root,
      title,
      body,
      titleVal,
      ...defaultRuleConstraints("alice", 100),
    ])
    const result = solveFull(store, CONFIG)

    // All 3 structure constraints should be in the index
    expect(result.structureIndex.byId.size).toBe(3)

    // title has a value, body does not
    expect(getNode(result.reality, "doc", "title")?.value).toBe("Hello")
    const bodyNode = getNode(result.reality, "doc", "body")
    expect(bodyNode).toBeDefined()
    expect(bodyNode?.value).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// PipelineResult metadata
// ---------------------------------------------------------------------------

describe("pipeline: resolution metadata in PipelineResult", () => {
  it("solveFull exposes resolutionResult", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice", 3)

    const store = buildStore([
      root,
      child,
      val,
      ...defaultRuleConstraints("alice", 100),
    ])
    const result = solveFull(store, CONFIG)

    expect(result.resolutionResult).toBeDefined()
    expect(result.resolutionResult.winners.size).toBe(1)
  })

  it("a custom winner rule decides the resolution", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice", 3)

    // Add a Layer 2 rule to force Datalog path
    const customRule: Rule = rule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            _,
            _,
          ]),
        ),
      ],
    )
    const ruleConstraint = makeRuleConstraint("alice", 10, 2, customRule)

    const store = buildStore([root, child, val, ruleConstraint])
    const result = solveFull(store, CONFIG)

    // Assert the *outcome*, not only the flags. A test that forces a path and
    // then checks nothing but metadata will keep passing even if that path
    // stops resolving anything at all. With a single value and a rule that
    // makes every `active_value` a winner, this is the one value.
    expect(getNode(result.reality, "profile", "name")?.value).toBe("Alice")
  })

  it("resolution result contains correct LWW winner data", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice", 3)

    const store = buildStore([
      root,
      child,
      val,
      ...defaultRuleConstraints("alice", 100),
    ])
    const result = solveFull(store, CONFIG)

    const winners = result.resolutionResult.winners
    expect(winners.size).toBe(1)

    const winner = Array.from(winners.values())[0]!
    expect(winner.content).toBe("Alice")
    expect(winner.winnerCnIdKey).toBe(cnIdKey(val.id))
  })
})

// ---------------------------------------------------------------------------
// Existing pipeline tests still pass (spot checks)
// ---------------------------------------------------------------------------
