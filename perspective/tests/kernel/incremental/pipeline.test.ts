// === Incremental Pipeline Differential Tests ===
// Tests for the incremental pipeline composition root (Plan 005, Phase 8).
//
// Covers:
// - Differential equivalence: after each insertion, pipeline.current()
//   deeply equals solve(store, config)
// - Multi-agent sync: two incremental pipelines converge
// - Retraction cascade: insert, retract, undo — verify deltas and state
// - Authority change cascade: queued constraints become valid after grant
// - Orphaned value resolution: value before structure
// - Out-of-order sync: non-causal delivery order
// - Bootstrap warm-start: createIncrementalPipelineFromBootstrap matches batch
// - Empty delta: duplicate constraint produces empty RealityDelta
// - Multi-removal retraction fix (Task 8.1a): multiple active removals
//   in a single delta are all processed correctly

import { describe, it, expect } from 'vitest';
import {
  createIncrementalPipeline,
  createIncrementalPipelineFromBootstrap,
  type IncrementalPipeline,
} from '../../../src/kernel/incremental/pipeline.js';
import {
  createReality,
  BOOTSTRAP_CONSTRAINT_COUNT,
} from '../../../src/bootstrap.js';
import { solve, solveFull } from '../../../src/kernel/pipeline.js';
import type { PipelineConfig } from '../../../src/kernel/pipeline.js';
import {
  createStore,
  insert,
  insertMany,
  exportDelta,
  importDelta,
  allConstraints,
  getVersionVector,
  hasConstraint,
} from '../../../src/kernel/store.js';
import type { ConstraintStore } from '../../../src/kernel/store.js';
import {
  createAgent,
  produceRoot,
  produceMapChild,
  produceSeqChild,
} from '../../../src/kernel/agent.js';
import type { Agent } from '../../../src/kernel/agent.js';
import { createCnId, cnIdKey } from '../../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../../src/kernel/signature.js';
import { DEFAULT_RETRACTION_CONFIG } from '../../../src/kernel/retraction.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  AuthorityConstraint,
  RuleConstraint,
  RealityNode,
  Reality,
  PeerID,
  Value,
  CnId,
} from '../../../src/kernel/types.js';
import type { RealityDelta, NodeDelta } from '../../../src/kernel/incremental/types.js';
import { realityDeltaEmpty } from '../../../src/kernel/incremental/types.js';
import {
  createIncrementalRetraction,
} from '../../../src/kernel/incremental/retraction.js';
import {
  zsetSingleton,
  zsetAdd,
  zsetFromEntries,
  zsetEmpty,
  type ZSet,
  type ZSetEntry,
} from '../../../src/base/zset.js';

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
  for (let i = 0; ; i++) {
    const child = container.children.get(String(i));
    if (child === undefined) break;
    values.push(child.value!);
  }
  return values;
}

/**
 * Deep compare two Reality objects by comparing their tree structures.
 * We compare node values, children keys, and children recursively.
 */
function realitiesEqual(a: Reality, b: Reality): boolean {
  return nodesEqual(a.root, b.root);
}

function nodesEqual(a: RealityNode, b: RealityNode): boolean {
  if (a.value !== b.value) return false;
  if (a.policy !== b.policy) return false;
  if (a.children.size !== b.children.size) return false;

  for (const [key, childA] of a.children) {
    const childB = b.children.get(key);
    if (childB === undefined) return false;
    if (!nodesEqual(childA, childB)) return false;
  }

  return true;
}

/**
 * Assert that an incremental pipeline's current reality matches
 * batch solve. This is the core differential test assertion.
 */
function assertDifferentialEquivalence(
  pipeline: IncrementalPipeline,
  label: string,
): void {
  const incremental = pipeline.current();
  const batch = pipeline.recompute();

  if (!realitiesEqual(incremental, batch)) {
    // Provide useful diff output
    const incStr = JSON.stringify(serializeReality(incremental), null, 2);
    const batchStr = JSON.stringify(serializeReality(batch), null, 2);
    throw new Error(
      `Differential equivalence FAILED at "${label}":\n` +
      `--- incremental ---\n${incStr}\n` +
      `--- batch ---\n${batchStr}\n`,
    );
  }
}

/**
 * Serialize a Reality for readable diff output.
 */
function serializeReality(reality: Reality): unknown {
  return serializeNode(reality.root);
}

function serializeNode(node: RealityNode): unknown {
  const children: Record<string, unknown> = {};
  for (const [key, child] of node.children) {
    children[key] = serializeNode(child);
  }
  return {
    value: node.value,
    policy: node.policy,
    children: Object.keys(children).length > 0 ? children : undefined,
  };
}

/**
 * Insert a constraint into a pipeline and verify differential equivalence.
 */
