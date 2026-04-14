// === Resolution Bridge ===
// Reads Datalog-derived facts and produces typed resolution data for
// the skeleton builder. This is the inverse of projection.ts:
//
//   projection.ts:  kernel types → Datalog ground facts
//   resolve.ts:     Datalog derived facts → kernel types
//
// The skeleton builder should not depend on Datalog types (Database,
// Relation, Fact). This module sits at the boundary and converts
// Datalog output back into kernel-typed data structures.
//
// Key derived relations consumed:
//   winner(Slot, CnId, Value)         — from LWW rules (§B.4)
//   fugue_before(Parent, A, B)        — from Fugue rules (§B.4)
//
// See unified-engine.md §7.2, §B.4, §B.7.

import type { Database, Fact } from "../datalog/types.js"
import type { LWWEntry } from "../solver/lww.js"
import { cnIdFromString } from "./cnid.js"
import { ACTIVE_STRUCTURE_SEQ, ACTIVE_VALUE } from "./projection.js"
import type { Value } from "./types.js"

// ---------------------------------------------------------------------------
// Resolution Result
// ---------------------------------------------------------------------------

/**
 * A resolved LWW winner for a single slot.
 */
export interface ResolvedWinner {
  /** The slot identity string. */
  readonly slotId: string
  /** The winning value constraint's CnId key string. */
  readonly winnerCnIdKey: string
  /** The resolved content value. */
  readonly content: Value
}

/**
 * A Fugue ordering pair: element A comes before element B
 * within a given parent container.
 */
export interface FugueBeforePair {
  /** Parent container CnId key string. */
  readonly parentKey: string
  /** CnId key string of the element that comes first. */
  readonly a: string
  /** CnId key string of the element that comes second. */
  readonly b: string
}

// ---------------------------------------------------------------------------
// Canonical Key & Utility Functions for FugueBeforePair
// ---------------------------------------------------------------------------

/**
 * Canonical string key for a `FugueBeforePair`, following the Z-set key
 * convention (alongside `cnIdKey` for constraints, `factKey` for facts,
 * `slotId` for winners).
 *
 * Two pairs with the same parent, a, and b produce the same key.
 * Used for Z-set keying in incremental Fugue pair diffing and resolution
 * extraction.
 */
export function fuguePairKey(p: FugueBeforePair): string {
  return `${p.parentKey}|${p.a}|${p.b}`
}

/**
 * Generate all (A, B) before-pairs from an ordered list of element keys.
 *
 * Given elements in total order [e0, e1, e2, ...], produces pairs
 * (e0, e1), (e0, e2), (e1, e2), ... — every (i, j) where i < j.
 * This matches the Datalog `fugue_before(Parent, A, B)` relation shape.
 *
 * @param parentKey - The parent container's CnId key string.
 * @param ordered - Elements in Fugue total order. Only `idKey` is read.
 * @returns Array of FugueBeforePair. Empty if fewer than 2 elements.
 */
export function allPairsFromOrdered(
  parentKey: string,
  ordered: readonly { readonly idKey: string }[],
): FugueBeforePair[] {
  if (ordered.length <= 1) return []

  const pairs: FugueBeforePair[] = []
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      pairs.push({
        parentKey,
        // biome-ignore lint/style/noNonNullAssertion: ordered[i] is guaranteed to exist within loop bounds
        a: ordered[i]!.idKey,
        // biome-ignore lint/style/noNonNullAssertion: ordered[j] is guaranteed to exist within loop bounds
        b: ordered[j]!.idKey,
      })
    }
  }
  return pairs
}

/**
 * The complete resolution result extracted from Datalog evaluation.
 *
 * Consumed by the skeleton builder to populate the reality tree
 * without calling native solvers directly.
 */
export interface ResolutionResult {
  /**
   * LWW winners indexed by slot identity string.
   * One winner per slot (the Datalog `winner` relation guarantees uniqueness
   * via stratified negation over `superseded`).
   */
  readonly winners: ReadonlyMap<string, ResolvedWinner>

  /**
   * Fugue ordering pairs grouped by parent container CnId key.
   * Each entry is a set of (A, B) pairs where A should come before B.
   * The skeleton builder uses these to produce a total order via
   * topological sort.
   */
  readonly fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>

  /**
   * Whether this resolution was produced from Datalog evaluation
   * (true) or from native solvers (false).
   */
  readonly fromDatalog: boolean
}

// ---------------------------------------------------------------------------
// Fact Tuple Parsers
//
// These parse ground fact tuples (from projection) back into typed kernel
// structures. They are the inverse of the projection functions in
// projection.ts and are used by both the incremental native solvers and
// the incremental Datalog evaluator's resolution extraction.
// ---------------------------------------------------------------------------

