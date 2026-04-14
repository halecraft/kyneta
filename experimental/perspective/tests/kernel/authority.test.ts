// === Authority Tests ===
// Tests for authority chain replay, capability computation,
// revoke-wins semantics, and capability containment.

import { describe, expect, it } from "vitest"
import { atom, positiveAtom, varTerm } from "../../src/datalog/types.js"
import { createAgent } from "../../src/kernel/agent.js"
import {
  capabilityCovers,
  capabilityEquals,
  capabilityKey,
  computeAuthority,
  getCapabilities,
  hasCapability,
  requiredCapability,
} from "../../src/kernel/authority.js"
import { createCnId } from "../../src/kernel/cnid.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import type {
  AuthorityConstraint,
  Capability,
  Constraint,
  PeerID,
} from "../../src/kernel/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuthorityConstraint(
  peer: PeerID,
  counter: number,
  lamport: number,
  targetPeer: PeerID,
  action: "grant" | "revoke",
  capability: Capability,
  refs: { peer: PeerID; counter: number }[] = [],
): AuthorityConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs: refs.map(r => createCnId(r.peer, r.counter)),
    sig: STUB_SIGNATURE,
    type: "authority",
    payload: { targetPeer, action, capability },
  }
}

const WRITE_PROFILE: Capability = { kind: "write", pathPattern: ["profile"] }
const WRITE_TODOS: Capability = { kind: "write", pathPattern: ["todos"] }
const CREATE_NODE_PROFILE: Capability = {
  kind: "createNode",
  pathPattern: ["profile"],
}
const RETRACT_OWN: Capability = { kind: "retract", scope: { kind: "own" } }
const RETRACT_ANY: Capability = { kind: "retract", scope: { kind: "any" } }
const CREATE_RULE_2: Capability = { kind: "createRule", minLayer: 2 }
const CREATE_RULE_3: Capability = { kind: "createRule", minLayer: 3 }
const ADMIN: Capability = { kind: "admin" }
const AUTHORITY_WRITE_PROFILE: Capability = {
  kind: "authority",
  capability: WRITE_PROFILE,
}

// ---------------------------------------------------------------------------
// capabilityEquals
// ---------------------------------------------------------------------------

