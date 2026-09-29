// === Datalog Stratification ===
// Implements dependency graph construction, SCC detection, stratification
// validation, and stratum ordering.
//
// Stratified negation requires that negated predicates are fully computed
// at a lower stratum before being used. Cyclic negation is rejected with
// a Result error.
//
// Finer-grained stratification (Plan 007 Phase 1): independent SCCs at the
// same dependency level are split into separate strata via
// connected-component analysis. Ground predicates (never appearing as rule
// heads) are excluded from the connectivity test — they are inputs, not
// intermediates.
//
// References:
// - `packages/perspective/theory/unified-engine.md` §14 (stratification layers)
// - `packages/perspective/theory/unified-engine.md` §B.3 (evaluator requirements)
// - Apt, Blair, Walker, "Towards a Theory of Declarative Knowledge" (1988)
// - `packages/perspective/.plans/007-partitioned-settling.md` § Phase 1

import { analyzeArity, matchedAtom } from "./arity.js"
import { lookup, nth } from "./checked.js"
import {
  type ForeignRelation,
  foreignRelations,
  type Host,
  hostErrors,
} from "./host.js"
import type { Result } from "./result.js"
import { err, ok } from "./result.js"
import type { BodyElement, ProgramError, Rule } from "./types.js"

// ---------------------------------------------------------------------------
// Dependency Graph
//
// Nodes are predicate names. Edges represent dependencies:
// - Positive edge: head depends on body predicate (no negation)
// - Negative edge: head depends on negated body predicate
// ---------------------------------------------------------------------------

export interface DependencyEdge {
  readonly from: string // head predicate
  readonly to: string // body predicate
  readonly negative: boolean
}

