// === Incremental Evaluation Stage Tests ===
// Tests for the evaluation stage wrapper (Plan 006, Phase 4 + Phase 6).
//
// Covers:
// - Pure fact router: correctly splits mixed ZSet<Fact> by predicate
// - Rule delta extraction from active-set delta
// - Native path produces correct resolution deltas
// - Strategy switching: native → datalog on custom rule, datalog → native on retraction
// - Incremental Datalog path produces correct results (Phase 6)
// - Strategy switch with simultaneous deltaFacts: facts are not dropped (Phase 6)
// - Custom LWW rule: reversed lamport comparison (Phase 6)
// - Rule addition/retraction mid-stream (Phase 6)

import type { Fact, Rule } from "@kyneta/datalog"
import {
  atom,
  eq,
  fact,
  gt,
  rule as makeRule,
  negation,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "@kyneta/datalog"
import type { ZSet } from "@kyneta/zset"
import {
  zsetAdd,
  zsetEmpty,
  zsetIsEmpty,
  zsetSingleton,
  zsetSize,
} from "@kyneta/zset"
import { describe, expect, it } from "vitest"
import {
  buildDefaultFugueRules,
  buildDefaultLWWRules,
} from "../../../src/bootstrap.js"
import { cnIdKey, createCnId } from "../../../src/kernel/cnid.js"
import {
  createIncrementalEvaluation,
  extractRuleDeltasFromActive,
  type IncrementalEvaluation,
} from "../../../src/kernel/incremental/evaluation.js"
import {
  ACTIVE_STRUCTURE_SEQ,
  ACTIVE_VALUE,
  CONSTRAINT_PEER,
} from "../../../src/kernel/projection.js"
import { STUB_SIGNATURE } from "../../../src/kernel/signature.js"
import { buildStructureIndex } from "../../../src/kernel/structure-index.js"
import type {
  CnId,
  Constraint,
  PeerID,
  RuleConstraint,
  StructureConstraint,
  Value,
  ValueConstraint,
} from "../../../src/kernel/types.js"

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

function makeRuleConstraint(
  peer: PeerID,
  counter: number,
  layer: number,
  rule: Rule,
): RuleConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "rule",
    payload: { layer, head: rule.head, body: rule.body },
  }
}

