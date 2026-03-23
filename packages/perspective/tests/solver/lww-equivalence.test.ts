// === LWW Equivalence Tests ===
// Validates that the native LWW solver produces identical results to the
// LWW Datalog rules from §B.4 for the same inputs.
//
// The native solver is an optimization (§B.7) — it MUST be semantically
// equivalent to the rules-as-data evaluator.

import { describe, expect, it } from "vitest"
import { buildDefaultLWWRules } from "../../src/bootstrap.js"
import { evaluateUnified as evaluate } from "../../src/datalog/evaluator.js"
import type { Fact } from "../../src/datalog/types.js"
import { fact } from "../../src/datalog/types.js"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import { buildStructureIndex } from "../../src/kernel/structure-index.js"
import type {
  CnId,
  Constraint,
  PeerID,
  StructureConstraint,
  Value,
  ValueConstraint,
} from "../../src/kernel/types.js"
import { resolveLWW } from "../../src/solver/lww.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStructureRoot(
  peer: PeerID,
  counter: number,
  containerId: string,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "root", containerId, policy: "map" },
  }
}

function makeStructureMap(
  peer: PeerID,
  counter: number,
  parent: CnId,
  key: string,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "map", parent, key },
  }
}

function makeValue(
  peer: PeerID,
  counter: number,
  target: CnId,
  content: Value,
  lamport: number,
): ValueConstraint {
  return {
    id: createCnId(peer, counter),
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "value",
    payload: { target, content },
  }
}

/**
 * Run the Datalog LWW rules on a set of active_value facts and
 * return a Map<slotId, { winnerId, content }>.
 */
function runDatalogLWW(
  activeValueFacts: Fact[],
): Map<string, { winnerId: string; content: Value }> {
  const rules = buildDefaultLWWRules()
  const result = evaluate(rules, activeValueFacts)

  if (!result.ok) {
    throw new Error(
      `Datalog evaluation failed: ${JSON.stringify(result.error)}`,
    )
  }

  const db = result.value
  const winnerFacts = db.getRelation("winner").tuples()
  const winners = new Map<string, { winnerId: string; content: Value }>()

  for (const tuple of winnerFacts) {
    // winner(Slot, CnId, Value)
    const slot = tuple[0] as string
    const cnid = tuple[1] as string
    const value = tuple[2] as Value
    winners.set(slot, { winnerId: cnid, content: value })
  }

  return winners
}

/**
 * Run the native LWW solver on a set of value constraints + structure index
 * and return a Map<slotId, { winnerId, content }>.
 */
function runNativeLWW(
  valueConstraints: ValueConstraint[],
  allConstraints: Constraint[],
): Map<string, { winnerId: string; content: Value }> {
  const index = buildStructureIndex(allConstraints)
  const result = resolveLWW(valueConstraints, index)

  const winners = new Map<string, { winnerId: string; content: Value }>()
  for (const [slot, winner] of result.winners) {
    winners.set(slot, {
      winnerId: cnIdKey(winner.winnerId),
      content: winner.content,
    })
  }
  return winners
}

/**
 * Convert constraints into Datalog active_value facts using the projection.
 */
function constraintsToFacts(
  valueConstraints: ValueConstraint[],
  allConstraints: Constraint[],
): Fact[] {
  const index = buildStructureIndex(allConstraints)
  const facts: Fact[] = []

  for (const vc of valueConstraints) {
    const targetKey = cnIdKey(vc.payload.target)
    const sid = index.structureToSlot.get(targetKey)
    if (sid === undefined) continue

    facts.push(
      fact("active_value", [
        cnIdKey(vc.id),
        sid,
        vc.payload.content,
        vc.lamport,
        vc.id.peer,
      ]),
    )
  }

  return facts
}

// ---------------------------------------------------------------------------
// Equivalence Tests
// ---------------------------------------------------------------------------

