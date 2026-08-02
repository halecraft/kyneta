// state-tree — CvRDT field-level LWW state space.
//
// The name is deliberate, though it reads like a leftover: the binding target
// this serves is `ephemeral`, and its substrate lives in `ephemeral.ts`.
// "State" here means *state-based CRDT* — the family whose peers exchange
// whole states and reconcile them with a join, rather than shipping an op log
// — which is precisely what this file implements. So `StateTree`,
// `StateTuple` and `mergeStateTree` keep the term rather than following the
// target's name.
//
// Defines the core data structure and merge algebra for the `ephemeral`
// substrate. A StateTree is isomorphic to the document schema, but every
// scalar leaf is replaced with a `StateTuple` — `[value, timestamp]`, plus a
// third slot on a deleted key (see `StateTuple` and TECHNICAL.md §"Deletion").
//
// Because the target supports only LWW laws (`"lww" | "lww-per-key"`),
// containers are limited to structs and maps. This creates a mathematically
// clean separation: any JSON array (`[]`) encountered in a StateTree is
// unambiguously a leaf tuple, not a sequence container.
//
// An *atomic register* — a `sum` variant or a `.json()` blob — is likewise
// stored as ONE leaf tuple whose value (the tuple's `[0]`) is the whole
// object, rather than being decomposed into per-field tuples. Atomicity is
// therefore encoded in the tree's *shape*: because a register is a single
// tuple, the schema-blind merge treats it atomically for free (see
// "Tree construction" below).
//
// This is what lets `mergeStateTree` be completely schema-blind, fulfilling
// the requirement that headless replicas (relays, stores) can merge entirety
// payloads without schema knowledge.

import type { ChangeBase, MapChange } from "../change.js"
import { walkPath } from "../fold-path.js"
import type { Path } from "../interpret.js"
import { deepClonePlain } from "../inverse.js"
import { needsContainer } from "../materialize-value.js"
import type { PlainState } from "../reader.js"
import { KIND, type Schema as SchemaNode } from "../schema.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// StateTuple & StateTree
// ---------------------------------------------------------------------------

/**
 * The fundamental LWW field-level state element.
 *
 * `[0]` is the scalar value (or structural zero), `[1]` is the wall-clock
 * timestamp, and `[2]` — when present and `true` — marks a **tombstone**: the
 * key was deleted at `[1]`, and reads project it as absent.
 *
 * The marker needs its own slot rather than a sentinel value, because it has
 * to be out-of-band from the value domain: `null` is legitimate under a
 * nullable schema, and any in-band marker is something a `.json()` blob could
 * itself contain.
 */
export type StateTuple = [value: unknown, timestamp: number, deleted?: boolean]

/**
 * A recursive tree of tuples.
 * Containers are `Record<string, StateTree>`.
 * Leaves are `StateTuple`.
 */
export type StateTree = StateTuple | Record<string, any>

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/**
 * Check if a StateTree node is a leaf tuple.
 *
 * Sequences are not a supported container here, so **any** array in a
 * StateTree is a leaf. That is the real invariant, and checking the tuple's
 * length is not it: the timestamp test already excludes an array too short to
 * be a tuple, so an arity check adds only an upper bound — on the one part of
 * the shape that changes as the tuple gains slots. Get that wrong and the
 * failure is quiet: a rejected tuple is treated as a container, and its slots
 * are merged and projected as if they were keys.
 */
export function isStateTuple(node: unknown): node is StateTuple {
  return Array.isArray(node) && typeof node[1] === "number"
}

/**
 * A tombstone: a tuple recording that the key was deleted at its timestamp.
 *
 * Deletion has to be *represented* rather than expressed as absence, because
 * `mergeStateTree` unions keys — a key missing from one peer is indistinguishable
 * from one that peer has never seen, so a bare removal is resurrected by the
 * next merge with anyone who still holds it.
 */
export function isTombstone(node: unknown): node is StateTuple {
  return isStateTuple(node) && node[2] === true
}

