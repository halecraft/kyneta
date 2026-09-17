// === Host code through the CCS pipeline ===
//
// `PipelineConfig.host` reaches both the batch solve and the incremental
// pipeline. A rule constraint may name a host function in a compute element
// and read a foreign relation, and the reality shows it. The constraint
// itself is plain data: the function is a name, resolved on this peer.

import type { ForeignRelation, Host, Rule } from "@kyneta/datalog"
import {
  _,
  atom,
  compute,
  negation,
  positiveAtom,
  rule,
  varTerm,
} from "@kyneta/datalog"
import { describe, expect, it } from "vitest"
import { buildDefaultRules } from "../../src/bootstrap.js"
import { createCnId } from "../../src/kernel/cnid.js"
import { createIncrementalPipeline } from "../../src/kernel/incremental/pipeline.js"
import { type PipelineConfig, solveFull } from "../../src/kernel/pipeline.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import { createStore, insertMany } from "../../src/kernel/store.js"
import type {
  CnId,
  Constraint,
  PeerID,
  Reality,
  RealityNode,
  RuleConstraint,
  StructureConstraint,
  Value,
  ValueConstraint,
} from "../../src/kernel/types.js"

const $ = varTerm

// --- The smallest store that exercises resolution -------------------------

function root(
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

function mapChild(
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

function value(
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

function ruleConstraint(
  peer: PeerID,
  counter: number,
  layer: number,
  r: Rule,
): RuleConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "rule",
    payload: { layer, head: r.head, body: r.body },
  }
}

function node(reality: Reality, ...path: string[]): RealityNode | undefined {
  let current: RealityNode | undefined = reality.root
  for (const key of path) current = current?.children.get(key)
  return current
}

// --- A winner rule that leans on host code ----------------------------------

/** Prefers whichever value's content starts with "B". Reads `active_value`. */
const PREFERRED: ForeignRelation = {
  predicate: "preferred",
  arity: 1,
  inputs: ["active_value"],
  version: "1",
  compute(read) {
    const out: Value[][] = []
    for (const t of read.getRelation("active_value").tuples()) {
      if (typeof t[2] === "string" && t[2].startsWith("B")) out.push([t[0]!])
    }
    return out
  },
}

const HOST: Host = {
  relations: [PREFERRED],
  functions: { upper: args => String(args[0]).toUpperCase() },
}

/**
 * winner(Slot, CnId, Upper) :-
 *   active_value(CnId, Slot, V, _, _), not superseded(CnId, Slot),
 *   preferred(CnId), compute("upper", [V], Upper).
 *
 * The default `winner` rule is left out of the store; `superseded` stays.
 */
const hostedWinner: Rule = rule(
  atom("winner", [$("Slot"), $("CnId"), $("Upper")]),
  [
    positiveAtom(atom("active_value", [$("CnId"), $("Slot"), $("V"), _, _])),
    negation(atom("superseded", [$("CnId"), $("Slot")])),
    positiveAtom(atom("preferred", [$("CnId")])),
    compute("upper", [$("V")], $("Upper")),
  ],
)

function constraints(): Constraint[] {
  const r = root("alice", 0, "data")
  const field = mapChild("alice", 1, r.id, "field")
  const defaults = buildDefaultRules()
    .filter(x => x.head.predicate !== "winner")
    .map((x, i) => ruleConstraint("alice", 100 + i, 1, x))
  return [
    r,
    field,
    // Bob's value has the higher lamport and would win under plain LWW as
    // well; the host code makes it win by name and uppercases it.
    value("alice", 2, field.id, "Alice", 10),
    value("alice", 3, field.id, "Bob", 20),
    ...defaults,
    ruleConstraint("alice", 200, 2, hostedWinner),
  ]
}

const CONFIG: PipelineConfig = { creator: "alice", host: HOST }

describe("host code through the pipeline", () => {
  it("a rule constraint with a compute element is data: it stores, validates, and solves through config.host", () => {
    const store = createStore()
    const inserted = insertMany(store, constraints())
    expect(inserted.ok).toBe(true)

    const result = solveFull(store, CONFIG)
    expect(node(result.reality, "data", "field")?.value).toBe("BOB")
  })

  it("the incremental pipeline reaches the same reality with the same config", () => {
    const pipeline = createIncrementalPipeline(CONFIG)
    pipeline.insertMany(constraints())
    expect(node(pipeline.current(), "data", "field")?.value).toBe("BOB")
    expect(node(pipeline.recompute(), "data", "field")?.value).toBe("BOB")
  })

  it("without the host the batch solve refuses rather than resolving some other way", () => {
    // A rule naming host code the engine was not given cannot be evaluated.
    // This used to fall back to the hand-written solvers and return a reality
    // under the *default* rules — a reality this store does not describe,
    // produced silently, with no way for the caller to notice. Refusing is the
    // lesser harm: the store is asking for something this peer cannot provide,
    // and that is exactly what it should hear.
    const store = createStore()
    insertMany(store, constraints())

    expect(() => solveFull(store, { creator: "alice" })).toThrow(
      /cannot solve: the store's rule set cannot be evaluated/,
    )
  })
})
