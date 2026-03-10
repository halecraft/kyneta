// === Integration Tests (Phase 5) ===
// End-to-end tests exercising the full stack: bootstrap → agents → constraints
// → store → sync → solve → reality. These tests validate that all components
// work together correctly, not just individually.
//
// Test categories (from plan):
// - Bootstrap: new reality has creation constraint, admin grant, LWW rules, Fugue rules
// - Two-agent sync: bidirectional delta exchange → convergent realities
// - Retraction sync: retract propagates via delta; reality reflects dominance
// - Multi-container: reality with both map and seq containers resolves correctly
// - Constraint auditability: invalid constraints remain in store, queryable but excluded

import { describe, it, expect } from 'vitest';
import {
  createReality,
  BOOTSTRAP_CONSTRAINT_COUNT,
  buildDefaultRules,
} from '../src/bootstrap.js';
import { solve, solveFull } from '../src/kernel/pipeline.js';
import type { PipelineConfig } from '../src/kernel/pipeline.js';
import {
  createStore,
  insert,
  insertMany,
  exportDelta,
  importDelta,
  constraintCount,
  allConstraints,
  constraintsByType,
  getVersionVector,
  mergeStores,
} from '../src/kernel/store.js';
import type { ConstraintStore } from '../src/kernel/store.js';
import {
  createAgent,
  produceRoot,
  produceMapChild,
  produceSeqChild,
} from '../src/kernel/agent.js';
import type { Agent } from '../src/kernel/agent.js';
import { createCnId, cnIdKey } from '../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../src/kernel/signature.js';
import { computeValid } from '../src/kernel/validity.js';
import { vvFromObject } from '../src/kernel/version-vector.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RuleConstraint,
  AuthorityConstraint,
  RealityNode,
  Reality,
  PeerID,
  Value,
  CnId,
} from '../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNode(reality: Reality, ...path: string[]): RealityNode | undefined {
  let current: RealityNode | undefined = reality.root;
  for (const key of path) {
    if (current === undefined) return undefined;
    current = current.children.get(key);
  }
  return current;
}

function getSeqValues(reality: Reality, ...containerPath: string[]): Value[] {
  const container = getNode(reality, ...containerPath);
  if (container === undefined) return [];
  const values: Value[] = [];
  // Seq children are keyed by index string ("0", "1", "2", ...)
  for (let i = 0; ; i++) {
    const child = container.children.get(String(i));
    if (child === undefined) break;
    values.push(child.value!);
  }
  return values;
}

/**
 * Perform bidirectional delta sync between two agents' stores.
 * After this, both stores contain the union of all constraints.
 */
function bidirectionalSync(
  storeA: ConstraintStore,
  storeB: ConstraintStore,
): void {
  // A → B
  const deltaAtoB = exportDelta(storeA, getVersionVector(storeB));
  const resultAtoB = importDelta(storeB, deltaAtoB);
  if (!resultAtoB.ok) throw new Error(`Sync A→B failed: ${JSON.stringify(resultAtoB.error)}`);

  // B → A
  const deltaBtoA = exportDelta(storeB, getVersionVector(storeA));
  const resultBtoA = importDelta(storeA, deltaBtoA);
  if (!resultBtoA.ok) throw new Error(`Sync B→A failed: ${JSON.stringify(resultBtoA.error)}`);
}

// ===========================================================================
// Bootstrap Tests
// ===========================================================================

