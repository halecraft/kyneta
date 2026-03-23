// === Incremental LWW Tests ===
// Validates that the native incremental LWW solver produces correct
// ZSet<ResolvedWinner> deltas and that its accumulated state matches
// the batch `resolveLWW` for all insertion orderings.

import { describe, expect, it } from "vitest"
import { zsetIsEmpty, zsetSingleton, zsetSize } from "../../src/base/zset.js"
import type { Fact } from "../../src/datalog/types.js"
import { fact } from "../../src/datalog/types.js"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import { ACTIVE_VALUE } from "../../src/kernel/projection.js"
import type { ResolvedWinner } from "../../src/kernel/resolve.js"
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
import { createIncrementalLWW } from "../../src/solver/incremental-lww.js"
import { resolveLWW } from "../../src/solver/lww.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _makeActiveValueFact(
  peer: PeerID,
  counter: number,
  slotId: string,
  content: Value,
  lamport: number,
): Fact {
  const id = createCnId(peer, counter)
  return fact(ACTIVE_VALUE.predicate, [
    cnIdKey(id),
    slotId,
    content,
    lamport,
    peer,
  ])
}

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
 * Build facts from constraints (mirrors the projection step).
 * Returns both facts and the batch resolution for comparison.
 */
function buildBatchWinners(
  structures: StructureConstraint[],
  values: ValueConstraint[],
): ReadonlyMap<string, ResolvedWinner> {
  const all: Constraint[] = [...structures, ...values]
  const index = buildStructureIndex(all)
  const result = resolveLWW(values, index)
  const winners = new Map<string, ResolvedWinner>()
  for (const [slot, winner] of result.winners) {
    winners.set(slot, {
      slotId: slot,
      winnerCnIdKey: cnIdKey(winner.winnerId),
      content: winner.content,
    })
  }
  return winners
}

/**
 * Build active_value facts from constraints via projection.
 */
