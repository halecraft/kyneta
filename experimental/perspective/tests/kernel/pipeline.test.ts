// === Pipeline Tests ===
// End-to-end tests for the solver pipeline: Store → Reality.
// Tests cover simple map, simple sequence, nested containers,
// retraction effects, version-parameterized solving, and
// native solver equivalence.

import { describe, expect, it } from "vitest"
import {
  createAgent,
  produceMapChild,
  produceRoot,
} from "../../src/kernel/agent.js"
import { createCnId } from "../../src/kernel/cnid.js"
import {
  type PipelineConfig,
  solve,
  solveFull,
} from "../../src/kernel/pipeline.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import {
  type ConstraintStore,
  createStore,
  insert,
  insertMany,
} from "../../src/kernel/store.js"
import type {
  AuthorityConstraint,
  CnId,
  Constraint,
  PeerID,
  Reality,
  RealityNode,
  RetractConstraint,
  StructureConstraint,
  Value,
  ValueConstraint,
} from "../../src/kernel/types.js"
import { vvFromObject } from "../../src/kernel/version-vector.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStructureRoot(
  peer: PeerID,
  counter: number,
  containerId: string,
  policy: "map" | "seq" = "map",
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "root", containerId, policy },
  }
}

function makeStructureMap(
  peer: PeerID,
  counter: number,
  parent: CnId,
  key: string,
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "map", parent, key },
  }
}

function makeStructureSeq(
  peer: PeerID,
  counter: number,
  parent: CnId,
  originLeft: CnId | null,
  originRight: CnId | null,
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "seq", parent, originLeft, originRight },
  }
}

function makeValue(
  peer: PeerID,
  counter: number,
  target: CnId,
  content: Value,
  lamport?: number,
): ValueConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "value",
    payload: { target, content },
  }
}

function makeRetract(
  peer: PeerID,
  counter: number,
  target: CnId,
  lamport?: number,
  refs?: CnId[],
): RetractConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: refs ?? [target],
    sig: STUB_SIGNATURE,
    type: "retract",
    payload: { target },
  }
}

/**
 * Grant Admin capability from the creator to another peer.
 * This is needed because the validity filter checks capabilities —
 * only the creator has implicit Admin, other peers need explicit grants.
 */
function grantAdmin(
  creator: PeerID,
  creatorCounter: number,
  targetPeer: PeerID,
  lamport?: number,
): AuthorityConstraint {
  return {
    id: createCnId(creator, creatorCounter),
    lamport: lamport ?? creatorCounter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "authority",
    payload: {
      targetPeer,
      action: "grant",
      capability: { kind: "admin" },
    },
  }
}

function buildStore(constraints: Constraint[]): ConstraintStore {
  const store = createStore()
  const result = insertMany(store, constraints)
  if (!result.ok)
    throw new Error(`insertMany failed: ${JSON.stringify(result.error)}`)
  return store
}

const DEFAULT_CONFIG: PipelineConfig = {
  creator: "alice",
  enableDatalogEvaluation: true, // Match production default: Datalog is primary
}

const NATIVE_ONLY_CONFIG: PipelineConfig = {
  creator: "alice",
  enableDatalogEvaluation: false, // Explicit native-only for bypass testing
}

/** Get all child keys of a reality node. */
function childKeys(node: RealityNode): string[] {
  return Array.from(node.children.keys())
}

/** Get a child node by key path from the reality root. */
function getNode(reality: Reality, ...path: string[]): RealityNode | undefined {
  let current: RealityNode | undefined = reality.root
  for (const key of path) {
    if (current === undefined) return undefined
    current = current.children.get(key)
  }
  return current
}

// ---------------------------------------------------------------------------
// Simple Map
// ---------------------------------------------------------------------------