describe("LWW equivalence: native == Datalog", () => {
  it("single value — no conflict", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice", 5)

    const all: Constraint[] = [root, child, val]
    const values = [val]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    expect(nativeResult.size).toBe(1)
    expect(datalogResult.size).toBe(1)

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
    }
  })

  it("two concurrent writes — higher lamport wins", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, child.id, "Alice", 3)
    const val2 = makeValue("bob", 2, child.id, "Bob", 7)

    const all: Constraint[] = [root, child, val1, val2]
    const values = [val1, val2]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
      expect(native.content).toBe("Bob")
    }
  })

  it("lamport tie — lexicographically greater peer wins", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, child.id, "Alice", 5)
    const val2 = makeValue("bob", 2, child.id, "Bob", 5)

    const all: Constraint[] = [root, child, val1, val2]
    const values = [val1, val2]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
      // "bob" > "alice", so Bob wins
      expect(native.content).toBe("Bob")
    }
  })

  it("three-way tie broken by peer", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, child.id, "Alice", 5)
    const val2 = makeValue("bob", 2, child.id, "Bob", 5)
    const val3 = makeValue("charlie", 2, child.id, "Charlie", 5)

    const all: Constraint[] = [root, child, val1, val2, val3]
    const values = [val1, val2, val3]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
      // "charlie" > "bob" > "alice"
      expect(native.content).toBe("Charlie")
    }
  })

  it("multiple independent slots — each resolved separately", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const title = makeStructureMap("alice", 1, root.id, "title")
    const body = makeStructureMap("alice", 2, root.id, "body")

    const titleVal1 = makeValue("alice", 3, title.id, "Hello", 1)
    const titleVal2 = makeValue("bob", 3, title.id, "Bonjour", 3)
    const bodyVal1 = makeValue("alice", 4, body.id, "World", 5)
    const bodyVal2 = makeValue("bob", 4, body.id, "Monde", 2)

    const all: Constraint[] = [
      root,
      title,
      body,
      titleVal1,
      titleVal2,
      bodyVal1,
      bodyVal2,
    ]
    const values = [titleVal1, titleVal2, bodyVal1, bodyVal2]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    expect(nativeResult.size).toBe(2)
    expect(datalogResult.size).toBe(2)

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
    }
  })

  it("null value wins via LWW (map deletion)", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, child.id, "Alice", 3)
    const val2 = makeValue("alice", 3, child.id, null, 5)

    const all: Constraint[] = [root, child, val1, val2]
    const values = [val1, val2]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBeNull()
      expect(datalog?.content).toBeNull()
    }
  })

  it("five concurrent writers, all different lamports", () => {
    const root = makeStructureRoot("alice", 0, "data")
    const child = makeStructureMap("alice", 1, root.id, "key")

    const writers: { peer: PeerID; content: string; lamport: number }[] = [
      { peer: "alice", content: "A", lamport: 3 },
      { peer: "bob", content: "B", lamport: 7 },
      { peer: "charlie", content: "C", lamport: 1 },
      { peer: "dave", content: "D", lamport: 5 },
      { peer: "eve", content: "E", lamport: 9 },
    ]

    const values: ValueConstraint[] = writers.map((w, i) =>
      makeValue(w.peer, 10 + i, child.id, w.content, w.lamport),
    )

    const all: Constraint[] = [root, child, ...values]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
      // Eve has highest lamport (9)
      expect(native.content).toBe("E")
    }
  })

  it("five concurrent writers, all same lamport", () => {
    const root = makeStructureRoot("alice", 0, "data")
    const child = makeStructureMap("alice", 1, root.id, "key")

    const writers: { peer: PeerID; content: string }[] = [
      { peer: "alice", content: "A" },
      { peer: "bob", content: "B" },
      { peer: "charlie", content: "C" },
      { peer: "dave", content: "D" },
      { peer: "eve", content: "E" },
    ]

    const values: ValueConstraint[] = writers.map((w, i) =>
      makeValue(w.peer, 10 + i, child.id, w.content, 5),
    )

    const all: Constraint[] = [root, child, ...values]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe(datalog?.content)
      // "eve" is lexicographically greatest
      expect(native.content).toBe("E")
    }
  })

  it("concurrent map structure creation — same slot, different structure CnIds", () => {
    const root = makeStructureRoot("alice", 0, "profile")

    // Two peers independently create the same map slot
    const aliceChild = makeStructureMap("alice", 1, root.id, "name")
    const bobChild = makeStructureMap("bob", 1, root.id, "name")

    // Each writes targeting their own structure
    const aliceVal = makeValue("alice", 2, aliceChild.id, "Alice", 3)
    const bobVal = makeValue("bob", 2, bobChild.id, "Bob", 7)

    const all: Constraint[] = [root, aliceChild, bobChild, aliceVal, bobVal]
    const values = [aliceVal, bobVal]

    const nativeResult = runNativeLWW(values, all)
    const datalogResult = runDatalogLWW(constraintsToFacts(values, all))

    // Both must resolve to the same winner (Bob, lamport 7)
    expect(nativeResult.size).toBe(1)
    expect(datalogResult.size).toBe(1)

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.winnerId).toBe(datalog?.winnerId)
      expect(native.content).toBe("Bob")
      expect(datalog?.content).toBe("Bob")
    }
  })

  it("determinism: same inputs produce same output regardless of iteration order", () => {
    const root = makeStructureRoot("alice", 0, "data")
    const child = makeStructureMap("alice", 1, root.id, "key")

    const val1 = makeValue("alice", 2, child.id, "A", 5)
    const val2 = makeValue("bob", 2, child.id, "B", 5)
    const val3 = makeValue("charlie", 2, child.id, "C", 5)

    const all: Constraint[] = [root, child, val1, val2, val3]

    // Try different orderings of value constraints
    const orderings = [
      [val1, val2, val3],
      [val3, val2, val1],
      [val2, val1, val3],
      [val3, val1, val2],
    ]

    const results: string[] = []
    for (const order of orderings) {
      const native = runNativeLWW(order, all)
      for (const [, winner] of native) {
        results.push(winner.content as string)
      }
    }

    // All orderings should produce the same winner
    expect(new Set(results).size).toBe(1)
  })

  it("orphaned values are excluded by both native and Datalog", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")

    const goodVal = makeValue("alice", 2, child.id, "Hello", 5)
    // Orphan targets a structure that doesn't exist
    const orphanVal = makeValue("bob", 3, createCnId("nobody", 99), "Ghost", 10)

    const all: Constraint[] = [root, child, goodVal, orphanVal]
    const values = [goodVal, orphanVal]

    const nativeResult = runNativeLWW(values, all)
    // Datalog facts only include non-orphaned values
    const datalogFacts = constraintsToFacts(values, all)
    const datalogResult = runDatalogLWW(datalogFacts)

    // Only 1 slot (the orphan is excluded)
    expect(nativeResult.size).toBe(1)
    expect(datalogResult.size).toBe(1)

    for (const [slot, native] of nativeResult) {
      const datalog = datalogResult.get(slot)
      expect(datalog).toBeDefined()
      expect(native.content).toBe("Hello")
      expect(datalog?.content).toBe("Hello")
    }
  })
})