/**
 * Build a tombstone. The value slot is `null` and is never read: a tombstoned
 * key projects as absent, so nothing consults what it used to hold.
 */
function tombstone(timestamp: number): StateTuple {
  return [null, timestamp, true]
}

/**
 * Mark an entire subtree deleted, tombstoning every leaf inside it.
 *
 * Replacing the whole subtree with one tombstone tuple would be shorter, and
 * it breaks associativity. It leaves two peers disagreeing about a node's
 * *shape* — one holding a leaf where the other still holds a container — and
 * resolving that means discarding one side's contents, which a later merge
 * then cannot recover. Concretely: a leaf at t=300 beats a container whose
 * newest leaf is t=150, destroying it, so merging a third peer afterwards
 * gives a different answer than merging it first.
 *
 * Going leaf-by-leaf keeps every shape stable, so the merge only ever joins
 * leaf against leaf — where it is provably a lattice. See TECHNICAL.md
 * §"Deletion" for the worked example.
 */
function tombstoneSubtree(node: StateTree, timestamp: number): StateTree {
  if (isStateTuple(node)) return tombstone(timestamp)
  const marked: Record<string, StateTree> = {}
  for (const key of Object.keys(node)) {
    marked[key] = tombstoneSubtree(
      (node as Record<string, StateTree>)[key],
      timestamp,
    )
  }
  return marked
}

// ---------------------------------------------------------------------------
// Merge Algebra (Join Semilattice)
// ---------------------------------------------------------------------------

/**
 * Rank a tuple's value for tie-breaking, as its JSON serialisation.
 *
 * The fallback matters: `JSON.stringify(undefined)` returns `undefined`, not a
 * string, which would make the comparison non-total and break the lattice. The
 * bare stand-in cannot collide with a real value, since the *string*
 * `"undefined"` serialises with quotes.
 */
function valueRank(value: unknown): string {
  return JSON.stringify(value) ?? "undefined"
}

/**
 * The join of two leaf tuples — which one wins.
 *
 * Highest timestamp wins; on a tie, the greater value rank.
 *
 * The tie rule is a decision rather than a detail. On a tie the greater
 * *value* wins, not the later writer: a tie IS simultaneity, so there is no
 * later writer to prefer, and an arbitrary-but-agreed winner is all a join
 * needs. Comparing serialisations reads like a hack and is not — both peers
 * compare the same pair of strings, so they cannot reach different verdicts,
 * and string comparison is a *total order*, which is what makes the join
 * associative across three or more tied peers. The rule this replaced ("take
 * remote") was deterministic but not commutative, so two peers merging in
 * opposite directions diverged permanently. TECHNICAL.md §"The merge rule, in
 * full" has the longer argument.
 *
 * Only the tie path pays for `stringify`. Returns one of its arguments rather
 * than a copy; the caller decides whether the winner needs cloning.
 */
export function joinTuples(local: StateTuple, remote: StateTuple): StateTuple {
  if (remote[1] > local[1]) return remote
  if (local[1] > remote[1]) return local
  return valueRank(remote[0]) > valueRank(local[0]) ? remote : local
}

/**
 * The newest timestamp anywhere in a subtree.
 *
 * Containers have no timestamp of their own — only leaves are stamped — so
 * this is what lets a leaf and a container be compared when one peer holds one
 * and another peer holds the other at the same key.
 */
function subtreeTimestamp(node: StateTree): number {
  if (isStateTuple(node)) return node[1]
  let newest = 0
  for (const key of Object.keys(node)) {
    newest = Math.max(newest, subtreeTimestamp(node[key]))
  }
  return newest
}

/**
 * Schema-blind recursive merge of two StateTrees.
 *
 * This implements the $A \sqcup B$ join operation for the CvRDT.
 * For leaf tuples, it defers to `joinTuples`.
 * For containers, it takes the union of keys and recurses.
 *
 * A `sum`/`.json()` register is a single leaf tuple *by construction* (see
 * "Tree construction" below), so this schema-blind join merges it atomically
 * — the whole variant wins or loses together, never blending fields across
 * variants. That structural encoding is exactly why merge needs no schema:
 * headless relays/stores converge on raw payloads without one.
 *
 * Modifies `local` in-place and returns it.
 */
