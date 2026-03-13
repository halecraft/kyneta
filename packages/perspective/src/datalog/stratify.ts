// === Datalog Stratification ===
// Implements dependency graph construction, SCC detection, stratification
// validation, and stratum ordering.
//
// Stratified negation requires that negated predicates are fully computed
// at a lower stratum before being used. Cyclic negation is rejected with
// a Result error.
//
// Plan 007 Phase 1 additions:
// - Finer-grained stratification: independent SCCs at the same dependency
//   level are split into separate strata via connected-component analysis.
//   Ground predicates (never appearing as rule heads) are excluded from
//   the connectivity test — they are inputs, not intermediates.
// - Partition key extraction: for each stratum, compute the intersection
//   of variables shared across all rules' heads and body atoms.
// - Stratum gains a `partitionKey` field populated during stratification.
//
// References:
// - unified-engine.md §14 (stratification layers)
// - unified-engine.md §B.3 (evaluator requirements)
// - Apt, Blair, Walker, "Towards a Theory of Declarative Knowledge" (1988)
// - .plans/007-partitioned-settling.md § Phase 1

import type {
  Rule,
  BodyElement,
  Result,
  StratificationError,
  Term,
} from './types.js';
import { ok, err } from './types.js';

// ---------------------------------------------------------------------------
// Dependency Graph
//
// Nodes are predicate names. Edges represent dependencies:
// - Positive edge: head depends on body predicate (no negation)
// - Negative edge: head depends on negated body predicate
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  readonly from: string; // head predicate
  readonly to: string;   // body predicate
  readonly negative: boolean;
}

export interface DependencyGraph {
  /** All predicate names that appear as heads or in bodies. */
  readonly predicates: ReadonlySet<string>;
  /** All edges in the graph. */
  readonly edges: readonly DependencyEdge[];
  /** Adjacency list: predicate -> edges from that predicate. */
  readonly adjacency: ReadonlyMap<string, readonly DependencyEdge[]>;
}

/**
 * Build a dependency graph from a set of rules.
 *
 * For each rule:
 * - The head predicate is a node.
 * - Each positive body atom creates a positive edge from head to body predicate.
 * - Each negated body atom creates a negative edge from head to body predicate.
 * - Each aggregation source atom creates a negative edge (aggregation, like negation,
 *   requires the source to be fully computed before use — it's stratified).
 */
export function buildDependencyGraph(rules: readonly Rule[]): DependencyGraph {
  const predicates = new Set<string>();
  const edges: DependencyEdge[] = [];
  const adjacency = new Map<string, DependencyEdge[]>();

  function addEdge(from: string, to: string, negative: boolean): void {
    const edge: DependencyEdge = { from, to, negative };
    edges.push(edge);
    let list = adjacency.get(from);
    if (list === undefined) {
      list = [];
      adjacency.set(from, list);
    }
    list.push(edge);
  }

  for (const rule of rules) {
    const headPred = rule.head.predicate;
    predicates.add(headPred);

    for (const element of rule.body) {
      switch (element.kind) {
        case 'atom': {
          predicates.add(element.atom.predicate);
          addEdge(headPred, element.atom.predicate, false);
          break;
        }
        case 'negation': {
          predicates.add(element.atom.predicate);
          addEdge(headPred, element.atom.predicate, true);
          break;
        }
        case 'aggregation': {
          predicates.add(element.agg.source.predicate);
          // Aggregation requires the source to be fully computed,
          // same as negation — treat as a negative dependency.
          addEdge(headPred, element.agg.source.predicate, true);
          break;
        }
        case 'guard': {
          // Guards are binary constraints on terms — they don't reference
          // any predicate and introduce no dependency edges.
          break;
        }
      }
    }
  }

  return { predicates, edges, adjacency };
}

// ---------------------------------------------------------------------------
// Strongly Connected Components (Tarjan's algorithm)
//
// Used to detect cycles in the dependency graph. A cycle through a negative
// edge means cyclic negation, which is invalid.
// ---------------------------------------------------------------------------

