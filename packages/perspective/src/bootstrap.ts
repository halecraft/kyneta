// === Reality Bootstrap ===
// Creates a new reality with the default constraints defined in §B.8:
//
//   1. Admin grant to the creating agent.
//   2. Default LWW rules as Layer 1 rule constraints (§B.4).
//   3. Default Fugue rules (complete, 8 rules) as Layer 1 rule constraints.
//   4. Compaction policy and retraction depth configuration.
//
// The default solver rules are ordinary `rule` constraints in the store.
// They can be retracted and replaced by any agent with the appropriate
// CreateRule and Retract capabilities. Changing the solver rules changes
// the reality — not the engine, not the agents' code. Just the data.
//
// See unified-engine.md §B.4, §B.8, §14 (Layer 1).

import type { Rule } from "./datalog/types.js"
import {
  _,
  atom,
  constTerm,
  eq,
  gt,
  lt,
  negation,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "./datalog/types.js"
import { type Agent, createAgent } from "./kernel/agent.js"
import { createCnId } from "./kernel/cnid.js"
import type { PipelineConfig } from "./kernel/pipeline.js"
import type { RetractionConfig } from "./kernel/retraction.js"
import { STUB_SIGNATURE } from "./kernel/signature.js"
import { type ConstraintStore, createStore, insert } from "./kernel/store.js"
import type {
  AuthorityConstraint,
  CnId,
  Constraint,
  ConstraintBase,
  PeerID,
  RuleConstraint,
} from "./kernel/types.js"

// ---------------------------------------------------------------------------
// Default LWW Rules (§B.4)
//
// Three rules that implement Last-Writer-Wins value resolution:
//
//   superseded(CnId, Slot) :-
//     active_value(CnId, Slot, _, L1, _),
//     active_value(CnId2, Slot, _, L2, _),
//     CnId ≠ CnId2, L2 > L1.
//
//   superseded(CnId, Slot) :-
//     active_value(CnId, Slot, _, L1, P1),
//     active_value(CnId2, Slot, _, L2, P2),
//     CnId ≠ CnId2, L2 == L1, P2 > P1.
//
//   winner(Slot, CnId, Value) :-
//     active_value(CnId, Slot, Value, _, _),
//     not superseded(CnId, Slot).
// ---------------------------------------------------------------------------

/**
 * Build the default LWW Datalog rules.
 *
 * These rules resolve value conflicts by (lamport DESC, peer DESC).
 * The `superseded` relation marks losers; the `winner` relation picks
 * the sole survivor per slot via stratified negation.
 */
export function buildDefaultLWWRules(): Rule[] {
  // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, _),
  //   active_value(CnId2, Slot, _, L2, _), CnId ≠ CnId2, L2 > L1.
  const supersededByLamport: Rule = rule(
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
      gt(varTerm("L2"), varTerm("L1")),
    ],
  )

  // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, P1),
  //   active_value(CnId2, Slot, _, L2, P2), CnId ≠ CnId2, L2 == L1, P2 > P1.
  const supersededByPeer: Rule = rule(
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
      gt(varTerm("P2"), varTerm("P1")),
    ],
  )

  // winner(Slot, CnId, Value) :- active_value(CnId, Slot, Value, _, _),
  //   not superseded(CnId, Slot).
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

  return [supersededByLamport, supersededByPeer, winnerRule]
}

// ---------------------------------------------------------------------------
// Default Fugue Rules (§B.4, complete — Phase 4.6.2)
//
// Eight rules across 3 predicates that express the full Fugue tree walk:
//
//   fugue_child        — derives tree structure from active_structure_seq
//   fugue_descendant   — transitive closure of the originLeft tree
//   fugue_before       — full DFS ordering (parent-child, sibling, subtree, transitive)
//
// See tests/solver/fugue-equivalence.test.ts for detailed documentation
// of each rule's purpose and the subtree-propagation negation guard.
// ---------------------------------------------------------------------------

/**
 * Build the complete Fugue Datalog rules.
 *
 * These rules express the full Fugue tree walk as a Datalog program:
 *   1. Tree structure from originLeft chains
 *   2. Transitive descendant closure (for subtree guard)
 *   3. Parent-before-child ordering
 *   4. Sibling ordering by peer ID (lower first)
 *   5. Sibling ordering by CnId key on peer tie
 *   6. Subtree propagation (with descendant negation guard)
 *   7. Transitive closure of before-relation
 */
