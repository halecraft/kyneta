// === Projection ===
// Converts active constraints into Datalog ground facts that the evaluator
// consumes. This is the bridge between the kernel type system and the
// Datalog evaluator.
//
// The key operation is a JOIN: each ValueConstraint's `target` CnId is
// resolved through the StructureIndex to obtain slot identity, then
// emitted as an `active_value(CnId, Slot, Content, Lamport, Peer)` fact.
//
// This module also emits:
// - `active_structure_seq(CnId, Parent, OriginLeft, OriginRight)` for Fugue rules
// - `constraint_peer(CnId, Peer)` for peer tiebreak in Fugue
//
// Slot identity is Layer 0 (kernel policy semantics, §8) — it is
// pre-computed here, not derived by Datalog rules. This ensures that
// an agent with CreateRule + Retract capabilities cannot break the
// reality by retracting a slot-identity rule.
//
// See unified-engine.md §7.2, §8, §B.4.

import type { Fact } from "../datalog/types.js"
import { fact } from "../datalog/types.js"
import { cnIdKey } from "./cnid.js"
import type { StructureIndex } from "./structure-index.js"
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
} from "./types.js"

// ---------------------------------------------------------------------------
// Projected Relation Schemas
//
// Each projected relation has a fixed column layout documented here so
// rule authors don't need to count tuple positions.
//
// active_value(CnId, Slot, Content, Lamport, Peer)
//   [0] CnId    — cnIdKey string of the value constraint's id
//   [1] Slot    — slot identity string (from structure index)
//   [2] Content — the value constraint's content (any Value)
//   [3] Lamport — the value constraint's lamport timestamp (number)
//   [4] Peer    — the value constraint's peer id (string)
//
// active_structure_seq(CnId, Parent, OriginLeft, OriginRight)
//   [0] CnId        — cnIdKey string of the seq structure constraint's id
//   [1] Parent       — cnIdKey string of the parent structure's id
//   [2] OriginLeft   — cnIdKey string or null
//   [3] OriginRight  — cnIdKey string or null
//
// constraint_peer(CnId, Peer)
//   [0] CnId — cnIdKey string of the constraint's id
//   [1] Peer — the constraint's peer id (string)
// ---------------------------------------------------------------------------

/**
 * Column positions for the `active_value` relation.
 */
export const ACTIVE_VALUE = {
  predicate: "active_value",
  CNID: 0,
  SLOT: 1,
  CONTENT: 2,
  LAMPORT: 3,
  PEER: 4,
} as const

/**
 * Column positions for the `active_structure_seq` relation.
 */
export const ACTIVE_STRUCTURE_SEQ = {
  predicate: "active_structure_seq",
  CNID: 0,
  PARENT: 1,
  ORIGIN_LEFT: 2,
  ORIGIN_RIGHT: 3,
} as const

/**
 * Column positions for the `constraint_peer` relation.
 */
export const CONSTRAINT_PEER = {
  predicate: "constraint_peer",
  CNID: 0,
  PEER: 1,
} as const

// ---------------------------------------------------------------------------
// Projection Result
// ---------------------------------------------------------------------------

/**
 * The result of projecting active constraints into Datalog facts.
 */
export interface ProjectionResult {
  /** All projected ground facts, ready for the Datalog evaluator. */
  readonly facts: readonly Fact[]