interface TarjanState {
  index: number;
  readonly stack: string[];
  readonly onStack: Set<string>;
  readonly indices: Map<string, number>;
  readonly lowlinks: Map<string, number>;
  readonly sccs: string[][];
}

/**
 * Compute strongly connected components using Tarjan's algorithm.
 * Returns SCCs in reverse topological order (dependencies before dependents).
 */
export function computeSCCs(graph: DependencyGraph): readonly (readonly string[])[] {
  const state: TarjanState = {
    index: 0,
    stack: [],
    onStack: new Set(),
    indices: new Map(),
    lowlinks: new Map(),
    sccs: [],
  };

  for (const pred of graph.predicates) {
    if (!state.indices.has(pred)) {
      strongconnect(pred, graph, state);
    }
  }

  return state.sccs;
}

function strongconnect(v: string, graph: DependencyGraph, state: TarjanState): void {
  state.indices.set(v, state.index);
  state.lowlinks.set(v, state.index);
  state.index++;
  state.stack.push(v);
  state.onStack.add(v);

  const edges = graph.adjacency.get(v) ?? [];
  for (const edge of edges) {
    const w = edge.to;
    if (!state.indices.has(w)) {
      // w has not yet been visited; recurse
      strongconnect(w, graph, state);
      state.lowlinks.set(
        v,
        Math.min(state.lowlinks.get(v)!, state.lowlinks.get(w)!),
      );
    } else if (state.onStack.has(w)) {
      // w is on stack and hence in the current SCC
      state.lowlinks.set(
        v,
        Math.min(state.lowlinks.get(v)!, state.indices.get(w)!),
      );
    }
  }

  // If v is a root node, pop the SCC
  if (state.lowlinks.get(v) === state.indices.get(v)) {
    const scc: string[] = [];
    let w: string;
    do {
      w = state.stack.pop()!;
      state.onStack.delete(w);
      scc.push(w);
    } while (w !== v);
    state.sccs.push(scc);
  }
}

// ---------------------------------------------------------------------------
// Partition Key Extraction
//
// For each stratum, computes the intersection of variables shared across
// all rules' heads and every body atom (positive + negation). If the
// intersection is non-empty, the stratum is partitionable: all derivations
// for facts sharing the same partition key values are independent.
//
// Guards and aggregation body elements are excluded from the intersection.
//
// See .plans/007-partitioned-settling.md § Architecture: Partition Key
// Extraction and theory/partitioned-settling.md §3.2.
// ---------------------------------------------------------------------------

/**
 * Information about a stratum's partition key.
 */
export interface PartitionKeyInfo {
  /** Variable names that form the partition key (empty = not partitionable). */
  readonly variables: readonly string[];
  /** For each derived predicate, the tuple positions of PK variables. */
  readonly headPositions: ReadonlyMap<string, readonly number[]>;
  /** For each input predicate, the tuple positions of PK variables. */
  readonly bodyPositions: ReadonlyMap<string, readonly number[]>;
}

/** The empty partition key — stratum is not partitionable. */
const EMPTY_PARTITION_KEY: PartitionKeyInfo = {
  variables: [],
  headPositions: new Map(),
  bodyPositions: new Map(),
};

/**
 * Extract variable names from a term list.
 * Returns a map from variable name to the set of positions where it appears.
 */
function extractVariablePositions(terms: readonly Term[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i]!;
    if (term.kind === 'var') {
      let positions = result.get(term.name);
      if (positions === undefined) {
        positions = new Set();
        result.set(term.name, positions);
      }
      positions.add(i);
    }
  }
  return result;
}

/**
 * Extract variable names from body atoms (positive and negation only).
 * Returns a set of variable names for each atom.
 */
