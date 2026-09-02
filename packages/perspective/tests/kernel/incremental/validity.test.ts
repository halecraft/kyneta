// === Incremental Validity Tests ===
// Tests for the incremental validity stage (Plan 005, Phase 6).
//
// Covers:
// - Non-authority constraint from authorized peer: emits {c: +1}
// - Non-authority constraint from unauthorized peer: recorded as invalid
// - Authority grant enables previously-invalid constraints: emits {c': +1}
// - Authority revoke disables previously-valid constraints: emits {c': -1}
// - Concurrent grant+revoke (revoke wins): capability is removed
// - Creator's constraints always valid (implicit Admin)
// - Bookmark constraints always valid (no capability required)
// - Removal (weight −1) handling
// - Out-of-order: constraint before enabling grant
// - Out-of-order: authority constraints in same delta as non-authority
// - Differential equivalence with batch computeValid
// - All-permutation differential tests

import { describe, expect, it } from "vitest"
import {
  type ZSet,
  type ZSetEntry,
  zsetEmpty,
  zsetForEach,
  zsetFromEntries,
  zsetNegative,
  zsetPositive,
  zsetSingleton,
  zsetSize,
} from "../../../src/base/zset.js"
import { atom, positiveAtom, varTerm } from "../../../src/datalog/types.js"
import { cnIdKey, createCnId } from "../../../src/kernel/cnid.js"
import {
  createIncrementalValidity,
  type IncrementalValidity,
} from "../../../src/kernel/incremental/validity.js"
import { STUB_SIGNATURE } from "../../../src/kernel/signature.js"
import type {
  AuthorityConstraint,
  BookmarkConstraint,
  Capability,
  CnId,
  Constraint,
  PeerID,
  RetractConstraint,
  RuleConstraint,
  StructureConstraint,
  ValueConstraint,
} from "../../../src/kernel/types.js"
import { computeValid } from "../../../src/kernel/validity.js"

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const WRITE_ANY: Capability = { kind: "write", pathPattern: ["*"] }
const CREATE_NODE_ANY: Capability = { kind: "createNode", pathPattern: ["*"] }
const RETRACT_ANY: Capability = { kind: "retract", scope: { kind: "any" } }
const ADMIN: Capability = { kind: "admin" }
const _WRITE_PROFILE: Capability = { kind: "write", pathPattern: ["profile"] }
const _CREATE_RULE_2: Capability = { kind: "createRule", minLayer: 2 }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CREATOR = "alice"

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
  action: "grant" | "revoke",
  capability: Capability,
  refs: CnId[] = [],
): AuthorityConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: "authority",
    payload: { targetPeer, action, capability },
  }
}

function makeBookmark(
  peer: PeerID,
  counter: number,
  lamport: number,
): BookmarkConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "bookmark",
    payload: { name: "snap", version: new Map() },
  }
}

function makeRule(
  peer: PeerID,
  counter: number,
  lamport: number,
  layer: number = 2,
): RuleConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "rule",
    payload: {
      layer,
      head: atom("test", [varTerm("X")]),
      body: [positiveAtom(atom("input", [varTerm("X")]))],
    },
  }
}

/** Build a Z-set delta from an array of constraints (all weight +1). */
function deltaFromConstraints(constraints: Constraint[]): ZSet<Constraint> {
  return zsetFromEntries(
    constraints.map(
      c =>
        [cnIdKey(c.id), { element: c, weight: 1 }] as [
          string,
          ZSetEntry<Constraint>,
        ],
    ),
  )
}

/** Build a single-constraint insertion delta. */
function insertDelta(c: Constraint): ZSet<Constraint> {
  return zsetSingleton(cnIdKey(c.id), c, 1)
}

/** Build a single-constraint removal delta. */
function removalDelta(c: Constraint): ZSet<Constraint> {
  return zsetSingleton(cnIdKey(c.id), c, -1)
}

/** Get the set of CnId keys from a Z-set's positive entries. */
function positiveKeys<T>(zs: ZSet<T>): Set<string> {
  const keys = new Set<string>()
  zsetForEach(zsetPositive(zs), (_entry, key) => keys.add(key))
  return keys
}

/** Get the set of CnId keys from a Z-set's negative entries. */
function negativeKeys<T>(zs: ZSet<T>): Set<string> {
  const keys = new Set<string>()
  zsetForEach(zsetNegative(zs), (_entry, key) => keys.add(key))
  return keys
}