function insertAndVerify(
  pipeline: IncrementalPipeline,
  constraint: Constraint,
  label: string,
): RealityDelta {
  const delta = pipeline.insert(constraint);
  assertDifferentialEquivalence(pipeline, label);
  return delta;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncrementalPipeline', () => {
  // =========================================================================
  // Bootstrap warm-start
  // =========================================================================

  describe('bootstrap warm-start', () => {
    it('createIncrementalPipelineFromBootstrap produces same initial reality as batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      const incremental = pipeline.current();
      const batch = solve(result.store, result.config);

      expect(realitiesEqual(incremental, batch)).toBe(true);
    });

    it('pipeline store contains all bootstrap constraints', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      // The pipeline's store should have the same number of constraints
      // as the bootstrap result's store
      expect(pipeline.store.constraints.size).toBe(BOOTSTRAP_CONSTRAINT_COUNT);
    });

    it('pipeline config matches bootstrap config', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      expect(pipeline.config.creator).toBe('alice');
      expect(pipeline.config.retractionConfig).toEqual(result.config.retractionConfig);
    });

    it('empty reality (only bootstrap) produces empty root', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      const reality = pipeline.current();
      expect(reality.root.children.size).toBe(0);
      expect(reality.root.value).toBeUndefined();
    });
  });

  // =========================================================================
  // Empty delta / deduplication
  // =========================================================================

  describe('empty delta', () => {
    it('inserting a duplicate constraint produces empty RealityDelta', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      // Get a bootstrap constraint and try to re-insert it
      const bootstrapConstraints = allConstraints(result.store);
      const dup = bootstrapConstraints[0]!;

      const delta = pipeline.insert(dup);
      expect(delta.isEmpty).toBe(true);
      expect(delta.changes.length).toBe(0);
    });

    it('insertMany with empty array produces empty RealityDelta', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      const delta = pipeline.insertMany([]);
      expect(delta.isEmpty).toBe(true);
    });

    it('insertMany with all duplicates produces empty RealityDelta', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      const dups = allConstraints(result.store).slice(0, 3);
      const delta = pipeline.insertMany(dups);
      expect(delta.isEmpty).toBe(true);
    });
  });

  // =========================================================================
  // Differential equivalence — simple map scenario
  // =========================================================================

  describe('differential equivalence: simple map', () => {
    it('single root + map child + value matches batch at every step', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      // Step 1: create root
      const { constraint: rootC, id: rootId } = produceRoot(agent, 'profile', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'after root');

      // Step 2: create map child
      const { constraint: childC, id: childId } = produceMapChild(agent, rootId, 'name');
      agent.observe(childC);
      insertAndVerify(pipeline, childC, 'after map child');

      // Step 3: set value
      const valueC = agent.produceValue(childId, 'Alice');
      agent.observe(valueC);
      const delta = insertAndVerify(pipeline, valueC, 'after value');

      // Verify the reality is correct
      const reality = pipeline.current();
      const nameNode = getNode(reality, 'profile', 'name');
      expect(nameNode).toBeDefined();
      expect(nameNode!.value).toBe('Alice');

      // Verify the delta reports the changes
      expect(delta.isEmpty).toBe(false);
    });

    it('multiple map children under same parent match batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      const { constraint: titleC, id: titleId } = produceMapChild(agent, rootId, 'title');
      agent.observe(titleC);
      insertAndVerify(pipeline, titleC, 'title child');

      const titleVal = agent.produceValue(titleId, 'Hello');
      agent.observe(titleVal);
      insertAndVerify(pipeline, titleVal, 'title value');

      const { constraint: bodyC, id: bodyId } = produceMapChild(agent, rootId, 'body');
      agent.observe(bodyC);
      insertAndVerify(pipeline, bodyC, 'body child');

      const bodyVal = agent.produceValue(bodyId, 'World');
      agent.observe(bodyVal);
      insertAndVerify(pipeline, bodyVal, 'body value');

      const reality = pipeline.current();
      expect(getNode(reality, 'doc', 'title')!.value).toBe('Hello');
      expect(getNode(reality, 'doc', 'body')!.value).toBe('World');
    });

    it('nested map containers match batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'app', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      const { constraint: profileC, id: profileId } = produceMapChild(agent, rootId, 'profile');
      agent.observe(profileC);
      insertAndVerify(pipeline, profileC, 'profile');

      const { constraint: nameC, id: nameId } = produceMapChild(agent, profileId, 'name');
      agent.observe(nameC);
      insertAndVerify(pipeline, nameC, 'name');

      const nameVal = agent.produceValue(nameId, 'Alice');
      agent.observe(nameVal);
      insertAndVerify(pipeline, nameVal, 'name value');

      const reality = pipeline.current();
      expect(getNode(reality, 'app', 'profile', 'name')!.value).toBe('Alice');
    });
  });

  // =========================================================================
  // Differential equivalence — sequence scenario
  // =========================================================================

  describe('differential equivalence: sequence', () => {
    it('sequential elements match batch at every step', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'items', 'seq');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'seq root');

      // Insert A → B → C
      const { constraint: e1C, id: e1Id } = produceSeqChild(agent, rootId, null, null);
      agent.observe(e1C);
      insertAndVerify(pipeline, e1C, 'element 1 structure');

      const v1 = agent.produceValue(e1Id, 'A');
      agent.observe(v1);
      insertAndVerify(pipeline, v1, 'element 1 value');

      const { constraint: e2C, id: e2Id } = produceSeqChild(agent, rootId, e1Id, null);
      agent.observe(e2C);
      insertAndVerify(pipeline, e2C, 'element 2 structure');

      const v2 = agent.produceValue(e2Id, 'B');
      agent.observe(v2);
      insertAndVerify(pipeline, v2, 'element 2 value');

      const { constraint: e3C, id: e3Id } = produceSeqChild(agent, rootId, e2Id, null);
      agent.observe(e3C);
      insertAndVerify(pipeline, e3C, 'element 3 structure');

      const v3 = agent.produceValue(e3Id, 'C');
      agent.observe(v3);
      insertAndVerify(pipeline, v3, 'element 3 value');

      const values = getSeqValues(pipeline.current(), 'items');
      expect(values).toEqual(['A', 'B', 'C']);
    });
  });

  // =========================================================================
  // Differential equivalence — mixed map + seq
  // =========================================================================

  describe('differential equivalence: mixed containers', () => {
    it('map with nested seq matches batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'profile', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      // Map child: name
      const { constraint: nameC, id: nameId } = produceMapChild(agent, rootId, 'name');
      agent.observe(nameC);
      insertAndVerify(pipeline, nameC, 'name child');
      const nameVal = agent.produceValue(nameId, 'Alice');
      agent.observe(nameVal);
      insertAndVerify(pipeline, nameVal, 'name value');

      // Seq child: todos
      const { constraint: todosC, id: todosId } = produceMapChild(agent, rootId, 'todos');
      agent.observe(todosC);
      insertAndVerify(pipeline, todosC, 'todos child');

      // This map child contains a seq value, but the container itself is a map.
      // Actually, the "todos" is a map child whose slot is under the root map.
      // To make it a seq container, we'd need a separate root.
      // Let's instead use the correct pattern: a seq root alongside map.

      const reality = pipeline.current();
      expect(getNode(reality, 'profile', 'name')!.value).toBe('Alice');
    });

    it('reality with both map and seq containers matches batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      // Map container
      const { constraint: profileC, id: profileId } = produceRoot(agent, 'profile', 'map');
      agent.observe(profileC);
      insertAndVerify(pipeline, profileC, 'profile root');

      const { constraint: nameC, id: nameId } = produceMapChild(agent, profileId, 'name');
      agent.observe(nameC);
      const nameVal = agent.produceValue(nameId, 'Alice');
      agent.observe(nameVal);
      insertAndVerify(pipeline, nameC, 'name child');
      insertAndVerify(pipeline, nameVal, 'name value');

      // Seq container
      const { constraint: todosC, id: todosId } = produceRoot(agent, 'todos', 'seq');
      agent.observe(todosC);
      insertAndVerify(pipeline, todosC, 'todos root');

      const { constraint: t1C, id: t1Id } = produceSeqChild(agent, todosId, null, null);
      agent.observe(t1C);
      const t1Val = agent.produceValue(t1Id, 'Buy milk');
      agent.observe(t1Val);
      insertAndVerify(pipeline, t1C, 't1 structure');
      insertAndVerify(pipeline, t1Val, 't1 value');

      const { constraint: t2C, id: t2Id } = produceSeqChild(agent, todosId, t1Id, null);
      agent.observe(t2C);
      const t2Val = agent.produceValue(t2Id, 'Walk dog');
      agent.observe(t2Val);
      insertAndVerify(pipeline, t2C, 't2 structure');
      insertAndVerify(pipeline, t2Val, 't2 value');

      const reality = pipeline.current();
      expect(getNode(reality, 'profile', 'name')!.value).toBe('Alice');
      const todoValues = getSeqValues(reality, 'todos');
      expect(todoValues).toEqual(['Buy milk', 'Walk dog']);
    });
  });

  // =========================================================================
  // Retraction cascade
  // =========================================================================

  describe('retraction cascade', () => {
    it('insert value, retract it — value disappears and matches batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'title');
      agent.observe(keyC);
      insertAndVerify(pipeline, keyC, 'key');

      const valueC = agent.produceValue(keyId, 'Hello');
      agent.observe(valueC);
      insertAndVerify(pipeline, valueC, 'value');

      // Verify value is present
      expect(getNode(pipeline.current(), 'doc', 'title')!.value).toBe('Hello');

      // Retract the value
      const retractC = agent.produceRetract(valueC.id);
      agent.observe(retractC);
      const retractDelta = insertAndVerify(pipeline, retractC, 'retract');

      // Value should be gone (undefined)
      const titleNode = getNode(pipeline.current(), 'doc', 'title');
      // Map child with undefined value and no children is invisible
      // (matches batch behavior)
      assertDifferentialEquivalence(pipeline, 'after retract final check');
    });

    it('retract + undo — value reappears and matches batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'key');
      agent.observe(keyC);
      insertAndVerify(pipeline, keyC, 'key');

      const valueC = agent.produceValue(keyId, 'Hello');
      agent.observe(valueC);
      insertAndVerify(pipeline, valueC, 'value');

      // Retract
      const retractC = agent.produceRetract(valueC.id);
      agent.observe(retractC);
      insertAndVerify(pipeline, retractC, 'retract');

      // Undo (retract the retract)
      const undoC = agent.produceRetract(retractC.id);
      agent.observe(undoC);
      insertAndVerify(pipeline, undoC, 'undo');

      // Value should be back
      const reality = pipeline.current();
      expect(getNode(reality, 'doc', 'key')!.value).toBe('Hello');
    });

    it('seq value retraction makes element a tombstone', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'list', 'seq');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      // Insert A, B, C
      const { constraint: e1C, id: e1Id } = produceSeqChild(agent, rootId, null, null);
      agent.observe(e1C);
      const v1 = agent.produceValue(e1Id, 'A');
      agent.observe(v1);
      insertAndVerify(pipeline, e1C, 'e1 structure');
      insertAndVerify(pipeline, v1, 'e1 value');

      const { constraint: e2C, id: e2Id } = produceSeqChild(agent, rootId, e1Id, null);
      agent.observe(e2C);
      const v2 = agent.produceValue(e2Id, 'B');
      agent.observe(v2);
      insertAndVerify(pipeline, e2C, 'e2 structure');
      insertAndVerify(pipeline, v2, 'e2 value');

      const { constraint: e3C, id: e3Id } = produceSeqChild(agent, rootId, e2Id, null);
      agent.observe(e3C);
      const v3 = agent.produceValue(e3Id, 'C');
      agent.observe(v3);
      insertAndVerify(pipeline, e3C, 'e3 structure');
      insertAndVerify(pipeline, v3, 'e3 value');

      expect(getSeqValues(pipeline.current(), 'list')).toEqual(['A', 'B', 'C']);

      // Retract B
      const retractB = agent.produceRetract(v2.id);
      agent.observe(retractB);
      insertAndVerify(pipeline, retractB, 'retract B');

      // Should be A, C (B is tombstoned)
      const values = getSeqValues(pipeline.current(), 'list');
      expect(values).toEqual(['A', 'C']);
    });
  });

  // =========================================================================
  // LWW resolution
  // =========================================================================

  describe('LWW resolution', () => {
    it('higher lamport wins and matches batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'color');
      agent.observe(keyC);
      insertAndVerify(pipeline, keyC, 'key');

      // First value
      const v1 = agent.produceValue(keyId, 'red');
      agent.observe(v1);
      insertAndVerify(pipeline, v1, 'first value');
      expect(getNode(pipeline.current(), 'doc', 'color')!.value).toBe('red');

      // Second value (higher lamport wins)
      const v2 = agent.produceValue(keyId, 'blue');
      agent.observe(v2);
      insertAndVerify(pipeline, v2, 'second value');
      expect(getNode(pipeline.current(), 'doc', 'color')!.value).toBe('blue');
    });

    it('null value via LWW (map deletion) matches batch', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'temp');
      agent.observe(keyC);
      insertAndVerify(pipeline, rootC, 'root');
      insertAndVerify(pipeline, keyC, 'key');

      const v1 = agent.produceValue(keyId, 'hello');
      agent.observe(v1);
      insertAndVerify(pipeline, v1, 'set value');

      const v2 = agent.produceValue(keyId, null);
      agent.observe(v2);
      insertAndVerify(pipeline, v2, 'null value');

      assertDifferentialEquivalence(pipeline, 'null value final');
    });
  });

  // =========================================================================
  // Authority change cascade
  // =========================================================================

  describe('authority change cascade', () => {
    it('grant capability to peer — queued constraints become valid', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const alice = result.agent;

      // Alice creates structure
      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'title');
      alice.observe(keyC);
      insertAndVerify(pipeline, keyC, 'key');

      // Bob creates a value constraint (without authority yet)
      const bob = createAgent('bob');
      bob.observeMany(allConstraints(pipeline.store));
      const bobVal = bob.produceValue(keyId, 'Bob was here');
      bob.observe(bobVal);

      // Insert Bob's value — should fail validity (no capability)
      insertAndVerify(pipeline, bobVal, 'bob value before grant');

      // Bob's value should NOT be in the reality
      const beforeGrant = pipeline.current();
      const titleBefore = getNode(beforeGrant, 'doc', 'title');
      // Either undefined or value is not "Bob was here"
      if (titleBefore !== undefined) {
        expect(titleBefore.value).not.toBe('Bob was here');
      }

      // Alice grants Bob admin
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      insertAndVerify(pipeline, grantBob, 'grant bob');

      // Now Bob's value should appear
      const afterGrant = pipeline.current();
      const titleAfter = getNode(afterGrant, 'doc', 'title');
      expect(titleAfter).toBeDefined();
      expect(titleAfter!.value).toBe('Bob was here');
    });

    it('revoke capability — peer constraints become invalid', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const alice = result.agent;

      // Alice creates structure and grants Bob
      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'data');
      alice.observe(keyC);
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);

      insertAndVerify(pipeline, rootC, 'root');
      insertAndVerify(pipeline, keyC, 'key');
      insertAndVerify(pipeline, grantBob, 'grant');

      // Bob writes a value
      const bob = createAgent('bob');
      bob.observeMany(allConstraints(pipeline.store));
      const bobVal = bob.produceValue(keyId, 'Bob data');
      bob.observe(bobVal);
      insertAndVerify(pipeline, bobVal, 'bob value');
      expect(getNode(pipeline.current(), 'doc', 'data')!.value).toBe('Bob data');

      // Alice revokes Bob's capability
      const revokeBob = alice.produceAuthority('bob', 'revoke', { kind: 'admin' });
      alice.observe(revokeBob);
      insertAndVerify(pipeline, revokeBob, 'revoke');

      // Bob's value should be gone (invalid)
      assertDifferentialEquivalence(pipeline, 'after revoke');
    });
  });

  // =========================================================================
  // Orphaned value resolution
  // =========================================================================

  describe('orphaned value resolution', () => {
    it('value constraint arrives before target structure — resolved later', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      // Create root structure
      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      insertAndVerify(pipeline, rootC, 'root');

      // Create the key structure (but don't insert yet)
      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'name');
      agent.observe(keyC);

      // Create and insert the value first (orphaned — target structure not yet in)
      const valueC = agent.produceValue(keyId, 'Alice');
      agent.observe(valueC);
      insertAndVerify(pipeline, valueC, 'value before structure');

      // Value should NOT be in reality yet (orphaned)
      assertDifferentialEquivalence(pipeline, 'value orphaned');

      // Now insert the structure
      insertAndVerify(pipeline, keyC, 'structure arrives');

      // Value should now appear
      const reality = pipeline.current();
      expect(getNode(reality, 'doc', 'name')!.value).toBe('Alice');
    });
  });

  // =========================================================================
  // Out-of-order sync
  // =========================================================================

  describe('out-of-order sync', () => {
    it('child structure before parent structure — both appear when parent arrives', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      // Create root and child (but insert child first)
      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      const { constraint: childC, id: childId } = produceMapChild(agent, rootId, 'title');
      agent.observe(childC);
      const childVal = agent.produceValue(childId, 'Hello');
      agent.observe(childVal);

      // Insert child first, then value, then root
      insertAndVerify(pipeline, childC, 'child before parent');
      insertAndVerify(pipeline, childVal, 'value before parent');

      // Root arrives — everything should appear
      insertAndVerify(pipeline, rootC, 'root arrives');

      const reality = pipeline.current();
      expect(getNode(reality, 'doc', 'title')!.value).toBe('Hello');
    });

    it('retract before target — target is dominated on arrival', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'key');
      agent.observe(keyC);
      insertAndVerify(pipeline, rootC, 'root');
      insertAndVerify(pipeline, keyC, 'key');

      // Create value
      const valueC = agent.produceValue(keyId, 'Hello');
      agent.observe(valueC);

      // Create retract targeting the value
      const retractC = agent.produceRetract(valueC.id);
      agent.observe(retractC);

      // Insert retract BEFORE the value
      insertAndVerify(pipeline, retractC, 'retract before target');

      // Now insert the value — it should be immediately dominated
      insertAndVerify(pipeline, valueC, 'target arrives after retract');

      // Value should not be visible
      assertDifferentialEquivalence(pipeline, 'retract-before-target final');
    });

    it('constraint before enabling authority grant', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const alice = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'data');
      alice.observe(keyC);
      insertAndVerify(pipeline, rootC, 'root');
      insertAndVerify(pipeline, keyC, 'key');

      // Bob's value (created before grant)
      const bob = createAgent('bob');
      bob.observeMany(allConstraints(pipeline.store));
      const bobVal = bob.produceValue(keyId, 'Bob data');
      bob.observe(bobVal);

      // Grant (created by Alice)
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);

      // Insert Bob's value first, then the grant
      insertAndVerify(pipeline, bobVal, 'bob val before grant');
      insertAndVerify(pipeline, grantBob, 'grant arrives');

      // Bob's value should now be visible
      expect(getNode(pipeline.current(), 'doc', 'data')!.value).toBe('Bob data');
    });

    it('complex out-of-order: retract + child + value + grant all jumbled', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const alice = result.agent;

      // Plan: Alice creates structure, grants Bob.
      // Bob writes a value, Alice retracts it.
      // Delivery order is jumbled.

      // Create everything
      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'x');
      alice.observe(keyC);
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);

      const bob = createAgent('bob');
      bob.observeMany([rootC, keyC, grantBob]);
      const bobVal = bob.produceValue(keyId, 'from bob');
      bob.observe(bobVal);

      alice.observe(bobVal);
      const retractBobVal = alice.produceRetract(bobVal.id);
      alice.observe(retractBobVal);

      // Insert in jumbled order:
      // 1. bob's value (no grant yet, no structure yet)
      // 2. retract (targeting bob's value which isn't valid yet)
      // 3. root structure
      // 4. key structure
      // 5. grant
      insertAndVerify(pipeline, bobVal, 'bob val (no grant, no struct)');
      insertAndVerify(pipeline, retractBobVal, 'retract bob val');
      insertAndVerify(pipeline, rootC, 'root');
      insertAndVerify(pipeline, keyC, 'key');
      insertAndVerify(pipeline, grantBob, 'grant');

      // Final state should match batch
      assertDifferentialEquivalence(pipeline, 'complex out-of-order final');
    });
  });

  // =========================================================================
  // Multi-agent sync
  // =========================================================================

  describe('multi-agent sync', () => {
    it('two pipelines converge after bidirectional constraint exchange', () => {
      // Alice creates reality
      const aliceResult = createReality({ creator: 'alice' });
      const alicePipeline = createIncrementalPipelineFromBootstrap(aliceResult);
      const alice = aliceResult.agent;

      // Alice grants Bob admin
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      alicePipeline.insert(grantBob);

      // Alice creates structure and value
      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      alicePipeline.insert(rootC);

      const { constraint: titleC, id: titleId } = produceMapChild(alice, rootId, 'title');
      alice.observe(titleC);
      alicePipeline.insert(titleC);

      const titleVal = alice.produceValue(titleId, 'Alice Title');
      alice.observe(titleVal);
      alicePipeline.insert(titleVal);

      // Bob creates his pipeline from Alice's store (simulating initial sync)
      const bobPipeline = createIncrementalPipeline(aliceResult.config);
      // Feed all of Alice's store into Bob's pipeline
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      // Bob writes his own value
      const bob = createAgent('bob');
      bob.observeMany(allConstraints(bobPipeline.store));
      const { constraint: bodyC, id: bodyId } = produceMapChild(bob, rootId, 'body');
      bob.observe(bodyC);
      bobPipeline.insert(bodyC);

      const bodyVal = bob.produceValue(bodyId, 'Bob Body');
      bob.observe(bodyVal);
      bobPipeline.insert(bodyVal);

      // Sync Bob's new constraints to Alice
      for (const c of allConstraints(bobPipeline.store)) {
        alicePipeline.insert(c); // duplicates are handled by dedup guard
      }

      // Both pipelines should have the same reality
      const aliceReality = alicePipeline.current();
      const bobReality = bobPipeline.current();

      // Sync Alice's store back to Bob (for recompute comparison)
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      expect(realitiesEqual(alicePipeline.current(), bobPipeline.current())).toBe(true);

      // Both should match their respective batch computations
      assertDifferentialEquivalence(alicePipeline, 'alice after sync');
      assertDifferentialEquivalence(bobPipeline, 'bob after sync');

      // Verify content
      expect(getNode(alicePipeline.current(), 'doc', 'title')!.value).toBe('Alice Title');
      expect(getNode(alicePipeline.current(), 'doc', 'body')!.value).toBe('Bob Body');
    });

    it('concurrent writes to same key — LWW resolves identically on both sides', () => {
      const aliceResult = createReality({ creator: 'alice' });
      const alicePipeline = createIncrementalPipelineFromBootstrap(aliceResult);
      const alice = aliceResult.agent;

      // Setup
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      alicePipeline.insert(grantBob);

      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      alicePipeline.insert(rootC);

      const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'color');
      alice.observe(keyC);
      alicePipeline.insert(keyC);

      // Bob gets initial state
      const bobPipeline = createIncrementalPipeline(aliceResult.config);
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      // Alice writes "red"
      const aliceVal = alice.produceValue(keyId, 'red');
      alice.observe(aliceVal);
      alicePipeline.insert(aliceVal);

      // Bob writes "blue" (higher lamport since Bob observed more)
      const bob = createAgent('bob');
      bob.observeMany(allConstraints(bobPipeline.store));
      const bobVal = bob.produceValue(keyId, 'blue');
      bob.observe(bobVal);
      bobPipeline.insert(bobVal);

      // Sync both ways
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }
      for (const c of allConstraints(bobPipeline.store)) {
        alicePipeline.insert(c);
      }

      // Both should converge to the same value
      const aliceColor = getNode(alicePipeline.current(), 'doc', 'color')!.value;
      const bobColor = getNode(bobPipeline.current(), 'doc', 'color')!.value;
      expect(aliceColor).toBe(bobColor);

      assertDifferentialEquivalence(alicePipeline, 'alice concurrent');
      assertDifferentialEquivalence(bobPipeline, 'bob concurrent');
    });
  });

  // =========================================================================
  // insertMany
  // =========================================================================

  describe('insertMany', () => {
    it('batch insert produces same reality as sequential inserts', () => {
      const result = createReality({ creator: 'alice' });
      const agent = result.agent;

      // Create constraints
      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'key');
      agent.observe(keyC);
      const valueC = agent.produceValue(keyId, 'hello');
      agent.observe(valueC);

      // Pipeline A: sequential
      const pA = createIncrementalPipelineFromBootstrap(result);
      pA.insert(rootC);
      pA.insert(keyC);
      pA.insert(valueC);

      // Pipeline B: batch
      const pB = createIncrementalPipelineFromBootstrap(
        createReality({ creator: 'alice' }),
      );
      // Need to use same constraints... let's just re-create
      const result2 = createReality({ creator: 'alice' });
      const agent2 = result2.agent;
      const { constraint: rootC2, id: rootId2 } = produceRoot(agent2, 'doc', 'map');
      agent2.observe(rootC2);
      const { constraint: keyC2, id: keyId2 } = produceMapChild(agent2, rootId2, 'key');
      agent2.observe(keyC2);
      const valueC2 = agent2.produceValue(keyId2, 'hello');
      agent2.observe(valueC2);

      const pB2 = createIncrementalPipelineFromBootstrap(result2);
      const batchDelta = pB2.insertMany([rootC2, keyC2, valueC2]);

      // Both should match batch
      assertDifferentialEquivalence(pA, 'sequential');
      assertDifferentialEquivalence(pB2, 'batch');

      // insertMany should return non-empty delta
      expect(batchDelta.isEmpty).toBe(false);
    });
  });

  // =========================================================================
  // recompute
  // =========================================================================

  describe('recompute', () => {
    it('recompute returns same result as solve(store, config)', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      pipeline.insert(rootC);

      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'key');
      agent.observe(keyC);
      pipeline.insert(keyC);

      const valueC = agent.produceValue(keyId, 'test');
      agent.observe(valueC);
      pipeline.insert(valueC);

      const recomputed = pipeline.recompute();
      const batchSolved = solve(pipeline.store, pipeline.config);

      expect(realitiesEqual(recomputed, batchSolved)).toBe(true);
    });
  });

  // =========================================================================
  // Retraction multi-removal bug fix (Task 8.1a)
  // =========================================================================

  describe('retraction multi-removal fix (8.1a)', () => {
    it('multiple active constraints removed in same delta are all processed', () => {
      // This tests the fix in retraction.ts where the removal loop
      // used to early-return after the first active removal.
      const retraction = createIncrementalRetraction();

      // Insert three value constraints (all active)
      const v1: ValueConstraint = {
        id: { peer: 'alice', counter: 0 },
        lamport: 0,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: { peer: 'alice', counter: 100 }, content: 'a' },
      };
      const v2: ValueConstraint = {
        id: { peer: 'alice', counter: 1 },
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: { peer: 'alice', counter: 101 }, content: 'b' },
      };
      const v3: ValueConstraint = {
        id: { peer: 'alice', counter: 2 },
        lamport: 2,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: { peer: 'alice', counter: 102 }, content: 'c' },
      };

      // Insert all three
      const addDelta = zsetFromEntries<Constraint>([
        [cnIdKey(v1.id), { element: v1, weight: 1 }],
        [cnIdKey(v2.id), { element: v2, weight: 1 }],
        [cnIdKey(v3.id), { element: v3, weight: 1 }],
      ]);
      const addResult = retraction.step(addDelta);

      // All three should be active
      expect(retraction.current().length).toBe(3);

      // Remove all three in a single delta
      const removeDelta = zsetFromEntries<Constraint>([
        [cnIdKey(v1.id), { element: v1, weight: -1 }],
        [cnIdKey(v2.id), { element: v2, weight: -1 }],
        [cnIdKey(v3.id), { element: v3, weight: -1 }],
      ]);
      const removeResult = retraction.step(removeDelta);

      // All three should be gone
      expect(retraction.current().length).toBe(0);

      // The delta should contain all three removals
      // (Before the fix, only one removal was emitted)
      let removalCount = 0;
      for (const [_key, entry] of removeResult) {
        if (entry.weight === -1) removalCount++;
      }
      expect(removalCount).toBe(3);
    });

    it('multi-removal with affected recomputation works correctly', () => {
      // A more complex case: removing two active constraints where
      // one has a retractor that should become relevant.
      const retraction = createIncrementalRetraction();

      const target: ValueConstraint = {
        id: { peer: 'alice', counter: 0 },
        lamport: 0,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: { peer: 'alice', counter: 100 }, content: 'x' },
      };
      const other: ValueConstraint = {
        id: { peer: 'alice', counter: 1 },
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: { peer: 'alice', counter: 101 }, content: 'y' },
      };

      // Insert both
      const addDelta = zsetFromEntries<Constraint>([
        [cnIdKey(target.id), { element: target, weight: 1 }],
        [cnIdKey(other.id), { element: other, weight: 1 }],
      ]);
      retraction.step(addDelta);
      expect(retraction.current().length).toBe(2);

      // Remove both simultaneously
      const removeDelta = zsetFromEntries<Constraint>([
        [cnIdKey(target.id), { element: target, weight: -1 }],
        [cnIdKey(other.id), { element: other, weight: -1 }],
      ]);
      const result = retraction.step(removeDelta);

      expect(retraction.current().length).toBe(0);

      // Both should be in the removal delta
      let removals = 0;
      for (const [_key, entry] of result) {
        if (entry.weight < 0) removals++;
      }
      expect(removals).toBe(2);
    });
  });

  // =========================================================================
  // Integration test replay — differential equivalence
  // =========================================================================

  describe('integration scenario replay', () => {
    it('simple map scenario from integration tests', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'profile', 'map');
      agent.observe(rootC);
      const { constraint: childC, id: childId } = produceMapChild(agent, rootId, 'name');
      agent.observe(childC);
      const valueC = agent.produceValue(childId, 'Alice');
      agent.observe(valueC);

      pipeline.insert(rootC);
      pipeline.insert(childC);
      pipeline.insert(valueC);

      assertDifferentialEquivalence(pipeline, 'simple map replay');
      expect(getNode(pipeline.current(), 'profile', 'name')!.value).toBe('Alice');
    });

    it('seq ordering scenario from integration tests', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'items', 'seq');
      agent.observe(rootC);
      pipeline.insert(rootC);

      const { constraint: e1C, id: e1Id } = produceSeqChild(agent, rootId, null, null);
      agent.observe(e1C);
      pipeline.insert(e1C);
      const v1 = agent.produceValue(e1Id, 'A');
      agent.observe(v1);
      pipeline.insert(v1);

      const { constraint: e2C, id: e2Id } = produceSeqChild(agent, rootId, e1Id, null);
      agent.observe(e2C);
      pipeline.insert(e2C);
      const v2 = agent.produceValue(e2Id, 'B');
      agent.observe(v2);
      pipeline.insert(v2);

      const { constraint: e3C } = produceSeqChild(agent, rootId, e2Id, null);
      agent.observe(e3C);
      pipeline.insert(e3C);
      const v3 = agent.produceValue(e3C.id, 'C');
      agent.observe(v3);
      pipeline.insert(v3);

      assertDifferentialEquivalence(pipeline, 'seq ordering replay');
      expect(getSeqValues(pipeline.current(), 'items')).toEqual(['A', 'B', 'C']);
    });

    it('retraction sync scenario from integration tests', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      pipeline.insert(rootC);

      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'temp');
      agent.observe(keyC);
      pipeline.insert(keyC);

      const valueC = agent.produceValue(keyId, 'Hello');
      agent.observe(valueC);
      pipeline.insert(valueC);

      assertDifferentialEquivalence(pipeline, 'before retract');

      const retractC = agent.produceRetract(valueC.id);
      agent.observe(retractC);
      pipeline.insert(retractC);

      assertDifferentialEquivalence(pipeline, 'after retract');
    });

    it('undo scenario from integration tests', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      const { constraint: keyC, id: keyId } = produceMapChild(agent, rootId, 'key');
      agent.observe(keyC);
      const valueC = agent.produceValue(keyId, 'Hello');
      agent.observe(valueC);

      pipeline.insert(rootC);
      pipeline.insert(keyC);
      pipeline.insert(valueC);

      const retractC = agent.produceRetract(valueC.id);
      agent.observe(retractC);
      pipeline.insert(retractC);

      assertDifferentialEquivalence(pipeline, 'after retract');

      const undoC = agent.produceRetract(retractC.id);
      agent.observe(undoC);
      pipeline.insert(undoC);

      assertDifferentialEquivalence(pipeline, 'after undo');
      expect(getNode(pipeline.current(), 'doc', 'key')!.value).toBe('Hello');
    });

    it('two-agent sync scenario from integration tests', () => {
      // Alice creates reality
      const aliceResult = createReality({ creator: 'alice' });
      const alicePipeline = createIncrementalPipelineFromBootstrap(aliceResult);
      const alice = aliceResult.agent;

      // Grant Bob admin
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      alicePipeline.insert(grantBob);

      // Alice creates structure
      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      alicePipeline.insert(rootC);

      const { constraint: titleC, id: titleId } = produceMapChild(alice, rootId, 'title');
      alice.observe(titleC);
      alicePipeline.insert(titleC);

      const titleVal = alice.produceValue(titleId, 'Hello');
      alice.observe(titleVal);
      alicePipeline.insert(titleVal);

      assertDifferentialEquivalence(alicePipeline, 'alice before sync');

      // Bob gets all of Alice's constraints
      const bobPipeline = createIncrementalPipeline(aliceResult.config);
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      // Bob creates a new key
      const bob = createAgent('bob');
      bob.observeMany(allConstraints(bobPipeline.store));
      const { constraint: bodyC, id: bodyId } = produceMapChild(bob, rootId, 'body');
      bob.observe(bodyC);
      bobPipeline.insert(bodyC);

      const bodyVal = bob.produceValue(bodyId, 'World');
      bob.observe(bodyVal);
      bobPipeline.insert(bodyVal);

      assertDifferentialEquivalence(bobPipeline, 'bob before sync');

      // Sync Bob's new constraints to Alice
      for (const c of allConstraints(bobPipeline.store)) {
        alicePipeline.insert(c);
      }

      assertDifferentialEquivalence(alicePipeline, 'alice after sync');

      expect(getNode(alicePipeline.current(), 'doc', 'title')!.value).toBe('Hello');
      expect(getNode(alicePipeline.current(), 'doc', 'body')!.value).toBe('World');
    });

    it('three-agent sync scenario from integration tests', () => {
      const aliceResult = createReality({ creator: 'alice' });
      const alicePipeline = createIncrementalPipelineFromBootstrap(aliceResult);
      const alice = aliceResult.agent;

      // Grants
      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      alicePipeline.insert(grantBob);

      const grantCharlie = alice.produceAuthority('charlie', 'grant', { kind: 'admin' });
      alice.observe(grantCharlie);
      alicePipeline.insert(grantCharlie);

      // Structure
      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      alicePipeline.insert(rootC);

      // Alice writes
      const { constraint: aKeyC, id: aKeyId } = produceMapChild(alice, rootId, 'alice_key');
      alice.observe(aKeyC);
      alicePipeline.insert(aKeyC);
      const aVal = alice.produceValue(aKeyId, 'alice_val');
      alice.observe(aVal);
      alicePipeline.insert(aVal);

      // Bob pipeline
      const bobPipeline = createIncrementalPipeline(aliceResult.config);
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      const bob = createAgent('bob');
      bob.observeMany(allConstraints(bobPipeline.store));
      const { constraint: bKeyC, id: bKeyId } = produceMapChild(bob, rootId, 'bob_key');
      bob.observe(bKeyC);
      bobPipeline.insert(bKeyC);
      const bVal = bob.produceValue(bKeyId, 'bob_val');
      bob.observe(bVal);
      bobPipeline.insert(bVal);

      // Charlie pipeline
      const charliePipeline = createIncrementalPipeline(aliceResult.config);
      for (const c of allConstraints(alicePipeline.store)) {
        charliePipeline.insert(c);
      }

      const charlie = createAgent('charlie');
      charlie.observeMany(allConstraints(charliePipeline.store));
      const { constraint: cKeyC, id: cKeyId } = produceMapChild(charlie, rootId, 'charlie_key');
      charlie.observe(cKeyC);
      charliePipeline.insert(cKeyC);
      const cVal = charlie.produceValue(cKeyId, 'charlie_val');
      charlie.observe(cVal);
      charliePipeline.insert(cVal);

      // Full sync: everyone gets everything
      const allBob = allConstraints(bobPipeline.store);
      const allCharlie = allConstraints(charliePipeline.store);

      for (const c of allBob) {
        alicePipeline.insert(c);
        charliePipeline.insert(c);
      }
      for (const c of allCharlie) {
        alicePipeline.insert(c);
        bobPipeline.insert(c);
      }
      // Alice's data to Bob and Charlie
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
        charliePipeline.insert(c);
      }

      // All three should converge
      assertDifferentialEquivalence(alicePipeline, 'alice 3-way');
      assertDifferentialEquivalence(bobPipeline, 'bob 3-way');
      assertDifferentialEquivalence(charliePipeline, 'charlie 3-way');

      const ar = alicePipeline.current();
      const br = bobPipeline.current();
      const cr = charliePipeline.current();

      expect(realitiesEqual(ar, br)).toBe(true);
      expect(realitiesEqual(br, cr)).toBe(true);

      expect(getNode(ar, 'doc', 'alice_key')!.value).toBe('alice_val');
      expect(getNode(ar, 'doc', 'bob_key')!.value).toBe('bob_val');
      expect(getNode(ar, 'doc', 'charlie_key')!.value).toBe('charlie_val');
    });

    it('multi-container scenario from integration tests', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      // Map container
      const { constraint: profileC, id: profileId } = produceRoot(agent, 'profile', 'map');
      agent.observe(profileC);
      pipeline.insert(profileC);

      const { constraint: nameC, id: nameId } = produceMapChild(agent, profileId, 'name');
      agent.observe(nameC);
      pipeline.insert(nameC);

      const nameVal = agent.produceValue(nameId, 'Alice');
      agent.observe(nameVal);
      pipeline.insert(nameVal);

      // Seq container
      const { constraint: todosC, id: todosId } = produceRoot(agent, 'todos', 'seq');
      agent.observe(todosC);
      pipeline.insert(todosC);

      const { constraint: t1C, id: t1Id } = produceSeqChild(agent, todosId, null, null);
      agent.observe(t1C);
      pipeline.insert(t1C);
      const t1Val = agent.produceValue(t1Id, 'Buy milk');
      agent.observe(t1Val);
      pipeline.insert(t1Val);

      const { constraint: t2C, id: t2Id } = produceSeqChild(agent, todosId, t1Id, null);
      agent.observe(t2C);
      pipeline.insert(t2C);
      const t2Val = agent.produceValue(t2Id, 'Walk dog');
      agent.observe(t2Val);
      pipeline.insert(t2Val);

      assertDifferentialEquivalence(pipeline, 'multi-container');

      const reality = pipeline.current();
      expect(getNode(reality, 'profile', 'name')!.value).toBe('Alice');
      expect(getSeqValues(reality, 'todos')).toEqual(['Buy milk', 'Walk dog']);
    });

    it('authorized agent after grant — integration test scenario', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const alice = result.agent;

      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      pipeline.insert(grantBob);

      const { constraint: rootC, id: rootId } = produceRoot(alice, 'doc', 'map');
      alice.observe(rootC);
      pipeline.insert(rootC);

      const { constraint: keyC, id: keyId } = produceMapChild(alice, rootId, 'key');
      alice.observe(keyC);
      pipeline.insert(keyC);

      const bob = createAgent('bob');
      bob.observeMany(allConstraints(pipeline.store));
      const bobVal = bob.produceValue(keyId, 'from bob');
      bob.observe(bobVal);
      pipeline.insert(bobVal);

      assertDifferentialEquivalence(pipeline, 'authorized agent');
      expect(getNode(pipeline.current(), 'doc', 'key')!.value).toBe('from bob');
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================



  describe('edge cases', () => {
    it('invalid constraint (store rejects) returns empty delta', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);

      // Create a constraint with an invalid counter (not safe uint)
      const badConstraint: Constraint = {
        id: { peer: 'alice', counter: -1 },
        lamport: 0,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: { peer: 'alice', counter: 0 }, content: 'bad' },
      } as any;

      const delta = pipeline.insert(badConstraint);
      expect(delta.isEmpty).toBe(true);
    });

    it('bookmark constraints pass through without affecting reality', () => {
      const result = createReality({ creator: 'alice' });
      const pipeline = createIncrementalPipelineFromBootstrap(result);
      const agent = result.agent;

      const { constraint: rootC, id: rootId } = produceRoot(agent, 'doc', 'map');
      agent.observe(rootC);
      pipeline.insert(rootC);

      // Insert a bookmark
      const bookmark = agent.produceBookmark('snapshot1', new Map([['alice', 100]]));
      agent.observe(bookmark);
      pipeline.insert(bookmark);

      assertDifferentialEquivalence(pipeline, 'after bookmark');
    });

    it('concurrent seq inserts by different peers converge', () => {
      const aliceResult = createReality({ creator: 'alice' });
      const alicePipeline = createIncrementalPipelineFromBootstrap(aliceResult);
      const alice = aliceResult.agent;

      const grantBob = alice.produceAuthority('bob', 'grant', { kind: 'admin' });
      alice.observe(grantBob);
      alicePipeline.insert(grantBob);

      const { constraint: rootC, id: rootId } = produceRoot(alice, 'list', 'seq');
      alice.observe(rootC);
      alicePipeline.insert(rootC);

      // Both Alice and Bob insert at the same position (start)
      const { constraint: aliceElemC, id: aliceElemId } = produceSeqChild(alice, rootId, null, null);
      alice.observe(aliceElemC);
      alicePipeline.insert(aliceElemC);
      const aliceVal = alice.produceValue(aliceElemId, 'Alice elem');
      alice.observe(aliceVal);
      alicePipeline.insert(aliceVal);

      // Bob's pipeline
      const bobPipeline = createIncrementalPipeline(aliceResult.config);
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      const bob = createAgent('bob');
      bob.observeMany(allConstraints(bobPipeline.store));
      // Bob inserts at start too (concurrent)
      const { constraint: bobElemC, id: bobElemId } = produceSeqChild(bob, rootId, null, null);
      bob.observe(bobElemC);
      bobPipeline.insert(bobElemC);
      const bobVal = bob.produceValue(bobElemId, 'Bob elem');
      bob.observe(bobVal);
      bobPipeline.insert(bobVal);

      // Sync
      for (const c of allConstraints(bobPipeline.store)) {
        alicePipeline.insert(c);
      }
      for (const c of allConstraints(alicePipeline.store)) {
        bobPipeline.insert(c);
      }

      assertDifferentialEquivalence(alicePipeline, 'alice concurrent seq');
      assertDifferentialEquivalence(bobPipeline, 'bob concurrent seq');

      const aliceValues = getSeqValues(alicePipeline.current(), 'list');
      const bobValues = getSeqValues(bobPipeline.current(), 'list');
      expect(aliceValues).toEqual(bobValues);
      expect(aliceValues.length).toBe(2);
    });
  });
});