function bodyAtomVariableSets(body: readonly BodyElement[]): {
  varSets: Set<string>[];
  atomPredicates: string[];
  atomTerms: (readonly Term[])[];
} {
  const varSets: Set<string>[] = [];
  const atomPredicates: string[] = [];
  const atomTerms: (readonly Term[])[] = [];

  for (const elem of body) {
    if (elem.kind === 'atom' || elem.kind === 'negation') {
      const atomObj = elem.kind === 'atom' ? elem.atom : elem.atom;
      const vars = new Set<string>();
      for (const term of atomObj.terms) {
        if (term.kind === 'var') {
          vars.add(term.name);
        }
      }
      varSets.push(vars);
      atomPredicates.push(atomObj.predicate);
      atomTerms.push(atomObj.terms);
    }
    // Guards and aggregation are excluded from PK analysis.
  }

  return { varSets, atomPredicates, atomTerms };
}

/**
 * Extract the partition key for a set of rules in a single stratum.
 *
 * Algorithm:
 * 1. Compute the cross-rule head variable intersection — variables that
 *    appear in every rule's head. This is the maximum possible PK.
 * 2. For each rule, validate whether the candidate PK is supported:
 *    every body atom must either contain the PK variables directly, or
 *    be "PK-covered" (a functional lookup whose variables are fully
 *    reachable through other atoms that do contain the PK).
 * 3. Narrow the candidate if any PK-required atom doesn't contain all
 *    candidate variables. Iterate until stable.
 * 4. Map surviving variables to tuple positions in each predicate.
 *
 * **Functional-lookup relaxation:** A body atom like
 * `constraint_peer(CnId, Peer)` doesn't need to contain the PK variable
 * `Parent` if its join variable `CnId` is already bound by another atom
 * `active_structure_seq(CnId, Parent, ...)` that does. The lookup is
 * "scoped through" the partition key — for a fixed `Parent`, the set of
 * matching `constraint_peer` facts is fully determined. This relaxation
 * recovers PK = `{Parent}` for the `fugue_child` rule, which the strict
 * per-rule intersection would miss (it would return `{CnId}` instead).
 *
 * The key insight: computing per-rule PKs independently and then
 * intersecting can fail when different rules have different strict PKs
 * (e.g., `{CnId}` for fugue_child vs `{Parent}` for fugue_descendant).
 * By computing the cross-rule head intersection first (`{Parent}`), we
 * give the relaxation the correct target to validate against.
 *
 * Returns `EMPTY_PARTITION_KEY` if:
 * - No rules
 * - Any rule has no positive/negation body atoms
 * - No variable survives the cross-rule validation
 */
