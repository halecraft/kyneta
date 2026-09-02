// === Fugue Equivalence Tests ===
// Validates that the native Fugue solver produces identical ordering to the
// complete Fugue Datalog rules for ALL inputs.
//
// The Datalog rules express the full Fugue tree walk:
//   1. fugue_child — derives tree structure from active_structure_seq + constraint_peer
//   2. fugue_sibling_before — sibling ordering (same originLeft, lower peer first)
//   3. fugue_before — full DFS ordering via recursive rules:
//      - siblings: A before B if A is an earlier sibling
//      - depth-first: A before B if A is in an earlier subtree
//      - ancestor: A before all its descendants
//
// See unified-engine.md §8.2, §B.4, §B.7.

import { describe, expect, it } from "vitest"
import { buildDefaultFugueRules } from "../../src/bootstrap.js"
import { evaluateUnified as evaluate } from "../../src/datalog/evaluator.js"
import type { Fact } from "../../src/datalog/types.js"
import { fact } from "../../src/datalog/types.js"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import type {
  CnId,
  PeerID,
  StructureConstraint,
} from "../../src/kernel/types.js"
import {
  buildFugueNodes,
  type FugueNode,
  orderFugueNodes,
} from "../../src/solver/fugue.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeqStructure(
  peer: PeerID,
  counter: number,
  parent: CnId,
  originLeft: CnId | null,
  originRight: CnId | null,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "seq", parent, originLeft, originRight },
  }
}

const PARENT = createCnId("root", 0)
const PARENT_KEY = cnIdKey(PARENT)

// Complete Fugue Datalog rules are imported from bootstrap.ts — the single
// source of truth for default solver rules. See bootstrap.ts for detailed
// documentation of each rule's purpose and the subtree-propagation negation guard.

/**
 * Convert seq structure constraints into Datalog facts for the Fugue rules.
 */
function constraintsToFugueFacts(constraints: StructureConstraint[]): Fact[] {
  const facts: Fact[] = []

  for (const sc of constraints) {
    if (sc.payload.kind !== "seq") continue

    // active_structure_seq(CnId, Parent, OriginLeft, OriginRight)
    facts.push(
      fact("active_structure_seq", [
        cnIdKey(sc.id),
        cnIdKey(sc.payload.parent),
        sc.payload.originLeft !== null ? cnIdKey(sc.payload.originLeft) : null,
        sc.payload.originRight !== null
          ? cnIdKey(sc.payload.originRight)
          : null,
      ]),
    )

    // constraint_peer(CnId, Peer)
    facts.push(fact("constraint_peer", [cnIdKey(sc.id), sc.id.peer]))
  }

  return facts
}

/**
 * Run complete Fugue Datalog rules and extract ALL before-pairs.
 * Returns a set of "A<B" strings for the given parent.
 */
function runDatalogFugue(
  constraints: StructureConstraint[],
  parentKey: string = PARENT_KEY,
): Set<string> {
  const rules = buildDefaultFugueRules()
  const facts = constraintsToFugueFacts(constraints)
  const result = evaluate(rules, facts)

  if (!result.ok) {
    throw new Error(
      `Datalog evaluation failed: ${JSON.stringify(result.error)}`,
    )
  }

  const db = result.value
  const beforeFacts = db.getRelation("fugue_before").tuples()
  const pairs = new Set<string>()

  for (const tuple of beforeFacts) {
    const parent = tuple[0] as string
    if (parent === parentKey) {
      const a = tuple[1] as string
      const b = tuple[2] as string
      pairs.add(`${a}<${b}`)
    }
  }

  return pairs
}

/**
 * Run native Fugue solver and return ordered nodes.
 */
function runNativeFugue(constraints: StructureConstraint[]): FugueNode[] {
  const nodes = buildFugueNodes(constraints)
  return [...orderFugueNodes(nodes)]
}

/**
 * Convert a native Fugue ordering into the COMPLETE set of (A, B) "before" pairs.
 * For every pair where A appears before B in the total order, include "A<B".
 */
function nativeOrderToAllPairs(ordered: FugueNode[]): Set<string> {
  const pairs = new Set<string>()
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      pairs.add(`${ordered[i]?.idKey}<${ordered[j]?.idKey}`)
    }
  }
  return pairs
}