  /**
   * Value constraints that were excluded because their target CnId
   * does not appear in the structure index (orphaned values).
   */
  readonly orphanedValues: readonly ValueConstraint[]
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

/**
 * Project active constraints into Datalog ground facts.
 *
 * This function performs three projections:
 *
 * 1. **Value projection**: For each active value constraint whose target
 *    is a known structure, emit an `active_value` fact with the slot
 *    identity derived from the structure index. Values targeting unknown
 *    structures (orphaned) are collected but not projected.
 *
 * 2. **Seq structure projection**: For each active seq structure constraint,
 *    emit an `active_structure_seq` fact with parent and origin references.
 *    These facts feed into Fugue ordering rules.
 *
 * 3. **Peer projection**: For each active seq structure constraint, emit
 *    a `constraint_peer` fact. This is used by Fugue rules for peer
 *    tiebreaking.
 *
 * @param activeConstraints - Constraints that have passed Valid(S) and Active(S).
 * @param structureIndex - The precomputed structure index.
 * @returns ProjectionResult with facts and diagnostics.
 */
export function projectToFacts(
  activeConstraints: Iterable<Constraint>,
  structureIndex: StructureIndex,
): ProjectionResult {
  const facts: Fact[] = []
  const orphanedValues: ValueConstraint[] = []

  for (const c of activeConstraints) {
    switch (c.type) {
      case "value":
        projectValue(c, structureIndex, facts, orphanedValues)
        break
      case "structure":
        projectStructure(c, facts)
        break
      // Other constraint types (retract, rule, authority, bookmark)
      // are not projected into Datalog ground facts. They have already
      // been processed by the validity and retraction filters.
    }
  }

  return { facts, orphanedValues }
}

// ---------------------------------------------------------------------------
// Value projection
// ---------------------------------------------------------------------------

/**
 * Project a single value constraint into an `active_value` fact.
 *
 * The target CnId is resolved through the structure index to obtain
 * the slot identity. If the target is not found (orphaned value),
 * the constraint is collected but not projected.
 */
function projectValue(
  vc: ValueConstraint,
  index: StructureIndex,
  facts: Fact[],
  orphaned: ValueConstraint[],
): void {
  const targetKey = cnIdKey(vc.payload.target)
  const sid = index.structureToSlot.get(targetKey)

  if (sid === undefined) {
    // Target structure not found — this value is orphaned.
    // It may have been retracted or never existed.
    orphaned.push(vc)
    return
  }

  // Emit: active_value(CnId, Slot, Content, Lamport, Peer)
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

// ---------------------------------------------------------------------------
// Structure projection
// ---------------------------------------------------------------------------

/**
 * Project a structure constraint into seq-specific facts.
 *
 * Only seq structures are projected (they feed Fugue rules).
 * Root and map structures are consumed directly by the skeleton builder,
 * not by Datalog rules.
 */
function projectStructure(sc: StructureConstraint, facts: Fact[]): void {
  const payload = sc.payload

  if (payload.kind === "seq") {
    // Emit: active_structure_seq(CnId, Parent, OriginLeft, OriginRight)
    facts.push(
      fact(ACTIVE_STRUCTURE_SEQ.predicate, [
        cnIdKey(sc.id),
        cnIdKey(payload.parent),
        payload.originLeft !== null ? cnIdKey(payload.originLeft) : null,
        payload.originRight !== null ? cnIdKey(payload.originRight) : null,
      ]),
    )

    // Emit: constraint_peer(CnId, Peer)
    facts.push(fact(CONSTRAINT_PEER.predicate, [cnIdKey(sc.id), sc.id.peer]))
  }
}

// ---------------------------------------------------------------------------
// Fact→Constraint Tracing
// ---------------------------------------------------------------------------

/**
 * Known predicates whose position-0 value is a CnIdKey string.
 */
const CONSTRAINT_KEY_PREDICATES: ReadonlySet<string> = new Set([
  ACTIVE_VALUE.predicate,
  ACTIVE_STRUCTURE_SEQ.predicate,
  CONSTRAINT_PEER.predicate,
])

/**
 * Extract the constraint key (CnIdKey) from position 0 of a projected fact,
 * if the fact belongs to a known projected relation. Returns `null` for
 * unrecognised predicates or facts with empty value tuples.
 *
 * O(1), stateless — just reads `f.values[0]`.
 */
export function constraintKeyFromFact(f: Fact): string | null {
  if (!CONSTRAINT_KEY_PREDICATES.has(f.predicate)) {
    return null
  }
  const v = f.values[0]
  if (typeof v !== "string") {
    return null
  }
  return v
}
