// === Skeleton Tests ===
// Focused tests for the skeleton builder with hand-constructed
// StructureIndex and ResolutionResult inputs.
//
// Covers:
// - Map children with null values (deletion exclusion)
// - Seq tombstone detection (elements without active values)
// - Slot group merging (multiple peers creating same map key)
// - Mixed nesting (map-in-seq, seq-in-map, seq-in-seq)
// - An explicit ResolutionResult vs. the store's default rules
// - Empty containers
//
// These tests exercise skeleton.ts in isolation, without the full pipeline.

import { evaluate } from "@kyneta/datalog"
import { describe, expect, it } from "vitest"
import { buildDefaultRules } from "../../src/bootstrap.js"
import { cnIdKey, createCnId } from "../../src/kernel/cnid.js"
import { projectToFacts } from "../../src/kernel/projection.js"
import {
  extractResolution,
  type FugueBeforePair,
  type ResolutionResult,
  type ResolvedWinner,
  resolutionOf,
} from "../../src/kernel/resolve.js"
import { STUB_SIGNATURE } from "../../src/kernel/signature.js"
import { buildSkeleton } from "../../src/kernel/skeleton.js"
import {
  buildStructureIndex,
  type StructureIndex,
} from "../../src/kernel/structure-index.js"
import type {
  CnId,
  Constraint,
  PeerID,
  Reality,
  RealityNode,
  StructureConstraint,
  Value,
  ValueConstraint,
} from "../../src/kernel/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot(
  peer: PeerID,
  counter: number,
  containerId: string,
  policy: "map" | "seq" = "map",
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "root", containerId, policy },
  }
}

function makeMapChild(
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

function makeSeqChild(
  peer: PeerID,
  counter: number,
  parent: CnId,
  originLeft: CnId | null,
  originRight: CnId | null,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: "structure",
    payload: { kind: "seq", parent, originLeft, originRight },
  }
}

function makeValue(
  peer: PeerID,
  counter: number,
  lamport: number,
  target: CnId,
  content: Value,
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

/**
 * Build a StructureIndex + active constraints array from a list of constraints.
 * Structures go into the index; all constraints are returned as "active."
 */
function setup(constraints: Constraint[]): {
  structureIndex: StructureIndex
  active: Constraint[]
} {
  return {
    structureIndex: buildStructureIndex(constraints),
    active: constraints,
  }
}

/**
 * Build a ResolutionResult from explicit winners and fugue pairs.
 */
function makeResolution(
  winners: Array<{ slotId: string; winnerCnIdKey: string; content: Value }>,
  fuguePairs?: ReadonlyMap<string, FugueBeforePair[]>,
): ResolutionResult {
  const winnersMap = new Map<string, ResolvedWinner>()
  for (const w of winners) {
    winnersMap.set(w.slotId, w)
  }
  return resolutionOf(winnersMap, fuguePairs ?? new Map())
}

function childKeys(node: RealityNode): string[] {
  return Array.from(node.children.keys())
}

function getChild(node: RealityNode, key: string): RealityNode | undefined {
  return node.children.get(key)
}

function getNode(reality: Reality, ...path: string[]): RealityNode | undefined {
  let current: RealityNode | undefined = reality.root
  for (const key of path) {
    if (current === undefined) return undefined
    current = current.children.get(key)
  }
  return current
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * The resolution the default rules produce for these constraints.
 *
 * `buildSkeleton` is a pure function of a `ResolutionResult` — it attaches
 * values and orders sequences according to what the rules already decided. It
 * used to accept no resolution at all and fall back to calling the
 * hand-written LWW and Fugue solvers directly, which is what most of the tests
 * below relied on. That fallback is gone: nothing in production ever took it
 * (`kernel/pipeline.ts` supplies a resolution in every branch), and while it
 * existed these tests were checking the solver rather than the rules.
 *
 * Running the real rule set here keeps them honest and costs one short
 * evaluation per test.
 */
function resolutionFor(
  active: readonly Constraint[],
  structureIndex: StructureIndex,
): ResolutionResult {
  const { facts } = projectToFacts(active, structureIndex)
  const result = evaluate(buildDefaultRules(), facts)
  if (!result.ok) {
    throw new Error(`default rules failed to evaluate: ${result.error.kind}`)
  }
  return extractResolution(result.value)
}

describe("skeleton: empty containers", () => {
  it("empty store produces reality with no containers", () => {
    const { structureIndex, active } = setup([])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )
    expect(reality.root.children.size).toBe(0)
  })

  it("root with no children has no child nodes", () => {
    const root = makeRoot("alice", 0, "profile")
    const { structureIndex, active } = setup([root])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const profile = getNode(reality, "profile")
    expect(profile).toBeDefined()
    expect(profile?.children.size).toBe(0)
    expect(profile?.value).toBeUndefined()
  })

  it("root with policy seq and no children has no child nodes", () => {
    const root = makeRoot("alice", 0, "todos", "seq")
    const { structureIndex, active } = setup([root])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const todos = getNode(reality, "todos")
    expect(todos).toBeDefined()
    expect(todos?.children.size).toBe(0)
  })

  it("map child with no value has undefined value", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    const { structureIndex, active } = setup([root, child])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBeUndefined()
  })
})