/**
 * Assert that Datalog and native Fugue produce identical total orderings.
 * The Datalog pairs should be exactly the transitive closure of the ordering.
 */
function assertEquivalence(
  constraints: StructureConstraint[],
  parentKey: string = PARENT_KEY,
): {
  nativeOrder: FugueNode[]
  datalogPairs: Set<string>
  nativePairs: Set<string>
} {
  const nativeOrder = runNativeFugue(constraints)
  const nativePairs = nativeOrderToAllPairs(nativeOrder)
  const datalogPairs = runDatalogFugue(constraints, parentKey)

  // Every native pair must be in Datalog
  for (const pair of nativePairs) {
    if (!datalogPairs.has(pair)) {
      const nativeNames = nativeOrder.map(n => n.idKey).join(", ")
      throw new Error(
        `Native pair ${pair} not found in Datalog result.\n` +
          `Native order: [${nativeNames}]\n` +
          `Datalog pairs: ${JSON.stringify([...datalogPairs])}\n` +
          `Native pairs: ${JSON.stringify([...nativePairs])}`,
      )
    }
  }

  // Every Datalog pair must be in native (no spurious pairs)
  for (const pair of datalogPairs) {
    if (!nativePairs.has(pair)) {
      const nativeNames = nativeOrder.map(n => n.idKey).join(", ")
      throw new Error(
        `Datalog pair ${pair} not found in native result.\n` +
          `Native order: [${nativeNames}]\n` +
          `Datalog pairs: ${JSON.stringify([...datalogPairs])}\n` +
          `Native pairs: ${JSON.stringify([...nativePairs])}`,
      )
    }
  }

  expect(datalogPairs.size).toBe(nativePairs.size)

  return { nativeOrder, datalogPairs, nativePairs }
}

// ---------------------------------------------------------------------------
// Equivalence Tests — Full Algorithm
// ---------------------------------------------------------------------------