export interface DependencyGraph {
  /** All predicate names that appear as heads or in bodies. */
  readonly predicates: ReadonlySet<string>
  /** All edges in the graph. */
  readonly edges: readonly DependencyEdge[]
  /** Adjacency list: predicate -> edges from that predicate. */
  readonly adjacency: ReadonlyMap<string, readonly DependencyEdge[]>
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
 *
 * For each foreign relation (`host.ts`): a node, and a negative edge to every
 * input. An edge from a rule *into* a foreign predicate is negative as well.
 * Strict in both directions means the relation is alone in its stratum, fully
 * computed before any reader runs and never inside a recursion. The inward
 * strictness is not optional: with a positive edge a reader could share the
 * relation's level, and the order of two strata at one level comes from the
 * SCC numbering, which is topological today by property rather than by rule.
 */
export function buildDependencyGraph(
  rules: readonly Rule[],
  foreign: readonly ForeignRelation[] = [],
): DependencyGraph {
  const predicates = new Set<string>()
  const edges: DependencyEdge[] = []
  const adjacency = new Map<string, DependencyEdge[]>()
  const foreignPreds = new Set(foreign.map(f => f.predicate))

  function addEdge(from: string, to: string, negative: boolean): void {
    const edge: DependencyEdge = { from, to, negative }
    edges.push(edge)
    let list = adjacency.get(from)
    if (list === undefined) {
      list = []
      adjacency.set(from, list)
    }
    list.push(edge)
  }

  for (const rule of rules) {
    const headPred = rule.head.predicate
    predicates.add(headPred)

    for (const element of rule.body) {
      switch (element.kind) {
        case "atom": {
          predicates.add(element.atom.predicate)
          addEdge(
            headPred,
            element.atom.predicate,
            foreignPreds.has(element.atom.predicate),
          )
          break
        }
        case "negation": {
          predicates.add(element.atom.predicate)
          addEdge(headPred, element.atom.predicate, true)
          break
        }
        case "aggregation": {
          predicates.add(element.agg.source.predicate)
          // Aggregation requires the source to be fully computed,
          // same as negation — treat as a negative dependency.
          addEdge(headPred, element.agg.source.predicate, true)
          break
        }
        case "guard":
        case "compute": {
          // Guards and compute elements constrain or bind terms — they
          // reference no predicate and introduce no dependency edges.
          break
        }
      }
    }
  }

  for (const f of foreign) {
    predicates.add(f.predicate)
    for (const input of f.inputs) {
      predicates.add(input)
      addEdge(f.predicate, input, true)
    }
  }

  return { predicates, edges, adjacency }
}

// ---------------------------------------------------------------------------
// Strongly Connected Components (Tarjan's algorithm)
//
// Used to detect cycles in the dependency graph. A cycle through a negative
// edge means cyclic negation, which is invalid.
// ---------------------------------------------------------------------------

interface TarjanState {
  index: number
  readonly stack: string[]
  readonly onStack: Set<string>
  readonly indices: Map<string, number>
  readonly lowlinks: Map<string, number>
  readonly sccs: string[][]
}

/**
 * Compute strongly connected components using Tarjan's algorithm.
 * Returns SCCs in reverse topological order (dependencies before dependents).
 */
export function computeSCCs(
  graph: DependencyGraph,
): readonly (readonly string[])[] {
  const state: TarjanState = {
    index: 0,
    stack: [],
    onStack: new Set(),
    indices: new Map(),
    lowlinks: new Map(),
    sccs: [],
  }

  for (const pred of graph.predicates) {
    if (!state.indices.has(pred)) {
      strongconnect(pred, graph, state)
    }
  }

  return state.sccs
}

function strongconnect(
  v: string,
  graph: DependencyGraph,
  state: TarjanState,
): void {
  state.indices.set(v, state.index)
  state.lowlinks.set(v, state.index)
  state.index++
  state.stack.push(v)
  state.onStack.add(v)

  const edges = graph.adjacency.get(v) ?? []
  for (const edge of edges) {
    const w = edge.to
    if (!state.indices.has(w)) {
      // w has not yet been visited; recurse
      strongconnect(w, graph, state)
      state.lowlinks.set(
        v,
        Math.min(lookup(state.lowlinks, v), lookup(state.lowlinks, w)),
      )
    } else if (state.onStack.has(w)) {
      // w is on stack and hence in the current SCC
      state.lowlinks.set(
        v,
        Math.min(lookup(state.lowlinks, v), lookup(state.indices, w)),
      )
    }
  }

  // If v is a root node, pop the SCC
  if (state.lowlinks.get(v) === state.indices.get(v)) {
    const scc: string[] = []
    // v is on the stack, so the loop stops at it.
    for (let w = state.stack.pop(); w !== undefined; w = state.stack.pop()) {
      state.onStack.delete(w)
      scc.push(w)
      if (w === v) break
    }
    state.sccs.push(scc)
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
  readonly index: number
  /** Predicates in this stratum. */
  readonly predicates: ReadonlySet<string>
  /** Rules whose heads are in this stratum. */
  readonly rules: readonly Rule[]
  /**
   * Set when this stratum is a host-computed relation rather than rules. It
   * then has no rules and exactly one predicate. See `host.ts`.
   */
  readonly foreign?: ForeignRelation
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
  host?: Host,
): Result<readonly Stratum[], ProgramError> {
  // The three checks a rule set has to pass, in the order they can be made:
  // does it fit its host, does it agree with itself about shapes, and does
  // its negation terminate. The first two are pure functions of the rules;
  // the third needs the dependency graph built below.
  const [problem] = hostErrors(rules, host)
  if (problem !== undefined) return err(problem)

  const shapes = analyzeArity(rules, host)
  const [shapeError] = shapes.errors
  if (shapeError !== undefined) return err(shapeError)

  const foreign = foreignRelations(host)
  if (rules.length === 0 && foreign.length === 0) {
    return ok([])
  }

  const graph = buildDependencyGraph(rules, foreign)

  // Step 1: Check for cyclic negation.
  // An SCC with more than one node that has an internal negative edge,
  // or a single-node SCC with a negative self-loop, means cyclic negation.
  const sccs = computeSCCs(graph)
  const sccCycleError = checkCyclicNegation(graph, sccs)
  if (sccCycleError !== null) {
    return err(sccCycleError)
  }

  // Step 2: Build the condensation DAG (SCC graph) and assign strata.
  // Each SCC becomes a node. Edges between SCCs inherit the negative flag.
  const predicateToScc = new Map<string, number>()
  for (const [i, scc] of sccs.entries()) {
    for (const pred of scc) {
      predicateToScc.set(pred, i)
    }
  }

  // Compute dependency level for each SCC using topological ordering.
  // Tarjan returns SCCs in reverse topological order: index 0 is a sink
  // (leaf/dependency), last index is a source (root/dependent).
  // We process from index 0 forward so that dependencies are assigned
  // levels before their dependents.
  const sccLevel = new Array<number>(sccs.length).fill(0)

  // Process SCCs in forward order (leaves/dependencies first)
  for (const [i, scc] of sccs.entries()) {
    let maxLevel = 0

    for (const pred of scc) {
      const edges = graph.adjacency.get(pred) ?? []
      for (const edge of edges) {
        const targetScc = predicateToScc.get(edge.to)
        if (targetScc === undefined) continue

        // Skip self-SCC edges (already handled by cyclic negation check)
        if (targetScc === i) continue

        const targetLevel = nth(sccLevel, targetScc)
        if (edge.negative) {
          // Negative dependency: must be strictly greater
          maxLevel = Math.max(maxLevel, targetLevel + 1)
        } else {
          // Positive dependency: must be at least equal
          maxLevel = Math.max(maxLevel, targetLevel)
        }
      }
    }

    sccLevel[i] = maxLevel
  }

  // Step 3: Identify derived predicates: rule heads, and foreign predicates,
  // which the host derives. Ground predicates (body-only) are excluded from
  // the connectivity test in Step 4.
  const derivedPredicates = headPredicates(rules)
  const foreignByPredicate = new Map(
    foreign.map(f => [f.predicate, f] as const),
  )
  for (const pred of foreignByPredicate.keys()) derivedPredicates.add(pred)

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
  const sccsByLevel = new Map<number, number[]>()
  for (const [i, level] of sccLevel.entries()) {
    let list = sccsByLevel.get(level)
    if (list === undefined) {
      list = []
      sccsByLevel.set(level, list)
    }
    list.push(i)
  }

  // For each level, compute connected components among SCCs using
  // union-find on derived-predicate connectivity.
  //
  // Map: SCC index → component representative SCC index.
  const sccComponent = new Array<number>(sccs.length)
  for (let i = 0; i < sccs.length; i++) {
    sccComponent[i] = i // Initially each SCC is its own component.
  }

  // Union-find helpers.
  function find(x: number): number {
    while (sccComponent[x] !== x) {
      sccComponent[x] = nth(sccComponent, nth(sccComponent, x)) // path compression
      x = nth(sccComponent, x)
    }
    return x
  }

  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) {
      sccComponent[ra] = rb
    }
  }