export function mergeStateTree(local: StateTree, remote: StateTree): StateTree {
  if (isStateTuple(local) && isStateTuple(remote)) {
    // Adopt the winner WHOLE rather than copying slot by slot: copying fixed
    // slots preserves any slot this function does not know about, so a losing
    // tombstone would leave its marker sitting on the value that beat it.
    const winner = joinTuples(local, remote)
    // Clone when remote wins, so the merged tree never aliases a payload the
    // caller may still own.
    return winner === local ? local : cloneTuple(winner)
  }

  // One side is a leaf where the other is a container: the peers disagree
  // about this node's SHAPE. Well-formed peers cannot get here — shape comes
  // from the schema, and even a delete preserves it (see `tombstoneSubtree`) —
  // so this is the degraded path for malformed or mismatched-schema payloads.
  //
  // Containers carry no timestamp of their own, hence the comparison on the
  // newest timestamp within. Simply taking `remote` would be shorter and is
  // wrong: deterministic is not commutative, so two peers merging in opposite
  // directions would disagree permanently.
  //
  // Deliberately NOT associative, and not claimed to be: the loser's contents
  // are discarded, so no later merge can recover them. That cannot be fixed
  // here without inventing a union of two disagreeing shapes; the guarantee
  // lives upstream, in keeping shapes stable.
  if (isStateTuple(local) || isStateTuple(remote)) {
    const localTimestamp = subtreeTimestamp(local)
    const remoteTimestamp = subtreeTimestamp(remote)
    if (remoteTimestamp > localTimestamp) return deepClone(remote)
    if (localTimestamp > remoteTimestamp) return local
    // Same rule as the tuple tie-break: greater serialisation wins, giving a
    // total order both peers compute identically.
    return valueRank(remote) > valueRank(local) ? deepClone(remote) : local
  }

  // Both are objects (containers). Union the keys.
  const l = local as Record<string, StateTree>
  const r = remote as Record<string, StateTree>

  for (const key of Object.keys(r)) {
    if (key in l) {
      l[key] = mergeStateTree(l[key], r[key])
    } else {
      l[key] = deepClone(r[key])
    }
  }

  return l
}

// ---------------------------------------------------------------------------
// PlainState Extraction (Shadow generation)
// ---------------------------------------------------------------------------

/**
 * Recursively strip timestamps from a StateTree to produce a canonical
 * `PlainState` shadow for the `plainReader`.
 *
 * Mutates `target` in place by projecting `tree` onto it, removing absent
 * keys and updating present ones.
 *
 * When `schema` and `now` are supplied, the projection is time-aware:
 * any leaf whose `(schema.decayMs)` is set and whose tuple timestamp is
 * older than `now - decayMs` is replaced with `Zero.structural(schema)`
 * in the shadow. This is purely a projection — the underlying `StateTree`
 * math is never mutated, so the version clock does not advance and the
 * network never sees a synthesized "absent" write.
 *
 * Returns `true` if any field was masked by decay (used by the substrate's
 * `tick()` to decide whether to fire the changefeed).
 */
export function extractPlainState(
  tree: StateTree,
  target: PlainState,
  schema?: SchemaNode,
  now?: number,
): boolean {
  if (isStateTuple(tree)) {
    throw new Error(
      "extractPlainState requires a root container, received a tuple",
    )
  }

  const { anyDecayed } = extractInto(
    tree as Record<string, StateTree>,
    target,
    schema,
    now,
  )
  return anyDecayed
}

/**
 * Inner recursion. Walks `source` (a StateTree container) alongside
 * `schema` (when provided), projecting values into `target`.
 */