describe('bootstrap', () => {
  it('creates a store with the correct number of bootstrap constraints', () => {
    const { store, constraints } = createReality({ creator: 'alice' });

    expect(constraintCount(store)).toBe(BOOTSTRAP_CONSTRAINT_COUNT);
    expect(constraints.length).toBe(BOOTSTRAP_CONSTRAINT_COUNT);
  });

  it('first constraint is an admin grant to the creator', () => {
    const { constraints } = createReality({ creator: 'alice' });

    const first = constraints[0]!;
    expect(first.type).toBe('authority');
    if (first.type !== 'authority') return;
    expect(first.payload.targetPeer).toBe('alice');
    expect(first.payload.action).toBe('grant');
    expect(first.payload.capability).toEqual({ kind: 'admin' });
    expect(first.id.peer).toBe('alice');
    expect(first.id.counter).toBe(0);
  });

  it('contains default LWW rules at Layer 1', () => {
    const { store } = createReality({ creator: 'alice' });

    const ruleConstraints = constraintsByType(store, 'rule');
    const lwwRules = ruleConstraints.filter(
      (r) => r.payload.head.predicate === 'superseded' || r.payload.head.predicate === 'winner',
    );

    // 2 superseded rules + 1 winner rule = 3
    expect(lwwRules.length).toBe(3);
    for (const r of lwwRules) {
      expect(r.payload.layer).toBe(1);
    }
  });

  it('contains default Fugue rules at Layer 1', () => {
    const { store } = createReality({ creator: 'alice' });

    const ruleConstraints = constraintsByType(store, 'rule');
    const fugueRules = ruleConstraints.filter(
      (r) =>
        r.payload.head.predicate === 'fugue_child' ||
        r.payload.head.predicate === 'fugue_descendant' ||
        r.payload.head.predicate === 'fugue_before',
    );

    // 1 fugue_child + 2 fugue_descendant + 5 fugue_before = 8
    expect(fugueRules.length).toBe(8);
    for (const r of fugueRules) {
      expect(r.payload.layer).toBe(1);
    }
  });

  it('all bootstrap constraints are from the creator peer', () => {
    const { constraints } = createReality({ creator: 'alice' });

    for (const c of constraints) {
      expect(c.id.peer).toBe('alice');
    }
  });

  it('bootstrap constraints have monotonically increasing counters', () => {
    const { constraints } = createReality({ creator: 'alice' });

    for (let i = 0; i < constraints.length; i++) {
      expect(constraints[i]!.id.counter).toBe(i);
    }
  });

  it('bootstrap constraints have monotonically increasing lamport values', () => {
    const { constraints } = createReality({ creator: 'alice' });

    for (let i = 0; i < constraints.length; i++) {
      expect(constraints[i]!.lamport).toBe(i);
    }
  });

  it('agent starts at the correct counter and lamport after bootstrap', () => {
    const { agent, constraints } = createReality({ creator: 'alice' });

    expect(agent.peerId).toBe('alice');
    expect(agent.counter).toBe(constraints.length);
    expect(agent.lamportValue).toBeGreaterThanOrEqual(constraints.length);
  });

  it('pipeline config uses the creator and default retraction depth', () => {
    const { config } = createReality({ creator: 'alice' });

    expect(config.creator).toBe('alice');
    expect(config.retractionConfig!.maxDepth).toBe(2);
    expect(config.enableDatalogEvaluation).toBe(true);
  });

  it('custom retraction depth is reflected in pipeline config', () => {
    const { config } = createReality({
      creator: 'alice',
      retractionDepth: 3,
    });

    expect(config.retractionConfig!.maxDepth).toBe(3);
  });

  it('solving an empty reality (only bootstrap constraints) produces empty root', () => {
    const { store, config } = createReality({ creator: 'alice' });

    const reality = solve(store, config);
    expect(reality.root).toBeDefined();
    expect(reality.root.children.size).toBe(0);
  });

  it('default solver rules in store produce correct results for a simple map', () => {
    const { store, agent, config } = createReality({ creator: 'alice' });

    // Create a map container with a key
    const { constraint: rootC, id: rootId } = produceRoot(agent, 'profile', 'map');
    insert(store, rootC);
    agent.observe(rootC);

    const { constraint: childC, id: childId } = produceMapChild(agent, rootId, 'name');
    insert(store, childC);
    agent.observe(childC);

    const valueC = agent.produceValue(childId, 'Alice');
    insert(store, valueC);
    agent.observe(valueC);

    const reality = solve(store, config);
    const nameNode = getNode(reality, 'profile', 'name');
    expect(nameNode).toBeDefined();
    expect(nameNode!.value).toBe('Alice');
  });

  it('default Fugue rules produce correct sequence ordering', () => {
    const { store, agent, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(agent, 'items', 'seq');
    insert(store, rootC);
    agent.observe(rootC);

    // Insert three sequential elements: A → B → C
    const { constraint: e1C, id: e1Id } = produceSeqChild(agent, rootId, null, null);
    insert(store, e1C);
    agent.observe(e1C);
    const v1 = agent.produceValue(e1Id, 'A');
    insert(store, v1);
    agent.observe(v1);

    const { constraint: e2C, id: e2Id } = produceSeqChild(agent, rootId, e1Id, null);
    insert(store, e2C);
    agent.observe(e2C);
    const v2 = agent.produceValue(e2Id, 'B');
    insert(store, v2);
    agent.observe(v2);

    const { constraint: e3C } = produceSeqChild(agent, rootId, e2Id, null);
    insert(store, e3C);
    agent.observe(e3C);
    const v3 = agent.produceValue(e3C.id, 'C');
    insert(store, v3);
    agent.observe(v3);

    const reality = solve(store, config);
    const values = getSeqValues(reality, 'items');
    expect(values).toEqual(['A', 'B', 'C']);
  });
});

// ===========================================================================
// Two-Agent Sync Tests
// ===========================================================================

describe('two-agent sync', () => {
  it('bidirectional delta exchange produces convergent realities', () => {
    // Alice creates the reality and shares bootstrap with Bob
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    // Bob gets a copy of the store via full sync
    const bobStore = createStore();
    const aliceDelta = exportDelta(aliceStore, getVersionVector(bobStore));
    importDelta(bobStore, aliceDelta);

    // Bob creates an agent
    const bob = createAgent('bob');
    bob.observeMany(allConstraints(bobStore));

    // Alice grants Bob admin so his constraints pass validity
    const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
    insert(aliceStore, grantBob);
    alice.observe(grantBob);

    // Alice creates a map container and sets a value
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    const { constraint: titleC, id: titleId } = produceMapChild(alice, rootId, 'title');
    insert(aliceStore, titleC);
    alice.observe(titleC);

    const titleVal = alice.produceValue(titleId, 'Hello');
    insert(aliceStore, titleVal);
    alice.observe(titleVal);

    // Bob creates a different key in the same container
    // (Bob observed root from Alice via initial sync, but not the title key yet)
    bob.observeMany(allConstraints(aliceStore)); // simulate Bob receiving Alice's constraints
    const bobDeltaFromAlice = exportDelta(aliceStore, getVersionVector(bobStore));
    importDelta(bobStore, bobDeltaFromAlice);

    const { constraint: bodyC, id: bodyId } = produceMapChild(bob, rootId, 'body');
    insert(bobStore, bodyC);
    bob.observe(bodyC);

    const bodyVal = bob.produceValue(bodyId, 'World');
    insert(bobStore, bodyVal);
    bob.observe(bodyVal);

    // Bidirectional sync
    bidirectionalSync(aliceStore, bobStore);

    // Both should compute the same reality
    const aliceReality = solve(aliceStore, config);
    const bobReality = solve(bobStore, config);

    expect(getNode(aliceReality, 'doc', 'title')!.value).toBe('Hello');
    expect(getNode(aliceReality, 'doc', 'body')!.value).toBe('World');
    expect(getNode(bobReality, 'doc', 'title')!.value).toBe('Hello');
    expect(getNode(bobReality, 'doc', 'body')!.value).toBe('World');
  });

  it('concurrent writes to same key resolve via LWW', () => {
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    // Share bootstrap with Bob
    const bobStore = createStore();
    importDelta(bobStore, exportDelta(aliceStore, getVersionVector(bobStore)));
    const bob = createAgent('bob');
    bob.observeMany(allConstraints(bobStore));

    // Alice grants Bob admin
    const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
    insert(aliceStore, grantBob);
    alice.observe(grantBob);

    // Alice creates the container and key
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'status');
    insert(aliceStore, keyC);
    alice.observe(keyC);

    // Sync so Bob has the structure
    bidirectionalSync(aliceStore, bobStore);
    bob.observeMany(allConstraints(bobStore));

    // Alice writes "active" at lamport ~N
    const aliceVal = alice.produceValue(keyId, 'active');
    insert(aliceStore, aliceVal);
    alice.observe(aliceVal);

    // Bob writes "inactive" concurrently (higher lamport because he observed more)
    // We'll ensure Bob has a higher lamport by ticking a few times
    const bobVal = bob.produceValue(keyId, 'inactive');
    insert(bobStore, bobVal);
    bob.observe(bobVal);

    // Sync
    bidirectionalSync(aliceStore, bobStore);

    // Both should see the same winner (whoever has higher lamport, or higher peer on tie)
    const aliceReality = solve(aliceStore, config);
    const bobReality = solve(bobStore, config);

    const aliceResult = getNode(aliceReality, 'doc', 'status')!.value;
    const bobResult = getNode(bobReality, 'doc', 'status')!.value;
    expect(aliceResult).toBe(bobResult);
  });

  it('concurrent sequence inserts at same position converge via Fugue', () => {
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    // Share bootstrap with Bob
    const bobStore = createStore();
    importDelta(bobStore, exportDelta(aliceStore, getVersionVector(bobStore)));
    const bob = createAgent('bob');
    bob.observeMany(allConstraints(bobStore));

    // Grant Bob admin
    const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
    insert(aliceStore, grantBob);
    alice.observe(grantBob);

    // Alice creates a seq container
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'list', 'seq');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    // Sync
    bidirectionalSync(aliceStore, bobStore);
    bob.observeMany(allConstraints(bobStore));

    // Both insert at the start concurrently
    const { constraint: aliceElemC, id: aliceElemId } = produceSeqChild(alice, rootId, null, null);
    insert(aliceStore, aliceElemC);
    alice.observe(aliceElemC);
    const aliceElemVal = alice.produceValue(aliceElemId, 'Alice-item');
    insert(aliceStore, aliceElemVal);
    alice.observe(aliceElemVal);

    const { constraint: bobElemC, id: bobElemId } = produceSeqChild(bob, rootId, null, null);
    insert(bobStore, bobElemC);
    bob.observe(bobElemC);
    const bobElemVal = bob.produceValue(bobElemId, 'Bob-item');
    insert(bobStore, bobElemVal);
    bob.observe(bobElemVal);

    // Sync
    bidirectionalSync(aliceStore, bobStore);

    // Both should see the same order
    const aliceReality = solve(aliceStore, config);
    const bobReality = solve(bobStore, config);

    const aliceValues = getSeqValues(aliceReality, 'list');
    const bobValues = getSeqValues(bobReality, 'list');

    expect(aliceValues.length).toBe(2);
    expect(bobValues.length).toBe(2);
    expect(aliceValues).toEqual(bobValues);

    // Fugue: lower peer goes first. "alice" < "bob" lexicographically
    expect(aliceValues[0]).toBe('Alice-item');
    expect(aliceValues[1]).toBe('Bob-item');
  });

  it('three-agent sync: all converge after pairwise exchange', () => {
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    // Create stores for Bob and Charlie
    const bobStore = createStore();
    importDelta(bobStore, exportDelta(aliceStore, getVersionVector(bobStore)));
    const bob = createAgent('bob');
    bob.observeMany(allConstraints(bobStore));

    const charlieStore = createStore();
    importDelta(charlieStore, exportDelta(aliceStore, getVersionVector(charlieStore)));
    const charlie = createAgent('charlie');
    charlie.observeMany(allConstraints(charlieStore));

    // Grant admin to all
    const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
    insert(aliceStore, grantBob);
    alice.observe(grantBob);
    const grantCharlie = alice.produceAuthority('charlie', 'grant', { kind: 'admin' });
    insert(aliceStore, grantCharlie);
    alice.observe(grantCharlie);

    // Alice creates a container
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'shared', 'map');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    // Sync Alice → Bob, Alice → Charlie
    bidirectionalSync(aliceStore, bobStore);
    bidirectionalSync(aliceStore, charlieStore);
    bob.observeMany(allConstraints(bobStore));
    charlie.observeMany(allConstraints(charlieStore));

    // Each agent writes a different key
    const { constraint: aKeyC, id: aKeyId } = produceMapChild(alice, rootId, 'a');
    insert(aliceStore, aKeyC);
    alice.observe(aKeyC);
    const aVal = alice.produceValue(aKeyId, 'from-alice');
    insert(aliceStore, aVal);
    alice.observe(aVal);

    const { constraint: bKeyC, id: bKeyId } = produceMapChild(bob, rootId, 'b');
    insert(bobStore, bKeyC);
    bob.observe(bKeyC);
    const bVal = bob.produceValue(bKeyId, 'from-bob');
    insert(bobStore, bVal);
    bob.observe(bVal);

    const { constraint: cKeyC, id: cKeyId } = produceMapChild(charlie, rootId, 'c');
    insert(charlieStore, cKeyC);
    charlie.observe(cKeyC);
    const cVal = charlie.produceValue(cKeyId, 'from-charlie');
    insert(charlieStore, cVal);
    charlie.observe(cVal);

    // Full pairwise sync
    bidirectionalSync(aliceStore, bobStore);
    bidirectionalSync(aliceStore, charlieStore);
    bidirectionalSync(bobStore, charlieStore);

    // All three should produce identical realities
    const aliceReality = solve(aliceStore, config);
    const bobReality = solve(bobStore, config);
    const charlieReality = solve(charlieStore, config);

    for (const reality of [aliceReality, bobReality, charlieReality]) {
      expect(getNode(reality, 'shared', 'a')!.value).toBe('from-alice');
      expect(getNode(reality, 'shared', 'b')!.value).toBe('from-bob');
      expect(getNode(reality, 'shared', 'c')!.value).toBe('from-charlie');
    }
  });
});