/**
 * Parse an `active_value` fact into an `LWWEntry`.
 *
 * Fact schema: `active_value(CnId, Slot, Content, Lamport, Peer)`
 * Column positions from `ACTIVE_VALUE` in `kernel/projection.ts`.
 *
 * This is the inverse of `projectValue` in `projection.ts`.
 *
 * @param f - A fact with predicate `active_value`.
 * @returns The parsed LWWEntry.
 */
export function parseLWWFact(f: Fact): LWWEntry {
  const values = f.values
  const cnIdKeyStr = values[ACTIVE_VALUE.CNID] as string
  const slotId = values[ACTIVE_VALUE.SLOT] as string
  const content = values[ACTIVE_VALUE.CONTENT] as Value
  const lamport = values[ACTIVE_VALUE.LAMPORT] as number
  const peer = values[ACTIVE_VALUE.PEER] as string

  return {
    id: cnIdFromString(cnIdKeyStr),
    slotId,
    content,
    lamport,
    peer,
  }
}

/**
 * Parsed result of an `active_structure_seq` fact.
 *
 * Contains the same information as a seq `StructureConstraint.payload`
 * but extracted from a flat fact tuple with string CnId keys.
 */
export interface ParsedSeqStructureFact {
  /** CnId key string of the seq structure constraint. */
  readonly cnIdKey: string
  /** CnId key string of the parent container. */
  readonly parentKey: string
  /** CnId key string of the origin-left element, or null. */
  readonly originLeft: string | null
  /** CnId key string of the origin-right element, or null. */
  readonly originRight: string | null
}

/**
 * Parse an `active_structure_seq` fact into a typed structure.
 *
 * Fact schema: `active_structure_seq(CnId, Parent, OriginLeft, OriginRight)`
 * Column positions from `ACTIVE_STRUCTURE_SEQ` in `kernel/projection.ts`.
 *
 * This is the inverse of `projectStructure` in `projection.ts`.
 *
 * @param f - A fact with predicate `active_structure_seq`.
 * @returns The parsed structure fields.
 */
export function parseSeqStructureFact(f: Fact): ParsedSeqStructureFact {
  const values = f.values
  return {
    cnIdKey: values[ACTIVE_STRUCTURE_SEQ.CNID] as string,
    parentKey: values[ACTIVE_STRUCTURE_SEQ.PARENT] as string,
    originLeft: values[ACTIVE_STRUCTURE_SEQ.ORIGIN_LEFT] as string | null,
    originRight: values[ACTIVE_STRUCTURE_SEQ.ORIGIN_RIGHT] as string | null,
  }
}

// ---------------------------------------------------------------------------
// Extract from Datalog Database
// ---------------------------------------------------------------------------

/**
 * Extract LWW resolution from a Datalog-evaluated Database.
 *
 * Reads the `winner(Slot, CnId, Value)` relation and converts each
 * fact tuple back into a typed `ResolvedWinner`.
 *
 * Column positions (must match the rule head in §B.4):
 *   [0] Slot   — slot identity string
 *   [1] CnId   — cnIdKey string of the winning value constraint
 *   [2] Value  — the resolved content
 *
 * @param db - The Datalog database after evaluation.
 * @returns Map from slotId to ResolvedWinner.
 */
export function extractWinners(
  db: Database,
): ReadonlyMap<string, ResolvedWinner> {
  const winners = new Map<string, ResolvedWinner>()
  const winnerRelation = db.getRelation("winner")

  for (const tuple of winnerRelation.tuples()) {
    const slotId = tuple[0] as string
    const winnerCnIdKey = tuple[1] as string
    const content = tuple[2] as Value

    winners.set(slotId, { slotId, winnerCnIdKey, content })
  }

  return winners
}

/**
 * Extract Fugue ordering from a Datalog-evaluated Database.
 *
 * Reads the `fugue_before(Parent, A, B)` relation and groups the
 * pairs by parent container.
 *
 * Column positions (must match the rule head):
 *   [0] Parent — cnIdKey string of the parent seq container
 *   [1] A      — cnIdKey string of the element that comes first
 *   [2] B      — cnIdKey string of the element that comes second
 *
 * @param db - The Datalog database after evaluation.
 * @returns Map from parent cnIdKey to array of FugueBeforePair.
 */