function extractInto(
  source: Record<string, StateTree>,
  target: PlainState,
  schema: SchemaNode | undefined,
  now: number | undefined,
): {
  anyDecayed: boolean
  maxTimestamp: number
  /** Whether this subtree should appear in the projection at all. */
  kept: boolean
} {
  let anyDecayed = false
  let maxTimestamp = 0
  // A subtree drops out of the projection only when it is entirely tombstoned.
  // Tracking "has a tombstone" separately from "has a live leaf" is what
  // distinguishes a deleted entry from a legitimately EMPTY container: an
  // empty record still projects as `{}`, while a deleted one is absent.
  let anyLive = false
  let anyTombstone = false

  for (const key of Object.keys(source)) {
    const child = source[key]
    if (!isStateTuple(child)) {
      // Nested container. Resolve the child schema if we can.
      const childSchema = schema ? childSchemaForKey(schema, key) : undefined
      if (typeof target[key] !== "object" || target[key] === null) {
        target[key] = {}
      }
      const result = extractInto(
        child,
        target[key] as PlainState,
        childSchema,
        now,
      )
      if (result.anyDecayed) {
        anyDecayed = true
      }
      if (result.kept) {
        anyLive = true
      } else {
        // Every leaf beneath it is tombstoned: the whole entry was deleted.
        delete target[key]
        anyTombstone = true
      }
      maxTimestamp = Math.max(maxTimestamp, result.maxTimestamp)
      continue
    }

    // Leaf tuple.
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    maxTimestamp = Math.max(maxTimestamp, child[1])

    if (isTombstone(child)) {
      // Deleted: present in the tree so the delete can replicate, absent from
      // every read. The tuple stays; the projection drops it.
      delete target[key]
      anyTombstone = true
      continue
    }
    anyLive = true

    const decayed =
      childSchema !== undefined &&
      now !== undefined &&
      isExpired(childSchema, child, now)

    if (decayed) {
      target[key] = Zero.structural(childSchema)
      anyDecayed = true
    } else {
      // A register (sum / .json()) is stored as one tuple whose value is a
      // whole object; clone it so the shadow never aliases the StateTree.
      const value = child[0]
      target[key] =
        typeof value === "object" && value !== null
          ? deepClonePlain(value)
          : value
    }
  }

  // Remove keys that are in target but not in source.
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  // Container decay: if this container schema has a decayMs and the latest
  // tuple within it has expired, decay the entire container to its structural zero.
  if (schema && now !== undefined) {
    const decayMs = (schema as { decayMs?: number }).decayMs
    if (
      decayMs !== undefined &&
      maxTimestamp > 0 &&
      now - maxTimestamp > decayMs
    ) {
      // Reset the target to the structural zero of this container
      const structuralZero = Zero.structural(schema) as Record<string, unknown>
      for (const key of Object.keys(target)) delete target[key]
      for (const [key, val] of Object.entries(structuralZero)) {
        target[key] = val
      }
      anyDecayed = true
    }
  }

  return { anyDecayed, maxTimestamp, kept: anyLive || !anyTombstone }
}

/**
 * The schema node for a named child of a container schema. This substrate's only
 * containers are product (`fields[key]`) and map (`item`) — a sum is stored as
 * one atomic leaf tuple, so it is never descended into and needs no case here.
 */
function childSchemaForKey(
  schema: SchemaNode,
  key: string,
): SchemaNode | undefined {
  switch (schema[KIND]) {
    case "product":
      return (schema as { fields: Record<string, SchemaNode> }).fields[key]
    case "map":
      return (schema as { item: SchemaNode }).item
    default:
      return undefined
  }
}

/**
 * True if the schema declares `decayMs` and the tuple's timestamp has
 * elapsed past the decay window measured from `now`.
 */
function isExpired(
  schema: SchemaNode,
  tuple: StateTuple,
  now: number,
): boolean {
  const decayMs = (schema as { decayMs?: number }).decayMs
  if (decayMs === undefined) return false
  return now - tuple[1] > decayMs
}

// ---------------------------------------------------------------------------
// Clone Helper
// ---------------------------------------------------------------------------