export function extractPartitionKey(rules: readonly Rule[]): PartitionKeyInfo {
  if (rules.length === 0) return EMPTY_PARTITION_KEY;

  // Phase 1: Compute cross-rule head variable intersection.
  // This is the maximum possible PK — variables present in every rule's head.
  let pkCandidate: Set<string> | null = null;

  for (const rule of rules) {
    const headVars = new Set<string>();
    for (const term of rule.head.terms) {
      if (term.kind === 'var') {
        headVars.add(term.name);
      }
    }

    if (pkCandidate === null) {
      pkCandidate = headVars;
    } else {
      const intersection = new Set<string>();
      for (const v of pkCandidate) {
        if (headVars.has(v)) {
          intersection.add(v);
        }
      }
      pkCandidate = intersection;
    }

    if (pkCandidate.size === 0) {
      return EMPTY_PARTITION_KEY;
    }
  }

  if (pkCandidate === null || pkCandidate.size === 0) {
    return EMPTY_PARTITION_KEY;
  }

  // Phase 2: Validate and narrow the candidate PK against each rule's
  // body atoms, using the functional-lookup relaxation.
  //
  // For each rule, we check whether the candidate PK is supported:
  // every body atom must either contain the PK variables, or be
  // PK-covered (all its variables are reachable from the PK through
  // other atoms). PK-required atoms (those not covered) must contain
  // the PK variables — if they don't, the PK is narrowed.

  for (const rule of rules) {
    const { varSets } = bodyAtomVariableSets(rule.body);

    if (varSets.length === 0) {
      // Rule has no positive/negation body atoms — can't partition.
      return EMPTY_PARTITION_KEY;
    }

    // Validate this rule against the current pkCandidate using relaxation.
    const validated = validateRulePK(pkCandidate, varSets);

    if (validated.size === 0) {
      return EMPTY_PARTITION_KEY;
    }

    // Narrow the candidate if this rule doesn't support all PK vars.
    if (validated.size < pkCandidate.size) {
      pkCandidate = validated;
    }
  }

  // If pkCandidate shrank during validation, re-validate all rules with
  // the narrower candidate (coverage classification may change).
  // Iterate until stable.
  let stable = false;
  for (let iter = 0; iter < rules.length && !stable; iter++) {
    stable = true;
    for (const rule of rules) {
      const { varSets } = bodyAtomVariableSets(rule.body);
      const validated = validateRulePK(pkCandidate, varSets);
      if (validated.size === 0) return EMPTY_PARTITION_KEY;
      if (validated.size < pkCandidate.size) {
        pkCandidate = validated;
        stable = false;
      }
    }
  }

  const crossRulePK = pkCandidate;

  // Phase 2: Sort PK variables for deterministic ordering.
  const pkVars = [...crossRulePK].sort();

  // Phase 3: Map PK variables to tuple positions in each predicate.
  const headPositions = new Map<string, readonly number[]>();
  const bodyPositions = new Map<string, readonly number[]>();

  // Collect all atoms (head + body) across all rules.
  for (const rule of rules) {
    // Head predicate positions.
    if (!headPositions.has(rule.head.predicate)) {
      const varPos = extractVariablePositions(rule.head.terms);
      const positions: number[] = [];
      for (const v of pkVars) {
        const posSet = varPos.get(v);
        if (posSet !== undefined && posSet.size > 0) {
          // Take the first position (each PK var should appear at
          // a unique position in a well-formed head).
          positions.push([...posSet][0]!);
        }
      }
      headPositions.set(rule.head.predicate, positions);
    }

    // Body predicate positions.
    const { atomPredicates, atomTerms } = bodyAtomVariableSets(rule.body);
    for (let i = 0; i < atomPredicates.length; i++) {
      const pred = atomPredicates[i]!;
      if (!bodyPositions.has(pred)) {
        const varPos = extractVariablePositions(atomTerms[i]!);
        const positions: number[] = [];
        for (const v of pkVars) {
          const posSet = varPos.get(v);
          if (posSet !== undefined && posSet.size > 0) {
            positions.push([...posSet][0]!);
          }
        }
        bodyPositions.set(pred, positions);
      }
    }
  }

  return {
    variables: pkVars,
    headPositions,
    bodyPositions,
  };
}

// ---------------------------------------------------------------------------
// Per-rule PK validation with functional-lookup relaxation
//
// Given a PK candidate (from cross-rule head intersection), validates
// whether a single rule supports that PK. Body atoms that are
// "PK-covered" (functional lookups whose variables are fully reachable
// through other atoms that contain the PK) are excluded from the
// intersection. Only PK-required atoms must contain the PK variables.
//
// Example:
//   fugue_child(Parent, CnId, OL, OR, Peer) :-
//     active_structure_seq(CnId, Parent, OL, OR),   -- has Parent ✅
//     constraint_peer(CnId, Peer).                   -- no Parent, but
//                                                       CnId is bound by
//                                                       the first atom
//
// With pkCandidate = {Parent}:
//   Reachable from {Parent}: Parent → (atom1) → CnId, OL, OR → (atom2) → Peer
//   Atom 2 is PK-covered (all vars reachable). PK-required = {atom1}.
//   Parent ∈ atom1 → validated PK = {Parent} ✅
// ---------------------------------------------------------------------------

/**
 * Validate a PK candidate against a single rule's body atoms.
 *
 * Returns the subset of pkCandidate that survives validation (may be
 * narrower than the input if some PK-required atoms don't contain all
 * candidate variables). Returns empty set if no PK survives.
 *
 * @param pkCandidate - The candidate PK variables to validate.
 * @param varSets     - Variable sets for each body atom (positive + negation).
 */
