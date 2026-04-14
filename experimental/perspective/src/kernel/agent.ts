// === Agent ===
// The imperative shell of the CCS model. An Agent encapsulates the
// stateful parts of constraint creation: CnId counter, Lamport clock,
// observed version vector, and private key. It produces immutable
// Constraint values.
//
// This is the only place where mutable state lives during normal
// operation. The store itself is grow-only (append-only set).
//
// See unified-engine.md §B.5, §1.

import type { Atom, BodyElement } from "../datalog/types.js"
import { createCnId } from "./cnid.js"
import {
  createLamportClock,
  type LamportClock,
  observe as observeLamport,
  tick,
} from "./lamport.js"
import { STUB_PRIVATE_KEY, sign } from "./signature.js"
import type {
  AuthorityAction,
  AuthorityConstraint,
  BookmarkConstraint,
  Capability,
  CnId,
  Constraint,
  Counter,
  Lamport,
  MutableVersionVector,
  PeerID,
  Policy,
  RetractConstraint,
  RuleConstraint,
  StructureConstraint,
  StructurePayload,
  Value,
  ValueConstraint,
  VersionVector,
} from "./types.js"
import {
  createVersionVector,
  vvExtendCnId,
  vvMergeInto,
} from "./version-vector.js"

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

/**
 * An Agent is a stateful constraint factory.
 *
 * It manages:
 * - A peer identity (PeerID)
 * - A monotonically increasing counter (for CnId generation)
 * - A Lamport clock (for causal ordering)
 * - An observed version vector (tracks what constraints this agent has seen)
 * - A private key (for signing — stub for now)
 *
 * All produce* methods return immutable Constraint values.
 */
export interface Agent {
  /** This agent's peer identity. */
  readonly peerId: PeerID

  /** The current counter value (next constraint will use this + 1). */
  readonly counter: Counter

  /** The current Lamport clock value. */
  readonly lamportValue: Lamport

  /** The current observed version vector (read-only view). */
  readonly versionVector: VersionVector

  // --- Constraint producers ---

  /** Produce a structure constraint (permanent node). */
  produceStructure(payload: StructurePayload): StructureConstraint

  /** Produce a value constraint (content at a node). */
  produceValue(target: CnId, content: Value): ValueConstraint

  /** Produce a retract constraint (dominate a target). */
  produceRetract(target: CnId): RetractConstraint

  /** Produce a rule constraint (Datalog rule at layer ≥ 2). */
  produceRule(
    layer: number,
    head: Atom,
    body: readonly BodyElement[],
  ): RuleConstraint

  /** Produce an authority constraint (capability change). */
  produceAuthority(
    targetPeer: PeerID,
    action: AuthorityAction,
    capability: Capability,
  ): AuthorityConstraint

  /** Produce a bookmark constraint (named causal moment). */
  produceBookmark(name: string, version: VersionVector): BookmarkConstraint

  // --- Observation ---

  /**
   * Observe a constraint — update the version vector and Lamport clock
   * to reflect having seen this constraint. Call this when receiving
   * constraints from other agents or from the store.
   */
  observe(constraint: Constraint): void

  /**
   * Observe multiple constraints at once.
   */
  observeMany(constraints: Iterable<Constraint>): void

  /**
   * Merge an external version vector into the observed set.
   */
  mergeVersionVector(vv: VersionVector): void
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new Agent.
 *
 * @param peerId - This agent's peer identity.
 * @param privateKey - The agent's ed25519 private key (stub: use STUB_PRIVATE_KEY).
 * @param initialCounter - Starting counter value (default 0).
 * @param initialLamport - Starting Lamport value (default 0).
 */
export function createAgent(
  peerId: PeerID,
  privateKey: Uint8Array = STUB_PRIVATE_KEY,
  initialCounter: Counter = 0,
  initialLamport: Lamport = 0,
): Agent {
  // Mutable state
  let counter: Counter = initialCounter
  const clock: LamportClock = createLamportClock()
  if (initialLamport > 0) {
    clock.value = initialLamport
  }
  const observedVV: MutableVersionVector = createVersionVector()
  const key: Uint8Array = privateKey

  // --- Internal helpers ---

  /**
   * Allocate the next CnId and tick the Lamport clock.
   * Returns [id, lamport] for the new constraint.
   *
   * @throws Error if counter or lamport would exceed MAX_SAFE_INTEGER.
   */
  function nextIdAndLamport(): [CnId, Lamport, CnId[]] {
    // Capture refs BEFORE updating VV — refs represent what we've
    // observed prior to this constraint, not including itself.
    const refs = currentRefs()

    const nextCounter = counter
    const nextLamport = tick(clock)

    // Enforce safe-integer invariant (programmer error if hit)
    if (nextCounter > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Agent ${peerId}: counter overflow (${nextCounter} > MAX_SAFE_INTEGER). ` +
          `This is a programmer error — no single agent should assert 2^53 constraints.`,
      )
    }
    if (nextLamport > Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Agent ${peerId}: lamport overflow (${nextLamport} > MAX_SAFE_INTEGER). ` +
          `This is a programmer error.`,
      )
    }

    const id = createCnId(peerId, nextCounter)
    counter += 1

    // Update our own version vector to include this new constraint
    vvExtendCnId(observedVV, id)

    return [id, nextLamport, refs]
  }