describe("capabilityEquals", () => {
  it("admin equals admin", () => {
    expect(capabilityEquals({ kind: "admin" }, { kind: "admin" })).toBe(true)
  })

  it("write with same path", () => {
    expect(
      capabilityEquals(WRITE_PROFILE, {
        kind: "write",
        pathPattern: ["profile"],
      }),
    ).toBe(true)
  })

  it("write with different path", () => {
    expect(capabilityEquals(WRITE_PROFILE, WRITE_TODOS)).toBe(false)
  })

  it("different kinds are not equal", () => {
    expect(capabilityEquals(WRITE_PROFILE, CREATE_NODE_PROFILE)).toBe(false)
    expect(capabilityEquals(ADMIN, WRITE_PROFILE)).toBe(false)
  })

  it("retract scopes compared correctly", () => {
    expect(capabilityEquals(RETRACT_OWN, RETRACT_OWN)).toBe(true)
    expect(capabilityEquals(RETRACT_OWN, RETRACT_ANY)).toBe(false)
    expect(capabilityEquals(RETRACT_ANY, RETRACT_ANY)).toBe(true)

    const byPath1: Capability = {
      kind: "retract",
      scope: { kind: "byPath", pattern: ["a"] },
    }
    const byPath2: Capability = {
      kind: "retract",
      scope: { kind: "byPath", pattern: ["a"] },
    }
    const byPath3: Capability = {
      kind: "retract",
      scope: { kind: "byPath", pattern: ["b"] },
    }
    expect(capabilityEquals(byPath1, byPath2)).toBe(true)
    expect(capabilityEquals(byPath1, byPath3)).toBe(false)
  })

  it("createRule compared by minLayer", () => {
    expect(capabilityEquals(CREATE_RULE_2, CREATE_RULE_2)).toBe(true)
    expect(capabilityEquals(CREATE_RULE_2, CREATE_RULE_3)).toBe(false)
  })

  it("authority compared recursively", () => {
    const a1: Capability = { kind: "authority", capability: WRITE_PROFILE }
    const a2: Capability = { kind: "authority", capability: WRITE_PROFILE }
    const a3: Capability = { kind: "authority", capability: WRITE_TODOS }
    expect(capabilityEquals(a1, a2)).toBe(true)
    expect(capabilityEquals(a1, a3)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// capabilityKey
// ---------------------------------------------------------------------------

describe("capabilityKey", () => {
  it("produces unique keys for different capabilities", () => {
    const keys = new Set([
      capabilityKey(ADMIN),
      capabilityKey(WRITE_PROFILE),
      capabilityKey(WRITE_TODOS),
      capabilityKey(CREATE_NODE_PROFILE),
      capabilityKey(RETRACT_OWN),
      capabilityKey(RETRACT_ANY),
      capabilityKey(CREATE_RULE_2),
      capabilityKey(CREATE_RULE_3),
      capabilityKey(AUTHORITY_WRITE_PROFILE),
    ])
    expect(keys.size).toBe(9)
  })

  it("produces same key for equal capabilities", () => {
    expect(capabilityKey(WRITE_PROFILE)).toBe(
      capabilityKey({ kind: "write", pathPattern: ["profile"] }),
    )
  })
})

// ---------------------------------------------------------------------------
// capabilityCovers
// ---------------------------------------------------------------------------

describe("capabilityCovers", () => {
  it("admin covers everything", () => {
    expect(capabilityCovers(ADMIN, WRITE_PROFILE)).toBe(true)
    expect(capabilityCovers(ADMIN, RETRACT_ANY)).toBe(true)
    expect(capabilityCovers(ADMIN, CREATE_RULE_2)).toBe(true)
    expect(capabilityCovers(ADMIN, ADMIN)).toBe(true)
    expect(capabilityCovers(ADMIN, AUTHORITY_WRITE_PROFILE)).toBe(true)
  })

  it("write covers same path", () => {
    expect(capabilityCovers(WRITE_PROFILE, WRITE_PROFILE)).toBe(true)
  })

  it("write does not cover different path", () => {
    expect(capabilityCovers(WRITE_PROFILE, WRITE_TODOS)).toBe(false)
  })

  it("write does not cover different kind", () => {
    expect(capabilityCovers(WRITE_PROFILE, CREATE_NODE_PROFILE)).toBe(false)
  })

  it("retract(any) covers retract(own)", () => {
    expect(capabilityCovers(RETRACT_ANY, RETRACT_OWN)).toBe(true)
  })

  it("retract(own) does not cover retract(any)", () => {
    expect(capabilityCovers(RETRACT_OWN, RETRACT_ANY)).toBe(false)
  })

  it("retract(own) covers retract(own)", () => {
    expect(capabilityCovers(RETRACT_OWN, RETRACT_OWN)).toBe(true)
  })

  it("createRule lower minLayer covers higher", () => {
    expect(capabilityCovers(CREATE_RULE_2, CREATE_RULE_3)).toBe(true)
    expect(capabilityCovers(CREATE_RULE_2, CREATE_RULE_2)).toBe(true)
  })

  it("createRule higher minLayer does not cover lower", () => {
    expect(capabilityCovers(CREATE_RULE_3, CREATE_RULE_2)).toBe(false)
  })

  it("authority(C) covers authority(C) for same C", () => {
    const held: Capability = { kind: "authority", capability: WRITE_PROFILE }
    const required: Capability = {
      kind: "authority",
      capability: WRITE_PROFILE,
    }
    expect(capabilityCovers(held, required)).toBe(true)
  })

  it("authority(C) does not cover authority(D) for different C,D", () => {
    const held: Capability = { kind: "authority", capability: WRITE_PROFILE }
    const required: Capability = { kind: "authority", capability: WRITE_TODOS }
    expect(capabilityCovers(held, required)).toBe(false)
  })

  it("non-admin does not cover admin", () => {
    expect(capabilityCovers(WRITE_PROFILE, ADMIN)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeAuthority / hasCapability / getCapabilities
// ---------------------------------------------------------------------------

describe("computeAuthority", () => {
  it("creator has Admin by default", () => {
    const state = computeAuthority([], "alice")
    expect(hasCapability(state, "alice", ADMIN)).toBe(true)
    expect(hasCapability(state, "alice", WRITE_PROFILE)).toBe(true) // Admin covers
  })

  it("non-creator has no capabilities by default", () => {
    const state = computeAuthority([], "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(false)
    expect(hasCapability(state, "bob", ADMIN)).toBe(false)
  })

  it("grant propagates capability to target peer", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
  })

  it("revoke removes capability", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 1, 2, "bob", "revoke", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(false)
  })

  it("grant after revoke restores capability", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 1, 2, "bob", "revoke", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 2, 3, "bob", "grant", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
  })

  it("revoke-wins on concurrent grant and revoke (same lamport)", () => {
    // Alice grants, carol revokes — both at lamport 1 (concurrent)
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("carol", 0, 1, "bob", "revoke", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(false)
  })

  it("higher lamport wins over lower lamport", () => {
    // Alice revokes at lamport 1, carol grants at lamport 2
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "revoke", WRITE_PROFILE),
      makeAuthorityConstraint("carol", 0, 2, "bob", "grant", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
  })

  it("revoke-wins when both at same max lamport", () => {
    // Three events: grant at L1, grant at L3, revoke at L3
    // At L3, there's a grant and a revoke → revoke wins
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("carol", 0, 3, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("dave", 0, 3, "bob", "revoke", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(false)
  })

  it("multiple capabilities for same peer are independent", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 1, 2, "bob", "grant", WRITE_TODOS),
      makeAuthorityConstraint("alice", 2, 3, "bob", "revoke", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(false)
    expect(hasCapability(state, "bob", WRITE_TODOS)).toBe(true)
  })

  it("capabilities for different peers are independent", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 1, 2, "carol", "grant", WRITE_TODOS),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
    expect(hasCapability(state, "bob", WRITE_TODOS)).toBe(false)
    expect(hasCapability(state, "carol", WRITE_PROFILE)).toBe(false)
    expect(hasCapability(state, "carol", WRITE_TODOS)).toBe(true)
  })

  it("non-authority constraints are ignored", () => {
    const agent = createAgent("alice")
    const valueConstraint = agent.produceValue(createCnId("alice", 99), "hello")

    const constraints: Constraint[] = [
      valueConstraint,
      makeAuthorityConstraint("alice", 5, 10, "bob", "grant", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
  })

  it("version-parameterized: only considers constraints visible at V", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 1, 2, "bob", "grant", WRITE_TODOS),
    ]

    // Version that only includes alice@0 (not alice@1)
    const version = new Map<string, number>([["alice", 1]]) // seen 0..0

    const state = computeAuthority(constraints, "alice", version)
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
    expect(hasCapability(state, "bob", WRITE_TODOS)).toBe(false)
  })

  it("empty constraints: only creator has Admin", () => {
    const state = computeAuthority([], "alice")
    const caps = getCapabilities(state, "alice")
    expect(caps).toEqual([{ kind: "admin" }])
    expect(getCapabilities(state, "bob")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getCapabilities
// ---------------------------------------------------------------------------

describe("getCapabilities", () => {
  it("returns Admin for creator", () => {
    const state = computeAuthority([], "alice")
    const caps = getCapabilities(state, "alice")
    expect(caps).toEqual([{ kind: "admin" }])
  })

  it("returns granted capabilities for non-creator", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
      makeAuthorityConstraint("alice", 1, 2, "bob", "grant", RETRACT_OWN),
    ]

    const state = computeAuthority(constraints, "alice")
    const caps = getCapabilities(state, "bob")
    expect(caps.length).toBe(2)
    expect(caps.some(c => c.kind === "write")).toBe(true)
    expect(caps.some(c => c.kind === "retract")).toBe(true)
  })

  it("returns empty for peer with no grants", () => {
    const state = computeAuthority([], "alice")
    expect(getCapabilities(state, "bob")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// requiredCapability
// ---------------------------------------------------------------------------

describe("requiredCapability", () => {
  it("structure requires createNode", () => {
    const agent = createAgent("alice")
    const c = agent.produceStructure({
      kind: "root",
      containerId: "test",
      policy: "map",
    })
    const cap = requiredCapability(c)
    expect(cap).not.toBeNull()
    expect(cap?.kind).toBe("createNode")
  })

  it("value requires write", () => {
    const agent = createAgent("alice")
    const c = agent.produceValue(createCnId("alice", 0), "hello")
    const cap = requiredCapability(c)
    expect(cap).not.toBeNull()
    expect(cap?.kind).toBe("write")
  })

  it("retract requires retract capability", () => {
    const agent = createAgent("alice")
    const c = agent.produceRetract(createCnId("alice", 0))
    const cap = requiredCapability(c)
    expect(cap).not.toBeNull()
    expect(cap?.kind).toBe("retract")
  })

  it("rule requires createRule", () => {
    const agent = createAgent("alice")
    const c = agent.produceRule(2, atom("test", [varTerm("X")]), [
      positiveAtom(atom("src", [varTerm("X")])),
    ])
    const cap = requiredCapability(c)
    expect(cap).not.toBeNull()
    expect(cap?.kind).toBe("createRule")
    if (cap?.kind === "createRule") {
      expect(cap?.minLayer).toBe(2)
    }
  })

  it("authority requires authority(C)", () => {
    const agent = createAgent("alice")
    const c = agent.produceAuthority("bob", "grant", WRITE_PROFILE)
    const cap = requiredCapability(c)
    expect(cap).not.toBeNull()
    expect(cap?.kind).toBe("authority")
    if (cap?.kind === "authority") {
      expect(capabilityEquals(cap?.capability, WRITE_PROFILE)).toBe(true)
    }
  })

  it("bookmark requires no capability", () => {
    const agent = createAgent("alice")
    const c = agent.produceBookmark("snap1", new Map())
    const cap = requiredCapability(c)
    expect(cap).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Capability attenuation
// ---------------------------------------------------------------------------

describe("capability attenuation", () => {
  it("admin holder can grant anything", () => {
    // Creator (admin) grants write to bob
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    // Alice (creator) has admin → can grant WRITE_PROFILE
    expect(
      hasCapability(state, "alice", {
        kind: "authority",
        capability: WRITE_PROFILE,
      }),
    ).toBe(true)
    expect(hasCapability(state, "bob", WRITE_PROFILE)).toBe(true)
  })

  it("non-admin cannot escalate to admin", () => {
    // Alice grants write to bob. Bob should not be able to claim admin.
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", WRITE_PROFILE),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", ADMIN)).toBe(false)
  })

  it("retract(own) cannot cover retract(any)", () => {
    const constraints: Constraint[] = [
      makeAuthorityConstraint("alice", 0, 1, "bob", "grant", RETRACT_OWN),
    ]

    const state = computeAuthority(constraints, "alice")
    expect(hasCapability(state, "bob", RETRACT_OWN)).toBe(true)
    expect(hasCapability(state, "bob", RETRACT_ANY)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("authority determinism", () => {
  it("same constraints produce same result regardless of insertion order", () => {
    const c1 = makeAuthorityConstraint(
      "alice",
      0,
      1,
      "bob",
      "grant",
      WRITE_PROFILE,
    )
    const c2 = makeAuthorityConstraint(
      "alice",
      1,
      2,
      "bob",
      "grant",
      WRITE_TODOS,
    )
    const c3 = makeAuthorityConstraint(
      "carol",
      0,
      2,
      "bob",
      "revoke",
      WRITE_PROFILE,
    )

    const state1 = computeAuthority([c1, c2, c3], "alice")
    const state2 = computeAuthority([c3, c1, c2], "alice")
    const state3 = computeAuthority([c2, c3, c1], "alice")

    // Bob should have WRITE_TODOS but not WRITE_PROFILE in all orderings
    expect(hasCapability(state1, "bob", WRITE_TODOS)).toBe(true)
    expect(hasCapability(state1, "bob", WRITE_PROFILE)).toBe(false)
    expect(hasCapability(state2, "bob", WRITE_TODOS)).toBe(true)
    expect(hasCapability(state2, "bob", WRITE_PROFILE)).toBe(false)
    expect(hasCapability(state3, "bob", WRITE_TODOS)).toBe(true)
    expect(hasCapability(state3, "bob", WRITE_PROFILE)).toBe(false)
  })
})