describe("Fugue equivalence: native == Datalog (complete)", () => {
  // --- Basic cases ---

  it("single element — no ordering constraints", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const { nativeOrder, datalogPairs } = assertEquivalence([e1])

    expect(nativeOrder.length).toBe(1)
    expect(datalogPairs.size).toBe(0)
  })

  it("empty input — no elements, no pairs", () => {
    const nativeOrder = runNativeFugue([])
    const datalogPairs = runDatalogFugue([])

    expect(nativeOrder.length).toBe(0)
    expect(datalogPairs.size).toBe(0)
  })

  // --- Sibling ordering (same originLeft) ---

  it("two concurrent inserts at start — lower peer goes first", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("bob", 0, PARENT, null, null)

    const { nativeOrder } = assertEquivalence([e1, e2])

    // 'alice' < 'bob' → alice first
    expect(nativeOrder[0]?.peer).toBe("alice")
    expect(nativeOrder[1]?.peer).toBe("bob")
  })

  it("three concurrent inserts at same position — transitive ordering via peer", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e3 = makeSeqStructure("charlie", 0, PARENT, null, null)

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.peer).toBe("alice")
    expect(nativeOrder[1]?.peer).toBe("bob")
    expect(nativeOrder[2]?.peer).toBe("charlie")

    // All 3 pairwise orderings should exist
    const aKey = cnIdKey(e1.id)
    const bKey = cnIdKey(e2.id)
    const cKey = cnIdKey(e3.id)
    expect(datalogPairs.has(`${aKey}<${bKey}`)).toBe(true)
    expect(datalogPairs.has(`${bKey}<${cKey}`)).toBe(true)
    expect(datalogPairs.has(`${aKey}<${cKey}`)).toBe(true)
  })

  it("five concurrent inserts at start — all peers ordered correctly", () => {
    const peers: PeerID[] = ["echo", "delta", "alpha", "charlie", "bravo"]
    const elements = peers.map((p, _i) =>
      makeSeqStructure(p, 0, PARENT, null, null),
    )

    const { nativeOrder } = assertEquivalence(elements)

    // Should be alphabetical by peer
    const sortedPeers = [...peers].sort()
    expect(nativeOrder.map(n => n.peer)).toEqual(sortedPeers)
  })

  // --- Sequential inserts (originLeft chains) ---

  it("sequential inserts by single peer preserve order", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("alice", 2, PARENT, e2.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    expect(nativeOrder[1]?.idKey).toBe(cnIdKey(e2.id))
    expect(nativeOrder[2]?.idKey).toBe(cnIdKey(e3.id))
  })

  it("long sequential chain (5 elements)", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("alice", 2, PARENT, e2.id, null)
    const e4 = makeSeqStructure("alice", 3, PARENT, e3.id, null)
    const e5 = makeSeqStructure("alice", 4, PARENT, e4.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3, e4, e5])

    for (let i = 0; i < 5; i++) {
      expect(nativeOrder[i]?.idKey).toBe(cnIdKey(createCnId("alice", i)))
    }
  })

  // --- Depth-first ordering (originLeft tree structure) ---

  it("child of first element comes between first and second (DFS)", () => {
    // e1 → e2 (sequential chain)
    // e3 is a child of e1 (originLeft = e1)
    // DFS: e1, e3, e2
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, e1.id, null)
    // e2 and e3 are both children of e1. e2 has originLeft=e1, e3 has originLeft=e1.
    // They are siblings with same originLeft=e1. 'alice' < 'bob' → e2 before e3.
    // Wait — e2's peer is 'alice' and e3's peer is 'bob'.
    // So the order among siblings of e1 is: e2 (alice), e3 (bob).
    // DFS from virtual root: [e1] → visit children of e1: [e2, e3]
    // DFS of e1's children: e2 first (then e2's children), then e3 (then e3's children).
    // Result: e1, e2, e3

    const { nativeOrder } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    expect(nativeOrder[1]?.idKey).toBe(cnIdKey(e2.id))
    expect(nativeOrder[2]?.idKey).toBe(cnIdKey(e3.id))
  })

  it("nested children: grandchild appears in DFS order", () => {
    // e1 is at the root (originLeft=null)
    // e2 is child of e1 (originLeft=e1)
    // e3 is child of e2 (originLeft=e2)
    // DFS: e1, e2, e3
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("alice", 2, PARENT, e2.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    expect(nativeOrder[1]?.idKey).toBe(cnIdKey(e2.id))
    expect(nativeOrder[2]?.idKey).toBe(cnIdKey(e3.id))
  })

  it("subtree of earlier sibling precedes later sibling", () => {
    // Virtual root has two children: e1 (alice) and e4 (bob)
    // e1 has child e2 (alice), e2 has child e3 (alice)
    // DFS: e1, e2, e3, e4
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("alice", 2, PARENT, e2.id, null)
    const e4 = makeSeqStructure("bob", 0, PARENT, null, null)

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3, e4])

    expect(nativeOrder.map(n => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e3.id),
      cnIdKey(e4.id),
    ])

    // e3 (deep in e1's subtree) should be before e4 (sibling of e1)
    expect(datalogPairs.has(`${cnIdKey(e3.id)}<${cnIdKey(e4.id)}`)).toBe(true)
  })

  it("two subtrees: earlier subtree entirely precedes later subtree", () => {
    // Root children: e1 (alice), e4 (bob)
    // e1's children: e2 (alice)
    // e4's children: e5 (bob)
    // DFS: e1, e2, e4, e5
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e4 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e5 = makeSeqStructure("bob", 1, PARENT, e4.id, null)

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e4, e5])

    expect(nativeOrder.map(n => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e4.id),
      cnIdKey(e5.id),
    ])

    // Cross-subtree: e2 (in e1's subtree) before e4 and e5
    expect(datalogPairs.has(`${cnIdKey(e2.id)}<${cnIdKey(e4.id)}`)).toBe(true)
    expect(datalogPairs.has(`${cnIdKey(e2.id)}<${cnIdKey(e5.id)}`)).toBe(true)
    // e1 before e5
    expect(datalogPairs.has(`${cnIdKey(e1.id)}<${cnIdKey(e5.id)}`)).toBe(true)
  })

  // --- Complex interleaving ---

  it("concurrent inserts after same element — lower peer first among siblings", () => {
    // e1 is first element (originLeft=null)
    // e2 (alice) and e3 (bob) both have originLeft=e1
    // Sibling order: e2 (alice) before e3 (bob)
    // DFS: e1, e2, e3
    const e1 = makeSeqStructure("charlie", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 0, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, e1.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    expect(nativeOrder[1]?.idKey).toBe(cnIdKey(e2.id))
    expect(nativeOrder[2]?.idKey).toBe(cnIdKey(e3.id))
  })

  it("mixed concurrent and sequential: some at root, some in subtree", () => {
    // e1 (alice) at root, e2 (bob) at root (concurrent)
    // e3 (alice) is child of e1 (sequential after e1)
    // DFS: e1, e3, e2 (e1's subtree finishes before e2)
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e3 = makeSeqStructure("alice", 1, PARENT, e1.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    expect(nativeOrder[1]?.idKey).toBe(cnIdKey(e3.id))
    expect(nativeOrder[2]?.idKey).toBe(cnIdKey(e2.id))
  })

  it("interleaved concurrent inserts at multiple levels", () => {
    // e1 (alice) at root
    // e2 (alice) child of e1 (originLeft=e1)
    // e3 (bob) also at root (concurrent with e1)
    // e4 (alice) child of e3 (originLeft=e3)
    // e5 (bob) also child of e3 (originLeft=e3)
    //
    // Root siblings: e1 (alice), e3 (bob) → e1 first
    // e1's children: e2
    // e3's children: e4 (alice), e5 (bob) → e4 first
    //
    // DFS: e1, e2, e3, e4, e5
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e4 = makeSeqStructure("alice", 2, PARENT, e3.id, null)
    const e5 = makeSeqStructure("bob", 1, PARENT, e3.id, null)

    const { nativeOrder, datalogPairs } = assertEquivalence([
      e1,
      e2,
      e3,
      e4,
      e5,
    ])

    expect(nativeOrder.map(n => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e3.id),
      cnIdKey(e4.id),
      cnIdKey(e5.id),
    ])

    // Cross-subtree ordering
    const e2Key = cnIdKey(e2.id)
    const e3Key = cnIdKey(e3.id)
    expect(datalogPairs.has(`${e2Key}<${e3Key}`)).toBe(true)

    // e4 and e5 are children of e3, ordered among themselves
    const e4Key = cnIdKey(e4.id)
    const e5Key = cnIdKey(e5.id)
    expect(datalogPairs.has(`${e4Key}<${e5Key}`)).toBe(true)
  })

  it("deep nesting with concurrent siblings at each level", () => {
    // Level 0 (root children): e1 (alice)
    // Level 1 (children of e1): e2 (alice), e3 (bob)
    // Level 2 (children of e2): e4 (alice)
    // DFS: e1, e2, e4, e3
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, e1.id, null)
    const e4 = makeSeqStructure("alice", 2, PARENT, e2.id, null)

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3, e4])

    expect(nativeOrder.map(n => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e4.id),
      cnIdKey(e3.id),
    ])

    // e4 (grandchild of e1, child of e2) comes before e3 (child of e1)
    // because e2's subtree precedes e3
    expect(datalogPairs.has(`${cnIdKey(e4.id)}<${cnIdKey(e3.id)}`)).toBe(true)
  })

  // --- Determinism ---

  it("deterministic: same inputs produce same order regardless of input ordering", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e3 = makeSeqStructure("charlie", 0, PARENT, null, null)

    const orderings = [
      [e1, e2, e3],
      [e3, e2, e1],
      [e2, e1, e3],
      [e3, e1, e2],
      [e2, e3, e1],
      [e1, e3, e2],
    ]

    const results = orderings.map(input => {
      const native = runNativeFugue(input)
      return native.map(n => n.idKey).join(",")
    })

    const first = results[0]
    for (const result of results) {
      expect(result).toBe(first)
    }
  })

  it("deterministic: complex tree input order does not affect result", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e4 = makeSeqStructure("bob", 1, PARENT, e3.id, null)

    const order1 = [e1, e2, e3, e4]
    const order2 = [e4, e3, e2, e1]
    const order3 = [e3, e1, e4, e2]

    const r1 = assertEquivalence(order1)
    const r2 = assertEquivalence(order2)
    const r3 = assertEquivalence(order3)

    const o1 = r1.nativeOrder.map(n => n.idKey).join(",")
    const o2 = r2.nativeOrder.map(n => n.idKey).join(",")
    const o3 = r3.nativeOrder.map(n => n.idKey).join(",")

    expect(o1).toBe(o2)
    expect(o1).toBe(o3)
  })

  // --- Edge cases ---

  it("single peer sequential chain matches native exactly", () => {
    // This is the simplest "real editing" case: one user typing characters in order.
    const elements: StructureConstraint[] = []
    let prev: CnId | null = null
    for (let i = 0; i < 8; i++) {
      const e = makeSeqStructure("alice", i, PARENT, prev, null)
      elements.push(e)
      prev = e.id
    }

    const { nativeOrder } = assertEquivalence(elements)

    for (let i = 0; i < 8; i++) {
      expect(nativeOrder[i]?.idKey).toBe(cnIdKey(createCnId("alice", i)))
    }
  })

  it("two peers typing sequentially from the same starting point", () => {
    // Alice types "ab" and Bob types "xy" both starting at the beginning.
    // Alice: e1(null) → e2(e1)
    // Bob: e3(null) → e4(e3)
    // Root siblings: e1 (alice), e3 (bob) → e1 first
    // DFS: e1, e2, e3, e4
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, null, null)
    const e4 = makeSeqStructure("bob", 1, PARENT, e3.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3, e4])

    expect(nativeOrder.map(n => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e3.id),
      cnIdKey(e4.id),
    ])
  })

  it("insert in the middle: new element between existing elements", () => {
    // e1 → e2 (alice's sequential chain)
    // e3 is bob's insert with originLeft=e1 (insert between e1 and e2)
    // Both e2 and e3 are children of e1. Sibling order: e2 (alice) before e3 (bob).
    // DFS: e1, e2, e3
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, e1.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3])

    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    expect(nativeOrder[1]?.idKey).toBe(cnIdKey(e2.id))
    expect(nativeOrder[2]?.idKey).toBe(cnIdKey(e3.id))
  })

  it("all pairs in Datalog equal all pairs in native for concurrent siblings", () => {
    // Stress test: many concurrent elements at the root
    const peers: PeerID[] = ["alice", "bob", "charlie", "dave", "eve"]
    const elements = peers.map((p, _i) =>
      makeSeqStructure(p, 0, PARENT, null, null),
    )

    const {
      nativeOrder: _nativeOrder,
      nativePairs,
      datalogPairs,
    } = assertEquivalence(elements)

    // n*(n-1)/2 pairs for 5 elements = 10
    expect(nativePairs.size).toBe(10)
    expect(datalogPairs.size).toBe(10)
  })

  it("wide tree: many children of the same parent", () => {
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)

    // 5 children of e1 from different peers
    const children = ["bob", "charlie", "dave", "eve", "frank"].map((p, _i) =>
      makeSeqStructure(p, 0, PARENT, e1.id, null),
    )

    const { nativeOrder } = assertEquivalence([e1, ...children])

    // e1 first, then children sorted by peer
    expect(nativeOrder[0]?.idKey).toBe(cnIdKey(e1.id))
    const childPeers = nativeOrder.slice(1).map(n => n.peer)
    expect(childPeers).toEqual([...childPeers].sort())
  })

  it("diamond pattern: two paths converge at same originLeft", () => {
    // e1 at root, e2 child of e1, e3 child of e1
    // e4 child of e2, e5 child of e3
    // Root: [e1]
    // e1's children: e2 (alice@1), e3 (bob@0) → alice < bob → e2 first
    // e2's children: e4 (alice@2)
    // e3's children: e5 (bob@1)
    // DFS: e1, e2, e4, e3, e5
    const e1 = makeSeqStructure("alice", 0, PARENT, null, null)
    const e2 = makeSeqStructure("alice", 1, PARENT, e1.id, null)
    const e3 = makeSeqStructure("bob", 0, PARENT, e1.id, null)
    const e4 = makeSeqStructure("alice", 2, PARENT, e2.id, null)
    const e5 = makeSeqStructure("bob", 1, PARENT, e3.id, null)

    const { nativeOrder } = assertEquivalence([e1, e2, e3, e4, e5])

    expect(nativeOrder.map(n => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e4.id),
      cnIdKey(e3.id),
      cnIdKey(e5.id),
    ])
  })
})