  /**
   * Get the current refs — all CnIds in the observed version vector
   * compressed to the frontier (one CnId per peer: the highest counter seen).
   *
   * This is a simplification: the spec says refs are "constraints this one
   * has observed (causal predecessors)." The version vector frontier is
   * the minimal representation of the full causal history.
   */
  function currentRefs(): CnId[] {
    const refs: CnId[] = []
    for (const [peer, nextCounter] of observedVV) {
      if (peer === peerId) {
        // Our own last constraint (if any) — counter is 0-based,
        // VV stores next expected, so last seen is nextCounter - 1.
        if (nextCounter > 0) {
          refs.push(createCnId(peer, nextCounter - 1))
        }
      } else {
        if (nextCounter > 0) {
          refs.push(createCnId(peer, nextCounter - 1))
        }
      }
    }
    return refs
  }

  /**
   * Sign a constraint. Stub: returns empty signature.
   */
  function signConstraint(): Uint8Array {
    // In a real implementation, we'd serialize the constraint fields
    // and sign with the private key.
    return sign(new Uint8Array(0), key)
  }

  // --- Agent object ---

  const agent: Agent = {
    get peerId() {
      return peerId
    },

    get counter() {
      return counter
    },

    get lamportValue() {
      return clock.value
    },

    get versionVector(): VersionVector {
      return observedVV
    },

    produceStructure(payload: StructurePayload): StructureConstraint {
      const [id, lamport, refs] = nextIdAndLamport()
      return {
        id,
        lamport,
        refs,
        sig: signConstraint(),
        type: "structure",
        payload,
      }
    },

    produceValue(target: CnId, content: Value): ValueConstraint {
      const [id, lamport, refs] = nextIdAndLamport()
      return {
        id,
        lamport,
        refs,
        sig: signConstraint(),
        type: "value",
        payload: { target, content },
      }
    },

    produceRetract(target: CnId): RetractConstraint {
      const [id, lamport, refs] = nextIdAndLamport()
      return {
        id,
        lamport,
        refs,
        sig: signConstraint(),
        type: "retract",
        payload: { target },
      }
    },

    produceRule(
      layer: number,
      head: Atom,
      body: readonly BodyElement[],
    ): RuleConstraint {
      if (layer < 2) {
        throw new Error(
          `Rule constraints must have layer ≥ 2, got ${layer}. ` +
            `Layers 0–1 are reserved for kernel and default solver rules.`,
        )
      }
      const [id, lamport, refs] = nextIdAndLamport()
      return {
        id,
        lamport,
        refs,
        sig: signConstraint(),
        type: "rule",
        payload: { layer, head, body },
      }
    },

    produceAuthority(
      targetPeer: PeerID,
      action: AuthorityAction,
      capability: Capability,
    ): AuthorityConstraint {
      const [id, lamport, refs] = nextIdAndLamport()
      return {
        id,
        lamport,
        refs,
        sig: signConstraint(),
        type: "authority",
        payload: { targetPeer, action, capability },
      }
    },

    produceBookmark(name: string, version: VersionVector): BookmarkConstraint {
      const [id, lamport, refs] = nextIdAndLamport()
      return {
        id,
        lamport,
        refs,
        sig: signConstraint(),
        type: "bookmark",
        payload: { name, version },
      }
    },

    observe(constraint: Constraint): void {
      vvExtendCnId(observedVV, constraint.id)
      observeLamport(clock, constraint.lamport)
    },

    observeMany(constraints: Iterable<Constraint>): void {
      for (const c of constraints) {
        vvExtendCnId(observedVV, c.id)
        observeLamport(clock, c.lamport)
      }
    },

    mergeVersionVector(vv: VersionVector): void {
      vvMergeInto(observedVV, vv)
      // Also update lamport to be at least as large as what the VV implies
      // (we don't have lamport info from VV alone, but this is fine —
      // lamport is updated when actual constraints are observed)
    },
  }

  return agent
}

// ---------------------------------------------------------------------------
// Convenience: create a structure root constraint
// ---------------------------------------------------------------------------

/**
 * Create a root structure constraint using an agent.
 *
 * Convenience for the common case of creating a container root.
 *
 * @param agent - The agent to use.
 * @param containerId - Top-level container name (e.g., "profile", "todos").
 * @param policy - Container policy (map or seq).
 * @returns The structure constraint and its CnId.
 */
export function produceRoot(
  agent: Agent,
  containerId: string,
  policy: Policy,
): { constraint: StructureConstraint; id: CnId } {
  const constraint = agent.produceStructure({
    kind: "root",
    containerId,
    policy,
  })
  return { constraint, id: constraint.id }
}

/**
 * Create a map child structure constraint using an agent.
 *
 * @param agent - The agent to use.
 * @param parent - CnId of the parent map node.
 * @param key - The map key.
 * @returns The structure constraint and its CnId.
 */
export function produceMapChild(
  agent: Agent,
  parent: CnId,
  key: string,
): { constraint: StructureConstraint; id: CnId } {
  const constraint = agent.produceStructure({
    kind: "map",
    parent,
    key,
  })
  return { constraint, id: constraint.id }
}

/**
 * Create a seq child structure constraint using an agent.
 *
 * @param agent - The agent to use.
 * @param parent - CnId of the parent seq node.
 * @param originLeft - Left neighbor at assertion time (null = start).
 * @param originRight - Right neighbor at assertion time (null = end).
 * @returns The structure constraint and its CnId.
 */
export function produceSeqChild(
  agent: Agent,
  parent: CnId,
  originLeft: CnId | null,
  originRight: CnId | null,
): { constraint: StructureConstraint; id: CnId } {
  const constraint = agent.produceStructure({
    kind: "seq",
    parent,
    originLeft,
    originRight,
  })
  return { constraint, id: constraint.id }
}
