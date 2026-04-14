// === Incremental Retraction Tests ===
// Tests for the incremental retraction stage (Plan 005, Phase 3).
//
// Covers:
// - Single non-retract insertion → active
// - Retract a value → target dominated, retract active
// - Undo (retract-the-retract) → original re-activates
// - Depth limits
// - Structure and authority immunity
// - Out-of-order: retract before target
// - Out-of-order: undo before retract
// - Out-of-order: retract + target in same multi-element delta
// - Removal (weight −1) handling
// - Differential equivalence with batch computeActive

import { describe, expect, it } from "vitest"
import {
  type ZSet,
  zsetAdd,
  zsetEmpty,
  zsetSingleton,
} from "../../../src/base/zset.js"
import { cnIdKey, createCnId } from "../../../src/kernel/cnid.js"
import {
  createIncrementalRetraction,
  type IncrementalRetraction,
} from "../../../src/kernel/incremental/retraction.js"
import {
  computeActive,
  DEFAULT_RETRACTION_CONFIG,
} from "../../../src/kernel/retraction.js"
import { STUB_SIGNATURE } from "../../../src/kernel/signature.js"
import type {
  AuthorityConstraint,
  CnId,
  Constraint,
  PeerID,
  RetractConstraint,
  StructureConstraint,
  ValueConstraint,
} from "../../../src/kernel/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValue(
  peer: PeerID,
  counter: number,
  lamport: number,
  target: CnId,
  content: unknown = "v",
  refs: CnId[] = [],
): ValueConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: "value",
    payload: { target, content: content as any },
  }
}

function makeStructure(
  peer: PeerID,
  counter: number,
  lamport: number,
  refs: CnId[] = [],
): StructureConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: {
      kind: "root",
      containerId: `c-${peer}-${counter}`,
      policy: "map",
    },
  }
}

function makeRetract(
  peer: PeerID,
  counter: number,
  lamport: number,
  target: CnId,
  refs: CnId[] = [],
): RetractConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: "retract",
    payload: { target },
  }
}

function makeAuthority(
  peer: PeerID,
  counter: number,
  lamport: number,
  targetPeer: PeerID,
  refs: CnId[] = [],
): AuthorityConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: "authority",
    payload: {
      targetPeer,
      action: "grant",
      capability: { kind: "write", pathPattern: ["*"] },
    },
  }
}

/** Insert a single constraint as a +1 singleton delta. */
function insertOne(
  stage: IncrementalRetraction,
  c: Constraint,
): ZSet<Constraint> {
  return stage.step(zsetSingleton(cnIdKey(c.id), c, 1))
}

/** Collect active constraint CnId keys from the incremental stage, sorted. */
function activeKeys(stage: IncrementalRetraction): string[] {
  return stage
    .current()
    .map(c => cnIdKey(c.id))
    .sort()
}

/** Collect active CnId keys from a Z-set delta (weight > 0), sorted. */
function deltaActiveKeys(delta: ZSet<Constraint>): string[] {
  const keys: string[] = []
  for (const [key, entry] of delta) {
    if (entry.weight > 0) keys.push(key)
  }
  return keys.sort()
}

/** Collect dominated CnId keys from a Z-set delta (weight < 0), sorted. */
function deltaDominatedKeys(delta: ZSet<Constraint>): string[] {
  const keys: string[] = []
  for (const [key, entry] of delta) {
    if (entry.weight < 0) keys.push(key)
  }
  return keys.sort()
}

/** Collect active CnId keys from batch computeActive, sorted. */
function batchActiveKeys(
  constraints: Constraint[],
  config = DEFAULT_RETRACTION_CONFIG,
): string[] {
  return computeActive(constraints, config)
    .active.map(c => cnIdKey(c.id))
    .sort()
}