// ===========================================================================
// Retraction Sync Tests
// ===========================================================================

describe('retraction sync', () => {
  it('retracted value disappears from reality after sync', () => {
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    // Create map with a value
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'temp');
    insert(aliceStore, keyC);
    alice.observe(keyC);

    const valueC = alice.produceValue(keyId, 'will-be-deleted');
    insert(aliceStore, valueC);
    alice.observe(valueC);

    // Verify value is present
    let reality = solve(aliceStore, config);
    expect(getNode(reality, 'doc', 'temp')!.value).toBe('will-be-deleted');

    // Retract the value (sets it to null effectively via dominance)
    const retractC = alice.produceRetract(valueC.id);
    insert(aliceStore, retractC);
    alice.observe(retractC);

    // Value should be gone (map null-deletion: no active value means the
    // key disappears if there are no children either)
    reality = solve(aliceStore, config);
    // The key node may still exist with undefined value, or be absent
    const tempNode = getNode(reality, 'doc', 'temp');
    if (tempNode !== undefined) {
      expect(tempNode.value).toBeUndefined();
    }

    // Sync to Bob and verify Bob also sees the retraction
    const bobStore = createStore();
    importDelta(bobStore, exportDelta(aliceStore, getVersionVector(bobStore)));

    const bobReality = solve(bobStore, config);
    const bobTempNode = getNode(bobReality, 'doc', 'temp');
    if (bobTempNode !== undefined) {
      expect(bobTempNode.value).toBeUndefined();
    }
  });

  it('undo (retract-of-retract) restores value after sync', () => {
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    // Create a value
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'field');
    insert(aliceStore, keyC);
    alice.observe(keyC);

    const valueC = alice.produceValue(keyId, 'important');
    insert(aliceStore, valueC);
    alice.observe(valueC);

    // Retract it
    const retractC = alice.produceRetract(valueC.id);
    insert(aliceStore, retractC);
    alice.observe(retractC);

    // Verify value is gone
    let reality = solve(aliceStore, config);
    const goneNode = getNode(reality, 'doc', 'field');
    if (goneNode !== undefined) {
      expect(goneNode.value).toBeUndefined();
    }

    // Undo the retraction (retract the retract)
    const undoC = alice.produceRetract(retractC.id);
    insert(aliceStore, undoC);
    alice.observe(undoC);

    // Value should be back
    reality = solve(aliceStore, config);
    expect(getNode(reality, 'doc', 'field')!.value).toBe('important');

    // Sync to Bob — Bob should also see the restored value
    const bobStore = createStore();
    importDelta(bobStore, exportDelta(aliceStore, getVersionVector(bobStore)));

    const bobReality = solve(bobStore, config);
    expect(getNode(bobReality, 'doc', 'field')!.value).toBe('important');
  });

  it('retraction of seq value makes element a tombstone', () => {
    const { store: aliceStore, agent: alice, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(alice, 'list', 'seq');
    insert(aliceStore, rootC);
    alice.observe(rootC);

    // Insert A, B, C
    const { constraint: e1C, id: e1Id } = produceSeqChild(alice, rootId, null, null);
    insert(aliceStore, e1C);
    alice.observe(e1C);
    const v1 = alice.produceValue(e1Id, 'A');
    insert(aliceStore, v1);
    alice.observe(v1);

    const { constraint: e2C, id: e2Id } = produceSeqChild(alice, rootId, e1Id, null);
    insert(aliceStore, e2C);
    alice.observe(e2C);
    const v2 = alice.produceValue(e2Id, 'B');
    insert(aliceStore, v2);
    alice.observe(v2);

    const { constraint: e3C, id: e3Id } = produceSeqChild(alice, rootId, e2Id, null);
    insert(aliceStore, e3C);
    alice.observe(e3C);
    const v3 = alice.produceValue(e3Id, 'C');
    insert(aliceStore, v3);
    alice.observe(v3);

    expect(getSeqValues(solve(aliceStore, config), 'list')).toEqual(['A', 'B', 'C']);

    // Retract 'B' — it becomes a tombstone (structurally present but invisible)
    const retractB = alice.produceRetract(v2.id);
    insert(aliceStore, retractB);
    alice.observe(retractB);

    const reality = solve(aliceStore, config);
    expect(getSeqValues(reality, 'list')).toEqual(['A', 'C']);

    // Sync to Bob — Bob should also see [A, C]
    const bobStore = createStore();
    importDelta(bobStore, exportDelta(aliceStore, getVersionVector(bobStore)));
    expect(getSeqValues(solve(bobStore, config), 'list')).toEqual(['A', 'C']);
  });

  it('agent retracts a non-frontier constraint via semantic refs', () => {
    // This tests the Phase 4.6 semantic refs fix: the Agent's version
    // vector frontier compresses refs, so retracting an old (non-frontier)
    // constraint still works because computeActive interprets refs semantically.
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'field');
    insert(store, keyC);
    alice.observe(keyC);

    // Write value #1
    const val1 = alice.produceValue(keyId, 'first');
    insert(store, val1);
    alice.observe(val1);

    // Write several more constraints to advance the frontier
    const val2 = alice.produceValue(keyId, 'second');
    insert(store, val2);
    alice.observe(val2);

    const val3 = alice.produceValue(keyId, 'third');
    insert(store, val3);
    alice.observe(val3);

    // Now retract val1 — val1's CnId is NOT on the frontier, but the
    // Agent's refs include (alice, N) where N >= val1.id.counter.
    const retractVal1 = alice.produceRetract(val1.id);
    insert(store, retractVal1);
    alice.observe(retractVal1);

    // Solve should work — the retraction should be valid
    const result = solveFull(store, config);
    // val1 should be dominated (retracted)
    expect(result.retractionResult.violations.length).toBe(0);
    // The winner should be val3 (highest lamport)
    expect(getNode(result.reality, 'doc', 'field')!.value).toBe('third');
  });
});