function validateRulePK(
  pkCandidate: ReadonlySet<string>,
  varSets: readonly ReadonlySet<string>[],
): Set<string> {
  // Compute reachable variables from pkCandidate through body atoms.
  // Start with pkCandidate, then iteratively add vars from atoms
  // whose variables overlap the reachable set.
  const reachable = new Set(pkCandidate);
  let changed = true;
  while (changed) {
    changed = false;
    for (const atomVars of varSets) {
      let hasOverlap = false;
      for (const v of atomVars) {
        if (reachable.has(v)) {
          hasOverlap = true;
          break;
        }
      }
      if (hasOverlap) {
        for (const v of atomVars) {
          if (!reachable.has(v)) {
            reachable.add(v);
            changed = true;
          }
        }
      }
    }
  }

  // Classify atoms as PK-covered or PK-required.
  // PK-covered: all vars ⊆ reachable (functional lookup — doesn't
  // introduce cross-partition dependencies).
  // PK-required: some var not reachable — must contain PK vars.
  let result = new Set(pkCandidate);
  for (const atomVars of varSets) {
    let allReachable = true;
    for (const v of atomVars) {
      if (!reachable.has(v)) {
        allReachable = false;
        break;
      }
    }

    if (!allReachable) {
      // PK-required atom — intersect result with its vars.
      const intersection = new Set<string>();
      for (const v of result) {
        if (atomVars.has(v)) {
          intersection.add(v);
        }
      }
      result = intersection;
      if (result.size === 0) return result;
    }
    // PK-covered atom — skip (doesn't constrain PK).
  }

  return result;
}

// ---------------------------------------------------------------------------
// Stratification
//
// Assigns each predicate to a stratum (non-negative integer) such that:
// 1. If A depends positively on B, stratum(A) >= stratum(B)
// 2. If A depends negatively on B, stratum(A) > stratum(B)
//
// This is impossible when there's a cycle through a negative edge
// (cyclic negation). We detect this and return an error.
//
// Step 4 (Plan 007): Instead of grouping all SCCs at the same dependency
// level into a single stratum, compute connected components among SCCs
// at the same level. Two SCCs are connected if a DERIVED predicate
// produced by one SCC appears in the body of a rule whose head is in
// the other SCC. Ground predicates (those never appearing as a rule
// head) are excluded from the connectivity test — they are inputs, not
// intermediates, and do not create evaluation dependencies between
// derived-predicate families.
// ---------------------------------------------------------------------------

export interface Stratum {
  /** The stratum index (0-based). Lower strata are evaluated first. */
  readonly index: number;
  /** Predicates in this stratum. */
  readonly predicates: ReadonlySet<string>;
  /** Rules whose heads are in this stratum. */
  readonly rules: readonly Rule[];
  /** Partition key information for this stratum. */
  readonly partitionKey: PartitionKeyInfo;
}

/**
 * Stratify a set of rules.
 *
 * Returns strata in evaluation order (stratum 0 first) on success,
 * or a `CyclicNegationError` if stratification is impossible.
 *
 * Ground facts (predicates that appear only in bodies, never in heads)
 * are implicitly at stratum 0. They don't need rules — they're provided
 * as input facts to the evaluator.
 *
 * Independent SCCs at the same dependency level are split into separate
 * strata via connected-component analysis (Plan 007 Phase 1, Task 1.3).
 * This enables per-partition settling for rules that have natural
 * partition structure (e.g., LWW by slot, Fugue by parent).
 */