describe("skeleton: map null-deletion", () => {
  it("map child with null value is excluded from children", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, 2, child.id, null)

    const { structureIndex, active } = setup([root, child, val])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const profile = getNode(reality, "profile")
    expect(profile).toBeDefined()
    // null value + no nested children = deleted (excluded)
    expect(profile?.children.has("name")).toBe(false)
  })

  it("map child with null value but nested children is still present", () => {
    const root = makeRoot("alice", 0, "profile")
    const address = makeMapChild("alice", 1, root.id, "address")
    const city = makeMapChild("alice", 2, address.id, "city")
    const valAddress = makeValue("alice", 3, 3, address.id, null)
    const valCity = makeValue("alice", 4, 4, city.id, "Springfield")

    const { structureIndex, active } = setup([
      root,
      address,
      city,
      valAddress,
      valCity,
    ])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    // address has null value but has a child (city) — should be present
    const addressNode = getNode(reality, "profile", "address")
    expect(addressNode).toBeDefined()
    expect(addressNode?.value).toBe(null)
    expect(getNode(reality, "profile", "address", "city")?.value).toBe(
      "Springfield",
    )
  })

  it("map child with non-null value is present", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, 2, child.id, "Alice")

    const { structureIndex, active } = setup([root, child, val])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Alice")
  })
})

describe("skeleton: seq tombstones", () => {
  it("seq element without value is excluded (tombstone)", () => {
    const root = makeRoot("alice", 0, "todos", "seq")
    const e1 = makeSeqChild("alice", 1, root.id, null, null)
    const e2 = makeSeqChild("alice", 2, root.id, e1.id, null)
    // Only e1 has a value — e2 is a tombstone
    const v1 = makeValue("alice", 3, 3, e1.id, "Buy milk")

    const { structureIndex, active } = setup([root, e1, e2, v1])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const todos = getNode(reality, "todos")
    expect(todos).toBeDefined()
    // Only one visible child (e1 with value), e2 is a tombstone
    expect(todos?.children.size).toBe(1)
    expect(getChild(todos!, "0")?.value).toBe("Buy milk")
  })

  it("seq with all elements tombstoned has no visible children", () => {
    const root = makeRoot("alice", 0, "list", "seq")
    const e1 = makeSeqChild("alice", 1, root.id, null, null)
    const e2 = makeSeqChild("alice", 2, root.id, e1.id, null)
    // No values for any element

    const { structureIndex, active } = setup([root, e1, e2])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const list = getNode(reality, "list")
    expect(list).toBeDefined()
    expect(list?.children.size).toBe(0)
  })
})