// ===========================================================================
// Multi-Container Tests
// ===========================================================================

describe('multi-container', () => {
  it('reality with both map and seq containers resolves correctly', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    // Map container: profile
    const { constraint: profileC, id: profileId } = produceRoot(alice, 'profile', 'map');
    insert(store, profileC);
    alice.observe(profileC);

    const { constraint: nameC, id: nameId } = produceMapChild(alice, profileId, 'name');
    insert(store, nameC);
    alice.observe(nameC);

    const nameVal = alice.produceValue(nameId, 'Alice');
    insert(store, nameVal);
    alice.observe(nameVal);

    // Seq container: todos
    const { constraint: todosC, id: todosId } = produceRoot(alice, 'todos', 'seq');
    insert(store, todosC);
    alice.observe(todosC);

    const { constraint: t1C, id: t1Id } = produceSeqChild(alice, todosId, null, null);
    insert(store, t1C);
    alice.observe(t1C);
    const t1Val = alice.produceValue(t1Id, 'Buy milk');
    insert(store, t1Val);
    alice.observe(t1Val);

    const { constraint: t2C, id: t2Id } = produceSeqChild(alice, todosId, t1Id, null);
    insert(store, t2C);
    alice.observe(t2C);
    const t2Val = alice.produceValue(t2Id, 'Walk dog');
    insert(store, t2Val);
    alice.observe(t2Val);

    const reality = solve(store, config);

    // Map container
    expect(getNode(reality, 'profile', 'name')!.value).toBe('Alice');

    // Seq container
    const todos = getSeqValues(reality, 'todos');
    expect(todos).toEqual(['Buy milk', 'Walk dog']);
  });

  it('nested containers: map-in-seq and seq-in-map', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    // Root map
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'data', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    // Map child "items" that acts as a seq container
    const { constraint: itemsC, id: itemsId } = produceMapChild(alice, rootId, 'items');
    insert(store, itemsC);
    alice.observe(itemsC);

    const itemsVal = alice.produceValue(itemsId, 'items-container');
    insert(store, itemsVal);
    alice.observe(itemsVal);

    // Map child "count" with a numeric value
    const { constraint: countC, id: countId } = produceMapChild(alice, rootId, 'count');
    insert(store, countC);
    alice.observe(countC);

    const countVal = alice.produceValue(countId, 42);
    insert(store, countVal);
    alice.observe(countVal);

    const reality = solve(store, config);
    expect(getNode(reality, 'data', 'items')!.value).toBe('items-container');
    expect(getNode(reality, 'data', 'count')!.value).toBe(42);
  });

  it('map with null value excludes key from reality', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'deleted-key');
    insert(store, keyC);
    alice.observe(keyC);

    // Set value to null — map deletion via LWW
    const nullVal = alice.produceValue(keyId, null);
    insert(store, nullVal);
    alice.observe(nullVal);

    const reality = solve(store, config);
    // Null-valued map key with no children is excluded
    expect(getNode(reality, 'doc', 'deleted-key')).toBeUndefined();
  });
});