function buildFacts(
  structures: StructureConstraint[],
  values: ValueConstraint[],
): Fact[] {
  const all: Constraint[] = [...structures, ...values]
  const index = buildStructureIndex(all)
  const facts: Fact[] = []
  for (const vc of values) {
    const targetKey = cnIdKey(vc.payload.target)
    const sid = index.structureToSlot.get(targetKey)
    if (sid === undefined) continue
    facts.push(
      fact(ACTIVE_VALUE.predicate, [
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

/** Generate all permutations of an array. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  const result: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const perm of permutations(rest)) {
      result.push([arr[i]!, ...perm])
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const root = makeStructureRoot("alice", 0, "doc")
const child1 = makeStructureMap("alice", 1, root.id, "title")
const child2 = makeStructureMap("alice", 2, root.id, "body")

const val1 = makeValue("alice", 3, child1.id, "Hello", 10)
const val2 = makeValue("bob", 1, child1.id, "World", 20) // supersedes val1 (higher lamport)
const val3 = makeValue("charlie", 1, child1.id, "Hi", 20) // ties val2 on lamport; 'charlie' > 'bob' → val3 wins

const structures = [root, child1, child2]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IncrementalLWW", () => {
  describe("single value insertion", () => {
    it("first value becomes winner with +1 delta", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val1])
      const delta = lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )

      // Should have exactly one winner delta entry
      expect(zsetSize(delta)).toBe(1)

      // Winner should be val1
      const winners = lww.current()
      expect(winners.size).toBe(1)
      const slotId = [...winners.keys()][0]!
      expect(winners.get(slotId)?.winnerCnIdKey).toBe(cnIdKey(val1.id))
      expect(winners.get(slotId)?.content).toBe("Hello")
    })
  })

  describe("superseding value", () => {
    it("emits +1 only for replacement (not −1 then +1)", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val1, val2])

      // Insert val1 (lamport 10)
      const d1 = lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )
      expect(zsetSize(d1)).toBe(1)

      // Insert val2 (lamport 20) — supersedes val1
      const d2 = lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(val2.id)}`,
          facts[1]!,
          1,
        ),
      )

      // Delta should have exactly 1 entry at +1 (the replacement)
      expect(zsetSize(d2)).toBe(1)
      const entry = [...d2.values()][0]!
      expect(entry.weight).toBe(1)
      expect(entry.element.winnerCnIdKey).toBe(cnIdKey(val2.id))
      expect(entry.element.content).toBe("World")
    })
  })

  describe("non-superseding value", () => {
    it("emits empty delta when loser arrives", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val2, val1])

      // Insert val2 first (lamport 20 — the winner)
      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val2.id)}`,
          facts[0]!,
          1,
        ),
      )

      // Insert val1 (lamport 10 — loses)
      const d2 = lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(val1.id)}`,
          facts[1]!,
          1,
        ),
      )

      // No winner change
      expect(zsetIsEmpty(d2)).toBe(true)

      // Winner is still val2
      const winners = lww.current()
      expect(winners.size).toBe(1)
      expect([...winners.values()][0]?.winnerCnIdKey).toBe(cnIdKey(val2.id))
    })
  })

  describe("value retraction", () => {
    it("retracting the winner promotes the next entry", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val1, val2])

      // Insert both
      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )
      lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(val2.id)}`,
          facts[1]!,
          1,
        ),
      )

      // Winner is val2 (higher lamport)
      expect([...lww.current().values()][0]?.winnerCnIdKey).toBe(
        cnIdKey(val2.id),
      )

      // Retract val2
      const d3 = lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(val2.id)}`,
          facts[1]!,
          -1,
        ),
      )

      // Delta: val1 becomes winner (+1)
      expect(zsetSize(d3)).toBe(1)
      const entry = [...d3.values()][0]!
      expect(entry.weight).toBe(1)
      expect(entry.element.winnerCnIdKey).toBe(cnIdKey(val1.id))
    })

    it("retracting sole entry emits −1", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val1])

      // Insert val1
      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )

      // Retract val1
      const d2 = lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          -1,
        ),
      )

      // Delta: winner removed (−1)
      expect(zsetSize(d2)).toBe(1)
      const entry = [...d2.values()][0]!
      expect(entry.weight).toBe(-1)

      // No winners left
      expect(lww.current().size).toBe(0)
    })

    it("retracting a non-winner emits empty delta", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val1, val2])

      // Insert both (val2 wins with higher lamport)
      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )
      lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(val2.id)}`,
          facts[1]!,
          1,
        ),
      )

      // Retract val1 (the loser)
      const d3 = lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          -1,
        ),
      )

      // No winner change
      expect(zsetIsEmpty(d3)).toBe(true)

      // Winner still val2
      expect([...lww.current().values()][0]?.winnerCnIdKey).toBe(
        cnIdKey(val2.id),
      )
    })
  })

  describe("multiple slots", () => {
    it("tracks slots independently", () => {
      const lww = createIncrementalLWW()
      const valBody = makeValue("alice", 4, child2.id, "Body text", 5)
      const facts = buildFacts(structures, [val1, valBody])

      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )
      lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(valBody.id)}`,
          facts[1]!,
          1,
        ),
      )

      const winners = lww.current()
      expect(winners.size).toBe(2)
    })
  })

  describe("ignores non-active_value facts", () => {
    it("skips facts with different predicates", () => {
      const lww = createIncrementalLWW()
      const otherFact = fact("active_structure_seq", [
        "cn1",
        "parent1",
        null,
        null,
      ])
      const delta = lww.step(zsetSingleton("other|key", otherFact, 1))
      expect(zsetIsEmpty(delta)).toBe(true)
      expect(lww.current().size).toBe(0)
    })
  })

  describe("peer tiebreak", () => {
    it("higher peer wins on lamport tie", () => {
      const lww = createIncrementalLWW()
      // val2 (bob, lamport 20) and val3 (charlie, lamport 20)
      // charlie > bob lexicographically, so val3 wins
      const facts = buildFacts(structures, [val2, val3])

      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val2.id)}`,
          facts[0]!,
          1,
        ),
      )
      lww.step(
        zsetSingleton(
          `${facts[1]?.predicate}|${cnIdKey(val3.id)}`,
          facts[1]!,
          1,
        ),
      )

      const winner = [...lww.current().values()][0]!
      expect(winner.winnerCnIdKey).toBe(cnIdKey(val3.id))
      expect(winner.content).toBe("Hi")
    })
  })

  describe("differential: incremental matches batch", () => {
    it("matches batch for sequential insertions", () => {
      const values = [val1, val2, val3]
      const facts = buildFacts(structures, values)
      const batchWinners = buildBatchWinners(structures, values)

      const lww = createIncrementalLWW()
      for (const f of facts) {
        const key = `${f.predicate}|${f.values[ACTIVE_VALUE.CNID]}`
        lww.step(zsetSingleton(key, f, 1))
      }

      // Compare current() against batch
      const incWinners = lww.current()
      expect(incWinners.size).toBe(batchWinners.size)
      for (const [slot, bw] of batchWinners) {
        const iw = incWinners.get(slot)
        expect(iw).toBeDefined()
        expect(iw?.winnerCnIdKey).toBe(bw.winnerCnIdKey)
        expect(iw?.content).toBe(bw.content)
      }
    })
  })

  describe("permutation: all orderings produce same current()", () => {
    it("3 values for same slot — all 6 orderings match", () => {
      const values = [val1, val2, val3]
      const facts = buildFacts(structures, values)
      const batchWinners = buildBatchWinners(structures, values)

      for (const perm of permutations(facts)) {
        const lww = createIncrementalLWW()
        for (const f of perm) {
          const key = `${f.predicate}|${f.values[ACTIVE_VALUE.CNID]}`
          lww.step(zsetSingleton(key, f, 1))
        }
        const incWinners = lww.current()
        expect(incWinners.size).toBe(batchWinners.size)
        for (const [slot, bw] of batchWinners) {
          const iw = incWinners.get(slot)
          expect(iw).toBeDefined()
          expect(iw?.winnerCnIdKey).toBe(bw.winnerCnIdKey)
          expect(iw?.content).toBe(bw.content)
        }
      }
    })

    it("insert and retract permutations produce same result", () => {
      const facts = buildFacts(structures, [val1, val2])
      // Insert both, then retract val1 — winner should be val2
      // Try all orderings of the two inserts
      for (const perm of permutations(facts)) {
        const lww = createIncrementalLWW()
        for (const f of perm) {
          const key = `${f.predicate}|${f.values[ACTIVE_VALUE.CNID]}`
          lww.step(zsetSingleton(key, f, 1))
        }
        // Now retract val1
        const retractKey = `${facts[0]?.predicate}|${cnIdKey(val1.id)}`
        lww.step(zsetSingleton(retractKey, facts[0]!, -1))

        const winners = lww.current()
        expect(winners.size).toBe(1)
        expect([...winners.values()][0]?.winnerCnIdKey).toBe(cnIdKey(val2.id))
      }
    })
  })

  describe("reset", () => {
    it("clears all state", () => {
      const lww = createIncrementalLWW()
      const facts = buildFacts(structures, [val1])
      lww.step(
        zsetSingleton(
          `${facts[0]?.predicate}|${cnIdKey(val1.id)}`,
          facts[0]!,
          1,
        ),
      )
      expect(lww.current().size).toBe(1)

      lww.reset()
      expect(lww.current().size).toBe(0)
    })
  })
})