describe("skeleton: slot group merging (concurrent map creation)", () => {
  it("two peers creating same map key are merged into one slot", () => {
    const root = makeRoot("alice", 0, "profile")
    // Alice and Bob independently create structure(map, parent=root, key="name")
    const aliceName = makeMapChild("alice", 1, root.id, "name")
    const bobName = makeMapChild("bob", 0, root.id, "name")
    // Both write values targeting their own structure
    const aliceVal = makeValue("alice", 2, 5, aliceName.id, "Alice")
    const bobVal = makeValue("bob", 1, 10, bobName.id, "Bob")

    const { structureIndex, active } = setup([
      root,
      aliceName,
      bobName,
      aliceVal,
      bobVal,
    ])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const profile = getNode(reality, "profile")
    expect(profile).toBeDefined()
    // Only one "name" key (the slot merges both structures)
    expect(childKeys(profile!)).toEqual(["name"])
    // Bob's value wins (higher lamport: 10 > 5)
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Bob")
  })

  it("slot group merging preserves children from both structures", () => {
    const root = makeRoot("alice", 0, "data")
    // Both peers create the same "settings" map child
    const aliceSettings = makeMapChild("alice", 1, root.id, "settings")
    const bobSettings = makeMapChild("bob", 0, root.id, "settings")
    // Alice creates a child under her structure
    const theme = makeMapChild("alice", 2, aliceSettings.id, "theme")
    const themeVal = makeValue("alice", 3, 3, theme.id, "dark")
    // Bob creates a different child under his structure
    const lang = makeMapChild("bob", 1, bobSettings.id, "lang")
    const langVal = makeValue("bob", 2, 2, lang.id, "en")

    const { structureIndex, active } = setup([
      root,
      aliceSettings,
      bobSettings,
      theme,
      themeVal,
      lang,
      langVal,
    ])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const settings = getNode(reality, "data", "settings")
    expect(settings).toBeDefined()
    // Both children should be present (from different structures in same slot group)
    expect(childKeys(settings!).sort()).toEqual(["lang", "theme"])
    expect(getNode(reality, "data", "settings", "theme")?.value).toBe("dark")
    expect(getNode(reality, "data", "settings", "lang")?.value).toBe("en")
  })
})

describe("skeleton: mixed nesting", () => {
  it("map inside map", () => {
    const root = makeRoot("alice", 0, "doc")
    const address = makeMapChild("alice", 1, root.id, "address")
    const city = makeMapChild("alice", 2, address.id, "city")
    const valCity = makeValue("alice", 3, 3, city.id, "Springfield")

    const { structureIndex, active } = setup([root, address, city, valCity])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    expect(getNode(reality, "doc", "address", "city")?.value).toBe(
      "Springfield",
    )
  })

  it("seq inside map", () => {
    const root = makeRoot("alice", 0, "doc")
    // "tags" is a seq container nested under a map root
    const tagsStructure = makeMapChild("alice", 1, root.id, "tags")
    // The tags node has seq children
    const e1 = makeSeqChild("alice", 2, tagsStructure.id, null, null)
    const e2 = makeSeqChild("alice", 3, tagsStructure.id, e1.id, null)
    const v1 = makeValue("alice", 4, 4, e1.id, "important")
    const v2 = makeValue("alice", 5, 5, e2.id, "urgent")

    const { structureIndex, active } = setup([
      root,
      tagsStructure,
      e1,
      e2,
      v1,
      v2,
    ])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const tags = getNode(reality, "doc", "tags")
    expect(tags).toBeDefined()
    expect(tags?.children.size).toBe(2)
    // Seq children keyed by position index
    expect(getChild(tags!, "0")?.value).toBe("important")
    expect(getChild(tags!, "1")?.value).toBe("urgent")
  })

  it("seq root container", () => {
    const root = makeRoot("alice", 0, "items", "seq")
    const e1 = makeSeqChild("alice", 1, root.id, null, null)
    const e2 = makeSeqChild("alice", 2, root.id, e1.id, null)
    const v1 = makeValue("alice", 3, 3, e1.id, "first")
    const v2 = makeValue("alice", 4, 4, e2.id, "second")

    const { structureIndex, active } = setup([root, e1, e2, v1, v2])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const items = getNode(reality, "items")
    expect(items).toBeDefined()
    expect(items?.children.size).toBe(2)
    expect(getChild(items!, "0")?.value).toBe("first")
    expect(getChild(items!, "1")?.value).toBe("second")
  })

  it("multiple root containers", () => {
    const profile = makeRoot("alice", 0, "profile")
    const settings = makeRoot("alice", 1, "settings")
    const name = makeMapChild("alice", 2, profile.id, "name")
    const theme = makeMapChild("alice", 3, settings.id, "theme")
    const valName = makeValue("alice", 4, 4, name.id, "Alice")
    const valTheme = makeValue("alice", 5, 5, theme.id, "dark")

    const { structureIndex, active } = setup([
      profile,
      settings,
      name,
      theme,
      valName,
      valTheme,
    ])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    expect(childKeys(reality.root).sort()).toEqual(["profile", "settings"])
    expect(getNode(reality, "profile", "name")?.value).toBe("Alice")
    expect(getNode(reality, "settings", "theme")?.value).toBe("dark")
  })

  it("deeply nested maps (3 levels)", () => {
    const root = makeRoot("alice", 0, "doc")
    const l1 = makeMapChild("alice", 1, root.id, "level1")
    const l2 = makeMapChild("alice", 2, l1.id, "level2")
    const l3 = makeMapChild("alice", 3, l2.id, "level3")
    const val = makeValue("alice", 4, 4, l3.id, "deep")

    const { structureIndex, active } = setup([root, l1, l2, l3, val])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    expect(getNode(reality, "doc", "level1", "level2", "level3")?.value).toBe(
      "deep",
    )
  })
})