export function stratify(
  rules: readonly Rule[],
): Result<readonly Stratum[], StratificationError> {
  if (rules.length === 0) {
    return ok([]);
  }

  const graph = buildDependencyGraph(rules);

  // Step 1: Check for cyclic negation.
  // An SCC with more than one node that has an internal negative edge,
  // or a single-node SCC with a negative self-loop, means cyclic negation.
  const sccs = computeSCCs(graph);
  const sccCycleError = checkCyclicNegation(graph, sccs);
  if (sccCycleError !== null) {
    return err(sccCycleError);
  }

  // Step 2: Build the condensation DAG (SCC graph) and assign strata.
  // Each SCC becomes a node. Edges between SCCs inherit the negative flag.
  const predicateToScc = new Map<string, number>();
  for (let i = 0; i < sccs.length; i++) {
    for (const pred of sccs[i]!) {
      predicateToScc.set(pred, i);
    }
  }

  // Compute dependency level for each SCC using topological ordering.
  // Tarjan returns SCCs in reverse topological order: index 0 is a sink
  // (leaf/dependency), last index is a source (root/dependent).
  // We process from index 0 forward so that dependencies are assigned
  // levels before their dependents.
  const sccLevel = new Array<number>(sccs.length).fill(0);

  // Process SCCs in forward order (leaves/dependencies first)
  for (let i = 0; i < sccs.length; i++) {
    const scc = sccs[i]!;
    let maxLevel = 0;

    for (const pred of scc) {
      const edges = graph.adjacency.get(pred) ?? [];
      for (const edge of edges) {
        const targetScc = predicateToScc.get(edge.to);
        if (targetScc === undefined) continue;

        // Skip self-SCC edges (already handled by cyclic negation check)
        if (targetScc === i) continue;

        const targetLevel = sccLevel[targetScc]!;
        if (edge.negative) {
          // Negative dependency: must be strictly greater
          maxLevel = Math.max(maxLevel, targetLevel + 1);
        } else {
          // Positive dependency: must be at least equal
          maxLevel = Math.max(maxLevel, targetLevel);
        }
      }
    }

    sccLevel[i] = maxLevel;
  }

  // Step 3: Identify derived predicates (those that appear as rule heads).
  // Ground predicates (body-only) are excluded from the connectivity
  // test in Step 4.
  const derivedPredicates = headPredicates(rules);

  // Step 4: Group SCCs at the same level into connected components.
  //
  // Two SCCs at the same level are connected if a DERIVED predicate
  // produced by one SCC appears in the body of a rule whose head is
  // in the other SCC. Ground predicates are excluded from connectivity
  // because they are inputs, not intermediates — they don't create
  // evaluation dependencies between derived-predicate families.
  //
  // We also include ground-only SCCs (those with no derived predicates)
  // in whichever component references them — but since they have no
  // rules and produce no derivations, they don't bridge components.

  // Group SCC indices by level.
  const sccsByLevel = new Map<number, number[]>();
  for (let i = 0; i < sccs.length; i++) {
    const level = sccLevel[i]!;
    let list = sccsByLevel.get(level);
    if (list === undefined) {
      list = [];
      sccsByLevel.set(level, list);
    }
    list.push(i);
  }

  // For each level, compute connected components among SCCs using
  // union-find on derived-predicate connectivity.
  //
  // Map: SCC index → component representative SCC index.
  const sccComponent = new Array<number>(sccs.length);
  for (let i = 0; i < sccs.length; i++) {
    sccComponent[i] = i; // Initially each SCC is its own component.
  }

  // Union-find helpers.
  function find(x: number): number {
    while (sccComponent[x] !== x) {
      sccComponent[x] = sccComponent[sccComponent[x]!]!; // path compression
      x = sccComponent[x]!;
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      sccComponent[ra] = rb;
    }
  }

  // Build a map: derived predicate → SCC index that produces it.
  const derivedPredToScc = new Map<string, number>();
  for (let i = 0; i < sccs.length; i++) {
    for (const pred of sccs[i]!) {
      if (derivedPredicates.has(pred)) {
        derivedPredToScc.set(pred, i);
      }
    }
  }

  // For each rule, if its body references a derived predicate from a
  // different SCC at the same level, union the head's SCC with that
  // body predicate's SCC.
  for (const rule of rules) {
    const headScc = predicateToScc.get(rule.head.predicate);
    if (headScc === undefined) continue;
    const headLevel = sccLevel[headScc]!;

    const bodyPreds = bodyPredicates(rule.body);
    for (const bodyPred of bodyPreds) {
      // Only consider derived predicates for connectivity.
      const bodyScc = derivedPredToScc.get(bodyPred);
      if (bodyScc === undefined) continue; // Ground predicate — skip.
      if (bodyScc === headScc) continue;   // Same SCC — already together.

      // Only connect SCCs at the same level.
      if (sccLevel[bodyScc]! !== headLevel) continue;

      union(headScc, bodyScc);
    }
  }

  // Step 5: Build strata from connected components, ordered by
  // (level, component) with sequential indices.

  // Collect components per level.
  interface ComponentInfo {
    readonly level: number;
    readonly sccIndices: number[];
  }

  const componentsByLevel = new Map<number, Map<number, ComponentInfo>>();
  for (let i = 0; i < sccs.length; i++) {
    const level = sccLevel[i]!;
    const comp = find(i);

    let levelMap = componentsByLevel.get(level);
    if (levelMap === undefined) {
      levelMap = new Map();
      componentsByLevel.set(level, levelMap);
    }

    let info = levelMap.get(comp);
    if (info === undefined) {
      info = { level, sccIndices: [] };
      levelMap.set(comp, info);
    }
    info.sccIndices.push(i);
  }

  // Sort levels in ascending order.
  const sortedLevels = [...componentsByLevel.keys()].sort((a, b) => a - b);

  // Build strata with sequential indices.
  const strata: Stratum[] = [];
  let nextIndex = 0;

  for (const level of sortedLevels) {
    const levelMap = componentsByLevel.get(level)!;

    // Sort components deterministically (by smallest SCC index in component).
    const components = [...levelMap.values()].sort(
      (a, b) => Math.min(...a.sccIndices) - Math.min(...b.sccIndices),
    );

    for (const comp of components) {
      // Collect predicates in this component.
      const preds = new Set<string>();
      for (const sccIdx of comp.sccIndices) {
        for (const pred of sccs[sccIdx]!) {
          preds.add(pred);
        }
      }

      // Collect rules whose heads are in this component.
      const componentRules = rules.filter((r) => preds.has(r.head.predicate));

      // Only include non-empty strata (have predicates or rules).
      if (preds.size > 0 || componentRules.length > 0) {
        strata.push({
          index: nextIndex,
          predicates: preds,
          rules: componentRules,
          partitionKey: extractPartitionKey(componentRules),
        });
        nextIndex++;
      }
    }
  }

  return ok(strata);
}