/**
 * Copy a leaf tuple, whatever slots it has.
 *
 * Arity-agnostic on purpose: naming slots here would quietly truncate any
 * tuple carrying more than the two a past version knew about. Shallow, like
 * the clone it replaced — `leafTuple` deep-clones a value once on the way in,
 * so the tree never aliases a caller's live value.
 */
function cloneTuple(tuple: StateTuple): StateTuple {
  return tuple.slice() as StateTuple
}

function deepClone(value: any): any {
  // An array inside a StateTree is always a leaf tuple: sequences are not a
  // supported container on this substrate, so nothing else can be an array.
  if (Array.isArray(value)) return cloneTuple(value as StateTuple)
  if (typeof value === "object" && value !== null) {
    const clone: Record<string, any> = {}
    for (const key of Object.keys(value)) {
      clone[key] = deepClone(value[key])
    }
    return clone
  }
  return value
}

// ---------------------------------------------------------------------------
// Tree construction — plain value / change → StateTree
// ---------------------------------------------------------------------------
// These build (or mutate) a StateTree from a plain value or a Change. They
// live here alongside the merge/extract algebra so the whole StateTree
// transform layer is one functional core; the `ephemeral` substrate (the
// imperative shell) just calls them.
//
// The one decision they share is leaf-vs-container. Products and maps
// decompose into per-field tuples — that is what gives `ephemeral` its
// field-level merge. Scalars and *registers* — a `sum` variant or a
// `.json()` blob, for which `needsContainer` is false — are stored as ONE
// leaf tuple. Storing a register whole is what stops
// `mergeStateTree` from blending fields across variants: a sum is opaque to
// the CRDT, exactly like a scalar (variant fields are not independently
// addressable — a variant switch is a single whole-value `.set()`).

/**
 * Should `value` be decomposed into per-field tuples (a container), or stored
 * as one atomic tuple (a scalar or register)? Only a plain (non-array) object
 * can be a decomposed container. A missing schema falls back to the
 * historical "decompose any object" behavior.
 */
function isDecomposedContainer(
  value: unknown,
  nodeSchema: SchemaNode | undefined,
): boolean {
  const isPlainObject =
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (!isPlainObject) return false
  return nodeSchema === undefined || needsContainer(nodeSchema)
}

/**
 * Wrap a leaf value in a `StateTuple`, deep-cloning objects/arrays (register
 * values) so the tree never aliases the caller's live value.
 */
function leafTuple(value: unknown, timestamp: number): StateTuple {
  const stored =
    typeof value === "object" && value !== null ? deepClonePlain(value) : value
  return [stored, timestamp]
}

/**
 * The schema node at `path`, or `undefined` when the path does not fit the
 * schema.
 *
 * `undefined` means "no schema opinion here," and callers answer it by falling
 * back to the original schema-blind behaviour, which decomposes any object it
 * is handed. That makes failure quiet and permissive, so it matters a great
 * deal which paths fail.
 *
 * Note what is deliberately absent: a `try/catch`. Catching failures here would
 * net two very different things with one rule.
 *
 * A genuinely malformed path — an unknown field, say — is fine to answer with
 * `undefined`. A path leading *into a sum* is not malformed at all; it simply
 * needs the **value** to resolve rather than the schema, because a sum picks
 * its variant by inspecting what is stored. Answering `undefined` for that
 * second case is the expensive mistake: the caller falls back to schema-blind
 * decomposition, splits the register into per-field tuples, and drops every
 * sibling field the change never mentioned. Silently, because local reads come
 * from a separate shadow.
 *
 * `walkPath` reports the two separately, which is why no `catch` is needed:
 * `mismatch` is a real malformed path and yields `undefined`, while `boundary`
 * yields the register's own schema.
 */
function schemaAtPath(
  root: SchemaNode | undefined,
  path: Path,
): SchemaNode | undefined {
  if (!root) return undefined
  const walk = walkPath(undefined, root, path)
  return walk.stop === "mismatch" ? undefined : walk.schema
}