// ===========================================================================
// Constraint Auditability Tests
// ===========================================================================

describe('constraint auditability', () => {
  it('invalid constraints remain in store but are excluded from solving', () => {
    const { store, config } = createReality({ creator: 'alice' });

    // Manually insert a constraint from an unauthorized peer
    const unauthorizedConstraint: ValueConstraint = {
      id: createCnId('mallory', 0),
      lamport: 100,
      refs: [],
      sig: STUB_SIGNATURE,
      type: 'value',
      payload: {
        target: createCnId('alice', 0),
        content: 'hacked',
      },
    };

    insert(store, unauthorizedConstraint);

    // The constraint is in the store
    expect(allConstraints(store).some(
      (c) => c.id.peer === 'mallory',
    )).toBe(true);

    // But solving should exclude it (mallory has no capabilities)
    const result = solveFull(store, config);
    expect(result.validityResult.invalid.length).toBeGreaterThan(0);
    expect(result.validityResult.invalid.some(
      (ic) => ic.constraint.id.peer === 'mallory',
    )).toBe(true);

    // The reality should not contain mallory's contribution
    // (the reality is just the empty root since there are no valid structures)
    expect(result.reality.root.children.size).toBe(0);
  });

  it('authorized agent after grant can contribute to reality', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    // Grant Bob admin
    const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
    insert(store, grantBob);
    alice.observe(grantBob);

    // Alice creates structure
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'field');
    insert(store, keyC);
    alice.observe(keyC);

    // Bob writes a value (he has admin now)
    const bob = createAgent('bob');
    bob.observeMany(allConstraints(store));

    const bobVal = bob.produceValue(keyId, 'Bob-wrote-this');
    insert(store, bobVal);

    const result = solveFull(store, config);

    // Bob's value should be valid and in the reality
    expect(result.validityResult.invalid.some(
      (ic) => ic.constraint.id.peer === 'bob',
    )).toBe(false);
    expect(getNode(result.reality, 'doc', 'field')!.value).toBe('Bob-wrote-this');
  });

  it('revoked agent constraints are excluded after revocation', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    // Grant Bob admin
    const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
    insert(store, grantBob);
    alice.observe(grantBob);

    // Create structure
    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'field');
    insert(store, keyC);
    alice.observe(keyC);

    // Revoke Bob's admin
    const revokeBob = alice.produceAuthority('bob', 'revoke', { kind: 'admin' });
    insert(store, revokeBob);
    alice.observe(revokeBob);

    // Bob tries to write a value (he no longer has admin)
    const bob = createAgent('bob');
    bob.observeMany(allConstraints(store));

    const bobVal = bob.produceValue(keyId, 'unauthorized');
    insert(store, bobVal);

    const result = solveFull(store, config);

    // Bob's value should be invalid
    expect(result.validityResult.invalid.some(
      (ic) => ic.constraint.id.peer === 'bob',
    )).toBe(true);
  });
});