// ---------------------------------------------------------------------------
// Cyclic negation detection
// ---------------------------------------------------------------------------

/**
 * Check for cyclic negation within SCCs.
 *
 * A cycle through a negative edge exists when:
 * - An SCC with >1 node has any negative edge between its members, OR
 * - A single-node SCC has a negative self-loop.
 */
function checkCyclicNegation(
  graph: DependencyGraph,
  sccs: readonly (readonly string[])[],
): StratificationError | null {
  for (const scc of sccs) {
    const sccSet = new Set(scc);

    // Check for negative edges within this SCC
    for (const pred of scc) {
      const edges = graph.adjacency.get(pred) ?? [];
      for (const edge of edges) {
        if (edge.negative && sccSet.has(edge.to)) {
          // Found a negative edge within an SCC — cyclic negation.
          // For a single-node SCC, this is a negative self-loop.
          // For a multi-node SCC, there's a cycle through negation.
          return {
            kind: 'cyclicNegation',
            cycle: [...scc],
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Utility: extract predicates from rule body
// ---------------------------------------------------------------------------

/**
 * Extract all predicate names referenced in a rule's body elements.
 */
export function bodyPredicates(body: readonly BodyElement[]): Set<string> {
  const preds = new Set<string>();
  for (const elem of body) {
    switch (elem.kind) {
      case 'atom':
        preds.add(elem.atom.predicate);
        break;
      case 'negation':
        preds.add(elem.atom.predicate);
        break;
      case 'aggregation':
        preds.add(elem.agg.source.predicate);
        break;
      case 'guard':
        // Guards reference no predicates.
        break;
    }
  }
  return preds;
}

/**
 * Extract all predicate names that appear as heads in a set of rules.
 */
export function headPredicates(rules: readonly Rule[]): Set<string> {
  const preds = new Set<string>();
  for (const r of rules) {
    preds.add(r.head.predicate);
  }
  return preds;
}