/** Build a multi-element Z-set delta from multiple constraints. */
function multiInsert(constraints: Constraint[]): ZSet<Constraint> {
  let zs = zsetEmpty<Constraint>()
  for (const c of constraints) {
    zs = zsetAdd(zs, zsetSingleton(cnIdKey(c.id), c, 1))
  }
  return zs
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IncrementalRetraction", () => {
  // -----------------------------------------------------------------------
  // Basic behavior
  // -----------------------------------------------------------------------

  describe("single non-retract insertion", () => {
    it("emits {c: +1} in active delta", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const delta = insertOne(stage, v1)

      expect(deltaActiveKeys(delta)).toEqual([cnIdKey(v1.id)])
      expect(deltaDominatedKeys(delta)).toEqual([])
    })

    it("constraint appears in current() after insertion", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      insertOne(stage, v1)

      expect(activeKeys(stage)).toEqual([cnIdKey(v1.id)])
    })

    it("multiple independent non-retracts are all active", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const v2 = makeValue("bob", 0, 1, createCnId("bob", 99))
      insertOne(stage, v1)
      insertOne(stage, v2)

      expect(activeKeys(stage)).toEqual([cnIdKey(v1.id), cnIdKey(v2.id)].sort())
    })

    it("duplicate insertion is a no-op", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      insertOne(stage, v1)
      const delta2 = insertOne(stage, v1)

      expect(delta2.size).toBe(0)
      expect(activeKeys(stage)).toEqual([cnIdKey(v1.id)])
    })
  })

  // -----------------------------------------------------------------------
  // Retract a value
  // -----------------------------------------------------------------------

  describe("retract a value", () => {
    it("target becomes dominated, retract itself active", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      insertOne(stage, v1)
      const delta = insertOne(stage, r1)

      // Delta should show: v1 went from active to dominated (−1),
      // r1 entered as active (+1)
      expect(deltaDominatedKeys(delta)).toEqual([cnIdKey(v1.id)])
      expect(deltaActiveKeys(delta)).toEqual([cnIdKey(r1.id)])

      // Current state: r1 active, v1 not active
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id)])
    })

    it("retract of value with multiple retractors: target still dominated", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("bob", 0, 3, v1.id, [v1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      const delta = insertOne(stage, r2)

      // v1 was already dominated, so no status change for v1
      // r2 enters as active
      expect(deltaActiveKeys(delta)).toEqual([cnIdKey(r2.id)])

      // Current: r1, r2 active; v1 dominated
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(r2.id)].sort())
    })
  })

  // -----------------------------------------------------------------------
  // Undo (retract-the-retract)
  // -----------------------------------------------------------------------

  describe("undo (retract of retract)", () => {
    it("original target re-activates", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      const delta = insertOne(stage, r2)

      // r2 dominates r1, which un-dominates v1
      // Delta: r2 active (+1), r1 dominated (−1), v1 re-activated (+1)
      expect(deltaActiveKeys(delta)).toEqual(
        [cnIdKey(r2.id), cnIdKey(v1.id)].sort(),
      )
      expect(deltaDominatedKeys(delta)).toEqual([cnIdKey(r1.id)])

      // Current: v1 active, r1 dominated, r2 active
      expect(activeKeys(stage)).toEqual([cnIdKey(r2.id), cnIdKey(v1.id)].sort())
    })
  })

  // -----------------------------------------------------------------------
  // Depth limits
  // -----------------------------------------------------------------------

  describe("depth limits", () => {
    it("depth 0: no retraction at all", () => {
      const stage = createIncrementalRetraction({ maxDepth: 0 })
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)

      // Both active when depth=0
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(v1.id)].sort())
    })

    it("depth 1: retract values only, no undo", () => {
      const stage = createIncrementalRetraction({ maxDepth: 1 })
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)

      // r1 dominates v1 (depth 1, allowed)
      // r2 targets r1 (depth 2, exceeds maxDepth 1 → ignored)
      // So: r1 active, r2 active, v1 dominated
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(r2.id)].sort())
    })

    it("depth Infinity: unlimited retraction chains", () => {
      const stage = createIncrementalRetraction({ maxDepth: Infinity })
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("alice", 2, 3, r1.id, [r1.id])
      const r3 = makeRetract("alice", 3, 4, r2.id, [r2.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)
      insertOne(stage, r3)

      // r3 dominates r2, which un-dominates r1, which re-dominates v1
      // v1: dominated (r1 active), r1: active (r2 dominated), r2: dominated (r3 active), r3: active
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(r3.id)].sort())
    })

    it("default config has maxDepth 2", () => {
      const stage = createIncrementalRetraction()
      // default is depth 2
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("alice", 2, 3, r1.id, [r1.id])
      const r3 = makeRetract("alice", 3, 4, r2.id, [r2.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)
      insertOne(stage, r3)

      // r1→v1 depth 1 (allowed), r2→r1 depth 2 (allowed), r3→r2 depth 3 (exceeds)
      // r2 dominates r1, un-dominates v1; r3 ignored (depth exceeded)
      expect(activeKeys(stage)).toEqual(
        [cnIdKey(r2.id), cnIdKey(r3.id), cnIdKey(v1.id)].sort(),
      )
    })
  })

  // -----------------------------------------------------------------------
  // Structure immunity
  // -----------------------------------------------------------------------

  describe("structure immunity", () => {
    it("retract targeting structure → violation, no graph change", () => {
      const stage = createIncrementalRetraction()
      const s1 = makeStructure("alice", 0, 1)
      const r1 = makeRetract("alice", 1, 2, s1.id, [s1.id])

      insertOne(stage, s1)
      insertOne(stage, r1)

      // Structure is immune — remains active
      expect(activeKeys(stage)).toContain(cnIdKey(s1.id))
      // Retract itself is still active (it's a constraint, just an invalid retract)
      expect(activeKeys(stage)).toContain(cnIdKey(r1.id))

      // Violation recorded
      const violations = stage.violations()
      expect(violations.length).toBe(1)
      expect(violations[0]?.reason.kind).toBe("targetIsStructure")
    })
  })

  // -----------------------------------------------------------------------
  // Authority immunity
  // -----------------------------------------------------------------------

  describe("authority immunity", () => {
    it("retract targeting authority → violation, no graph change", () => {
      const stage = createIncrementalRetraction()
      const a1 = makeAuthority("alice", 0, 1, "bob")
      const r1 = makeRetract("alice", 1, 2, a1.id, [a1.id])

      insertOne(stage, a1)
      insertOne(stage, r1)

      // Authority is immune — remains active
      expect(activeKeys(stage)).toContain(cnIdKey(a1.id))
      expect(activeKeys(stage)).toContain(cnIdKey(r1.id))

      const violations = stage.violations()
      expect(violations.length).toBe(1)
      expect(violations[0]?.reason.kind).toBe("targetIsAuthority")
    })
  })

  // -----------------------------------------------------------------------
  // Target-in-refs validation
  // -----------------------------------------------------------------------

  describe("target-in-refs validation", () => {
    it("retract without refs produces a violation", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, []) // no refs!

      insertOne(stage, v1)
      insertOne(stage, r1)

      // v1 should remain active (retract is invalid)
      expect(activeKeys(stage)).toContain(cnIdKey(v1.id))

      const violations = stage.violations()
      expect(violations.length).toBe(1)
      expect(violations[0]?.reason.kind).toBe("targetNotInRefs")
    })

    it("retract with ref counter < target counter produces a violation", () => {
      const stage = createIncrementalRetraction()
      const _v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      // ref counter 98 < target counter 99 → not observed
      const _r1 = makeRetract("bob", 0, 2, createCnId("alice", 0), [
        createCnId("alice", 98),
      ])

      // Target is alice@0, ref covers alice up to 98, but target is alice@0
      // which IS ≤ 98. Wait — let me re-read the semantic interpretation.
      // ref (alice, 98) means "observed alice@0..alice@98". Target is alice@0.
      // So target counter (0) ≤ ref counter (98) → valid!
      // Let me make a truly invalid case instead.
      const v2 = makeValue("alice", 5, 1, createCnId("alice", 99))
      const r2 = makeRetract("bob", 1, 3, v2.id, [
        createCnId("alice", 3), // ref counter 3 < target counter 5
      ])

      insertOne(stage, v2)
      insertOne(stage, r2)

      expect(activeKeys(stage)).toContain(cnIdKey(v2.id))
      expect(
        stage.violations().some(v => v.reason.kind === "targetNotInRefs"),
      ).toBe(true)
    })

    it("retract with ref counter >= target counter succeeds", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("bob", 0, 2, v1.id, [
        createCnId("alice", 5), // 5 >= 0 → observed
      ])

      insertOne(stage, v1)
      insertOne(stage, r1)

      // Retract is valid — v1 should be dominated
      expect(activeKeys(stage)).not.toContain(cnIdKey(v1.id))
      expect(activeKeys(stage)).toContain(cnIdKey(r1.id))
      expect(stage.violations().length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Out-of-order: retract before target
  // -----------------------------------------------------------------------

  describe("out-of-order: retract before target", () => {
    it("target is dominated immediately upon arrival", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      // Insert retract FIRST
      const delta1 = insertOne(stage, r1)
      // r1 enters as active (its target hasn't arrived yet)
      expect(deltaActiveKeys(delta1)).toEqual([cnIdKey(r1.id)])

      // Insert target SECOND
      const delta2 = insertOne(stage, v1)
      // v1 should be immediately dominated because r1 already targets it
      expect(deltaDominatedKeys(delta2)).toEqual([])
      // v1 never became active, so no −1 in delta.
      // But v1 IS dominated — it should NOT appear in the +1 side.
      // The delta should be empty for v1 (it entered as dominated directly).
      expect(deltaActiveKeys(delta2)).toEqual([])

      // Final state: r1 active, v1 dominated
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id)])
    })

    it("matches batch computeActive for retract-before-target", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      insertOne(stage, r1) // retract first
      insertOne(stage, v1) // target second

      const batchResult = batchActiveKeys([r1, v1])
      expect(activeKeys(stage)).toEqual(batchResult)
    })
  })

  // -----------------------------------------------------------------------
  // Out-of-order: undo before retract
  // -----------------------------------------------------------------------

  describe("out-of-order: undo before retract", () => {
    it("undo → retract → target: target is active because retract is dominated", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const u1 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      // Insert in order: undo, retract, target
      insertOne(stage, u1)
      insertOne(stage, r1)
      insertOne(stage, v1)

      // u1 dominates r1, so r1's edge is inactive → v1 is active
      // Final: v1 active, r1 dominated, u1 active
      expect(activeKeys(stage)).toEqual([cnIdKey(u1.id), cnIdKey(v1.id)].sort())
    })

    it("matches batch computeActive", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const u1 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      insertOne(stage, u1)
      insertOne(stage, r1)
      insertOne(stage, v1)

      const batchResult = batchActiveKeys([v1, r1, u1])
      expect(activeKeys(stage)).toEqual(batchResult)
    })
  })

  // -----------------------------------------------------------------------
  // Out-of-order: retract before target in multi-element delta
  // -----------------------------------------------------------------------

  describe("out-of-order: multi-element delta", () => {
    it("retract + target in same delta: target is dominated", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      // Both arrive in the same delta
      const _delta = stage.step(multiInsert([r1, v1]))

      // v1 should be dominated, r1 active
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id)])
    })

    it("matches batch computeActive for same-delta case", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      stage.step(multiInsert([r1, v1]))

      const batchResult = batchActiveKeys([v1, r1])
      expect(activeKeys(stage)).toEqual(batchResult)
    })

    it("multi-element delta with undo, retract, and target", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const u1 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      stage.step(multiInsert([v1, r1, u1]))

      // u1 dominates r1, so v1 is active
      const batchResult = batchActiveKeys([v1, r1, u1])
      expect(activeKeys(stage)).toEqual(batchResult)
    })
  })

  // -----------------------------------------------------------------------
  // Deferred immunity: retract arrives before immune target
  // -----------------------------------------------------------------------

  describe("deferred immunity", () => {
    it("retract arrives before structure target: violation on target arrival", () => {
      const stage = createIncrementalRetraction()
      const s1 = makeStructure("alice", 0, 1)
      const r1 = makeRetract("alice", 1, 2, s1.id, [s1.id])

      // Retract arrives first — no violation yet (target not known)
      insertOne(stage, r1)
      expect(stage.violations().length).toBe(0)

      // Structure arrives — deferred immunity check triggers violation
      insertOne(stage, s1)
      expect(stage.violations().length).toBe(1)
      expect(stage.violations()[0]?.reason.kind).toBe("targetIsStructure")

      // Both should be active (structure immune, retract's edge removed)
      expect(activeKeys(stage)).toContain(cnIdKey(s1.id))
      expect(activeKeys(stage)).toContain(cnIdKey(r1.id))
    })

    it("retract arrives before authority target: violation on target arrival", () => {
      const stage = createIncrementalRetraction()
      const a1 = makeAuthority("alice", 0, 1, "bob")
      const r1 = makeRetract("alice", 1, 2, a1.id, [a1.id])

      insertOne(stage, r1)
      expect(stage.violations().length).toBe(0)

      insertOne(stage, a1)
      expect(stage.violations().length).toBe(1)
      expect(stage.violations()[0]?.reason.kind).toBe("targetIsAuthority")

      expect(activeKeys(stage)).toContain(cnIdKey(a1.id))
      expect(activeKeys(stage)).toContain(cnIdKey(r1.id))
    })
  })

  // -----------------------------------------------------------------------
  // Removal (weight −1)
  // -----------------------------------------------------------------------

  describe("removal (weight −1)", () => {
    it("removing an active constraint emits −1 delta", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))

      insertOne(stage, v1)
      expect(activeKeys(stage)).toEqual([cnIdKey(v1.id)])

      const delta = stage.step(zsetSingleton(cnIdKey(v1.id), v1, -1))
      expect(deltaDominatedKeys(delta)).toEqual([cnIdKey(v1.id)])
      expect(activeKeys(stage)).toEqual([])
    })

    it("removing a retract re-activates its target", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id)])

      // Remove the retract
      const delta = stage.step(zsetSingleton(cnIdKey(r1.id), r1, -1))

      // r1 removed (−1), v1 re-activated (+1)
      expect(deltaDominatedKeys(delta)).toContain(cnIdKey(r1.id))
      expect(deltaActiveKeys(delta)).toContain(cnIdKey(v1.id))
      expect(activeKeys(stage)).toEqual([cnIdKey(v1.id)])
    })
  })

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("reset clears all state", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      insertOne(stage, v1)
      expect(activeKeys(stage).length).toBe(1)

      stage.reset()

      expect(activeKeys(stage)).toEqual([])
      expect(stage.violations()).toEqual([])
    })

    it("stage works correctly after reset", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      insertOne(stage, v1)
      stage.reset()

      const v2 = makeValue("bob", 0, 1, createCnId("bob", 99))
      insertOne(stage, v2)
      expect(activeKeys(stage)).toEqual([cnIdKey(v2.id)])
    })
  })

  // -----------------------------------------------------------------------
  // Empty delta
  // -----------------------------------------------------------------------

  describe("empty delta", () => {
    it("empty delta returns empty delta", () => {
      const stage = createIncrementalRetraction()
      const delta = stage.step(zsetEmpty())
      expect(delta.size).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Independent retractions
  // -----------------------------------------------------------------------

  describe("independent retractions", () => {
    it("independent retractions do not interfere", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const v2 = makeValue("bob", 0, 1, createCnId("bob", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      insertOne(stage, v1)
      insertOne(stage, v2)
      insertOne(stage, r1)

      // v1 dominated by r1, v2 unaffected
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(v2.id)].sort())
    })

    it("two values retracted independently", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const v2 = makeValue("bob", 0, 1, createCnId("bob", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("bob", 1, 3, v2.id, [v2.id])

      insertOne(stage, v1)
      insertOne(stage, v2)
      insertOne(stage, r1)
      insertOne(stage, r2)

      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(r2.id)].sort())
    })
  })

  // -----------------------------------------------------------------------
  // Retract targeting non-existent constraint
  // -----------------------------------------------------------------------

  describe("retract targeting non-existent constraint", () => {
    it("retract alone (target never arrives) is active", () => {
      const stage = createIncrementalRetraction()
      const r1 = makeRetract("alice", 1, 2, createCnId("alice", 0), [
        createCnId("alice", 0),
      ])

      insertOne(stage, r1)

      // The retract is active — its edge is recorded but the target
      // never arrived, so the retract has no dominance effect.
      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id)])
    })
  })

  // -----------------------------------------------------------------------
  // Differential equivalence with batch
  // -----------------------------------------------------------------------

  describe("differential equivalence", () => {
    it("matches batch after single insertion", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      insertOne(stage, v1)

      expect(activeKeys(stage)).toEqual(batchActiveKeys([v1]))
    })

    it("matches batch after retraction", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)

      expect(activeKeys(stage)).toEqual(batchActiveKeys([v1, r1]))
    })

    it("matches batch after undo", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)

      expect(activeKeys(stage)).toEqual(batchActiveKeys([v1, r1, r2]))
    })

    it("matches batch with depth limit 1", () => {
      const depthConfig = { maxDepth: 1 }
      const stage = createIncrementalRetraction(depthConfig)
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)

      expect(activeKeys(stage)).toEqual(
        batchActiveKeys([v1, r1, r2], depthConfig),
      )
    })

    it("matches batch with complex multi-step scenario", () => {
      const stage = createIncrementalRetraction()
      const all: Constraint[] = []

      // Create a scenario: two values, one retracted, one retracted and undone
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const v2 = makeValue("bob", 0, 1, createCnId("bob", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("bob", 1, 3, v2.id, [v2.id])
      const u2 = makeRetract("bob", 2, 4, r2.id, [r2.id])

      for (const c of [v1, v2, r1, r2, u2]) {
        insertOne(stage, c)
        all.push(c)
        expect(activeKeys(stage)).toEqual(batchActiveKeys(all))
      }
    })

    it("matches batch regardless of insertion order", () => {
      const constraints: Constraint[] = []
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const v2 = makeValue("bob", 0, 1, createCnId("bob", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      constraints.push(v1, v2, r1)

      const batchResult = batchActiveKeys(constraints)

      // Try multiple orderings
      const orderings = [
        [v1, v2, r1],
        [r1, v1, v2],
        [v2, r1, v1],
        [r1, v2, v1],
      ]

      for (const ordering of orderings) {
        const stage = createIncrementalRetraction()
        for (const c of ordering) {
          insertOne(stage, c)
        }
        expect(activeKeys(stage)).toEqual(batchResult)
      }
    })

    it("matches batch with structure immunity", () => {
      const stage = createIncrementalRetraction()
      const all: Constraint[] = []

      const s1 = makeStructure("alice", 0, 1)
      const v1 = makeValue("alice", 1, 2, s1.id)
      const r1 = makeRetract("alice", 2, 3, s1.id, [s1.id]) // targets structure (violation)
      const r2 = makeRetract("alice", 3, 4, v1.id, [v1.id]) // targets value (valid)

      for (const c of [s1, v1, r1, r2]) {
        insertOne(stage, c)
        all.push(c)
      }

      expect(activeKeys(stage)).toEqual(batchActiveKeys(all))
    })

    it("matches batch with all orderings of retract-before-target + undo", () => {
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const u1 = makeRetract("alice", 2, 3, r1.id, [r1.id])

      const constraints = [v1, r1, u1]
      const batchResult = batchActiveKeys(constraints)

      // All 6 permutations
      const permutations = [
        [v1, r1, u1],
        [v1, u1, r1],
        [r1, v1, u1],
        [r1, u1, v1],
        [u1, v1, r1],
        [u1, r1, v1],
      ]

      for (const ordering of permutations) {
        const stage = createIncrementalRetraction()
        for (const c of ordering) {
          insertOne(stage, c)
        }
        expect(activeKeys(stage)).toEqual(batchResult)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Mixed violations and valid retractions
  // -----------------------------------------------------------------------

  describe("mixed violations and valid retractions", () => {
    it("violation does not prevent valid retraction of different target", () => {
      const stage = createIncrementalRetraction()
      const s1 = makeStructure("alice", 0, 1)
      const v1 = makeValue("alice", 1, 2, s1.id)
      const rBad = makeRetract("alice", 2, 3, s1.id, [s1.id]) // targets structure
      const rGood = makeRetract("alice", 3, 4, v1.id, [v1.id]) // targets value

      insertOne(stage, s1)
      insertOne(stage, v1)
      insertOne(stage, rBad)
      insertOne(stage, rGood)

      // s1: active (immune), v1: dominated (valid retraction), rBad: active, rGood: active
      expect(activeKeys(stage)).toContain(cnIdKey(s1.id))
      expect(activeKeys(stage)).not.toContain(cnIdKey(v1.id))
      expect(activeKeys(stage)).toContain(cnIdKey(rGood.id))

      expect(stage.violations().length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Constraint retracted by multiple peers
  // -----------------------------------------------------------------------

  describe("multiple peers retracting same target", () => {
    it("all retractions active → target dominated", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("bob", 0, 3, v1.id, [v1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)

      expect(activeKeys(stage)).toEqual([cnIdKey(r1.id), cnIdKey(r2.id)].sort())
      expect(activeKeys(stage)).not.toContain(cnIdKey(v1.id))
    })

    it("undoing one retractor re-evaluates target (still dominated by other)", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("bob", 0, 3, v1.id, [v1.id])
      const u1 = makeRetract("alice", 2, 4, r1.id, [r1.id])

      insertOne(stage, v1)
      insertOne(stage, r1)
      insertOne(stage, r2)
      insertOne(stage, u1)

      // r1 is dominated by u1, but r2 still actively retracts v1
      expect(activeKeys(stage)).not.toContain(cnIdKey(v1.id))
      expect(activeKeys(stage)).toContain(cnIdKey(r2.id))
      expect(activeKeys(stage)).toContain(cnIdKey(u1.id))
      expect(activeKeys(stage)).not.toContain(cnIdKey(r1.id))
    })

    it("matches batch with multiple retractors and undo", () => {
      const stage = createIncrementalRetraction()
      const v1 = makeValue("alice", 0, 1, createCnId("alice", 99))
      const r1 = makeRetract("alice", 1, 2, v1.id, [v1.id])
      const r2 = makeRetract("bob", 0, 3, v1.id, [v1.id])
      const u1 = makeRetract("alice", 2, 4, r1.id, [r1.id])

      const all: Constraint[] = []
      for (const c of [v1, r1, r2, u1]) {
        insertOne(stage, c)
        all.push(c)
      }

      expect(activeKeys(stage)).toEqual(batchActiveKeys(all))
    })
  })
})