  // Build a map: derived predicate → SCC index that produces it.
  const derivedPredToScc = new Map<string, number>()
  for (const [i, scc] of sccs.entries()) {
    for (const pred of scc) {
      if (derivedPredicates.has(pred)) {
        derivedPredToScc.set(pred, i)
      }
    }
  }

  // For each rule, if its body references a derived predicate from a
  // different SCC at the same level, union the head's SCC with that
  // body predicate's SCC.
  for (const rule of rules) {
    const headScc = predicateToScc.get(rule.head.predicate)
    if (headScc === undefined) continue
    const headLevel = nth(sccLevel, headScc)

    const bodyPreds = bodyPredicates(rule.body)
    for (const bodyPred of bodyPreds) {
      // Only consider derived predicates for connectivity.
      const bodyScc = derivedPredToScc.get(bodyPred)
      if (bodyScc === undefined) continue // Ground predicate — skip.
      if (bodyScc === headScc) continue // Same SCC — already together.

      // Only connect SCCs at the same level.
      if (nth(sccLevel, bodyScc) !== headLevel) continue

      union(headScc, bodyScc)
    }
  }

  // Step 5: Build strata from connected components, ordered by
  // (level, component) with sequential indices.

  // Collect components per level.
  interface ComponentInfo {
    readonly level: number
    readonly sccIndices: number[]
  }