/** Get sorted CnId keys from current() for comparison. */
function currentKeys(stage: IncrementalValidity): string[] {
  return stage
    .current()
    .map(c => cnIdKey(c.id))
    .sort()
}

/** Get sorted CnId keys from batch computeValid for comparison. */
function batchValidKeys(constraints: Constraint[]): string[] {
  return computeValid(constraints, CREATOR)
    .valid.map(c => cnIdKey(c.id))
    .sort()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IncrementalValidity", () => {
  // -----------------------------------------------------------------------
  // Creator constraints
  // -----------------------------------------------------------------------

  describe("creator constraints", () => {
    it("creator value constraint is always valid (implicit Admin)", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 0)
      const v = makeValue(CREATOR, 1, 1, target)

      const delta = stage.step(insertDelta(v))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(v.id))).toBe(true)
    })

    it("creator structure constraint is always valid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)

      const delta = stage.step(insertDelta(s))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(s.id))).toBe(true)
    })

    it("creator authority constraint is always valid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const a = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)

      const delta = stage.step(insertDelta(a))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(a.id))).toBe(true)
    })

    it("creator retract constraint is always valid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 0)
      const r = makeRetract(CREATOR, 1, 1, target)

      const delta = stage.step(insertDelta(r))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(r.id))).toBe(true)
    })

    it("multiple creator constraints all valid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)
      const v = makeValue(CREATOR, 1, 1, s.id)
      const a = makeAuthority(CREATOR, 2, 2, "bob", "grant", WRITE_ANY)

      const d1 = stage.step(insertDelta(s))
      const d2 = stage.step(insertDelta(v))
      const d3 = stage.step(insertDelta(a))

      expect(zsetSize(zsetPositive(d1))).toBe(1)
      expect(zsetSize(zsetPositive(d2))).toBe(1)
      expect(zsetSize(zsetPositive(d3))).toBe(1)
      expect(stage.current().length).toBe(3)
    })
  })

  // -----------------------------------------------------------------------
  // Non-creator without capabilities
  // -----------------------------------------------------------------------

  describe("non-creator without capabilities", () => {
    it("non-creator value constraint is invalid without capability", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 0)
      const v = makeValue("bob", 0, 1, target)

      const delta = stage.step(insertDelta(v))

      // No positive entry — constraint is invalid
      expect(zsetSize(delta)).toBe(0)
      expect(stage.current().length).toBe(0)
    })

    it("non-creator structure constraint is invalid without capability", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure("bob", 0, 0)

      const delta = stage.step(insertDelta(s))

      expect(zsetSize(delta)).toBe(0)
      expect(stage.current().length).toBe(0)
    })

    it("non-creator retract constraint is invalid without capability", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 0)
      const r = makeRetract("bob", 0, 1, target)

      const delta = stage.step(insertDelta(r))

      expect(zsetSize(delta)).toBe(0)
      expect(stage.current().length).toBe(0)
    })

    it("non-creator authority constraint is invalid without authority capability", () => {
      const stage = createIncrementalValidity(CREATOR)
      const a = makeAuthority("bob", 0, 1, "charlie", "grant", WRITE_ANY)

      const delta = stage.step(insertDelta(a))

      expect(zsetSize(delta)).toBe(0)
      expect(stage.current().length).toBe(0)
    })

    it("non-creator rule constraint is invalid without createRule capability", () => {
      const stage = createIncrementalValidity(CREATOR)
      const r = makeRule("bob", 0, 1, 2)

      const delta = stage.step(insertDelta(r))

      expect(zsetSize(delta)).toBe(0)
      expect(stage.current().length).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Non-creator with capabilities
  // -----------------------------------------------------------------------

  describe("non-creator with capabilities", () => {
    it("non-creator with write can produce value constraints", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 2, target)

      // Grant first, then value
      stage.step(insertDelta(grant))
      const delta = stage.step(insertDelta(v))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(v.id))).toBe(true)
    })

    it("non-creator with createNode can produce structure constraints", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(
        CREATOR,
        0,
        1,
        "bob",
        "grant",
        CREATE_NODE_ANY,
      )
      const s = makeStructure("bob", 0, 2)

      stage.step(insertDelta(grant))
      const delta = stage.step(insertDelta(s))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(s.id))).toBe(true)
    })

    it("non-creator with retract capability can produce retract constraints", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", RETRACT_ANY)
      const target = createCnId(CREATOR, 10)
      const r = makeRetract("bob", 0, 2, target)

      stage.step(insertDelta(grant))
      const delta = stage.step(insertDelta(r))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(r.id))).toBe(true)
    })

    it("admin grant gives full access", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", ADMIN)

      const s = makeStructure("bob", 0, 2)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 1, 3, target)
      const r = makeRetract("bob", 2, 4, target)

      stage.step(insertDelta(grant))
      const d1 = stage.step(insertDelta(s))
      const d2 = stage.step(insertDelta(v))
      const d3 = stage.step(insertDelta(r))

      expect(zsetSize(zsetPositive(d1))).toBe(1)
      expect(zsetSize(zsetPositive(d2))).toBe(1)
      expect(zsetSize(zsetPositive(d3))).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Bookmark constraints (no capability required)
  // -----------------------------------------------------------------------

  describe("bookmark constraints", () => {
    it("bookmarks require no capability", () => {
      const stage = createIncrementalValidity(CREATOR)
      const b = makeBookmark("bob", 0, 1)

      const delta = stage.step(insertDelta(b))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
      expect(positiveKeys(delta).has(cnIdKey(b.id))).toBe(true)
    })

    it("bookmarks from unknown peer are valid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const b = makeBookmark("unknown_peer", 0, 1)

      const delta = stage.step(insertDelta(b))

      expect(zsetSize(zsetPositive(delta))).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Authority grant enables previously-invalid constraints
  // -----------------------------------------------------------------------

  describe("authority grant enables previously-invalid", () => {
    it("grant enables single previously-invalid constraint", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      // Value first (invalid), then grant
      const d1 = stage.step(insertDelta(v))
      expect(zsetSize(d1)).toBe(0) // invalid

      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)
      const d2 = stage.step(insertDelta(grant))

      // Grant is valid (+1) AND bob's value is now valid (+1)
      expect(positiveKeys(d2).has(cnIdKey(grant.id))).toBe(true)
      expect(positiveKeys(d2).has(cnIdKey(v.id))).toBe(true)
      expect(stage.current().length).toBe(2)
    })

    it("grant enables multiple previously-invalid constraints from same peer", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v1 = makeValue("bob", 0, 1, target, "val1")
      const v2 = makeValue("bob", 1, 2, target, "val2")
      const s = makeStructure("bob", 2, 3)

      // All invalid first
      stage.step(insertDelta(v1))
      stage.step(insertDelta(v2))
      stage.step(insertDelta(s))
      expect(stage.current().length).toBe(0)

      // Grant admin — all become valid
      const grant = makeAuthority(CREATOR, 0, 4, "bob", "grant", ADMIN)
      const d = stage.step(insertDelta(grant))

      // Grant + v1 + v2 + s = 4
      expect(zsetSize(zsetPositive(d))).toBe(4)
      expect(stage.current().length).toBe(4)
    })

    it("grant for one peer does not affect another peer", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const bobVal = makeValue("bob", 0, 1, target, "bob")
      const charlieVal = makeValue("charlie", 0, 1, target, "charlie")

      stage.step(insertDelta(bobVal))
      stage.step(insertDelta(charlieVal))
      expect(stage.current().length).toBe(0)

      // Only grant to bob
      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)
      const d = stage.step(insertDelta(grant))

      // Grant + bob's value = 2
      expect(positiveKeys(d).has(cnIdKey(bobVal.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(charlieVal.id))).toBe(false)
      expect(stage.current().length).toBe(2)
    })

    it("partial capability grant: only matching constraints enabled", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      // Bob tries to write and create structure
      const v = makeValue("bob", 0, 1, target, "val")
      const s = makeStructure("bob", 1, 2)

      stage.step(insertDelta(v))
      stage.step(insertDelta(s))
      expect(stage.current().length).toBe(0)

      // Grant only write (not createNode)
      const grant = makeAuthority(CREATOR, 0, 3, "bob", "grant", WRITE_ANY)
      const d = stage.step(insertDelta(grant))

      // Only the value constraint becomes valid (write covers it)
      // The structure constraint needs createNode, still invalid
      expect(positiveKeys(d).has(cnIdKey(v.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(s.id))).toBe(false)
      // grant + v = 2
      expect(stage.current().length).toBe(2)
    })
  })

  // -----------------------------------------------------------------------
  // Authority revoke disables previously-valid constraints
  // -----------------------------------------------------------------------

  describe("authority revoke disables previously-valid", () => {
    it("revoke makes previously-valid constraint invalid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 2, target)

      stage.step(insertDelta(grant))
      stage.step(insertDelta(v))
      expect(stage.current().length).toBe(2)

      // Revoke
      const revoke = makeAuthority(CREATOR, 1, 3, "bob", "revoke", WRITE_ANY)
      const d = stage.step(insertDelta(revoke))

      // Revoke valid (+1) AND bob's value now invalid (−1)
      expect(positiveKeys(d).has(cnIdKey(revoke.id))).toBe(true)
      expect(negativeKeys(d).has(cnIdKey(v.id))).toBe(true)

      // grant + revoke remain valid, v is invalid
      expect(stage.current().length).toBe(2)
    })

    it("revoke of one capability does not affect other capabilities", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grantWrite = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const grantNode = makeAuthority(
        CREATOR,
        1,
        2,
        "bob",
        "grant",
        CREATE_NODE_ANY,
      )
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 3, target)
      const s = makeStructure("bob", 1, 4)

      stage.step(insertDelta(grantWrite))
      stage.step(insertDelta(grantNode))
      stage.step(insertDelta(v))
      stage.step(insertDelta(s))
      expect(stage.current().length).toBe(4)

      // Revoke write only
      const revoke = makeAuthority(CREATOR, 2, 5, "bob", "revoke", WRITE_ANY)
      const d = stage.step(insertDelta(revoke))

      // Value (write) becomes invalid, structure (createNode) stays valid
      expect(negativeKeys(d).has(cnIdKey(v.id))).toBe(true)
      expect(negativeKeys(d).has(cnIdKey(s.id))).toBe(false)
    })

    it("revoke disables multiple constraints from same peer", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const v1 = makeValue("bob", 0, 2, target, "val1")
      const v2 = makeValue("bob", 1, 3, target, "val2")

      stage.step(insertDelta(grant))
      stage.step(insertDelta(v1))
      stage.step(insertDelta(v2))
      expect(stage.current().length).toBe(3)

      const revoke = makeAuthority(CREATOR, 1, 4, "bob", "revoke", WRITE_ANY)
      const d = stage.step(insertDelta(revoke))

      expect(negativeKeys(d).has(cnIdKey(v1.id))).toBe(true)
      expect(negativeKeys(d).has(cnIdKey(v2.id))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Concurrent grant + revoke (revoke wins)
  // -----------------------------------------------------------------------

  describe("concurrent grant + revoke", () => {
    it("revoke wins at same lamport", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      // Grant and revoke at the same lamport — revoke wins
      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)
      const revoke = makeAuthority(CREATOR, 1, 2, "bob", "revoke", WRITE_ANY)

      stage.step(insertDelta(v))
      stage.step(insertDelta(grant))
      const _d = stage.step(insertDelta(revoke))

      // After revoke, bob's value should be invalid
      // The grant initially made v valid, revoke makes it invalid
      // The value should not be in current
      const validValueKeys = stage
        .current()
        .filter(c => c.type === "value")
        .map(c => cnIdKey(c.id))
      expect(validValueKeys.length).toBe(0)
    })

    it("revoke wins when grant and revoke in same delta", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      // Insert value first (invalid)
      stage.step(insertDelta(v))

      // Grant and revoke at same lamport, in same delta
      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)
      const revoke = makeAuthority(CREATOR, 1, 2, "bob", "revoke", WRITE_ANY)
      const batchDelta = deltaFromConstraints([grant, revoke])
      stage.step(batchDelta)

      // Revoke wins — bob still has no write
      const validValueKeys = stage
        .current()
        .filter(c => c.type === "value")
        .map(c => cnIdKey(c.id))
      expect(validValueKeys.length).toBe(0)
    })

    it("higher lamport wins over lower lamport", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      // Revoke at lamport 2, then grant at lamport 3 (grant wins)
      const revoke = makeAuthority(CREATOR, 0, 2, "bob", "revoke", WRITE_ANY)
      const grant = makeAuthority(CREATOR, 1, 3, "bob", "grant", WRITE_ANY)

      stage.step(insertDelta(v))
      stage.step(insertDelta(revoke))
      stage.step(insertDelta(grant))

      // Grant has higher lamport → bob has write
      const validValueKeys = stage
        .current()
        .filter(c => c.type === "value")
        .map(c => cnIdKey(c.id))
      expect(validValueKeys.length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Out-of-order: constraint before enabling grant
  // -----------------------------------------------------------------------

  describe("out-of-order arrival", () => {
    it("constraint before grant: constraint becomes valid on grant arrival", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      // Value arrives first (invalid)
      const d1 = stage.step(insertDelta(v))
      expect(zsetSize(d1)).toBe(0)
      expect(stage.current().length).toBe(0)

      // Grant arrives later
      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)
      const d2 = stage.step(insertDelta(grant))

      expect(positiveKeys(d2).has(cnIdKey(v.id))).toBe(true)
      expect(stage.current().length).toBe(2)
    })

    it("multiple constraints before grant: all become valid on grant", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v1 = makeValue("bob", 0, 1, target, "a")
      const v2 = makeValue("bob", 1, 2, target, "b")

      stage.step(insertDelta(v1))
      stage.step(insertDelta(v2))
      expect(stage.current().length).toBe(0)

      const grant = makeAuthority(CREATOR, 0, 3, "bob", "grant", WRITE_ANY)
      const d = stage.step(insertDelta(grant))

      expect(positiveKeys(d).has(cnIdKey(v1.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(v2.id))).toBe(true)
      expect(stage.current().length).toBe(3)
    })

    it("grant + constraint in same delta: constraint is valid", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)
      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)

      // Both in same delta
      const batchDelta = deltaFromConstraints([v, grant])
      const d = stage.step(batchDelta)

      // Both should be valid
      expect(positiveKeys(d).has(cnIdKey(v.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(grant.id))).toBe(true)
      expect(stage.current().length).toBe(2)
    })

    it("constraint before grant, then revoke: constraint becomes invalid again", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      stage.step(insertDelta(v)) // invalid
      const grant = makeAuthority(CREATOR, 0, 2, "bob", "grant", WRITE_ANY)
      stage.step(insertDelta(grant)) // v becomes valid
      expect(stage.current().length).toBe(2)

      const revoke = makeAuthority(CREATOR, 1, 3, "bob", "revoke", WRITE_ANY)
      const d = stage.step(insertDelta(revoke))

      expect(negativeKeys(d).has(cnIdKey(v.id))).toBe(true)
      // grant + revoke = valid, v = invalid
      expect(stage.current().length).toBe(2)
      expect(
        stage
          .current()
          .some(c => c.type === "value" && cnIdKey(c.id) === cnIdKey(v.id)),
      ).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // Removal (weight −1)
  // -----------------------------------------------------------------------

  describe("removal handling", () => {
    it("removal of valid non-authority constraint emits −1", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)

      stage.step(insertDelta(s))
      expect(stage.current().length).toBe(1)

      const d = stage.step(removalDelta(s))
      expect(negativeKeys(d).has(cnIdKey(s.id))).toBe(true)
      expect(stage.current().length).toBe(0)
    })

    it("removal of invalid constraint emits nothing", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)

      stage.step(insertDelta(v)) // invalid
      const d = stage.step(removalDelta(v))

      expect(zsetSize(d)).toBe(0)
      expect(stage.current().length).toBe(0)
    })

    it("removal of authority constraint triggers re-check", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 2, target)

      stage.step(insertDelta(grant))
      stage.step(insertDelta(v))
      expect(stage.current().length).toBe(2)

      // Remove the grant
      const d = stage.step(removalDelta(grant))

      // Grant removed (−1) and bob's value becomes invalid (−1)
      expect(negativeKeys(d).has(cnIdKey(grant.id))).toBe(true)
      expect(negativeKeys(d).has(cnIdKey(v.id))).toBe(true)
      expect(stage.current().length).toBe(0)
    })

    it("removal of non-existent constraint is no-op", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)

      const d = stage.step(removalDelta(s))
      expect(zsetSize(d)).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  describe("deduplication", () => {
    it("inserting the same constraint twice is a no-op", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)

      const d1 = stage.step(insertDelta(s))
      expect(zsetSize(zsetPositive(d1))).toBe(1)

      const d2 = stage.step(insertDelta(s))
      expect(zsetSize(d2)).toBe(0)
      expect(stage.current().length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe("reset", () => {
    it("reset clears all state", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)

      stage.step(insertDelta(s))
      expect(stage.current().length).toBe(1)

      stage.reset()
      expect(stage.current().length).toBe(0)
    })

    it("reset allows reuse", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)

      stage.step(insertDelta(s))
      stage.reset()

      const d = stage.step(insertDelta(s))
      expect(zsetSize(zsetPositive(d))).toBe(1)
      expect(stage.current().length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Empty delta
  // -----------------------------------------------------------------------

  describe("empty delta", () => {
    it("empty delta produces empty output", () => {
      const stage = createIncrementalValidity(CREATOR)

      const d = stage.step(zsetEmpty())
      expect(zsetSize(d)).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Transitive authority cascade
  // -----------------------------------------------------------------------

  describe("transitive authority cascade", () => {
    it("revoking authority from peer A invalidates grants A made", () => {
      const stage = createIncrementalValidity(CREATOR)

      // Alice grants Admin to Bob
      const grantBob = makeAuthority(CREATOR, 0, 1, "bob", "grant", ADMIN)
      stage.step(insertDelta(grantBob))

      // Bob grants write to Charlie (valid because Bob has Admin)
      const authCap: Capability = { kind: "authority", capability: WRITE_ANY }
      const grantBobAuth = makeAuthority(CREATOR, 1, 2, "bob", "grant", authCap)
      stage.step(insertDelta(grantBobAuth))

      const grantCharlie = makeAuthority(
        "bob",
        0,
        3,
        "charlie",
        "grant",
        WRITE_ANY,
      )
      stage.step(insertDelta(grantCharlie))

      // Charlie creates a value (valid because Charlie has write via Bob's grant)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("charlie", 0, 4, target)
      stage.step(insertDelta(v))
      expect(
        stage
          .current()
          .some(c => c.type === "value" && cnIdKey(c.id) === cnIdKey(v.id)),
      ).toBe(true)

      // Alice revokes Admin from Bob
      const revokeBob = makeAuthority(CREATOR, 2, 5, "bob", "revoke", ADMIN)
      const _d = stage.step(insertDelta(revokeBob))

      // Now do a differential check to see that the incremental result
      // matches the batch. The batch pipeline replays all authority
      // constraints from scratch, which catches transitive cascades.
      const allConstraints = [
        grantBob,
        grantBobAuth,
        grantCharlie,
        v,
        revokeBob,
      ]
      const batchValid = batchValidKeys(allConstraints)
      const incrementalValid = currentKeys(stage)
      expect(incrementalValid).toEqual(batchValid)
    })
  })

  // -----------------------------------------------------------------------
  // Mixed constraint types in same delta
  // -----------------------------------------------------------------------

  describe("mixed constraint types in same delta", () => {
    it("authority + value + structure in same delta", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", ADMIN)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 2, target)
      const s = makeStructure("bob", 1, 3)

      const batch = deltaFromConstraints([grant, v, s])
      const d = stage.step(batch)

      // All three should be valid
      expect(positiveKeys(d).has(cnIdKey(grant.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(v.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(s.id))).toBe(true)
      expect(stage.current().length).toBe(3)
    })

    it("creator + non-creator constraints in same delta", () => {
      const stage = createIncrementalValidity(CREATOR)
      const aliceStruct = makeStructure(CREATOR, 0, 0)
      const bobStruct = makeStructure("bob", 0, 1)

      const batch = deltaFromConstraints([aliceStruct, bobStruct])
      const d = stage.step(batch)

      // Alice's is valid (creator), Bob's is invalid (no capability)
      expect(positiveKeys(d).has(cnIdKey(aliceStruct.id))).toBe(true)
      expect(positiveKeys(d).has(cnIdKey(bobStruct.id))).toBe(false)
      expect(stage.current().length).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // Differential equivalence with batch
  // -----------------------------------------------------------------------

  describe("differential equivalence", () => {
    it("matches batch after single insertion", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)
      const all = [s]

      stage.step(insertDelta(s))

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("matches batch after grant + value", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 2, target)
      const all = [grant, v]

      stage.step(insertDelta(grant))
      stage.step(insertDelta(v))

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("matches batch after grant + revoke", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 2, target)
      const revoke = makeAuthority(CREATOR, 1, 3, "bob", "revoke", WRITE_ANY)
      const all = [grant, v, revoke]

      stage.step(insertDelta(grant))
      stage.step(insertDelta(v))
      stage.step(insertDelta(revoke))

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("matches batch with unauthorized peer", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)
      const v = makeValue("bob", 0, 1, target)
      const all = [v]

      stage.step(insertDelta(v))

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("matches batch with mixed valid/invalid constraints", () => {
      const stage = createIncrementalValidity(CREATOR)
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const target = createCnId(CREATOR, 10)
      const bobVal = makeValue("bob", 0, 2, target)
      const charlieVal = makeValue("charlie", 0, 3, target)
      const aliceStruct = makeStructure(CREATOR, 1, 4)
      const bookmark = makeBookmark("dave", 0, 5)
      const all = [grant, bobVal, charlieVal, aliceStruct, bookmark]

      for (const c of all) {
        stage.step(insertDelta(c))
      }

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("matches batch with complex multi-step scenario", () => {
      const stage = createIncrementalValidity(CREATOR)
      const all: Constraint[] = []

      // Step 1: Creator creates structure
      const s = makeStructure(CREATOR, 0, 0)
      all.push(s)
      stage.step(insertDelta(s))

      // Step 2: Bob tries to write (invalid)
      const target = createCnId(CREATOR, 10)
      const v1 = makeValue("bob", 0, 1, target, "hello")
      all.push(v1)
      stage.step(insertDelta(v1))

      // Step 3: Creator grants write to bob
      const grant = makeAuthority(CREATOR, 1, 2, "bob", "grant", WRITE_ANY)
      all.push(grant)
      stage.step(insertDelta(grant))

      // Step 4: Bob writes again (valid)
      const v2 = makeValue("bob", 1, 3, target, "world")
      all.push(v2)
      stage.step(insertDelta(v2))

      // Step 5: Creator revokes write from bob
      const revoke = makeAuthority(CREATOR, 2, 4, "bob", "revoke", WRITE_ANY)
      all.push(revoke)
      stage.step(insertDelta(revoke))

      // Step 6: Bob tries again (invalid)
      const v3 = makeValue("bob", 2, 5, target, "!")
      all.push(v3)
      stage.step(insertDelta(v3))

      // Step 7: Bookmark (always valid)
      const bk = makeBookmark("charlie", 0, 6)
      all.push(bk)
      stage.step(insertDelta(bk))

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("matches batch regardless of insertion order (all permutations of 4)", () => {
      const target = createCnId(CREATOR, 10)
      const constraints: Constraint[] = [
        makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY),
        makeValue("bob", 0, 2, target, "val"),
        makeStructure(CREATOR, 1, 3),
        makeBookmark("bob", 1, 4),
      ]

      // Compute expected from batch (order doesn't matter for batch)
      const expected = batchValidKeys(constraints)

      // Test all 24 permutations
      const permutations = allPermutations(constraints)
      expect(permutations.length).toBe(24)

      for (const perm of permutations) {
        const stage = createIncrementalValidity(CREATOR)
        for (const c of perm) {
          stage.step(insertDelta(c))
        }
        expect(currentKeys(stage)).toEqual(expected)
      }
    })

    it("matches batch regardless of order with authority cascade", () => {
      const target = createCnId(CREATOR, 10)
      const constraints: Constraint[] = [
        makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY),
        makeAuthority(CREATOR, 1, 3, "bob", "revoke", WRITE_ANY),
        makeValue("bob", 0, 2, target, "val"),
        makeStructure(CREATOR, 2, 4),
      ]

      const expected = batchValidKeys(constraints)
      const permutations = allPermutations(constraints)

      for (const perm of permutations) {
        const stage = createIncrementalValidity(CREATOR)
        for (const c of perm) {
          stage.step(insertDelta(c))
        }
        expect(currentKeys(stage)).toEqual(expected)
      }
    })

    it("matches batch regardless of order with grant+bookmark+value (5 constraints)", () => {
      const target = createCnId(CREATOR, 10)
      const constraints: Constraint[] = [
        makeAuthority(CREATOR, 0, 1, "bob", "grant", ADMIN),
        makeValue("bob", 0, 2, target, "val"),
        makeStructure("bob", 1, 3),
        makeRetract("bob", 2, 4, target),
        makeBookmark("charlie", 0, 5),
      ]

      const expected = batchValidKeys(constraints)
      const permutations = allPermutations(constraints)
      // 120 permutations for 5 elements
      expect(permutations.length).toBe(120)

      for (const perm of permutations) {
        const stage = createIncrementalValidity(CREATOR)
        for (const c of perm) {
          stage.step(insertDelta(c))
        }
        expect(currentKeys(stage)).toEqual(expected)
      }
    })
  })

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("authority constraint from non-creator without authority capability is invalid", () => {
      const stage = createIncrementalValidity(CREATOR)
      // Bob tries to grant capability to Charlie without having Authority capability
      const a = makeAuthority("bob", 0, 1, "charlie", "grant", WRITE_ANY)

      const d = stage.step(insertDelta(a))
      expect(zsetSize(d)).toBe(0)
    })

    it("authority constraint self-referencing does not cause infinite loop", () => {
      const stage = createIncrementalValidity(CREATOR)
      // Alice grants Authority(Write) to Bob
      const authCap: Capability = { kind: "authority", capability: WRITE_ANY }
      const grant = makeAuthority(CREATOR, 0, 1, "bob", "grant", authCap)

      const d = stage.step(insertDelta(grant))
      expect(zsetSize(zsetPositive(d))).toBe(1)
    })

    it("many peers, many capabilities", () => {
      const stage = createIncrementalValidity(CREATOR)
      const all: Constraint[] = []

      // Grant various capabilities to multiple peers
      const peers = ["bob", "charlie", "dave", "eve"]
      const caps: Capability[] = [WRITE_ANY, CREATE_NODE_ANY, RETRACT_ANY]
      let counter = 0

      for (const peer of peers) {
        for (const cap of caps) {
          const grant = makeAuthority(
            CREATOR,
            counter++,
            counter,
            peer,
            "grant",
            cap,
          )
          all.push(grant)
          stage.step(insertDelta(grant))
        }
      }

      // Each peer creates constraints
      const target = createCnId(CREATOR, 99)
      for (const peer of peers) {
        const v = makeValue(peer, 0, counter + 1, target, `${peer}-val`)
        const s = makeStructure(peer, 1, counter + 2)
        all.push(v, s)
        stage.step(insertDelta(v))
        stage.step(insertDelta(s))
      }

      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("grant then re-grant at higher lamport is idempotent", () => {
      const stage = createIncrementalValidity(CREATOR)
      const target = createCnId(CREATOR, 10)

      const grant1 = makeAuthority(CREATOR, 0, 1, "bob", "grant", WRITE_ANY)
      const v = makeValue("bob", 0, 2, target)
      const grant2 = makeAuthority(CREATOR, 1, 3, "bob", "grant", WRITE_ANY)

      stage.step(insertDelta(grant1))
      stage.step(insertDelta(v))
      expect(stage.current().length).toBe(2)

      // Second grant should not change anything
      const _d = stage.step(insertDelta(grant2))
      // Bob's value should still be valid
      expect(
        stage
          .current()
          .some(c => c.type === "value" && cnIdKey(c.id) === cnIdKey(v.id)),
      ).toBe(true)

      // Batch check
      const all = [grant1, v, grant2]
      expect(currentKeys(stage)).toEqual(batchValidKeys(all))
    })

    it("creator constraints valid even when no authority constraints exist", () => {
      const stage = createIncrementalValidity(CREATOR)
      const s = makeStructure(CREATOR, 0, 0)
      const target = s.id
      const v = makeValue(CREATOR, 1, 1, target)

      stage.step(insertDelta(s))
      stage.step(insertDelta(v))

      expect(stage.current().length).toBe(2)
    })
  })
})

// ---------------------------------------------------------------------------
// Permutation helper
// ---------------------------------------------------------------------------

/**
 * Generate all permutations of an array.
 * Warning: O(n!) — only use for small arrays (≤ 7 elements).
 */
function allPermutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr]

  const result: T[][] = []

  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)]
    const subPerms = allPermutations(rest)
    for (const perm of subPerms) {
      result.push([arr[i]!, ...perm])
    }
  }

  return result
}