export function buildDefaultFugueRules(): Rule[] {
  // Rule 1: fugue_child(Parent, CnId, OriginLeft, OriginRight, Peer) :-
  //   active_structure_seq(CnId, Parent, OriginLeft, OriginRight),
  //   constraint_peer(CnId, Peer).
  const fugueChild: Rule = rule(
    atom("fugue_child", [
      varTerm("Parent"),
      varTerm("CnId"),
      varTerm("OriginLeft"),
      varTerm("OriginRight"),
      varTerm("Peer"),
    ]),
    [
      positiveAtom(
        atom("active_structure_seq", [
          varTerm("CnId"),
          varTerm("Parent"),
          varTerm("OriginLeft"),
          varTerm("OriginRight"),
        ]),
      ),
      positiveAtom(atom("constraint_peer", [varTerm("CnId"), varTerm("Peer")])),
    ],
  )

  // Rule 2a: fugue_descendant(Parent, Child, TreeParent) :-
  //   fugue_child(Parent, Child, TreeParent, _, _), TreeParent ≠ null.
  const fugueDescendantBase: Rule = rule(
    atom("fugue_descendant", [
      varTerm("Parent"),
      varTerm("Child"),
      varTerm("TreeParent"),
    ]),
    [
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("Child"),
          varTerm("TreeParent"),
          _,
          _,
        ]),
      ),
      neq(varTerm("TreeParent"), constTerm(null)),
    ],
  )

  // Rule 2b: fugue_descendant(Parent, Desc, Anc) :-
  //   fugue_descendant(Parent, Desc, Mid),
  //   fugue_descendant(Parent, Mid, Anc).
  const fugueDescendantTransitive: Rule = rule(
    atom("fugue_descendant", [
      varTerm("Parent"),
      varTerm("Desc"),
      varTerm("Anc"),
    ]),
    [
      positiveAtom(
        atom("fugue_descendant", [
          varTerm("Parent"),
          varTerm("Desc"),
          varTerm("Mid"),
        ]),
      ),
      positiveAtom(
        atom("fugue_descendant", [
          varTerm("Parent"),
          varTerm("Mid"),
          varTerm("Anc"),
        ]),
      ),
    ],
  )

  // Rule 3: fugue_before(Parent, A, B) :-
  //   fugue_child(Parent, B, A, _, _), A ≠ null.
  // Parent-before-child: in DFS, a node is visited before all its children.
  const fugueBeforeParentChild: Rule = rule(
    atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("B")]),
    [
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("B"),
          varTerm("A"),
          _,
          _,
        ]),
      ),
      neq(varTerm("A"), constTerm(null)),
    ],
  )

  // Rule 4a: fugue_before(Parent, A, B) :-
  //   fugue_child(Parent, A, OriginLeft, _, PeerA),
  //   fugue_child(Parent, B, OriginLeft, _, PeerB),
  //   A ≠ B, PeerA < PeerB.
  // Siblings with same originLeft: lower peer goes first.
  const fugueBeforeSiblingByPeer: Rule = rule(
    atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("B")]),
    [
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("A"),
          varTerm("OriginLeft"),
          _,
          varTerm("PeerA"),
        ]),
      ),
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("B"),
          varTerm("OriginLeft"),
          _,
          varTerm("PeerB"),
        ]),
      ),
      neq(varTerm("A"), varTerm("B")),
      lt(varTerm("PeerA"), varTerm("PeerB")),
    ],
  )

  // Rule 4b: fugue_before(Parent, A, B) :-
  //   fugue_child(Parent, A, OriginLeft, _, Peer),
  //   fugue_child(Parent, B, OriginLeft, _, Peer),
  //   A ≠ B, A < B.
  // Same peer, same originLeft: lower CnId key goes first.
  const fugueBeforeSiblingByCnId: Rule = rule(
    atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("B")]),
    [
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("A"),
          varTerm("OriginLeft"),
          _,
          varTerm("Peer"),
        ]),
      ),
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("B"),
          varTerm("OriginLeft"),
          _,
          varTerm("Peer"),
        ]),
      ),
      neq(varTerm("A"), varTerm("B")),
      lt(varTerm("A"), varTerm("B")),
    ],
  )

  // Rule 5: fugue_before(Parent, A, B) :-
  //   fugue_child(Parent, A, X, _, _), X ≠ null,
  //   fugue_before(Parent, X, B), A ≠ B,
  //   not fugue_descendant(Parent, B, X).
  // Subtree propagation with descendant negation guard.
  const fugueBeforeSubtreeProp: Rule = rule(
    atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("B")]),
    [
      positiveAtom(
        atom("fugue_child", [
          varTerm("Parent"),
          varTerm("A"),
          varTerm("X"),
          _,
          _,
        ]),
      ),
      neq(varTerm("X"), constTerm(null)),
      positiveAtom(
        atom("fugue_before", [varTerm("Parent"), varTerm("X"), varTerm("B")]),
      ),
      neq(varTerm("A"), varTerm("B")),
      negation(
        atom("fugue_descendant", [
          varTerm("Parent"),
          varTerm("B"),
          varTerm("X"),
        ]),
      ),
    ],
  )

  // Rule 6: fugue_before(Parent, A, C) :-
  //   fugue_before(Parent, A, B),
  //   fugue_before(Parent, B, C),
  //   A ≠ C.
  // Transitive closure.
  const fugueBeforeTransitive: Rule = rule(
    atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("C")]),
    [
      positiveAtom(
        atom("fugue_before", [varTerm("Parent"), varTerm("A"), varTerm("B")]),
      ),
      positiveAtom(
        atom("fugue_before", [varTerm("Parent"), varTerm("B"), varTerm("C")]),
      ),
      neq(varTerm("A"), varTerm("C")),
    ],
  )

  return [
    fugueChild,
    fugueDescendantBase,
    fugueDescendantTransitive,
    fugueBeforeParentChild,
    fugueBeforeSiblingByPeer,
    fugueBeforeSiblingByCnId,
    fugueBeforeSubtreeProp,
    fugueBeforeTransitive,
  ]
}