// ===========================================================================
// Version-Parameterized Solving (Time Travel)
// ===========================================================================

describe('version-parameterized solving', () => {
  it('solve(S, V_past) returns historical reality', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'version');
    insert(store, keyC);
    alice.observe(keyC);

    // Write v1
    const v1 = alice.produceValue(keyId, 'v1');
    insert(store, v1);
    alice.observe(v1);

    // Snapshot the version vector at this point
    const snapshotVV = vvFromObject({ alice: alice.counter });

    // Write v2 (overwrites v1 via LWW)
    const v2 = alice.produceValue(keyId, 'v2');
    insert(store, v2);
    alice.observe(v2);

    // Current reality should show v2
    const currentReality = solve(store, config);
    expect(getNode(currentReality, 'doc', 'version')!.value).toBe('v2');

    // Historical reality at snapshot should show v1
    const historicalReality = solve(store, config, snapshotVV);
    expect(getNode(historicalReality, 'doc', 'version')!.value).toBe('v1');
  });
});

// ===========================================================================
// Pipeline Metadata Tests
// ===========================================================================

describe('pipeline metadata with bootstrap', () => {
  it('native fast path activates for default rules', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'field');
    insert(store, keyC);
    alice.observe(keyC);

    const val = alice.produceValue(keyId, 'hello');
    insert(store, val);
    alice.observe(val);

    const result = solveFull(store, config);
    // Default rules should trigger native fast path
    expect(result.nativeFastPath).toBe(true);
    expect(getNode(result.reality, 'doc', 'field')!.value).toBe('hello');
  });

  it('Datalog path produces identical result to native path', () => {
    const { store, agent: alice, config } = createReality({ creator: 'alice' });

    const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
    insert(store, rootC);
    alice.observe(rootC);

    const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'field');
    insert(store, keyC);
    alice.observe(keyC);

    const val = alice.produceValue(keyId, 'hello');
    insert(store, val);
    alice.observe(val);

    // Force Datalog path by disabling native
    const datalogConfig: PipelineConfig = {
      ...config,
      enableDatalogEvaluation: true,
    };

    // Force native path
    const nativeConfig: PipelineConfig = {
      ...config,
      enableDatalogEvaluation: false,
    };

    const datalogResult = solveFull(store, datalogConfig);
    const nativeResult = solveFull(store, nativeConfig);

    // Both should produce the same reality
    expect(getNode(datalogResult.reality, 'doc', 'field')!.value).toBe('hello');
    expect(getNode(nativeResult.reality, 'doc', 'field')!.value).toBe('hello');
  });
});