  const componentsByLevel = new Map<number, Map<number, ComponentInfo>>()
  for (const [i, level] of sccLevel.entries()) {
    const comp = find(i)

    let levelMap = componentsByLevel.get(level)
    if (levelMap === undefined) {
      levelMap = new Map()
      componentsByLevel.set(level, levelMap)
    }

    let info = levelMap.get(comp)
    if (info === undefined) {
      info = { level, sccIndices: [] }
      levelMap.set(comp, info)
    }
    info.sccIndices.push(i)
  }

  // Levels in ascending order.
  const byLevel = [...componentsByLevel].sort(([a], [b]) => a - b)

  // Build strata with sequential indices.
  const strata: Stratum[] = []
  let nextIndex = 0

  for (const [, levelMap] of byLevel) {
    // Sort components deterministically (by smallest SCC index in component).
    const components = [...levelMap.values()].sort(
      (a, b) => Math.min(...a.sccIndices) - Math.min(...b.sccIndices),
    )

    for (const comp of components) {
      // Collect predicates in this component.
      const preds = new Set<string>()
      for (const sccIdx of comp.sccIndices) {
        for (const pred of nth(sccs, sccIdx)) {
          preds.add(pred)
        }
      }

      // Collect rules whose heads are in this component.
      const componentRules = rules.filter(r => preds.has(r.head.predicate))

      // A foreign predicate is alone in its component: every edge touching
      // it is strict, so nothing shares its level and connects to it.
      let foreignHere: ForeignRelation | undefined
      for (const pred of preds) {
        const f = foreignByPredicate.get(pred)
        if (f !== undefined) foreignHere = f
      }

      // Only include non-empty strata (have predicates or rules).
      if (preds.size > 0 || componentRules.length > 0) {
        strata.push({
          index: nextIndex,
          predicates: preds,
          rules: componentRules,
          ...(foreignHere !== undefined ? { foreign: foreignHere } : {}),
        })
        nextIndex++
      }
    }
  }

  return ok(strata)
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
): ProgramError | null {
  for (const scc of sccs) {
    const sccSet = new Set(scc)

    // Check for negative edges within this SCC
    for (const pred of scc) {
      const edges = graph.adjacency.get(pred) ?? []
      for (const edge of edges) {
        if (edge.negative && sccSet.has(edge.to)) {
          // Found a negative edge within an SCC — cyclic negation.
          // For a single-node SCC, this is a negative self-loop.
          // For a multi-node SCC, there's a cycle through negation.
          return {
            kind: "cyclicNegation",
            cycle: [...scc],
          }
        }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Utility: extract predicates from rule body
// ---------------------------------------------------------------------------

/**
 * Extract all predicate names referenced in a rule's body elements.
 *
 * Which element reads which relation is decided once, by `matchedAtom` in
 * `arity.ts`, so this answer cannot drift from the one the arity check uses.
 */
export function bodyPredicates(body: readonly BodyElement[]): Set<string> {
  const preds = new Set<string>()
  for (const elem of body) {
    const atom = matchedAtom(elem)
    if (atom !== undefined) preds.add(atom.predicate)
  }
  return preds
}

/**
 * Extract all predicate names that appear as heads in a set of rules.
 */
export function headPredicates(rules: readonly Rule[]): Set<string> {
  const preds = new Set<string>()
  for (const r of rules) {
    preds.add(r.head.predicate)
  }
  return preds
}