/**
 * Build all default solver rules (LWW + Fugue).
 */
export function buildDefaultRules(): Rule[] {
  return [...buildDefaultLWWRules(), ...buildDefaultFugueRules()]
}

// ---------------------------------------------------------------------------
// Bootstrap Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for reality creation.
 */
export interface BootstrapConfig {
  /**
   * PeerID of the creating agent. This peer receives implicit Admin
   * and all bootstrap constraints are attributed to this peer.
   */
  readonly creator: PeerID

  /**
   * Maximum retraction chain depth. Default: 2 (undo + redo).
   * See §6.4.
   */
  readonly retractionDepth?: number
}

// ---------------------------------------------------------------------------
// Bootstrap Result
// ---------------------------------------------------------------------------

/**
 * The result of bootstrapping a new reality.
 */
export interface BootstrapResult {
  /**
   * The constraint store pre-populated with bootstrap constraints.
   */
  readonly store: ConstraintStore

  /**
   * The creator's Agent, already initialized with correct counter
   * and lamport values reflecting the bootstrap constraints.
   */
  readonly agent: Agent

  /**
   * The pipeline configuration derived from bootstrap settings.
   */
  readonly config: PipelineConfig

  /**
   * The bootstrap constraints that were inserted into the store.
   * Useful for inspection and testing.
   */
  readonly constraints: readonly Constraint[]
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * The default retraction depth (undo + redo). See §6.4, §B.8.
 */
export const DEFAULT_RETRACTION_DEPTH = 2

/**
 * Create a new reality.
 *
 * This implements §B.8 — the reality bootstrap process:
 *
 * 1. An Admin grant to the creator (as specified in §2.5).
 * 2. Default LWW rules (3 rule constraints at Layer 1).
 * 3. Default Fugue rules (8 rule constraints at Layer 1).
 * 4. Retraction depth configuration.
 *
 * The creator's Agent is returned ready to produce further constraints.
 * The store is pre-populated with the bootstrap constraints (11 total).
 *
 * @param config - Bootstrap configuration.
 * @returns BootstrapResult with store, agent, and pipeline config.
 */
export function createReality(config: BootstrapConfig): BootstrapResult {
  const { creator } = config
  const retractionDepth = config.retractionDepth ?? DEFAULT_RETRACTION_DEPTH

  // We construct bootstrap constraints directly (not through the Agent's
  // produceRule) because Layer 0-1 rules are kernel-reserved. The Agent's
  // produceRule() enforces layer >= 2 for user-facing rules — this is
  // correct for normal operation. Bootstrap is the kernel itself setting
  // up the initial state, so it bypasses that check.

  const constraints: Constraint[] = []
  let counter = 0
  let lamport = 0

  /**
   * Allocate the next CnId and lamport for a bootstrap constraint.
   */
  function nextId(): { id: CnId; lamport: number; counter: number } {
    const id = createCnId(creator, counter)
    const l = lamport
    counter += 1
    lamport += 1
    return { id, lamport: l, counter: l }
  }

  /**
   * Create a ConstraintBase for bootstrap constraints.
   * Bootstrap constraints have no refs (they are the first constraints)
   * and use the stub signature.
   */
  function baseFields(): Pick<
    ConstraintBase,
    "id" | "lamport" | "refs" | "sig"
  > {
    const { id, lamport: l } = nextId()
    return {
      id,
      lamport: l,
      refs: [],
      sig: STUB_SIGNATURE,
    }
  }

  // --- 1. Admin grant to creator (§2.5, §B.8) ---
  //
  // The first constraint grants Admin capability to the creator.
  // This is the root of the authority chain — all other capabilities
  // derive from this grant.
  const adminGrant: AuthorityConstraint = {
    ...baseFields(),
    type: "authority",
    payload: {
      targetPeer: creator,
      action: "grant",
      capability: { kind: "admin" },
    },
  }
  constraints.push(adminGrant)

  // --- 2. Default LWW rules (§B.4) ---
  const lwwRules = buildDefaultLWWRules()
  for (const r of lwwRules) {
    const ruleConstraint: RuleConstraint = {
      ...baseFields(),
      type: "rule",
      payload: {
        layer: 1,
        head: r.head,
        body: r.body,
      },
    }
    constraints.push(ruleConstraint)
  }

  // --- 3. Default Fugue rules (§B.4, complete) ---
  const fugueRules = buildDefaultFugueRules()
  for (const r of fugueRules) {
    const ruleConstraint: RuleConstraint = {
      ...baseFields(),
      type: "rule",
      payload: {
        layer: 1,
        head: r.head,
        body: r.body,
      },
    }
    constraints.push(ruleConstraint)
  }

  // --- 4. Populate the store ---
  const store = createStore()
  for (const c of constraints) {
    const result = insert(store, c)
    if (!result.ok) {
      // Bootstrap constraints are internally constructed and should
      // never fail validation. If they do, it's a bug in bootstrap.
      throw new Error(
        `Bootstrap constraint insertion failed: ${JSON.stringify(result.error)}. ` +
          `This is a bug in bootstrap.ts.`,
      )
    }
  }

  // --- 5. Create the creator's Agent ---
  //
  // The agent starts at the counter and lamport values after all
  // bootstrap constraints, so it doesn't collide with them.
  // It also observes all bootstrap constraints so its version vector
  // and lamport clock are up to date.
  const agent = createAgent(creator, undefined, counter, lamport)
  agent.observeMany(constraints)

  // --- 6. Build pipeline configuration ---
  const retractionConfig: RetractionConfig = {
    maxDepth: retractionDepth,
  }

  const pipelineConfig: PipelineConfig = {
    creator,
    retractionConfig,
    enableDatalogEvaluation: true,
  }

  return {
    store,
    agent,
    config: pipelineConfig,
    constraints,
  }
}

// ---------------------------------------------------------------------------
// Convenience: count of bootstrap constraints
// ---------------------------------------------------------------------------

/**
 * The number of constraints emitted during bootstrap.
 *
 * 1 admin grant + 3 LWW rules + 8 Fugue rules = 12.
 */
export const BOOTSTRAP_CONSTRAINT_COUNT = 12
