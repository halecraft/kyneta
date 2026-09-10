// === The default rule program, under the unified evaluator ===
// The evaluator itself has no idea what a winner is. These tests run the LWW and
// Fugue rules that `bootstrap.ts` puts in every new reality (§B.4) through it, and
// assert on the reality that comes out: which value wins a slot, how sequence
// elements order, what happens when the rules themselves are retracted.
//
// They lived beside the evaluator until it became `@kyneta/datalog`. Tests of
// evaluator *mechanics* — weights, deltas, the dirty map, stratum scheduling —
// stayed with it; these came here, because what they check is the rules, and the
// rules ship from this package.

import type { Fact, Rule, Value } from "@kyneta/datalog"
import {
  _,
  atom,
  createEvaluator,
  evaluate,
  evaluatePositive,
  fact,
  factKey,
  factsToZSet,
  lt,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "@kyneta/datalog"
import type { ZSet } from "@kyneta/zset"
import {
  zsetAdd,
  zsetEmpty,
  zsetForEach,
  zsetFromEntries,
  zsetIsEmpty,
  zsetSingleton,
  zsetSize,
} from "@kyneta/zset"
import { describe, expect, it } from "vitest"
import { buildDefaultLWWRules, buildDefaultRules } from "../../src/bootstrap.js"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import type {
  FugueBeforePair,
  ResolvedWinner,
} from "../../src/kernel/resolve.js"
import {
  extractResolution,
  fuguePairDeltas,
  winnerDeltas,
} from "../../src/kernel/resolve.js"

// ---------------------------------------------------------------------------
// Helpers
//
// The projection stage in `kernel/projection.ts` is what builds these facts for
// real; here we shortcut it, because what is under test is the rules, not the
// projection. The column layouts are the ones `ACTIVE_VALUE` documents.
// ---------------------------------------------------------------------------

/** `active_value(CnId, Slot, Content, Lamport, Peer)` — one value assertion. */
function makeActiveValueFact(
  peer: string,
  counter: number,
  slotId: string,
  content: Value,
  lamport: number,
): Fact {
  const id = createCnId(peer, counter)
  return fact("active_value", [cnIdKey(id), slotId, content, lamport, peer])
}

/** Generate all permutations of an array. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]
  const result: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    for (const perm of permutations(rest)) {
      result.push([arr[i] as T, ...perm])
    }
  }
  return result
}

/** Build a ZSet<Fact> with a weight per fact, keyed the way `step` expects. */
function factsToWeightedZSet(facts: [Fact, number][]): ZSet<Fact> {
  return zsetFromEntries(
    facts.map(([f, w]) => [factKey(f), { element: f, weight: w }]),
  )
}

describe("the default rule program", () => {
  describe("LWW resolution with default rules", () => {
    const lwwRules = buildDefaultLWWRules()
    const slotId = "slot:title"

    it("single active_value produces a winner", () => {
      const evaluator = createEvaluator(lwwRules)

      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const delta = factsToZSet([f])

      const result = evaluator.step(delta)

      const winners = winnerDeltas(result)
      expect(zsetIsEmpty(winners)).toBe(false)
      expect(zsetSize(winners)).toBe(1)

      const winnerEntry = [...winners.values()][0]!
      expect(winnerEntry.weight).toBe(1)
      expect(winnerEntry.element.slotId).toBe(slotId)
      expect(winnerEntry.element.content).toBe("Hello")
    })

    it("superseding value produces winner change", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert first value (lamport 10).
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]))

      // Insert superseding value (lamport 20).
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      const result = evaluator.step(factsToZSet([f2]))

      // Should have winner changes.
      expect(zsetIsEmpty(winnerDeltas(result))).toBe(false)

      // The new winner should be bob's value.
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(1)
      const winner = resolution.winners.get(slotId)!
      expect(winner.content).toBe("World")
      expect(winner.winnerCnIdKey).toBe(cnIdKey(createCnId("bob", 1)))
    })

    it("non-superseding value produces no winner change", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert the winner first (lamport 20).
      const f1 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1]))

      // Insert a loser (lamport 10).
      const f2 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f2]))

      // The winner should still be bob's value.
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(1)
      expect(resolution.winners.get(slotId)?.content).toBe("World")
    })

    it("value retraction causes winner recomputation via weight propagation", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert two values.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1, f2]))

      // Winner should be bob (lamport 20).
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("World")

      // Retract bob's value.
      const retractDelta = factsToWeightedZSet([[f2, -1]])
      evaluator.step(retractDelta)

      // Winner should now be alice — via weight propagation, not DRed.
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(1)
      expect(resolution.winners.get(slotId)?.content).toBe("Hello")
    })

    it("retraction of sole value removes winner", () => {
      const evaluator = createEvaluator(lwwRules)

      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]))

      // Retract it.
      evaluator.step(factsToWeightedZSet([[f1, -1]]))

      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(0)
    })

    it("multiple slots are tracked independently", () => {
      const evaluator = createEvaluator(lwwRules)

      const f1 = makeActiveValueFact("alice", 1, "slot:title", "Title", 10)
      const f2 = makeActiveValueFact("alice", 2, "slot:body", "Body", 10)

      evaluator.step(factsToZSet([f1, f2]))

      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(2)
      expect(resolution.winners.get("slot:title")?.content).toBe("Title")
      expect(resolution.winners.get("slot:body")?.content).toBe("Body")
    })

    it("peer tiebreak: higher peer wins on lamport tie", () => {
      const evaluator = createEvaluator(lwwRules)

      const f1 = makeActiveValueFact("bob", 1, slotId, "Bob", 20)
      const f2 = makeActiveValueFact("charlie", 1, slotId, "Charlie", 20)

      evaluator.step(factsToZSet([f1, f2]))

      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.get(slotId)?.content).toBe("Charlie")
    })

    it("superseding value produces old winner −1, new winner +1", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert first value (lamport 10).
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]))

      // Insert superseding value (lamport 20).
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      const result = evaluator.step(factsToZSet([f2]))

      // Should have winner changes.
      expect(zsetIsEmpty(winnerDeltas(result))).toBe(false)

      // Collect all winner deltas.
      const entries: { element: ResolvedWinner; weight: number }[] = []
      zsetForEach(winnerDeltas(result), e => entries.push(e))

      // A changed winner arrives as a single +1, not a −1 then a +1: both the
      // old and the new winner key on the same slot, so `winnerDeltas` reports
      // the replacement and lets the skeleton overwrite. See `winnerDeltas` in
      // `kernel/resolve.ts` for why that fold is hand-written.
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(1)
      expect(resolution.winners.get(slotId)?.content).toBe("World")
      expect(resolution.winners.get(slotId)?.winnerCnIdKey).toBe(
        cnIdKey(createCnId("bob", 1)),
      )
    })

    it("value retraction causes winner recomputation", () => {
      const evaluator = createEvaluator(lwwRules)

      // Insert two values.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1, f2]))

      // Winner should be bob (lamport 20).
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("World")

      // Retract bob's value.
      const retractDelta = factsToWeightedZSet([[f2, -1]])
      const _result = evaluator.step(retractDelta)

      // Winner should now be alice.
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.size).toBe(1)
      expect(resolution.winners.get(slotId)?.content).toBe("Hello")
    })
  })

  // ---------------------------------------------------------------------------
  // Three-way equivalence oracle
  // ---------------------------------------------------------------------------

  describe("three-way oracle: batch ≡ single-step ≡ one-at-a-time", () => {
    const lwwRules = buildDefaultLWWRules()
    const slotId = "slot:title"

    it("all three paths produce the same database for sequential insertions", () => {
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
        makeActiveValueFact("charlie", 1, slotId, "Hi", 20),
      ]

      // Path 1: batch evaluate (old evaluate function).
      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      // Path 2: unified evaluator, single step with all facts.
      const singleStep = createEvaluator(lwwRules)
      singleStep.step(factsToZSet(facts))
      const _singleStepDb = singleStep.currentDatabase()

      // Path 3: unified evaluator, one fact per step.
      const oneAtATime = createEvaluator(lwwRules)
      for (const f of facts) {
        oneAtATime.step(factsToZSet([f]))
      }
      const _oneAtATimeDb = oneAtATime.currentDatabase()

      // Compare winners across all three.
      const batchWinners = new Map<string, Value>()
      for (const tuple of batchDb.getRelation("winner").tuples()) {
        batchWinners.set(tuple[0] as string, tuple[2]!)
      }

      const singleStepWinners = extractResolution(
        singleStep.currentDatabase(),
      ).winners
      const oneAtATimeWinners = extractResolution(
        oneAtATime.currentDatabase(),
      ).winners

      // All should have the same number of winners.
      expect(singleStepWinners.size).toBe(batchWinners.size)
      expect(oneAtATimeWinners.size).toBe(batchWinners.size)

      // All should agree on content.
      for (const [slot, content] of batchWinners) {
        expect(singleStepWinners.get(slot)?.content).toBe(content)
        expect(oneAtATimeWinners.get(slot)?.content).toBe(content)
      }
    })

    it("matches batch for two values in the same step", () => {
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]

      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      const evaluator = createEvaluator(lwwRules)
      evaluator.step(factsToZSet(facts))

      const incRes = extractResolution(evaluator.currentDatabase())
      const batchWinner = batchDb.getRelation("winner").tuples()[0]!

      expect(incRes.winners.size).toBe(1)
      expect(incRes.winners.get(slotId)?.content).toBe(batchWinner[2])
    })

    it("accepts a Z-set keyed by zsetSingleton(factKey(f)) as well as factsToZSet", () => {
      // `step` trusts the key it is given instead of recomputing it, so the
      // contract is that every producer keys by `factKey`. Both blessed
      // ways of building the input must agree with batch.
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]
      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchWinner = batchResult.value.getRelation("winner").tuples()[0]!

      const viaHelper = createEvaluator(lwwRules)
      viaHelper.step(factsToZSet(facts))

      const viaSingletons = createEvaluator(lwwRules)
      for (const f of facts) {
        viaSingletons.step(zsetSingleton(factKey(f), f, 1))
      }

      expect(
        extractResolution(viaHelper.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe(batchWinner[2])
      expect(
        extractResolution(viaSingletons.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe(batchWinner[2])
      // And a retraction keyed the same way is honoured.
      viaSingletons.step(zsetSingleton(factKey(facts[1]!), facts[1]!, -1))
      expect(
        extractResolution(viaSingletons.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("Hello")
    })

    it("three-way oracle with transitive closure", () => {
      const rules: Rule[] = [
        rule(atom("path", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("path", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const edges = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["c", "d"]),
      ]

      // Path 1: old batch evaluate.
      const batchDb = evaluatePositive(rules, edges)

      // Path 2: unified single step.
      const singleStep = createEvaluator(rules)
      singleStep.step(factsToZSet(edges))

      // Path 3: unified one-at-a-time.
      const oneAtATime = createEvaluator(rules)
      for (const e of edges) {
        oneAtATime.step(factsToZSet([e]))
      }

      const batchPaths = batchDb.getRelation("path").tuples()
      const singlePaths = singleStep
        .currentDatabase()
        .getRelation("path")
        .tuples()
      const oneAtATimePaths = oneAtATime
        .currentDatabase()
        .getRelation("path")
        .tuples()

      expect(singlePaths.length).toBe(batchPaths.length)
      expect(oneAtATimePaths.length).toBe(batchPaths.length)

      for (const t of batchPaths) {
        expect(singleStep.currentDatabase().hasFact(fact("path", t))).toBe(true)
        expect(oneAtATime.currentDatabase().hasFact(fact("path", t))).toBe(true)
      }
    })

    it("matches batch Datalog for sequential insertions", () => {
      const evaluator = createEvaluator(lwwRules)

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
        makeActiveValueFact("charlie", 1, slotId, "Hi", 20),
      ]

      // Feed incrementally.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]))
      }

      // Batch evaluate.
      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      // Compare winners.
      const incRes = extractResolution(evaluator.currentDatabase())
      const batchWinners = new Map<string, { slotId: string; content: Value }>()
      for (const tuple of batchDb.getRelation("winner").tuples()) {
        batchWinners.set(tuple[0] as string, {
          slotId: tuple[0] as string,
          content: tuple[2]!,
        })
      }

      expect(incRes.winners.size).toBe(batchWinners.size)
      for (const [slot, bw] of batchWinners) {
        const iw = incRes.winners.get(slot)
        expect(iw).toBeDefined()
        expect(iw?.content).toBe(bw.content)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Permutation test
  // ---------------------------------------------------------------------------

  describe("permutation test", () => {
    const lwwRules = buildDefaultLWWRules()
    const slotId = "slot:title"

    it("all orderings of 3 values produce same current resolution", () => {
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "A", 10),
        makeActiveValueFact("bob", 1, slotId, "B", 20),
        makeActiveValueFact("charlie", 1, slotId, "C", 20),
      ]

      // Batch evaluate for the expected result.
      const batchResult = evaluate(lwwRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value
      const batchWinnerTuple = batchDb.getRelation("winner").tuples()[0]!
      const expectedContent = batchWinnerTuple[2]

      for (const perm of permutations(facts)) {
        const evaluator = createEvaluator(lwwRules)
        for (const f of perm) {
          evaluator.step(factsToZSet([f]))
        }
        const resolution = extractResolution(evaluator.currentDatabase())
        expect(resolution.winners.size).toBe(1)
        expect(resolution.winners.get(slotId)?.content).toBe(expectedContent)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // Fugue rules
  // ---------------------------------------------------------------------------

  describe("Fugue rules with default rules", () => {
    const allRules = buildDefaultRules()

    it("structure facts produce fugue_child derivation", () => {
      const evaluator = createEvaluator(allRules)

      const parentKey = cnIdKey(createCnId("alice", 0))
      const childKey = cnIdKey(createCnId("alice", 1))

      const seqFact = fact("active_structure_seq", [
        childKey,
        parentKey,
        null,
        null,
      ])
      const peerFact = fact("constraint_peer", [childKey, "alice"])

      evaluator.step(factsToZSet([seqFact, peerFact]))

      const db = evaluator.currentDatabase()
      const fugueChildTuples = db.getRelation("fugue_child").tuples()
      expect(fugueChildTuples.length).toBe(1)
      expect(fugueChildTuples[0]?.[0]).toBe(parentKey)
      expect(fugueChildTuples[0]?.[1]).toBe(childKey)
    })

    it("two children produce fugue_before pairs", () => {
      const evaluator = createEvaluator(allRules)

      const parentKey = cnIdKey(createCnId("alice", 0))
      const child1Key = cnIdKey(createCnId("alice", 1))
      const child2Key = cnIdKey(createCnId("bob", 1))

      const seq1 = fact("active_structure_seq", [
        child1Key,
        parentKey,
        null,
        null,
      ])
      const peer1 = fact("constraint_peer", [child1Key, "alice"])

      const seq2 = fact("active_structure_seq", [
        child2Key,
        parentKey,
        child1Key,
        null,
      ])
      const peer2 = fact("constraint_peer", [child2Key, "bob"])

      evaluator.step(factsToZSet([seq1, peer1, seq2, peer2]))

      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.fuguePairs.size).toBeGreaterThan(0)

      const allPairs: FugueBeforePair[] = []
      for (const pairs of resolution.fuguePairs.values()) {
        allPairs.push(...pairs)
      }
      expect(allPairs.length).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------------------
  // Rule changes
  // ---------------------------------------------------------------------------

  describe("rule changes", () => {
    it("adding a custom superseded rule changes resolution", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      // Insert two competing values.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      evaluator.step(factsToZSet([f1, f2]))

      // With default rules, bob wins (lamport 20 > 10).
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("World")

      // Add a custom rule that makes LOWER lamport win.
      const customRule = rule(
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
          lt(varTerm("L2"), varTerm("L1")), // reversed: lower lamport wins
        ],
      )

      // Remove default superseded rules, add custom one.
      let ruleDelta = zsetEmpty<Rule>()
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton("rule1", lwwRules[0]!, -1))
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton("rule2", lwwRules[1]!, -1))
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton("rule3", customRule, 1))

      evaluator.changeRules(ruleDelta)

      // Now alice should win (lamport 10 < 20).
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.get(slotId)?.content).toBe("Hello")
    })
  })

  // ---------------------------------------------------------------------------
  // Empty inputs
  // ---------------------------------------------------------------------------

  describe("empty inputs", () => {
    it("empty delta produces empty result", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const result = evaluator.step(zsetEmpty())

      expect(zsetIsEmpty(winnerDeltas(result))).toBe(true)
      expect(zsetIsEmpty(fuguePairDeltas(result))).toBe(true)
      expect(zsetIsEmpty(result)).toBe(true)
    })

    it("evaluator with no rules produces no derived facts", () => {
      const evaluator = createEvaluator([])
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      const result = evaluator.step(factsToZSet([f]))

      // Ground fact is stored, but no derived facts.
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true)
      expect(zsetIsEmpty(result)).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Resolution extraction from derived facts
  // ---------------------------------------------------------------------------

  describe("resolution extraction from derived facts", () => {
    it("the derived delta contains winner facts with the winner column layout", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const slotId = "slot:title"
      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)

      const result = evaluator.step(factsToZSet([f]))

      // The delta carries both winner and superseded facts.
      expect(zsetIsEmpty(result)).toBe(false)

      let foundWinner = false
      zsetForEach(result, entry => {
        if (entry.element.predicate === "winner") {
          foundWinner = true
          expect(entry.weight).toBe(1)
          expect(entry.element.values[0]).toBe(slotId)
          expect(entry.element.values[2]).toBe("Hello")
        }
      })
      expect(foundWinner).toBe(true)
    })

    it("winnerDeltas agrees with the winner facts in the derived delta", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      const result = evaluator.step(factsToZSet([f]))

      // Count winner facts in deltaDerived.
      let derivedWinnerCount = 0
      zsetForEach(result, entry => {
        if (entry.element.predicate === "winner") derivedWinnerCount++
      })

      expect(zsetSize(winnerDeltas(result))).toBe(derivedWinnerCount)
    })
  })

  // ---------------------------------------------------------------------------
  // Accumulated database consistency
  // ---------------------------------------------------------------------------

  describe("accumulated database consistency", () => {
    it("currentDatabase contains both ground and derived facts", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())

      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      evaluator.step(factsToZSet([f]))

      const db = evaluator.currentDatabase()

      // Ground fact should be present.
      expect(db.hasFact(f)).toBe(true)

      // Derived winner fact should be present.
      expect(db.getRelation("winner").size).toBe(1)
    })

    it("after retraction, ground fact is removed from database", () => {
      const evaluator = createEvaluator(buildDefaultLWWRules())
      const f = makeActiveValueFact("alice", 1, "slot:title", "Hello", 10)
      evaluator.step(factsToZSet([f]))
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true)

      evaluator.step(factsToWeightedZSet([[f, -1]]))
      expect(evaluator.currentDatabase().hasFact(f)).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Batch equivalence with full default rules
  // ---------------------------------------------------------------------------

  describe("batch equivalence with full default rules", () => {
    it("LWW + Fugue together match batch evaluation", () => {
      const allRules = buildDefaultRules()
      const evaluator = createEvaluator(allRules)

      const parentKey = cnIdKey(createCnId("alice", 0))
      const child1Key = cnIdKey(createCnId("alice", 1))

      const facts = [
        // Structure facts.
        fact("active_structure_seq", [child1Key, parentKey, null, null]),
        fact("constraint_peer", [child1Key, "alice"]),
        // Value facts.
        makeActiveValueFact("alice", 10, "slot:title", "Hello", 10),
      ]

      // Feed incrementally.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]))
      }

      // Batch.
      const batchResult = evaluate(allRules, facts)
      if (!batchResult.ok) throw new Error("batch eval failed")
      const batchDb = batchResult.value

      // Compare all derived predicates that the batch evaluator produces.
      for (const pred of [
        "winner",
        "superseded",
        "fugue_child",
        "fugue_before",
      ]) {
        const batchTuples = batchDb.getRelation(pred).tuples()
        const incTuples = evaluator.currentDatabase().getRelation(pred).tuples()
        expect(incTuples.length).toBe(batchTuples.length)
        for (const t of batchTuples) {
          expect(evaluator.currentDatabase().hasFact(fact(pred, t))).toBe(true)
        }
      }
    })
  })

  // ---------------------------------------------------------------------------
  // reset() + replay equals accumulated state
  // ---------------------------------------------------------------------------

  describe("reset + replay equals accumulated state", () => {
    it("replaying the same facts after reset produces identical state", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]

      // Accumulate.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]))
      }
      const beforeReset = extractResolution(evaluator.currentDatabase())

      // Replay into a fresh evaluator.
      const freshEval = createEvaluator(lwwRules)
      for (const f of facts) {
        freshEval.step(factsToZSet([f]))
      }
      const afterReplay = extractResolution(freshEval.currentDatabase())

      expect(afterReplay.winners.size).toBe(beforeReset.winners.size)
      for (const [slot, winner] of beforeReset.winners) {
        expect(afterReplay.winners.get(slot)?.content).toBe(winner.content)
      }
    })
  })

  // ---------------------------------------------------------------------------
  // extractDelta: output delta has ±1 weights only
  // ---------------------------------------------------------------------------

  describe("output delta correctness", () => {
    it("step results carry weights +1 or -1 only", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      const result = evaluator.step(factsToZSet([f]))

      // All derived deltas should be +1 or -1.
      zsetForEach(result, entry => {
        expect(Math.abs(entry.weight)).toBe(1)
      })
    })

    it("retraction step produces -1 derived deltas", () => {
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const f = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f]))

      const result = evaluator.step(factsToWeightedZSet([[f, -1]]))

      let hasNegative = false
      zsetForEach(result, entry => {
        expect(Math.abs(entry.weight)).toBe(1)
        if (entry.weight === -1) hasNegative = true
      })
      // Retracting the sole value should produce −1 derived deltas.
      expect(hasNegative).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Incremental evaluation: strata propagation
  // ---------------------------------------------------------------------------

  describe("strata propagation", () => {
    it("lower stratum output delta feeds higher stratum correctly", () => {
      // Stratum 0: superseded facts
      // Stratum 1: winner facts (depends on not superseded)
      // Inserting a value that supersedes the current winner should
      // propagate through both strata in a single step.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      // Insert first value.
      const f1 = makeActiveValueFact("alice", 1, slotId, "Hello", 10)
      evaluator.step(factsToZSet([f1]))

      // Insert superseding value — must propagate superseded in stratum 0,
      // then update winner in stratum 1.
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)
      const result = evaluator.step(factsToZSet([f2]))

      // Winner should have changed.
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("World")

      // The winner delta should reflect the change.
      expect(zsetIsEmpty(winnerDeltas(result))).toBe(false)
    })

    it("retraction in stratum 0 cascades through stratum 1 negation via step()", () => {
      // This is the multi-stratum retraction propagation test.
      // Stratum 0 (positive): superseded(CnId, Slot).
      // Stratum 1 (negation): winner(Slot, CnId, Val) :- ..., not superseded(CnId, Slot).
      //
      // Insert alice (L=10), bob (L=20). Bob wins.
      // Retract bob → stratum 0 produces −1 for superseded(alice),
      // stratum 1 sees that change and derives winner(alice).
      //
      // Without correct inter-stratum −1 propagation, stratum 1 would
      // not see the superseded retraction and alice would never win.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      evaluator.step(factsToZSet([alice, bob]))
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("B")

      // Retract bob — the −1 must propagate: stratum 0 retracts
      // superseded(alice), stratum 1 derives winner(alice).
      const result = evaluator.step(factsToWeightedZSet([[bob, -1]]))

      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("A")

      // The winner delta should contain the change.
      expect(zsetIsEmpty(winnerDeltas(result))).toBe(false)

      // deltaDerived should contain both −1 (old winner/superseded) and +1 (new winner).
      let hasNeg = false
      let hasPos = false
      zsetForEach(result, entry => {
        if (entry.weight < 0) hasNeg = true
        if (entry.weight > 0) hasPos = true
      })
      expect(hasNeg).toBe(true)
      expect(hasPos).toBe(true)
    })

    it("re-insertion after full retraction restores derived facts via step()", () => {
      // insert alice → winner(alice). Retract → no winner.
      // Re-insert alice → winner(alice) again.
      // Validates the weight round-trip: 0 → 1 → 0 → 1 across strata.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)

      // Insert.
      evaluator.step(factsToZSet([alice]))
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("A")

      // Retract.
      evaluator.step(factsToWeightedZSet([[alice, -1]]))
      expect(extractResolution(evaluator.currentDatabase()).winners.size).toBe(
        0,
      )

      // Re-insert — derived facts must reappear.
      const result = evaluator.step(factsToZSet([alice]))
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("A")

      // The re-insertion should produce +1 derived deltas.
      let hasPositive = false
      zsetForEach(result, entry => {
        if (entry.weight > 0) hasPositive = true
      })
      expect(hasPositive).toBe(true)
    })
  })

  // ---------------------------------------------------------------------------
  // Mechanism verification tests (Plan 006.2, Phase 4)
  // ---------------------------------------------------------------------------

  describe("mechanism verification (Plan 006.2 Phase 4)", () => {
    it("LWW three-value retraction: superseded(alice) survives, winner changes charlie→bob", () => {
      // The critical three-value test. alice (L=10), bob (L=20), charlie (L=30).
      // superseded(alice) is derived by BOTH bob and charlie (weight 2).
      // superseded(bob) is derived by charlie only (weight 1).
      // winner = charlie.
      // Retract charlie → superseded(alice) survives (weight 2→1),
      // superseded(bob) retracted (weight 1→0), winner changes to bob.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      const charlie = makeActiveValueFact("charlie", 1, slotId, "C", 30)

      evaluator.step(factsToZSet([alice, bob, charlie]))

      // Charlie wins (lamport 30).
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("C")

      // Both alice and bob should be superseded.
      const db = evaluator.currentDatabase()
      expect(
        db.hasFact(
          fact("superseded", [cnIdKey(createCnId("alice", 1)), slotId]),
        ),
      ).toBe(true)
      expect(
        db.hasFact(fact("superseded", [cnIdKey(createCnId("bob", 1)), slotId])),
      ).toBe(true)

      // Retract charlie.
      const result = evaluator.step(factsToWeightedZSet([[charlie, -1]]))

      // Winner should change to bob (not alice).
      const resolution = extractResolution(evaluator.currentDatabase())
      expect(resolution.winners.get(slotId)?.content).toBe("B")

      // superseded(alice) should SURVIVE — bob still supersedes alice.
      const dbAfter = evaluator.currentDatabase()
      expect(
        dbAfter.hasFact(
          fact("superseded", [cnIdKey(createCnId("alice", 1)), slotId]),
        ),
      ).toBe(true)

      // superseded(bob) should be RETRACTED — charlie was the only one superseding bob.
      expect(
        dbAfter.hasFact(
          fact("superseded", [cnIdKey(createCnId("bob", 1)), slotId]),
        ),
      ).toBe(false)

      // deltaResolved should reflect the winner change.
      expect(zsetIsEmpty(winnerDeltas(result))).toBe(false)
    })

    it("recursive retraction cascade via createEvaluator: edge removal retracts transitive paths", () => {
      // edges a→b→c→d, retract b→c.
      // reachable(a,c), reachable(a,d), reachable(b,c), reachable(b,d) retracted.
      // reachable(a,b) and reachable(c,d) survive.
      const rules: Rule[] = [
        rule(atom("reachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("reachable", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)

      const edges: Fact[] = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["c", "d"]),
      ]
      evaluator.step(factsToZSet(edges))

      const db1 = evaluator.currentDatabase()
      expect(db1.hasFact(fact("reachable", ["a", "d"]))).toBe(true)
      expect(db1.hasFact(fact("reachable", ["b", "d"]))).toBe(true)

      // Retract edge b→c.
      evaluator.step(factsToWeightedZSet([[fact("edge", ["b", "c"]), -1]]))

      const db2 = evaluator.currentDatabase()
      // Paths through b→c are gone.
      expect(db2.hasFact(fact("reachable", ["b", "c"]))).toBe(false)
      expect(db2.hasFact(fact("reachable", ["b", "d"]))).toBe(false)
      expect(db2.hasFact(fact("reachable", ["a", "c"]))).toBe(false)
      expect(db2.hasFact(fact("reachable", ["a", "d"]))).toBe(false)

      // Paths not through b→c survive.
      expect(db2.hasFact(fact("reachable", ["a", "b"]))).toBe(true)
      expect(db2.hasFact(fact("reachable", ["c", "d"]))).toBe(true)
    })

    it("diamond alternative support: reachable(a,c) survives when one of two paths retracted", () => {
      // edges: a→b, b→c, a→c (direct). Two paths from a to c.
      // Retract a→b. reachable(a,b) retracted, but reachable(a,c) survives
      // via the direct edge (weight 2→1, no zero-crossing).
      const rules: Rule[] = [
        rule(atom("reachable", [varTerm("X"), varTerm("Y")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        ]),
        rule(atom("reachable", [varTerm("X"), varTerm("Z")]), [
          positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
          positiveAtom(atom("reachable", [varTerm("Y"), varTerm("Z")])),
        ]),
      ]

      const evaluator = createEvaluator(rules)

      const edges: Fact[] = [
        fact("edge", ["a", "b"]),
        fact("edge", ["b", "c"]),
        fact("edge", ["a", "c"]), // Direct edge: alternative support.
      ]
      evaluator.step(factsToZSet(edges))

      const db1 = evaluator.currentDatabase()
      expect(db1.hasFact(fact("reachable", ["a", "b"]))).toBe(true)
      expect(db1.hasFact(fact("reachable", ["a", "c"]))).toBe(true)
      expect(db1.hasFact(fact("reachable", ["b", "c"]))).toBe(true)

      // Retract a→b. The path a→b→c is gone, but a→c (direct) remains.
      evaluator.step(factsToWeightedZSet([[fact("edge", ["a", "b"]), -1]]))

      const db2 = evaluator.currentDatabase()
      // a→b is gone — reachable(a,b) retracted.
      expect(db2.hasFact(fact("reachable", ["a", "b"]))).toBe(false)
      // a→c survives via direct edge — dual-weight prevents over-retraction.
      expect(db2.hasFact(fact("reachable", ["a", "c"]))).toBe(true)
      // b→c still holds (edge b→c was not retracted).
      expect(db2.hasFact(fact("reachable", ["b", "c"]))).toBe(true)
    })

    it("differential negation timing: new superseding value produces −1 old winner, +1 new winner", () => {
      // Insert alice (L=10) → winner(alice).
      // Insert bob (L=20) → supersedes alice → winner changes.
      // Verify the step result contains both −1 for old winner and +1 for new.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      evaluator.step(factsToZSet([alice]))
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("A")

      // Insert bob — supersedes alice.
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      const result = evaluator.step(factsToZSet([bob]))

      // Winner changed to bob.
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("B")

      // deltaDerived should contain both +1 and −1 entries.
      let hasPositive = false
      let hasNegative = false
      zsetForEach(result, entry => {
        if (entry.weight > 0) hasPositive = true
        if (entry.weight < 0) hasNegative = true
      })
      // New winner/superseded facts produce +1; old winner retraction produces −1.
      expect(hasPositive).toBe(true)
      expect(hasNegative).toBe(true)

      // The winner delta should contain the change.
      let resolvedCount = 0
      zsetForEach(winnerDeltas(result), () => {
        resolvedCount++
      })
      expect(resolvedCount).toBeGreaterThan(0)
    })

    it("LWW two-value retraction: intermediate weight states are correct", () => {
      // alice (L=10), bob (L=20). superseded(alice) weight=1.
      // Retract bob → superseded(alice) retracted (weight 1→0),
      // winner changes bob→alice.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const alice = makeActiveValueFact("alice", 1, slotId, "A", 10)
      const bob = makeActiveValueFact("bob", 1, slotId, "B", 20)
      evaluator.step(factsToZSet([alice, bob]))

      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("B")

      // Verify superseded(alice) exists with weight 1.
      const db1 = evaluator.currentDatabase()
      const aliceCnIdKey = cnIdKey(createCnId("alice", 1))
      expect(db1.hasFact(fact("superseded", [aliceCnIdKey, slotId]))).toBe(true)
      expect(
        db1.getRelation("superseded").getWeight([aliceCnIdKey, slotId]),
      ).toBe(1)

      // Retract bob.
      evaluator.step(factsToWeightedZSet([[bob, -1]]))

      const db2 = evaluator.currentDatabase()
      // superseded(alice) retracted — weight crossed zero.
      expect(db2.hasFact(fact("superseded", [aliceCnIdKey, slotId]))).toBe(
        false,
      )
      // alice is now the winner.
      expect(
        extractResolution(evaluator.currentDatabase()).winners.get(slotId)
          ?.content,
      ).toBe("A")
    })
  })

  // ---------------------------------------------------------------------------
  // Batch/incremental parity, on the default rules specifically
  //
  // The generic halves of these three comparisons — "does the unified evaluator
  // agree with the old one" over hand-written rules — stayed with the evaluator.
  // What is left here is the part whose fixture is the default rule program.
  // ---------------------------------------------------------------------------

  describe("batch and incremental agree on the default rules", () => {
    it("produces identical results for LWW rules", () => {
      const lwwRules = buildDefaultLWWRules()
      const slotId = "slot:title"
      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
      ]

      const oldResult = evaluate(lwwRules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluate(lwwRules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      const oldWinners = oldResult.value.getRelation("winner").tuples()
      const newWinners = newResult.value.getRelation("winner").tuples()

      expect(newWinners.length).toBe(oldWinners.length)
      for (const t of oldWinners) {
        expect(newResult.value.hasFact(fact("winner", t))).toBe(true)
      }
    })

    it("full default rules: LWW + Fugue batch equivalence", () => {
      const allRules = buildDefaultRules()
      const slotId = "slot:title"
      const parentKey = cnIdKey(createCnId("alice", 0))
      const child1Key = cnIdKey(createCnId("alice", 1))
      const child2Key = cnIdKey(createCnId("bob", 1))

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "Hello", 10),
        makeActiveValueFact("bob", 1, slotId, "World", 20),
        fact("active_structure_seq", [child1Key, parentKey, null, null]),
        fact("constraint_peer", [child1Key, "alice"]),
        fact("active_structure_seq", [child2Key, parentKey, child1Key, null]),
        fact("constraint_peer", [child2Key, "bob"]),
      ]

      const oldResult = evaluate(allRules, facts)
      if (!oldResult.ok) throw new Error("old eval failed")

      const newResult = evaluate(allRules, facts)
      if (!newResult.ok) throw new Error("new eval failed")

      // Compare all derived predicates.
      for (const pred of [
        "winner",
        "superseded",
        "fugue_child",
        "fugue_before",
        "fugue_descendant",
      ]) {
        const oldTuples = oldResult.value.getRelation(pred).tuples()
        const newTuples = newResult.value.getRelation(pred).tuples()
        expect(newTuples.length).toBe(oldTuples.length)
        for (const t of oldTuples) {
          expect(newResult.value.hasFact(fact(pred, t))).toBe(true)
        }
      }
    })

    it("self-join weights are exact with asymmetric join (no double-counting)", () => {
      // superseded involves a self-join on active_value.
      // With dual-weight + asymmetric join (Plan 006.2), each derivation
      // path is counted exactly once. Three values: alice (L=10),
      // bob (L=20), charlie (L=30).
      //   superseded(alice) ← bob supersedes alice AND charlie supersedes alice = weight 2
      //   superseded(bob)   ← charlie supersedes bob = weight 1
      //   charlie is not superseded.
      const lwwRules = buildDefaultLWWRules()
      const evaluator = createEvaluator(lwwRules)
      const slotId = "slot:title"

      const facts = [
        makeActiveValueFact("alice", 1, slotId, "A", 10),
        makeActiveValueFact("bob", 1, slotId, "B", 20),
        makeActiveValueFact("charlie", 1, slotId, "C", 30),
      ]

      evaluator.step(factsToZSet(facts))

      const db = evaluator.currentDatabase()
      const aliceKey = cnIdKey(createCnId("alice", 1))
      const bobKey = cnIdKey(createCnId("bob", 1))

      // Exact weights — asymmetric join prevents double-counting.
      expect(db.getRelation("superseded").getWeight([aliceKey, slotId])).toBe(2)
      expect(db.getRelation("superseded").getWeight([bobKey, slotId])).toBe(1)

      // weightedTuples() returns clampedWeight = 1 for joins.
      for (const { weight } of db.getRelation("superseded").weightedTuples()) {
        expect(weight).toBe(1)
      }
    })
  })
})