/**
 * Apply a change directly to the StateTree, stamping mutated leaves with the
 * given timestamp. `schema` is the document root schema; it is threaded so a
 * mutated register (sum / `.json()`) lands as a single atomic tuple instead of
 * being decomposed into blendable per-field tuples.
 */
export function applyChangeToStateTree(
  tree: StateTree,
  path: Path,
  change: ChangeBase,
  timestamp: number,
  schema: SchemaNode | undefined,
): void {
  if (path.length === 0) {
    if (change.type === "replace") {
      const val = (change as any).value
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        // Deep replace of the whole root (always a product). Decompose so
        // nested registers still land atomically (schema threaded through).
        const newTree: Record<string, StateTree> = {}
        syncStateTreeToShadow(newTree, val, schema, timestamp)
        const target = tree as Record<string, StateTree>
        for (const k of Object.keys(target)) delete target[k]
        for (const k of Object.keys(newTree)) target[k] = newTree[k]
      } else {
        throw new Error("Cannot replace root with a scalar")
      }
    } else if (change.type === "map") {
      applyMapChange(
        tree as Record<string, StateTree>,
        change as MapChange,
        schema,
        timestamp,
      )
    }
    return
  }

  // Resolve the schema at the target node so a register replace stays atomic.
  const targetSchema = schemaAtPath(schema, path)

  // Traverse to the parent of the target node.
  let current: unknown = tree
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path.segments[i]
    const key = String(segment.resolve())
    let next = (current as Record<string, unknown>)[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      next = {}
      ;(current as Record<string, unknown>)[key] = next
    }
    current = next
  }

  const lastSegment = path.segments[path.length - 1]
  const key = String(lastSegment.resolve())
  const target = current as Record<string, StateTree>

  if (change.type === "replace") {
    const val = (change as any).value
    if (isDecomposedContainer(val, targetSchema)) {
      const newTree: Record<string, StateTree> = {}
      syncStateTreeToShadow(newTree, val, targetSchema, timestamp)
      target[key] = newTree
    } else {
      target[key] = leafTuple(val, timestamp)
    }
  } else if (change.type === "map") {
    let child = target[key]

    // A map change is only meaningful at a container. An atomic register — a
    // sum or `.json()` node, stored as ONE tuple so a variant switch resolves
    // whole — never legitimately receives one, because `state.ts:prepare`
    // widens such writes into a whole-value replace first. Getting here means
    // that widening was bypassed.
    //
    // Throwing is the point. Quietly building a container instead would
    // decompose the register into blendable per-field tuples and drop every
    // sibling field the change did not mention — and since local reads are
    // served from a separate shadow, the damage would only ever appear on
    // some other peer.
    //
    // The schema is authoritative and catches a register not yet written; the
    // tuple check covers the case where there is no schema opinion.
    const schemaSaysRegister =
      targetSchema !== undefined && !needsContainer(targetSchema)
    if (schemaSaysRegister || isStateTuple(child)) {
      throw new Error(
        `Cannot apply a map change at "${key}": it is an atomic register ` +
          `(a sum or .json() node). Such writes must be widened to a ` +
          `whole-value replace before reaching the state tree.`,
      )
    }

    if (typeof child !== "object" || child === null) {
      child = {}
      target[key] = child
    }
    applyMapChange(
      child as Record<string, StateTree>,
      change as MapChange,
      targetSchema,
      timestamp,
    )
  }
}

/**
 * Apply a `MapChange` to one StateTree container.
 *
 * Shared by the root and nested call sites above. Both were duplicates, and
 * both read a shape the change vocabulary has never defined (per-key
 * `{type: "set" | "delete"}` instructions under `.entries`), so every map
 * write threw and `Schema.record` was unusable. Duplication is how they came
 * to agree on a shape neither had.
 *
 * `delete` is an array of keys, not instruction objects. Deletes apply before
 * sets, matching `stepMap`, so a key in both ends up set.
 */
