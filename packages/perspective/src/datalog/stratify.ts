// === Datalog Stratification ===
// Implements dependency graph construction, SCC detection, stratification
// validation, and stratum ordering.
//
// Stratified negation requires that negated predicates are fully computed
// at a lower stratum before being used. Cyclic negation is rejected with
// a Result error.
//
// References:
// - unified-engine.md §14 (stratification layers)
// - unified-engine.md §B.3 (evaluator requirements)
// - Apt, Blair, Walker, "Towards a Theory of Declarative Knowledge" (1988)

import type {
  Rule,
  BodyElement,
  Result,
  StratificationError,
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
// Stratification
//
// Assigns each predicate to a stratum (non-negative integer) such that:
// 1. If A depends positively on B, stratum(A) >= stratum(B)
// 2. If A depends negatively on B, stratum(A) > stratum(B)
//
// This is impossible when there's a cycle through a negative edge
// (cyclic negation). We detect this and return an error.
// ---------------------------------------------------------------------------

export interface Stratum {
  /** The stratum index (0-based). Lower strata are evaluated first. */
  readonly index: number;
  /** Predicates in this stratum. */
  readonly predicates: ReadonlySet<string>;
  /** Rules whose heads are in this stratum. */
  readonly rules: readonly Rule[];
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

  // Compute stratum for each SCC using topological ordering.
  // Tarjan returns SCCs in reverse topological order: index 0 is a sink
  // (leaf/dependency), last index is a source (root/dependent).
  // We process from index 0 forward so that dependencies are assigned
  // strata before their dependents.
  const sccStratum = new Array<number>(sccs.length).fill(0);

  // Process SCCs in forward order (leaves/dependencies first)
  for (let i = 0; i < sccs.length; i++) {
    const scc = sccs[i]!;
    let maxStratum = 0;

    for (const pred of scc) {
      const edges = graph.adjacency.get(pred) ?? [];
      for (const edge of edges) {
        const targetScc = predicateToScc.get(edge.to);
        if (targetScc === undefined) continue;

        // Skip self-SCC edges (already handled by cyclic negation check)
        if (targetScc === i) continue;

        const targetStratum = sccStratum[targetScc]!;
        if (edge.negative) {
          // Negative dependency: must be strictly greater
          maxStratum = Math.max(maxStratum, targetStratum + 1);
        } else {
          // Positive dependency: must be at least equal
          maxStratum = Math.max(maxStratum, targetStratum);
        }
      }
    }

    sccStratum[i] = maxStratum;
  }

  // Step 3: Build stratum assignments for predicates.
  const predicateStratum = new Map<string, number>();
  for (let i = 0; i < sccs.length; i++) {
    for (const pred of sccs[i]!) {
      predicateStratum.set(pred, sccStratum[i]!);
    }
  }

  // Step 4: Group predicates and rules by stratum.
  const maxStratum = Math.max(...sccStratum, 0);
  const strata: Stratum[] = [];

  for (let s = 0; s <= maxStratum; s++) {
    const preds = new Set<string>();
    for (const [pred, stratum] of predicateStratum) {
      if (stratum === s) {
        preds.add(pred);
      }
    }

    const stratumRules = rules.filter((r) => predicateStratum.get(r.head.predicate) === s);

    // Only include non-empty strata
    if (preds.size > 0 || stratumRules.length > 0) {
      strata.push({
        index: s,
        predicates: preds,
        rules: stratumRules,
      });
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