function makeActiveValueFact(
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

function makeSeqStructureFact(
  peer: PeerID,
  counter: number,
  parentKey: string,
  originLeft: string | null,
  originRight: string | null,
): Fact {
  const id = createCnId(peer, counter)
  return fact(ACTIVE_STRUCTURE_SEQ.predicate, [
    cnIdKey(id),
    parentKey,
    originLeft,
    originRight,
  ])
}

function makePeerFact(peer: PeerID, counter: number): Fact {
  const id = createCnId(peer, counter)
  return fact(CONSTRAINT_PEER.predicate, [cnIdKey(id), peer])
}

// Fixtures
const root = makeStructureRoot("alice", 0, "doc")
const child1 = makeStructureMap("alice", 1, root.id, "title")
const structures = [root, child1]

function buildSlotId(): string {
  const all: Constraint[] = [...structures]
  const index = buildStructureIndex(all)
  return index.structureToSlot.get(cnIdKey(child1.id))!
}

const slotId = buildSlotId()

// ---------------------------------------------------------------------------
// routeFactsByPredicate tests
// ---------------------------------------------------------------------------

describe("extractRuleDeltasFromActive", () => {
  it("extracts rule constraints from active delta", () => {
    const lwwRules = buildDefaultLWWRules()
    const rc = makeRuleConstraint("alice", 10, 1, lwwRules[0]!)
    const activeDelta: ZSet<Constraint> = zsetSingleton(cnIdKey(rc.id), rc, 1)

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta)
    expect(zsetSize(ruleDeltas)).toBe(1)

    const entry = [...ruleDeltas.values()][0]!
    expect(entry.weight).toBe(1)
    expect(entry.element.head.predicate).toBe(lwwRules[0]?.head.predicate)
  })

  it("ignores non-rule constraints", () => {
    const val = makeValue("alice", 3, child1.id, "Hello", 10)
    const activeDelta: ZSet<Constraint> = zsetSingleton(cnIdKey(val.id), val, 1)

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta)
    expect(zsetIsEmpty(ruleDeltas)).toBe(true)
  })

  it("preserves weight for retracted rules", () => {
    const lwwRules = buildDefaultLWWRules()
    const rc = makeRuleConstraint("alice", 10, 1, lwwRules[0]!)
    const activeDelta: ZSet<Constraint> = zsetSingleton(cnIdKey(rc.id), rc, -1)

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta)
    expect(zsetSize(ruleDeltas)).toBe(1)
    const entry = [...ruleDeltas.values()][0]!
    expect(entry.weight).toBe(-1)
  })

  it("extracts multiple rules from mixed delta", () => {
    const lwwRules = buildDefaultLWWRules()
    const rc1 = makeRuleConstraint("alice", 10, 1, lwwRules[0]!)
    const rc2 = makeRuleConstraint("alice", 11, 1, lwwRules[1]!)
    const val = makeValue("alice", 3, child1.id, "Hello", 10)

    let activeDelta: ZSet<Constraint> = zsetEmpty()
    activeDelta = zsetAdd(activeDelta, zsetSingleton(cnIdKey(rc1.id), rc1, 1))
    activeDelta = zsetAdd(activeDelta, zsetSingleton(cnIdKey(rc2.id), rc2, 1))
    activeDelta = zsetAdd(activeDelta, zsetSingleton(cnIdKey(val.id), val, 1))

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta)
    expect(zsetSize(ruleDeltas)).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// IncrementalEvaluation — native path tests
// ---------------------------------------------------------------------------

/**
 * A rule set as a Z-set delta, with keys derived from `keyPrefix`.
 *
 * Stable keys matter: retracting a rule means sending the same key at weight
 * −1, so a test that installs the defaults and later replaces them has to use
 * the same prefix both times.
 */
function ruleDelta(
  rules: readonly Rule[],
  keyPrefix: string,
  weight: 1 | -1,
): ZSet<Rule> {
  let delta = zsetEmpty<Rule>()
  rules.forEach((r, i) => {
    delta = zsetAdd(delta, zsetSingleton(`${keyPrefix}-${i}`, r, weight))
  })
  return delta
}

/** The default LWW rules, add or retract. */
const defaultLWWDelta = (weight: 1 | -1): ZSet<Rule> =>
  ruleDelta(buildDefaultLWWRules(), "default-lww", weight)

/** The default Fugue rules, add or retract. */
const defaultFugueDelta = (weight: 1 | -1): ZSet<Rule> =>
  ruleDelta(buildDefaultFugueRules(), "default-fugue", weight)

/**
 * An evaluation stage with the default LWW + Fugue rules already installed.
 *
 * The stage is a Datalog evaluator and nothing else, so it derives nothing
 * until the store's rules reach it. A test that asserts last-writer-wins has to
 * hand it the rules that say so first — the same obligation a real store has,
 * where `bootstrap.ts` asserts them when the reality is created.
 *
 * Before the §B.7 native solvers were retired this was not necessary: the stage
 * started on hand-written LWW and Fugue, so it resolved values whether or not
 * anyone had told it how.
 */
function evaluationWithDefaultRules(): IncrementalEvaluation {
  const evaluation = createIncrementalEvaluation()
  evaluation.step(
    zsetEmpty(),
    zsetAdd(defaultLWWDelta(1), defaultFugueDelta(1)),
  )
  return evaluation
}

describe("IncrementalEvaluation", () => {
  describe("resolution through the default rules", () => {
    it("produces winner delta for a single active_value fact", () => {
      const evaluation = evaluationWithDefaultRules()
      const f = makeActiveValueFact("alice", 3, slotId, "Hello", 10)
      const deltaFacts = zsetSingleton(
        `v|${cnIdKey(createCnId("alice", 3))}`,
        f,
        1,
      )

      const { deltaResolved, deltaFuguePairs } = evaluation.step(
        deltaFacts,
        zsetEmpty(),
      )

      expect(zsetSize(deltaResolved)).toBe(1)
      const winnerEntry = [...deltaResolved.values()][0]!
      expect(winnerEntry.weight).toBe(1)
      expect(winnerEntry.element.slotId).toBe(slotId)
      expect(winnerEntry.element.content).toBe("Hello")

      expect(zsetIsEmpty(deltaFuguePairs)).toBe(true)
    })

    it("superseding value produces +1 replacement delta", () => {
      const evaluation = evaluationWithDefaultRules()

      const f1 = makeActiveValueFact("alice", 3, slotId, "Hello", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "World", 20)

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
        zsetEmpty(),
      )

      const { deltaResolved } = evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        zsetEmpty(),
      )

      expect(zsetSize(deltaResolved)).toBe(1)
      const entry = [...deltaResolved.values()][0]!
      expect(entry.weight).toBe(1)
      expect(entry.element.content).toBe("World")
    })

    it("empty delta produces empty result", () => {
      const evaluation = evaluationWithDefaultRules()
      const { deltaResolved, deltaFuguePairs } = evaluation.step(
        zsetEmpty(),
        zsetEmpty(),
      )
      expect(zsetIsEmpty(deltaResolved)).toBe(true)
      expect(zsetIsEmpty(deltaFuguePairs)).toBe(true)
    })

    it("current() returns materialized ResolutionResult", () => {
      const evaluation = evaluationWithDefaultRules()

      const f = makeActiveValueFact("alice", 3, slotId, "Hello", 10)
      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f, 1),
        zsetEmpty(),
      )

      const result = evaluation.current()
      expect(result.winners.size).toBe(1)
      expect(result.winners.get(slotId)?.content).toBe("Hello")
    })

    it("processes Fugue facts into before-pairs", () => {
      const evaluation = evaluationWithDefaultRules()
      const parentKey = cnIdKey(createCnId("root", 0))

      const elem1 = createCnId("alice", 1)
      const elem2 = createCnId("alice", 2)

      // First element: structure + peer
      const sf1 = makeSeqStructureFact("alice", 1, parentKey, null, null)
      const pf1 = makePeerFact("alice", 1)
      let delta1 = zsetEmpty<Fact>()
      delta1 = zsetAdd(delta1, zsetSingleton(`s|${cnIdKey(elem1)}`, sf1, 1))
      delta1 = zsetAdd(delta1, zsetSingleton(`p|${cnIdKey(elem1)}`, pf1, 1))

      const r1 = evaluation.step(delta1, zsetEmpty())

      // First element alone — no pairs
      expect(zsetIsEmpty(r1.deltaFuguePairs)).toBe(true)

      // Second element
      const sf2 = makeSeqStructureFact(
        "alice",
        2,
        parentKey,
        cnIdKey(elem1),
        null,
      )
      const pf2 = makePeerFact("alice", 2)
      let delta2 = zsetEmpty<Fact>()
      delta2 = zsetAdd(delta2, zsetSingleton(`s|${cnIdKey(elem2)}`, sf2, 1))
      delta2 = zsetAdd(delta2, zsetSingleton(`p|${cnIdKey(elem2)}`, pf2, 1))

      const r2 = evaluation.step(delta2, zsetEmpty())

      // Should have one pair
      expect(zsetSize(r2.deltaFuguePairs)).toBe(1)
      const pairEntry = [...r2.deltaFuguePairs.values()][0]!
      expect(pairEntry.weight).toBe(1)
      expect(pairEntry.element.parentKey).toBe(parentKey)
    })
  })

  describe("reset", () => {
    it("clears all state", () => {
      const evaluation = evaluationWithDefaultRules()

      const f = makeActiveValueFact("alice", 3, slotId, "Hello", 10)
      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f, 1),
        zsetEmpty(),
      )

      expect(evaluation.current().winners.size).toBe(1)

      evaluation.reset()
      expect(evaluation.current().winners.size).toBe(0)
    })
  })

  describe("incremental Datalog path (Phase 6)", () => {
    // Build a complete "reversed LWW" rule set: lower lamport wins.
    // This REPLACES the default superseded rules rather than adding
    // alongside them (adding alongside would cause both values to be
    // superseded by different rules, so nobody wins).
    //
    // Rules:
    //   superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, _),
    //     active_value(CnId2, Slot, _, L2, _), CnId ≠ CnId2, L1 > L2.
    //   superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, P1),
    //     active_value(CnId2, Slot, _, L2, P2), CnId ≠ CnId2, L1 == L2, P1 > P2.
    //   winner(Slot, CnId, Value) :- active_value(CnId, Slot, Value, _, _),
    //     not superseded(CnId, Slot).
    const reversedSupersededByLamport = makeRule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("_V1"),
            varTerm("L1"),
            varTerm("_P1"),
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            varTerm("_V2"),
            varTerm("L2"),
            varTerm("_P2"),
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        gt(varTerm("L1"), varTerm("L2")), // REVERSED: higher lamport gets superseded
      ],
    )
    const reversedSupersededByPeer = makeRule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("_V1"),
            varTerm("L1"),
            varTerm("P1"),
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            varTerm("_V2"),
            varTerm("L2"),
            varTerm("P2"),
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        eq(varTerm("L1"), varTerm("L2")),
        gt(varTerm("P1"), varTerm("P2")), // REVERSED peer tiebreak too
      ],
    )
    // The winner rule is identical to the default.
    const winnerRule = makeRule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            varTerm("_L"),
            varTerm("_P"),
          ]),
        ),
        negation(atom("superseded", [varTerm("CnId"), varTerm("Slot")])),
      ],
    )
    const reversedLWWRules = [
      reversedSupersededByLamport,
      reversedSupersededByPeer,
      winnerRule,
    ]

    /**
     * Build a set of active constraints that uses reversed LWW rules
     * (all at Layer 2) alongside the default Fugue rules (at Layer 1).
     * The default LWW rules are NOT included.
     */
    function buildReversedRuleConstraints(): {
      ruleConstraints: RuleConstraint[]
      activeConstraints: Constraint[]
      /** The Layer 2 rule constraints (for building rule deltas). */
      customRuleConstraints: RuleConstraint[]
      /** The Layer 1 default constraints (LWW + Fugue). */
      defaultRuleConstraints: RuleConstraint[]
    } {
      const defaultLWW = buildDefaultLWWRules()
      const defaultFugue = buildDefaultFugueRules()
      const allDefaults = [...defaultLWW, ...defaultFugue]
      const defaultRuleConstraints: RuleConstraint[] = allDefaults.map((r, i) =>
        makeRuleConstraint("alice", 100 + i, 1, r),
      )
      const customRuleConstraints: RuleConstraint[] = reversedLWWRules.map(
        (r, i) => makeRuleConstraint("alice", 200 + i, 2, r),
      )
      // Active constraints: default Fugue (Layer 1) + reversed LWW (Layer 2).
      // Default LWW rules are dominated/retracted (not present).
      const fugueOnlyDefaults = defaultRuleConstraints.filter(rc => {
        const pred = rc.payload.head.predicate
        return pred !== "superseded" && pred !== "winner"
      })
      const ruleConstraints = [...fugueOnlyDefaults, ...customRuleConstraints]
      return {
        ruleConstraints,
        activeConstraints: ruleConstraints as Constraint[],
        customRuleConstraints,
        defaultRuleConstraints,
      }
    }

    it("incremental Datalog produces correct winners for custom rules", () => {
      const evaluation = createIncrementalEvaluation()

      const { activeConstraints, customRuleConstraints } =
        buildReversedRuleConstraints()

      // Switch to datalog by adding the custom rules.
      let ruleDelta = zsetEmpty<Rule>()
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        ruleDelta = zsetAdd(ruleDelta, zsetSingleton(cnIdKey(rc.id), r, 1))
      }
      evaluation.step(zsetEmpty(), ruleDelta)

      // Insert two competing values: lamport 10 and lamport 20.
      // With reversed rule, lamport 10 should win.
      const f1 = makeActiveValueFact("alice", 3, slotId, "LowLamport", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "HighLamport", 20)

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
        zsetEmpty(),
      )

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        zsetEmpty(),
      )

      // With reversed rules, the lower lamport (10) should win.
      const current = evaluation.current()
      expect(current.winners.size).toBe(1)
      expect(current.winners.get(slotId)?.content).toBe("LowLamport")
    })

    it("one step carrying both a fact delta and a rule delta nets the two on the datalog path", () => {
      // The stage answers this with changeRules then step, summed. The
      // winner must end where a fresh evaluation over everything ends, and
      // the summed delta must carry the replacement as a single +1.
      const evaluation = createIncrementalEvaluation()
      const { activeConstraints, customRuleConstraints } =
        buildReversedRuleConstraints()
      let ruleDelta = zsetEmpty<Rule>()
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        ruleDelta = zsetAdd(ruleDelta, zsetSingleton(cnIdKey(rc.id), r, 1))
      }
      evaluation.step(zsetEmpty(), ruleDelta)

      const f1 = makeActiveValueFact("alice", 3, slotId, "LowLamport", 10)
      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
        zsetEmpty(),
      )
      expect(evaluation.current().winners.get(slotId)?.content).toBe(
        "LowLamport",
      )

      // A further Layer 2 rule, so the strategy stays datalog, and a value
      // that wins under the reversed rules, in the same step.
      const marker: Rule = rule(atom("marked", [varTerm("S")]), [
        positiveAtom(
          atom("winner", [varTerm("S"), varTerm("C"), varTerm("V")]),
        ),
      ])
      const markerConstraint = makeRuleConstraint("alice", 300, 2, marker)
      const f2 = makeActiveValueFact("bob", 1, slotId, "LowerLamport", 5)
      const { deltaResolved } = evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        zsetSingleton(cnIdKey(markerConstraint.id), marker, 1),
      )

      expect(evaluation.current().winners.get(slotId)?.content).toBe(
        "LowerLamport",
      )
      expect(deltaResolved.get(slotId)?.weight).toBe(1)
      expect(deltaResolved.get(slotId)?.element.content).toBe("LowerLamport")

      const fresh = createIncrementalEvaluation()
      fresh.step(
        zsetEmpty(),
        zsetAdd(
          ruleDelta,
          zsetSingleton(cnIdKey(markerConstraint.id), marker, 1),
        ),
      )
      fresh.step(
        zsetAdd(
          zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
          zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        ),
        zsetEmpty(),
      )
      expect(evaluation.current().winners).toEqual(fresh.current().winners)
    })

    it("rule addition mid-stream: values re-resolved under new rules", () => {
      const evaluation = evaluationWithDefaultRules()

      // Two competing values. Under the defaults, higher lamport wins.
      const f1 = makeActiveValueFact("alice", 3, slotId, "LowLamport", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "HighLamport", 20)

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
        zsetEmpty(),
      )

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        zsetEmpty(),
      )

      expect(evaluation.current().winners.get(slotId)?.content).toBe(
        "HighLamport",
      )

      // Replace the LWW rules with a reversed set: lowest lamport wins.
      //
      // The default LWW rules have to be *retracted*, not merely added
      // alongside — with both sets active every value is superseded by one rule
      // or the other and nobody wins. This used to be implicit: the stage
      // rebuilt itself from the active constraint set on a strategy switch, so
      // the test could send only the additions and let the rebuild drop the
      // rest. With one path the delta has to say what actually changed.
      const { customRuleConstraints } = buildReversedRuleConstraints()
      let ruleDelta = defaultLWWDelta(-1)
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        ruleDelta = zsetAdd(ruleDelta, zsetSingleton(cnIdKey(rc.id), r, 1))
      }

      const { deltaResolved } = evaluation.step(zsetEmpty(), ruleDelta)

      // After rule addition, winner should flip to LowLamport.
      const current = evaluation.current()
      expect(current.winners.size).toBe(1)
      expect(current.winners.get(slotId)?.content).toBe("LowLamport")

      // Delta should reflect the change.
      expect(zsetIsEmpty(deltaResolved)).toBe(false)
    })

    it("rule retraction mid-stream: values re-resolved under restored defaults", () => {
      const evaluation = createIncrementalEvaluation()

      const { customRuleConstraints } = buildReversedRuleConstraints()

      // Start with the reversed LWW rules and the default Fugue rules.
      let addRuleDelta = defaultFugueDelta(1)
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        addRuleDelta = zsetAdd(
          addRuleDelta,
          zsetSingleton(cnIdKey(rc.id), r, 1),
        )
      }
      evaluation.step(zsetEmpty(), addRuleDelta)

      // Insert two values through the Datalog path.
      const f1 = makeActiveValueFact("alice", 3, slotId, "LowLamport", 10)
      const f2 = makeActiveValueFact("bob", 1, slotId, "HighLamport", 20)

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
        zsetEmpty(),
      )

      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        zsetEmpty(),
      )

      // Under reversed rules: LowLamport wins.
      expect(evaluation.current().winners.get(slotId)?.content).toBe(
        "LowLamport",
      )

      // Retract the reversed rules and restore the defaults.
      //
      // Both halves are needed. This test used to send only the retraction and
      // still see last-writer-wins come back, because retracting the custom
      // rules flipped the stage onto the hand-written §B.7 solvers, which
      // supplied default semantics whether or not any rule in the store asked
      // for them. With one path, restoring the defaults means asserting them.
      let retractRuleDelta = defaultLWWDelta(1)
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        retractRuleDelta = zsetAdd(
          retractRuleDelta,
          zsetSingleton(cnIdKey(rc.id), r, -1),
        )
      }

      evaluation.step(zsetEmpty(), retractRuleDelta)

      // Under default rules: HighLamport wins (higher lamport = winner).
      const current = evaluation.current()
      expect(current.winners.size).toBe(1)
      expect(current.winners.get(slotId)?.content).toBe("HighLamport")
    })

    it("strategy switch with simultaneous deltaFacts: facts are not dropped", () => {
      const evaluation = createIncrementalEvaluation()

      const { activeConstraints, customRuleConstraints } =
        buildReversedRuleConstraints()

      // Build rule delta for the switch.
      let ruleDelta = zsetEmpty<Rule>()
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        ruleDelta = zsetAdd(ruleDelta, zsetSingleton(cnIdKey(rc.id), r, 1))
      }

      // Send a value fact AND a rule delta in the SAME step.
      // The rule triggers native→datalog switch. The value fact must
      // not be dropped — it should be processed through the newly-active
      // Datalog strategy.
      const f = makeActiveValueFact("alice", 3, slotId, "Hello", 10)

      const { deltaResolved: _deltaResolved } = evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f, 1),
        ruleDelta, // accumulated facts includes the new fact
      )

      // The value should have been processed — there should be a winner.
      const current = evaluation.current()
      expect(current.winners.size).toBe(1)
      expect(current.winners.get(slotId)?.content).toBe("Hello")
    })

    it("incremental Datalog processes subsequent fact deltas without batch calls", () => {
      const evaluation = createIncrementalEvaluation()

      const { activeConstraints, customRuleConstraints } =
        buildReversedRuleConstraints()

      // Switch to Datalog.
      let ruleDelta = zsetEmpty<Rule>()
      for (const rc of customRuleConstraints) {
        const r: Rule = { head: rc.payload.head, body: rc.payload.body }
        ruleDelta = zsetAdd(ruleDelta, zsetSingleton(cnIdKey(rc.id), r, 1))
      }
      evaluation.step(zsetEmpty(), ruleDelta)

      // Insert values one at a time through incremental Datalog.
      const f1 = makeActiveValueFact("alice", 3, slotId, "First", 10)
      const r1 = evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("alice", 3))}`, f1, 1),
        zsetEmpty(),
      )

      expect(zsetSize(r1.deltaResolved)).toBe(1)
      expect(evaluation.current().winners.get(slotId)?.content).toBe("First")

      // Insert a second value (higher lamport, but reversed rule: lower wins).
      const f2 = makeActiveValueFact("bob", 1, slotId, "Second", 20)
      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("bob", 1))}`, f2, 1),
        zsetEmpty(),
      )

      // First should still be the winner under reversed rules.
      expect(evaluation.current().winners.get(slotId)?.content).toBe("First")

      // Insert a third value (even lower lamport → new winner under reversed rules).
      const f3 = makeActiveValueFact("charlie", 1, slotId, "Third", 5)
      evaluation.step(
        zsetSingleton(`v|${cnIdKey(createCnId("charlie", 1))}`, f3, 1),
        zsetEmpty(),
      )

      // Third should win (lamport 5 < 10 < 20 → Third wins under reversed).
      expect(evaluation.current().winners.get(slotId)?.content).toBe("Third")
    })
  })
})