function applyMapChange(
  target: Record<string, StateTree>,
  change: MapChange,
  containerSchema: SchemaNode | undefined,
  timestamp: number,
): void {
  for (const key of change.delete ?? []) {
    // A tombstone, not a removal: `mergeStateTree` unions keys, so a key taken
    // out of the tree is indistinguishable from one never seen, and the next
    // merge with anyone still holding it brings it back.
    //
    // Concurrent add and remove resolve BY TIMESTAMP — LWW-Element-Set, and
    // deliberately not an observed-remove set where a concurrent add always
    // wins regardless of clock. Worth naming, because "tombstone" usually
    // implies OR-Set. TECHNICAL.md §"Deletion" covers why LWW is right here.
    const existing = target[key]
    target[key] =
      existing === undefined
        ? tombstone(timestamp)
        : tombstoneSubtree(existing, timestamp)
  }

  for (const [key, value] of Object.entries(change.set ?? {})) {
    // The container's item schema decides whether an entry decomposes into a
    // subtree or lands as one leaf tuple (a register, or an ordinary scalar).
    const itemSchema = containerSchema
      ? childSchemaForKey(containerSchema, key)
      : undefined
    if (isDecomposedContainer(value, itemSchema)) {
      const subtree: Record<string, StateTree> = {}
      syncStateTreeToShadow(subtree, value, itemSchema, timestamp)
      target[key] = subtree
    } else {
      target[key] = leafTuple(value, timestamp)
    }
  }
}

/**
 * Propagate a plain value (from user mutations) into a StateTree, guided by
 * `schema`: containers decompose, scalars and registers become one tuple.
 */
export function syncStateTreeToShadow(
  tree: StateTree,
  plain: any,
  schema: SchemaNode | undefined,
  timestamp: number,
): void {
  if (isStateTuple(tree)) {
    throw new Error("Cannot sync into a root tuple.")
  }

  const target = tree as Record<string, StateTree>

  for (const key of Object.keys(plain)) {
    const val = plain[key]
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    if (isDecomposedContainer(val, childSchema)) {
      // Container (product/map): reuse an existing subtree so a partial update
      // merges into it; replace a tuple/absent slot with a fresh container.
      if (!target[key] || isStateTuple(target[key])) {
        target[key] = {}
      }
      syncStateTreeToShadow(target[key], val, childSchema, timestamp)
    } else {
      // Scalar or register (sum / .json()): one atomic tuple.
      target[key] = leafTuple(val, timestamp)
    }
  }

  // A key in the tree but absent from the plain value has been deleted, so it
  // tombstones exactly as an explicit `delete` does — otherwise which call a
  // writer happened to use would decide whether the removal survives a merge.
  //
  // An existing tombstone is left alone rather than re-stamped: refreshing it
  // on every unrelated whole-value write would let an old delete keep beating
  // a newer remote re-add.
  for (const key of Object.keys(target)) {
    if (key in plain) continue
    if (isTombstone(target[key])) continue
    target[key] = tombstoneSubtree(target[key], timestamp)
  }
}

/**
 * Seed structural-zero defaults (timestamp 0 = genesis, lineage ⊥) for keys
 * missing from `tree`, guided by `schema` so a register default (e.g. a sum's
 * first variant) is seeded as one atomic tuple.
 */
export function insertStructuralZeros(
  tree: StateTree,
  defaults: any,
  schema: SchemaNode | undefined,
): void {
  if (isStateTuple(tree)) return

  const t = tree as Record<string, StateTree>

  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key]
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    if (!(key in t)) {
      if (isDecomposedContainer(defaultVal, childSchema)) {
        t[key] = {}
        insertStructuralZeros(t[key], defaultVal, childSchema)
      } else {
        t[key] = leafTuple(defaultVal, 0)
      }
    } else if (isDecomposedContainer(defaultVal, childSchema)) {
      // Present container: fill any nested gaps.
      insertStructuralZeros(t[key], defaultVal, childSchema)
    }
  }
}