describe("skeleton: ResolutionResult path", () => {
  it("uses ResolutionResult winners instead of the default LWW rules", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")

    // Two competing values
    const val1 = makeValue("alice", 2, 5, child.id, "Alice")
    const val2 = makeValue("bob", 0, 10, child.id, "Bob")

    const { structureIndex } = setup([root, child, val1, val2])

    // Build a ResolutionResult that picks Alice (despite Bob having higher lamport)
    // This simulates a custom resolution rule
    const slotId = `map:${cnIdKey(root.id)}:name`
    const resolution = makeResolution([
      {
        slotId,
        winnerCnIdKey: cnIdKey(val1.id),
        content: "Alice",
      },
    ])

    const reality = buildSkeleton(structureIndex, resolution)
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Alice")
  })

  it("the default rules produce the LWW result when none is supplied", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, 5, child.id, "Alice")
    const val2 = makeValue("bob", 0, 10, child.id, "Bob")

    const { structureIndex, active } = setup([root, child, val1, val2])

    // The resolution the default rules compute for these constraints.
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    // Default LWW: Bob wins (lamport 10 > 5)
    expect(name?.value).toBe("Bob")
  })

  it("an explicit ResolutionResult and the default rules agree for standard LWW", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    const val1 = makeValue("alice", 2, 3, child.id, "First")
    const val2 = makeValue("alice", 3, 7, child.id, "Second")

    const { structureIndex, active } = setup([root, child, val1, val2])

    // What the default rules resolve.
    const realityFromRules = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    // An explicit resolution result matching what the rules decided.
    const slotId = `map:${cnIdKey(root.id)}:name`
    const resolution = makeResolution([
      {
        slotId,
        winnerCnIdKey: cnIdKey(val2.id),
        content: "Second",
      },
    ])
    const realityResolved = buildSkeleton(structureIndex, resolution)

    expect(getNode(realityFromRules, "profile", "name")?.value).toBe("Second")
    expect(getNode(realityResolved, "profile", "name")?.value).toBe("Second")
  })

  it("ResolutionResult with no winner for a slot leaves value undefined", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    const val = makeValue("alice", 2, 2, child.id, "Alice")

    const { structureIndex } = setup([root, child, val])

    // Resolution result with no winner for this slot (custom rules decided no winner)
    const resolution = makeResolution([])

    const reality = buildSkeleton(structureIndex, resolution)
    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBeUndefined()
  })

  it("ResolutionResult with fugue_before pairs orders seq children", () => {
    const root = makeRoot("alice", 0, "list", "seq")
    const e1 = makeSeqChild("alice", 1, root.id, null, null)
    const e2 = makeSeqChild("bob", 0, root.id, null, null)

    const v1 = makeValue("alice", 2, 2, e1.id, "alice-item")
    const v2 = makeValue("bob", 1, 1, e2.id, "bob-item")

    const { structureIndex } = setup([root, e1, e2, v1, v2])

    // Build resolution with explicit ordering: bob before alice
    const parentKey = cnIdKey(root.id)
    const e1Key = cnIdKey(e1.id)
    const e2Key = cnIdKey(e2.id)

    const fuguePairs = new Map<string, FugueBeforePair[]>()
    fuguePairs.set(parentKey, [
      { parentKey, a: e2Key, b: e1Key }, // bob before alice
    ])

    const slotE1 = `seq:${e1Key}`
    const slotE2 = `seq:${e2Key}`
    const resolution = makeResolution(
      [
        {
          slotId: slotE1,
          winnerCnIdKey: cnIdKey(v1.id),
          content: "alice-item",
        },
        { slotId: slotE2, winnerCnIdKey: cnIdKey(v2.id), content: "bob-item" },
      ],
      fuguePairs,
    )

    const reality = buildSkeleton(structureIndex, resolution)
    const list = getNode(reality, "list")
    expect(list).toBeDefined()
    expect(list?.children.size).toBe(2)
    // bob-item should come first (position 0) per our fugue_before pairs
    expect(getChild(list!, "0")?.value).toBe("bob-item")
    expect(getChild(list!, "1")?.value).toBe("alice-item")
  })
})