describe("pipeline: simple map", () => {
  it("single map container with one key-value pair", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice", 3)

    const store = buildStore([root, child, val])
    const reality = solve(store, DEFAULT_CONFIG)

    // Reality root contains the "profile" container
    const profile = getNode(reality, "profile")
    expect(profile).toBeDefined()
    expect(profile?.policy).toBe("map")

    // "profile" has a "name" child with value "Alice"
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Alice")
  })

  it("map with multiple keys", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const title = makeStructureMap("alice", 1, root.id, "title")
    const body = makeStructureMap("alice", 2, root.id, "body")
    const valTitle = makeValue("alice", 3, title.id, "Hello", 4)
    const valBody = makeValue("alice", 4, body.id, "World", 5)

    const store = buildStore([root, title, body, valTitle, valBody])
    const reality = solve(store, DEFAULT_CONFIG)

    expect(getNode(reality, "profile", "title")?.value).toBe("Hello")
    expect(getNode(reality, "profile", "body")?.value).toBe("World")
  })

  it("concurrent writes to same key resolved by LWW (higher lamport wins)", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grant = grantAdmin("alice", 2, "bob")

    // Alice writes "Alice" at lamport 3, Bob writes "Bob" at lamport 5
    const val1 = makeValue("alice", 3, child.id, "Alice", 3)
    const val2 = makeValue("bob", 2, child.id, "Bob", 5)

    const store = buildStore([root, child, grant, val1, val2])
    const reality = solve(store, DEFAULT_CONFIG)

    // Bob wins (higher lamport)
    expect(getNode(reality, "profile", "name")?.value).toBe("Bob")
  })

  it("concurrent writes with same lamport resolved by peer tiebreak", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grant = grantAdmin("alice", 2, "bob")

    // Both at lamport 5, "bob" > "alice" lexicographically
    const val1 = makeValue("alice", 3, child.id, "Alice", 5)
    const val2 = makeValue("bob", 2, child.id, "Bob", 5)

    const store = buildStore([root, child, grant, val1, val2])
    const reality = solve(store, DEFAULT_CONFIG)

    // Bob wins (greater peer ID)
    expect(getNode(reality, "profile", "name")?.value).toBe("Bob")
  })

  it("concurrent map structure creation: both peers write to same logical slot", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const grant = grantAdmin("alice", 1, "bob")

    // Alice and Bob independently create structure for key="name"
    const aliceName = makeStructureMap("alice", 2, root.id, "name")
    const bobName = makeStructureMap("bob", 1, root.id, "name")

    // Each writes a value targeting their own structure
    const aliceVal = makeValue("alice", 3, aliceName.id, "Alice", 3)
    const bobVal = makeValue("bob", 2, bobName.id, "Bob", 5)

    const store = buildStore([
      root,
      grant,
      aliceName,
      bobName,
      aliceVal,
      bobVal,
    ])
    const reality = solve(store, DEFAULT_CONFIG)

    // Bob wins (higher lamport), even though they targeted different structure CnIds
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Bob")
  })

  it("null value deletes a map key", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")

    const val1 = makeValue("alice", 2, child.id, "Alice", 3)
    const val2 = makeValue("alice", 3, child.id, null, 5) // Deletion

    const store = buildStore([root, child, val1, val2])
    const reality = solve(store, DEFAULT_CONFIG)

    // "name" should not appear (null won via LWW and no sub-children)
    const profile = getNode(reality, "profile")
    expect(profile).toBeDefined()
    expect(profile?.children.has("name")).toBe(false)
  })

  it("map key with no value constraints has undefined value", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")

    const store = buildStore([root, child])
    const reality = solve(store, DEFAULT_CONFIG)

    // The "name" node exists but has no value
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Simple Sequence
// ---------------------------------------------------------------------------

describe("pipeline: simple sequence", () => {
  it("single seq container with ordered elements", () => {
    const root = makeStructureRoot("alice", 0, "todos", "seq")
    const e1 = makeStructureSeq("alice", 1, root.id, null, null)
    const e2 = makeStructureSeq("alice", 2, root.id, e1.id, null)
    const e3 = makeStructureSeq("alice", 3, root.id, e2.id, null)

    const v1 = makeValue("alice", 4, e1.id, "Buy milk", 5)
    const v2 = makeValue("alice", 5, e2.id, "Walk dog", 6)
    const v3 = makeValue("alice", 6, e3.id, "Read book", 7)

    const store = buildStore([root, e1, e2, e3, v1, v2, v3])
    const reality = solve(store, DEFAULT_CONFIG)

    const todos = getNode(reality, "todos")
    expect(todos).toBeDefined()
    expect(todos?.policy).toBe("seq")

    const keys = childKeys(todos!)
    expect(keys).toEqual(["0", "1", "2"])

    expect(todos?.children.get("0")?.value).toBe("Buy milk")
    expect(todos?.children.get("1")?.value).toBe("Walk dog")
    expect(todos?.children.get("2")?.value).toBe("Read book")
  })

  it("seq element without value (tombstone) is excluded from visible children", () => {
    const root = makeStructureRoot("alice", 0, "list", "seq")
    const e1 = makeStructureSeq("alice", 1, root.id, null, null)
    const e2 = makeStructureSeq("alice", 2, root.id, e1.id, null)

    // Only e1 has a value; e2 is a tombstone
    const v1 = makeValue("alice", 3, e1.id, "visible", 4)

    const store = buildStore([root, e1, e2, v1])
    const reality = solve(store, DEFAULT_CONFIG)

    const list = getNode(reality, "list")
    expect(list?.children.size).toBe(1)
    expect(list?.children.get("0")?.value).toBe("visible")
  })

  it("concurrent seq inserts at same position: lower peer goes first", () => {
    const root = makeStructureRoot("alice", 0, "list", "seq")
    const grant = grantAdmin("alice", 1, "bob")

    // Both insert at start (originLeft=null, originRight=null)
    const e1 = makeStructureSeq("alice", 2, root.id, null, null)
    const e2 = makeStructureSeq("bob", 1, root.id, null, null)

    const v1 = makeValue("alice", 3, e1.id, "alice-item", 4)
    const v2 = makeValue("bob", 2, e2.id, "bob-item", 3)

    const store = buildStore([root, grant, e1, e2, v1, v2])
    const reality = solve(store, DEFAULT_CONFIG)

    const list = getNode(reality, "list")
    expect(list?.children.size).toBe(2)

    // "alice" < "bob" lexicographically, so alice goes first
    expect(list?.children.get("0")?.value).toBe("alice-item")
    expect(list?.children.get("1")?.value).toBe("bob-item")
  })

  it("empty sequence has no children", () => {
    const root = makeStructureRoot("alice", 0, "list", "seq")

    const store = buildStore([root])
    const reality = solve(store, DEFAULT_CONFIG)

    const list = getNode(reality, "list")
    expect(list).toBeDefined()
    expect(list?.children.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Nested Containers
// ---------------------------------------------------------------------------

describe("pipeline: nested containers", () => {
  it("map inside map", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const address = makeStructureMap("alice", 1, root.id, "address")
    const city = makeStructureMap("alice", 2, address.id, "city")
    const valCity = makeValue("alice", 3, city.id, "Portland", 4)

    const store = buildStore([root, address, city, valCity])
    const reality = solve(store, DEFAULT_CONFIG)

    expect(getNode(reality, "profile", "address", "city")?.value).toBe(
      "Portland",
    )
  })

  it("multiple root containers in one reality", () => {
    const profile = makeStructureRoot("alice", 0, "profile")
    const settings = makeStructureRoot("alice", 1, "settings")

    const name = makeStructureMap("alice", 2, profile.id, "name")
    const theme = makeStructureMap("alice", 3, settings.id, "theme")

    const valName = makeValue("alice", 4, name.id, "Alice", 5)
    const valTheme = makeValue("alice", 5, theme.id, "dark", 6)

    const store = buildStore([
      profile,
      settings,
      name,
      theme,
      valName,
      valTheme,
    ])
    const reality = solve(store, DEFAULT_CONFIG)

    expect(getNode(reality, "profile", "name")?.value).toBe("Alice")
    expect(getNode(reality, "settings", "theme")?.value).toBe("dark")
  })

  it("empty store produces reality with no containers", () => {
    const store = createStore()
    const reality = solve(store, DEFAULT_CONFIG)

    expect(reality.root.children.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Retraction + Pipeline
// ---------------------------------------------------------------------------

describe("pipeline: retraction", () => {
  it("retracted value excluded from reality", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")

    const val = makeValue("alice", 2, child.id, "Alice", 3)
    const retract = makeRetract("alice", 3, val.id, 4, [val.id])

    const store = buildStore([root, child, val, retract])
    const reality = solve(store, DEFAULT_CONFIG)

    // "name" exists structurally but has no value (retracted)
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBeUndefined()
  })

  it("un-retracted value reappears (retract of retract)", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")

    const val = makeValue("alice", 2, child.id, "Alice", 3)
    const retract1 = makeRetract("alice", 3, val.id, 4, [val.id])
    const retract2 = makeRetract("alice", 4, retract1.id, 5, [retract1.id])

    const store = buildStore([root, child, val, retract1, retract2])
    const reality = solve(store, DEFAULT_CONFIG)

    // Value is active again (retract of retract restores it)
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Alice")
  })

  it("retracted value does not participate in LWW", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grantBob = grantAdmin("alice", 2, "bob")
    const grantCharlie = grantAdmin("alice", 3, "charlie")

    // Alice writes at lamport 10 (should win normally)
    const aliceVal = makeValue("alice", 4, child.id, "Alice", 10)
    // Bob writes at lamport 3
    const bobVal = makeValue("bob", 0, child.id, "Bob", 3)
    // Alice's value is retracted by charlie
    const retract = makeRetract("charlie", 0, aliceVal.id, 11, [aliceVal.id])

    const store = buildStore([
      root,
      child,
      grantBob,
      grantCharlie,
      aliceVal,
      bobVal,
      retract,
    ])
    const reality = solve(store, DEFAULT_CONFIG)

    // Alice's value is retracted, so Bob wins
    expect(getNode(reality, "profile", "name")?.value).toBe("Bob")
  })
})

// ---------------------------------------------------------------------------
// Version-Parameterized Solving (§7.1)
// ---------------------------------------------------------------------------

describe("pipeline: version-parameterized solving", () => {
  it("solve(S, V_past) returns historical reality", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")

    // Alice writes "First" at counter 2, then "Second" at counter 3
    const val1 = makeValue("alice", 2, child.id, "First", 3)
    const val2 = makeValue("alice", 3, child.id, "Second", 5)

    const store = buildStore([root, child, val1, val2])

    // Solve at V={alice:3} — should see only root, child, val1
    const pastReality = solve(store, DEFAULT_CONFIG, vvFromObject({ alice: 3 }))
    expect(getNode(pastReality, "profile", "name")?.value).toBe("First")

    // Solve at current (no version filter) — should see everything
    const currentReality = solve(store, DEFAULT_CONFIG)
    expect(getNode(currentReality, "profile", "name")?.value).toBe("Second")
  })

  it("solve(S, V) where V excludes all constraints returns empty reality", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Hello", 3)

    const store = buildStore([root, child, val])

    // V={alice:0} means we haven't seen anything from alice
    const reality = solve(store, DEFAULT_CONFIG, vvFromObject({ alice: 0 }))
    expect(reality.root.children.size).toBe(0)
  })

  it("solve(S, V_current) returns same as solve(S) without version", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Hello", 3)

    const store = buildStore([root, child, val])

    // V={alice:3} includes all 3 constraints (counters 0,1,2)
    const versionedReality = solve(
      store,
      DEFAULT_CONFIG,
      vvFromObject({ alice: 3 }),
    )
    const unversionedReality = solve(store, DEFAULT_CONFIG)

    expect(getNode(versionedReality, "profile", "name")?.value).toBe("Hello")
    expect(getNode(unversionedReality, "profile", "name")?.value).toBe("Hello")
  })

  it("version filter with multiple peers", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grant = grantAdmin("alice", 2, "bob")

    const aliceVal = makeValue("alice", 3, child.id, "Alice", 3)
    const bobVal = makeValue("bob", 0, child.id, "Bob", 5)

    const store = buildStore([root, child, grant, aliceVal, bobVal])

    // V={alice:4, bob:0} — see alice's constraints (including grant) but not bob's
    const pastReality = solve(
      store,
      DEFAULT_CONFIG,
      vvFromObject({ alice: 4, bob: 0 }),
    )
    expect(getNode(pastReality, "profile", "name")?.value).toBe("Alice")

    // V={alice:4, bob:1} — see both
    const fullReality = solve(
      store,
      DEFAULT_CONFIG,
      vvFromObject({ alice: 4, bob: 1 }),
    )
    expect(getNode(fullReality, "profile", "name")?.value).toBe("Bob")
  })
})

// ---------------------------------------------------------------------------
// solveFull — intermediate results
// ---------------------------------------------------------------------------

describe("solveFull", () => {
  it("exposes intermediate pipeline stages", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Hello", 3)

    const store = buildStore([root, child, val])
    const result = solveFull(store, DEFAULT_CONFIG)

    // All constraints pass version filter (no version specified)
    expect(result.versionFiltered).toHaveLength(3)

    // All are valid (creator is alice, stub signatures)
    expect(result.validityResult.valid).toHaveLength(3)
    expect(result.validityResult.invalid).toHaveLength(0)

    // All are active (no retractions)
    expect(result.retractionResult.active).toHaveLength(3)
    expect(result.retractionResult.dominated).toHaveLength(0)

    // Structure index has the root and child
    expect(result.structureIndex.roots.size).toBe(1)
    expect(result.structureIndex.byId.size).toBe(2)

    // Projection produces one active_value fact
    expect(result.projectionResult.facts.length).toBeGreaterThan(0)
    expect(result.projectionResult.orphanedValues).toHaveLength(0)

    // Reality is correct
    expect(getNode(result.reality, "profile", "name")?.value).toBe("Hello")
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("pipeline: determinism", () => {
  it("same store produces same reality regardless of constraint insertion order", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const grant = grantAdmin("alice", 2, "bob")
    const val1 = makeValue("alice", 3, child.id, "Alice", 3)
    const val2 = makeValue("bob", 0, child.id, "Bob", 5)

    // Insert in different orders
    const store1 = buildStore([root, child, grant, val1, val2])
    const store2 = buildStore([val2, val1, grant, child, root])

    const reality1 = solve(store1, DEFAULT_CONFIG)
    const reality2 = solve(store2, DEFAULT_CONFIG)

    expect(getNode(reality1, "profile", "name")?.value).toBe("Bob")
    expect(getNode(reality2, "profile", "name")?.value).toBe("Bob")
  })
})

// ---------------------------------------------------------------------------
// Agent-produced constraints (integration with Agent)
// ---------------------------------------------------------------------------

describe("pipeline: agent integration", () => {
  it("Agent-produced constraints flow through the full pipeline", () => {
    const agent = createAgent("alice")

    const { constraint: rootC, id: rootId } = produceRoot(
      agent,
      "profile",
      "map",
    )
    agent.observe(rootC)

    const { constraint: childC, id: childId } = produceMapChild(
      agent,
      rootId,
      "name",
    )
    agent.observe(childC)

    const valueC = agent.produceValue(childId, "Alice")
    agent.observe(valueC)

    const store = createStore()
    insert(store, rootC)
    insert(store, childC)
    insert(store, valueC)

    const reality = solve(store, DEFAULT_CONFIG)

    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Alice")
  })

  it("Two agents create map entries and both appear in reality", () => {
    const alice = createAgent("alice")
    const bob = createAgent("bob")

    const { constraint: rootC, id: rootId } = produceRoot(alice, "doc", "map")
    alice.observe(rootC)
    bob.observe(rootC)

    // Alice grants Bob admin capability
    const grantC = alice.produceAuthority("bob", "grant", { kind: "admin" })
    alice.observe(grantC)
    bob.observe(grantC)

    const { constraint: titleC, id: titleId } = produceMapChild(
      alice,
      rootId,
      "title",
    )
    alice.observe(titleC)
    bob.observe(titleC)

    const { constraint: bodyC, id: bodyId } = produceMapChild(
      bob,
      rootId,
      "body",
    )
    bob.observe(bodyC)

    const titleVal = alice.produceValue(titleId, "My Doc")
    const bodyVal = bob.produceValue(bodyId, "Content here")

    const store = buildStore([rootC, grantC, titleC, bodyC, titleVal, bodyVal])
    const reality = solve(store, DEFAULT_CONFIG)

    expect(getNode(reality, "doc", "title")?.value).toBe("My Doc")
    expect(getNode(reality, "doc", "body")?.value).toBe("Content here")
  })
})

// ---------------------------------------------------------------------------
// Native-only bypass (explicit opt-out from Datalog)
// ---------------------------------------------------------------------------

describe("pipeline: native-only bypass", () => {
  it("native-only config produces same reality as Datalog-enabled (no rules in store)", () => {
    const root = makeStructureRoot("alice", 0, "profile")
    const child = makeStructureMap("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, child.id, "Alice")

    const store = buildStore([root, child, val])
    const realityDatalog = solve(store, DEFAULT_CONFIG)
    const realityNative = solve(store, NATIVE_ONLY_CONFIG)

    expect(getNode(realityDatalog, "profile", "name")?.value).toBe("Alice")
    expect(getNode(realityNative, "profile", "name")?.value).toBe("Alice")
  })

  it("solveFull with native-only reports nativeFastPath as null", () => {
    const root = makeStructureRoot("alice", 0, "doc")
    const child = makeStructureMap("alice", 1, root.id, "title")
    const val = makeValue("alice", 2, child.id, "Hello")

    const store = buildStore([root, child, val])
    const result = solveFull(store, NATIVE_ONLY_CONFIG)

    // enableDatalogEvaluation: false → nativeFastPath is null (bypass mode)
    expect(result.nativeFastPath).toBe(null)
  })

  it("solveFull with Datalog enabled and no rules reports nativeFastPath as true", () => {
    const root = makeStructureRoot("alice", 0, "doc")
    const child = makeStructureMap("alice", 1, root.id, "title")
    const val = makeValue("alice", 2, child.id, "Hello")

    const store = buildStore([root, child, val])
    const result = solveFull(store, DEFAULT_CONFIG)

    // No rules in store → falls through to native solvers
    expect(result.nativeFastPath).toBe(true)
  })

  it("native-only seq ordering matches Datalog-enabled ordering", () => {
    const root = makeStructureRoot("alice", 0, "list", "seq")
    const grant = grantAdmin("alice", 1, "bob")
    const e1 = makeStructureSeq("alice", 2, root.id, null, null)
    const e2 = makeStructureSeq("bob", 0, root.id, null, null)
    const v1 = makeValue("alice", 3, e1.id, "Alice")
    const v2 = makeValue("bob", 1, e2.id, "Bob")

    const store = buildStore([root, grant, e1, e2, v1, v2])
    const realityDatalog = solve(store, DEFAULT_CONFIG)
    const realityNative = solve(store, NATIVE_ONLY_CONFIG)

    const listD = getNode(realityDatalog, "list")
    const listN = getNode(realityNative, "list")
    expect(listD).toBeDefined()
    expect(listN).toBeDefined()
    expect(listD?.children.size).toBe(listN?.children.size)

    // Both should produce same ordering
    // biome-ignore lint/style/noNonNullAssertion: listD is guaranteed present after assertions above
    for (const [key, nodeD] of listD!.children) {
      // biome-ignore lint/style/noNonNullAssertion: listN is guaranteed present after assertions above
      const nodeN = listN!.children.get(key)
      expect(nodeN).toBeDefined()
      expect(nodeD.value).toBe(nodeN?.value)
    }
  })
})