export function extractFugueOrdering(
  db: Database,
): ReadonlyMap<string, FugueBeforePair[]> {
  const pairs = new Map<string, FugueBeforePair[]>()
  const beforeRelation = db.getRelation("fugue_before")

  for (const tuple of beforeRelation.tuples()) {
    const parentKey = tuple[0] as string
    const a = tuple[1] as string
    const b = tuple[2] as string

    const pair: FugueBeforePair = { parentKey, a, b }

    let existing = pairs.get(parentKey)
    if (existing === undefined) {
      existing = []
      pairs.set(parentKey, existing)
    }
    existing.push(pair)
  }

  return pairs
}

/**
 * Extract a complete ResolutionResult from a Datalog-evaluated Database.
 *
 * This is the primary entry point for the Datalog→skeleton bridge.
 * It reads both `winner` and `fugue_before` relations and packages
 * them into a single typed result.
 *
 * @param db - The Datalog database after evaluation.
 * @returns Complete resolution result.
 */
export function extractResolution(db: Database): ResolutionResult {
  return {
    winners: extractWinners(db),
    fuguePairs: extractFugueOrdering(db),
    fromDatalog: true,
  }
}

// ---------------------------------------------------------------------------
// Resolution from native solvers
//
// These helpers allow the pipeline to produce a ResolutionResult from
// native solver output, giving the skeleton builder a uniform interface
// regardless of whether the Datalog or native path was used.
// ---------------------------------------------------------------------------

/**
 * Create a ResolutionResult from native solver output.
 *
 * @param winners - Map from slotId to ResolvedWinner (from native LWW).
 * @param fuguePairs - Map from parent key to FugueBeforePair[] (from native Fugue).
 * @returns A ResolutionResult marked as from native solvers.
 */
export function nativeResolution(
  winners: ReadonlyMap<string, ResolvedWinner>,
  fuguePairs: ReadonlyMap<string, readonly FugueBeforePair[]>,
): ResolutionResult {
  return {
    winners,
    fuguePairs,
    fromDatalog: false,
  }
}

// ---------------------------------------------------------------------------
// Topological sort for Fugue ordering
// ---------------------------------------------------------------------------

/**
 * Produce a total order of element CnId keys from a set of
 * `fugue_before(Parent, A, B)` pairs for a single parent.
 *
 * Uses topological sort over the partial order defined by the pairs.
 * Elements with no ordering constraint are sorted by their CnId key
 * string for determinism.
 *
 * @param pairs - The before-pairs for a single parent.
 * @param allElementKeys - All element CnId keys that should appear in the output
 *                         (some may have no ordering constraints).
 * @returns Ordered array of element CnId key strings.
 */
export function topologicalOrderFromPairs(
  pairs: readonly FugueBeforePair[],
  allElementKeys: readonly string[],
): string[] {
  if (allElementKeys.length === 0) return []
  if (allElementKeys.length === 1) return [allElementKeys[0]!]

  // Build adjacency list and in-degree count.
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  // Initialize all elements.
  for (const key of allElementKeys) {
    adj.set(key, [])
    inDegree.set(key, 0)
  }

  // Add edges from before-pairs.
  for (const pair of pairs) {
    // Only include edges for elements that are in our set.
    if (!inDegree.has(pair.a) || !inDegree.has(pair.b)) continue

    adj.get(pair.a)?.push(pair.b)
    inDegree.set(pair.b, inDegree.get(pair.b)! + 1)
  }

  // Kahn's algorithm with deterministic tie-breaking (sort by key).
  const queue: string[] = []
  for (const [key, deg] of inDegree) {
    if (deg === 0) {
      queue.push(key)
    }
  }
  // Sort for determinism — lexicographic by CnId key.
  queue.sort()

  const result: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    result.push(current)

    const neighbors = adj.get(current)
    if (neighbors !== undefined) {
      for (const neighbor of neighbors) {
        const newDeg = inDegree.get(neighbor)! - 1
        inDegree.set(neighbor, newDeg)
        if (newDeg === 0) {
          // Insert in sorted position for determinism.
          insertSorted(queue, neighbor)
        }
      }
    }
  }

  // If there are elements not reached (cycle — shouldn't happen with
  // valid Fugue data), append them sorted for determinism.
  if (result.length < allElementKeys.length) {
    const resultSet = new Set(result)
    const remaining = allElementKeys.filter(k => !resultSet.has(k)).sort()
    result.push(...remaining)
  }

  return result
}

/**
 * Insert a string into a sorted array maintaining sort order.
 */
function insertSorted(arr: string[], value: string): void {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (arr[mid]! < value) {
      lo = mid + 1
    } else {
      hi = mid
    }
  }
  arr.splice(lo, 0, value)
}