describe("skeleton: LWW value resolution (default rules)", () => {
  it("higher lamport wins", () => {
    const root = makeRoot("alice", 0, "doc")
    const child = makeMapChild("alice", 1, root.id, "title")
    const val1 = makeValue("alice", 2, 2, child.id, "Draft")
    const val2 = makeValue("alice", 3, 5, child.id, "Final")

    const { structureIndex, active } = setup([root, child, val1, val2])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    expect(getNode(reality, "doc", "title")?.value).toBe("Final")
  })

  it("peer tiebreak when lamport is equal", () => {
    const root = makeRoot("alice", 0, "doc")
    const child = makeMapChild("alice", 1, root.id, "title")
    // Same lamport, different peers — higher peer wins
    const val1 = makeValue("alice", 2, 5, child.id, "Alice Version")
    const val2 = makeValue("bob", 0, 5, child.id, "Bob Version")

    const { structureIndex, active } = setup([root, child, val1, val2])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    // 'bob' > 'alice' lexicographically
    expect(getNode(reality, "doc", "title")?.value).toBe("Bob Version")
  })
})

describe("skeleton: orphaned values", () => {
  it("value targeting unknown structure is ignored", () => {
    const root = makeRoot("alice", 0, "profile")
    const child = makeMapChild("alice", 1, root.id, "name")
    // Value targets a non-existent structure
    const orphanedVal = makeValue(
      "alice",
      2,
      2,
      createCnId("alice", 99),
      "Orphan",
    )
    const realVal = makeValue("alice", 3, 3, child.id, "Alice")

    const { structureIndex, active } = setup([
      root,
      child,
      orphanedVal,
      realVal,
    ])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const name = getNode(reality, "profile", "name")
    expect(name).toBeDefined()
    expect(name?.value).toBe("Alice")
  })
})

describe("skeleton: seq ordering (default Fugue rules)", () => {
  it("sequential inserts preserve order", () => {
    const root = makeRoot("alice", 0, "list", "seq")
    const e1 = makeSeqChild("alice", 1, root.id, null, null)
    const e2 = makeSeqChild("alice", 2, root.id, e1.id, null)
    const e3 = makeSeqChild("alice", 3, root.id, e2.id, null)
    const v1 = makeValue("alice", 4, 4, e1.id, "A")
    const v2 = makeValue("alice", 5, 5, e2.id, "B")
    const v3 = makeValue("alice", 6, 6, e3.id, "C")

    const { structureIndex, active } = setup([root, e1, e2, e3, v1, v2, v3])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const list = getNode(reality, "list")
    expect(list).toBeDefined()
    expect(list?.children.size).toBe(3)
    expect(getChild(list!, "0")?.value).toBe("A")
    expect(getChild(list!, "1")?.value).toBe("B")
    expect(getChild(list!, "2")?.value).toBe("C")
  })

  it("concurrent inserts at same position: lower peer goes first", () => {
    const root = makeRoot("alice", 0, "list", "seq")
    // Both insert at the beginning (originLeft = null)
    const eAlice = makeSeqChild("alice", 1, root.id, null, null)
    const eBob = makeSeqChild("bob", 0, root.id, null, null)
    const vAlice = makeValue("alice", 2, 2, eAlice.id, "Alice")
    const vBob = makeValue("bob", 1, 1, eBob.id, "Bob")

    const { structureIndex, active } = setup([root, eAlice, eBob, vAlice, vBob])
    const reality = buildSkeleton(
      structureIndex,
      resolutionFor(active, structureIndex),
    )

    const list = getNode(reality, "list")
    expect(list).toBeDefined()
    expect(list?.children.size).toBe(2)
    // 'alice' < 'bob' lexicographically → alice first
    expect(getChild(list!, "0")?.value).toBe("Alice")
    expect(getChild(list!, "1")?.value).toBe("Bob")
  })
})
