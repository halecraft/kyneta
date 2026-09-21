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

import type { BuiltinChange, ChangeBase, MapChange } from "../change.js"
import { isReplaceChange } from "../change.js"
import { deepClonePlain } from "../clone.js"
import { walkPath } from "../fold-path.js"
import { samePlainValue } from "../guards.js"
import { DIGEST_SEEDS, type Digest, digestFold } from "../hash.js"
import type { Path } from "../interpret.js"
import type { PlainState } from "../reader.js"
import {
  isJsonBoundary,
  isOpaqueBoundary,
  KIND,
  type Schema as SchemaNode,
  storageClass,
} from "../schema.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// StateTuple & StateTree
// ---------------------------------------------------------------------------

/**
 * The fundamental LWW field-level state element.
 *
 * `[0]` is the scalar value (or structural zero) and `[1]` is the wall-clock
 * timestamp the value was *written* at — what LWW orders by and what decay
 * measures. `[3]`, when present and `true`, marks a **tombstone**: the key was
 * deleted at `[1]`, and reads project it as absent.
 *
 * The marker needs its own slot rather than a sentinel value, because it has
 * to be out-of-band from the value domain: `null` is legitimate under a
 * nullable schema, and any in-band marker is something a `.json()` blob could
 * itself contain.
 *
 * `[2]` is the local install ordinal: which batch *this* replica took the
 * value in. It answers a different question from `[1]` — a peer returning from
 * an hour offline sends leaves written an hour ago and installed just now, and
 * filtering an outgoing delta by write time would drop exactly those.
 *
 * It is **local**, so it is stripped on the way out and re-stamped on the way
 * in. Two peers holding identical data stamp it differently, which is why no
 * comparison that decides agreement may read it: see `joinTuples`,
 * `sameTuple` and `stateTreeDigest`. Stripping it shifts the tombstone marker
 * down to index 2, which is exactly the encoding peers already speak.
 */
export type StateTuple = [
  value: unknown,
  timestamp: number,
  installedAt: number,
  deleted?: boolean,
]

/**
 * When a write happened, in both senses the tree needs.
 *
 * `timestamp` is the wall clock: what LWW orders by and what decay measures.
 * `installedAt` is this replica's install ordinal: which batch *we* took the
 * value in. They are not interchangeable and the difference is the whole
 * reason deltas work — a peer back from an hour offline sends leaves with old
 * timestamps that we are installing now, and a delta filtered by timestamp
 * would drop exactly those.
 */
export interface WriteStamp {
  readonly timestamp: number
  readonly installedAt: number
}

/**
 * The stamp a structural zero carries: nobody wrote it and nobody installed
 * it. Timestamp zero loses every LWW comparison, and install ordinal zero sits
 * below every cursor, so a zero is never mistaken for news and never ships in
 * a delta.
 */
const STRUCTURAL_ZERO: WriteStamp = { timestamp: 0, installedAt: 0 }

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
  return isStateTuple(node) && node[3] === true
}

/**
 * Build a tombstone. The value slot is `null` and is never read: a tombstoned
 * key projects as absent, so nothing consults what it used to hold.
 */
function tombstone(stamp: WriteStamp): StateTuple {
  return [null, stamp.timestamp, stamp.installedAt, true]
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
function tombstoneSubtree(node: StateTree, stamp: WriteStamp): StateTree {
  if (isStateTuple(node)) return tombstone(stamp)
  const marked: Record<string, StateTree> = {}
  for (const key of Object.keys(node)) {
    marked[key] = tombstoneSubtree(
      (node as Record<string, StateTree>)[key],
      stamp,
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
 * Whether two leaf tuples carry the same replicating content.
 *
 * Compares exactly the slots a peer can observe — value, timestamp, tombstone
 * marker — by the same rule as `joinTuples`, so "the join did not move" and
 * "the join picked an equal tuple" cannot disagree.
 */
function sameTuple(a: StateTuple, b: StateTuple): boolean {
  return (
    a[1] === b[1] &&
    isTombstone(a) === isTombstone(b) &&
    valueRank(a[0]) === valueRank(b[0])
  )
}

/**
 * The join of two leaf tuples — which one wins.
 *
 * Highest timestamp wins; on a tie, a live tuple beats a tombstone, and
 * otherwise the greater value rank.
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
 * The rank has to cover **every slot that replicates**, not just the value.
 * Ranking the value alone made a tombstone and a live `null` at the same
 * timestamp indistinguishable — a delete on one peer against a `null` write on
 * another, in the same millisecond, left each keeping its own and diverging
 * permanently. Live beats tombstone because a tie carries no reason to prefer
 * the deletion and that direction discards less. Any slot added here that does
 * **not** replicate must stay out of this comparison: two peers agree on the
 * tree and not on their own bookkeeping.
 *
 * Only the value tie pays for `stringify`. Returns one of its arguments rather
 * than a copy; the caller decides whether the winner needs cloning.
 */
export function joinTuples(local: StateTuple, remote: StateTuple): StateTuple {
  if (remote[1] > local[1]) return remote
  if (local[1] > remote[1]) return local

  const localLive = !isTombstone(local)
  if (localLive !== !isTombstone(remote)) return localLive ? local : remote

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
 * Modifies `local` in-place and returns it, along with whether the join moved.
 *
 * `changed` is a lattice question, not a bookkeeping one: `a ⊔ b = a` exactly
 * when `b ≤ a`, so a false answer means the incoming payload was already
 * subsumed. The caller needs it because announcing a change that did not happen
 * is not merely wasteful — in a mesh of three or more peers it is a cycle,
 * since each peer relays to everyone but the sender and no peer can decline a
 * re-import it has no way to recognise as redundant.
 */
export interface MergeResult {
  readonly tree: StateTree
  readonly changed: boolean
}

export function mergeStateTree(
  local: StateTree,
  remote: StateTree,
  installedAt: number,
): MergeResult {
  const moved = { changed: false }
  const tree = mergeInto(local, remote, installedAt, moved)
  return { tree, changed: moved.changed }
}

/**
 * Adopt an incoming node, stamping every leaf in it as installed now.
 *
 * The incoming payload carries no install ordinal — it is stripped on the
 * wire, because it is a fact about the receiver. Stamping here rather than at
 * parse time means only leaves that actually *win* are stamped, which is what
 * makes "the counter moved" and "the state changed" the same question.
 */
function adopt(node: StateTree, installedAt: number): StateTree {
  if (isStateTuple(node)) {
    const copy = cloneTuple(node)
    copy[2] = installedAt
    return copy
  }
  const clone: Record<string, StateTree> = {}
  for (const key of Object.keys(node)) {
    clone[key] = adopt((node as Record<string, StateTree>)[key], installedAt)
  }
  return clone
}

function mergeInto(
  local: StateTree,
  remote: StateTree,
  installedAt: number,
  moved: { changed: boolean },
): StateTree {
  if (isStateTuple(local) && isStateTuple(remote)) {
    // Adopt the winner WHOLE rather than copying slot by slot: copying fixed
    // slots preserves any slot this function does not know about, so a losing
    // tombstone would leave its marker sitting on the value that beat it.
    const winner = joinTuples(local, remote)
    if (winner === local) return local
    // A won tie returns the incoming tuple even when it is indistinguishable
    // from the local one, so compare content rather than identity: adopting an
    // equal tuple is not a change, and treating it as one is what circulates.
    if (sameTuple(local, winner)) return local
    moved.changed = true
    // Clone when remote wins, so the merged tree never aliases a payload the
    // caller may still own.
    return adopt(winner, installedAt) as StateTuple
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
    if (remoteTimestamp > localTimestamp) {
      moved.changed = true
      return adopt(remote, installedAt)
    }
    if (localTimestamp > remoteTimestamp) return local
    // Same rule as the tuple tie-break: greater serialisation wins, giving a
    // total order both peers compute identically.
    if (valueRank(remote) <= valueRank(local)) return local
    moved.changed = true
    return adopt(remote, installedAt)
  }

  // Both are objects (containers). Union the keys.
  const l = local as Record<string, StateTree>
  const r = remote as Record<string, StateTree>

  for (const key of Object.keys(r)) {
    if (key in l) {
      l[key] = mergeInto(l[key], r[key], installedAt, moved)
    } else {
      // A key we have never seen. Absence carries no information under a
      // key-unioning merge, so this is always new state.
      moved.changed = true
      l[key] = adopt(r[key], installedAt)
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
 * Returns the root keys whose projection actually moved. Callers announce a
 * re-projection to subscribers, and who hears it depends on naming the fields
 * that changed — so the comparison happens here, where each value is written
 * and the old one is still in hand, rather than by diffing a copy of the
 * whole shadow afterwards.
 */
export function extractPlainState(
  tree: StateTree,
  target: PlainState,
  schema?: SchemaNode,
  now?: number,
): ReadonlySet<string> {
  if (isStateTuple(tree)) {
    throw new Error(
      "extractPlainState requires a root container, received a tuple",
    )
  }

  const changedKeys = new Set<string>()
  extractInto(
    tree as Record<string, StateTree>,
    target,
    schema,
    now,
    changedKeys,
  )
  return changedKeys
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
  /** Set only by the outermost call, which is the level callers announce at. */
  changedKeys?: Set<string>,
): {
  maxTimestamp: number
  /** Whether this subtree should appear in the projection at all. */
  kept: boolean
  /** Whether anything in this subtree's projection differs from before. */
  changed: boolean
} {
  let maxTimestamp = 0
  let changed = false
  // A subtree drops out of the projection when it is entirely tombstoned AND
  // its key was written rather than declared. Tracking "has a tombstone"
  // separately from "has a live leaf" is what distinguishes a deleted entry
  // from a legitimately EMPTY container: an empty record still projects as
  // `{}`, while a deleted one is absent.
  let anyLive = false
  let anyTombstone = false

  // Dropping says a key was written and then removed, so it applies only
  // where keys are written. A declared field with nothing live under it is an
  // empty container, not an absent one.
  const dropsWhenEmpty = (schema ? keySpace(schema) : undefined) !== "declared"

  /** Note a key whose projected value moved. */
  const moved = (key: string): void => {
    changed = true
    changedKeys?.add(key)
  }

  for (const key of Object.keys(source)) {
    const child = source[key]
    if (!isStateTuple(child)) {
      // Nested container. Resolve the child schema if we can.
      const childSchema = schema ? childSchemaForKey(schema, key) : undefined
      let keyChanged = false
      if (typeof target[key] !== "object" || target[key] === null) {
        target[key] = {}
        keyChanged = true
      }
      const result = extractInto(
        child,
        target[key] as PlainState,
        childSchema,
        now,
      )
      if (result.kept || !dropsWhenEmpty) {
        anyLive = true
      } else {
        // Every leaf beneath it is tombstoned: the whole entry was deleted.
        if (key in target) keyChanged = true
        delete target[key]
        anyTombstone = true
      }
      if (keyChanged || result.changed) moved(key)
      maxTimestamp = Math.max(maxTimestamp, result.maxTimestamp)
      continue
    }

    // Leaf tuple.
    const childSchema = schema ? childSchemaForKey(schema, key) : undefined

    maxTimestamp = Math.max(maxTimestamp, child[1])

    if (isTombstone(child)) {
      // Deleted: present in the tree so the delete can replicate, absent from
      // every read. The tuple stays; the projection drops it. A tombstoned
      // *declared* leaf still drops — the field exists, its value does not —
      // and the reader supplies the structural zero.
      if (key in target) moved(key)
      delete target[key]
      anyTombstone = true
      continue
    }
    anyLive = true

    const decayed =
      childSchema !== undefined &&
      now !== undefined &&
      isExpired(childSchema, child, now)

    // Compare before writing. An unchanged register also skips its clone,
    // which is the bulk of a steady-state projection's work.
    const next = decayed ? Zero.structural(childSchema) : child[0]
    if (samePlainValue(target[key], next)) continue
    moved(key)
    target[key] =
      typeof next === "object" && next !== null ? deepClonePlain(next) : next
  }

  // Remove keys that are in target but not in source.
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      moved(key)
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
      if (!samePlainValue(target, structuralZero)) {
        changed = true
        for (const key of Object.keys(target)) delete target[key]
        for (const [key, val] of Object.entries(structuralZero)) {
          target[key] = val
          changedKeys?.add(key)
        }
      }
    }
  }

  return { maxTimestamp, kept: anyLive || !anyTombstone, changed }
}

/**
 * How the StateTree stores a schema node.
 *
 * - `decompose` — per-field or per-key tuples, which is what gives this
 *   substrate its field-level merge.
 * - `register` — one leaf tuple holding the whole value, so a concurrent
 *   variant switch resolves to one coherent variant.
 * - `unrepresentable` — the tree has no shape for it.
 *
 * The single definition of that decision, in the sense `storageClass`
 * (`schema.ts`) is for substrates generally. Its four consumers hold no logic
 * of their own: `childSchemaForKey`, `isDecomposedContainer`,
 * `stateTreeViolation`, and the map-change guard in
 * `applyChangeToStateTree`.
 *
 * Two kinds are listed, not seven. `register` and `unrepresentable` are
 * different answers, and stating the accepted set means a schema kind added
 * later lands in `unrepresentable` rather than joining the storable set
 * silently.
 */
export type StateTreeRole = "decompose" | "register" | "unrepresentable"

export function stateTreeRole(node: SchemaNode): StateTreeRole {
  // A `sum` or `.json()` node is one tuple whatever its kind says, so the
  // storage class answers before the kind is consulted.
  if (storageClass(node) !== "container") return "register"
  switch (node[KIND]) {
    case "product":
    case "map":
      return "decompose"
    default:
      return "unrepresentable"
  }
}

/**
 * Where a node's key set comes from.
 *
 * - `declared` — a product's fields. A constant index set fixed by the schema,
 *   with no lattice: the keys do not arrive, change, or leave.
 * - `dynamic` — a map's keys. A last-writer-wins element set, which is why a
 *   removal has to be represented rather than expressed by omission.
 *
 * This is the distinction behind "absence carries no information". That rule
 * is true of a map and false of a product, where an absent field means the
 * tree is malformed. Applying the map's rule to a product is what made a
 * record's last delete drop the record, and a partial struct write drop the
 * fields it did not mention.
 *
 * A node with no keys at all — a register, or an unrepresentable kind — has no
 * key space, and callers that reach one have nothing to decide.
 */
export type KeySpace = "declared" | "dynamic"

export function keySpace(parent: SchemaNode): KeySpace | undefined {
  if (stateTreeRole(parent) !== "decompose") return undefined
  return parent[KIND] === "product" ? "declared" : "dynamic"
}

/**
 * The schema node for a named child, or `undefined` where there is nothing to
 * descend into. A register holds its whole value in one tuple, and an
 * unrepresentable node has no tuples at all.
 */
function childSchemaForKey(
  schema: SchemaNode,
  key: string,
): SchemaNode | undefined {
  if (stateTreeRole(schema) !== "decompose") return undefined
  switch (schema[KIND]) {
    case "product":
      return (schema as { fields: Record<string, SchemaNode> }).fields[key]
    default:
      return (schema as { item: SchemaNode }).item
  }
}

/**
 * Why a schema cannot be stored in a StateTree.
 *
 * - `unrepresentable` — a node whose kind has no shape here.
 * - `decay-below-register` — `.decay()` under a `sum` or `.json()` node.
 *   A register is one tuple with one timestamp, so a field inside it has
 *   nothing of its own to age out.
 */
export type StateTreeViolation =
  | { rule: "unrepresentable"; path: string; kind: string }
  | { rule: "decay-below-register"; path: string }

/**
 * The maximum schema-graph traversal depth. The grammar guarantees finite
 * acyclic schemas, so this is only ever hit by an `as any`-crafted cycle.
 */
const MAX_SCHEMA_DEPTH = 1000

/**
 * The first reason this schema cannot be stored, if any.
 *
 * Both callers are seams a schema enters the substrate by: `bind()` and
 * `createStateSubstrate`. Neither can rely on the other, because
 * `ephemeralSubstrateFactory.create` is exported and skips `bind()`, and the
 * tree is seeded from the schema's zero at construction, so an unrepresentable
 * field is already stored wrongly before any write.
 *
 * Reports rather than throws, so the two callers cannot word the same failure
 * differently. `stepSchema` (`schema.ts`) states the reason for the shape.
 *
 * Representability outranks decay placement: being unable to store a field at
 * all subsumes any question about where its `.decay()` sits.
 *
 * No visited-set, deliberately. A legitimate shared node — one
 * `Schema.string()` reused across many fields — would false-positive. The
 * depth cap turns a cycle into a clear error instead.
 */
export function stateTreeViolation(
  schema: SchemaNode,
): StateTreeViolation | undefined {
  let decayViolation: StateTreeViolation | undefined

  const walk = (
    node: SchemaNode,
    path: string,
    depth: number,
    belowRegister: boolean,
    belowJson: boolean,
  ): StateTreeViolation | undefined => {
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new Error(
        `stateTreeViolation: schema nesting exceeds limit (${MAX_SCHEMA_DEPTH}) — cycle or pathological depth`,
      )
    }

    // Only `.json()` launders an unrepresentable kind, and a `sum` does not,
    // even though both store as one tuple. `.json()` is a request for opaque
    // storage; a `sum` is not, so a list inside a `.nullable()` wrap still
    // means the list semantics the schema asked for and this tree cannot keep
    // them. `EphemeralLaws` draws the line in the same place.
    if (!belowJson && stateTreeRole(node) === "unrepresentable") {
      return { rule: "unrepresentable", path, kind: String(node[KIND]) }
    }

    if (
      belowRegister &&
      (node as { decayMs?: number }).decayMs !== undefined &&
      decayViolation === undefined
    ) {
      decayViolation = { rule: "decay-below-register", path }
    }

    // Raised for the children, not for this node: `.decay()` on a register
    // itself is legal and means the whole value decays together. Decay uses
    // the wider boundary because a sum shares one timestamp across its
    // variant's fields whether or not it is opaque to the law set.
    const childrenBelowRegister = belowRegister || isOpaqueBoundary(node)
    const childrenBelowJson = belowJson || isJsonBoundary(node)
    const at = (key: string) => (path === "" ? key : `${path}.${key}`)

    switch (node[KIND]) {
      case "product": {
        const fields = (node as { fields: Record<string, SchemaNode> }).fields
        for (const key of Object.keys(fields)) {
          const found = walk(
            fields[key] as SchemaNode,
            at(key),
            depth + 1,
            childrenBelowRegister,
            childrenBelowJson,
          )
          if (found) return found
        }
        return undefined
      }
      case "sum": {
        const variants = (node as { variants: readonly SchemaNode[] }).variants
        for (const [i, variant] of variants.entries()) {
          const found = walk(
            variant,
            at(`<${i}>`),
            depth + 1,
            childrenBelowRegister,
            childrenBelowJson,
          )
          if (found) return found
        }
        return undefined
      }
      case "sequence":
      case "map":
      case "set":
      case "tree":
      case "movable":
        return walk(
          (node as { item: SchemaNode }).item,
          at("*"),
          depth + 1,
          childrenBelowRegister,
          childrenBelowJson,
        )
      default:
        // scalar, text, counter, richtext: no children to walk.
        return undefined
    }
  }

  return walk(schema, "", 0, false, false) ?? decayViolation
}

/**
 * Refuse a change the StateTree has no way to record.
 *
 * Unreachable in production: `stateTreeViolation` rejects the schemas that
 * could produce one at both seams a schema enters by, so a document whose
 * substrate exists can only issue `replace` and `map`. It is kept for the
 * shape rather than for the coverage.
 *
 * Every member of `BuiltinChange` is named, and `never` closes the switch.
 * A ninth member is then a compile error here until someone decides whether
 * this tree can store it. A `default` arm would have swallowed it into the
 * refusal silently, which is the failure this whole file is being changed for:
 * an unhandled change type used to fall off the end of `applyChangeToStateTree`
 * and advance σ while leaving λ untouched.
 *
 * `ChangeBase` is open — third-party backends extend it — so the unknown-type
 * case is answered separately below. The exhaustiveness check covers the
 * builtin vocabulary, not every possible change.
 */
function refuseUnstorableChange(change: ChangeBase): void {
  const refuse = (kind: string): never => {
    throw new Error(
      `The ephemeral substrate cannot store a ${kind} change. It keeps one ` +
        `timestamped tuple per leaf, so only whole-value replaces and map ` +
        `set/delete have a representation. Wrap the field with .json() to ` +
        `carry it as one opaque value.`,
    )
  }

  const type = change.type as BuiltinChange["type"]
  switch (type) {
    case "replace":
    case "map":
      return
    case "text":
    case "sequence":
    case "set-op":
    case "tree":
    case "increment":
    case "richtext":
      refuse(type)
      return
    default: {
      const exhaustive: never = type
      refuse(String(exhaustive))
    }
  }
}

/**
 * The message both seams throw, so the same failure cannot be worded two ways.
 *
 * Each names what to do rather than only what is wrong: a caller who reaches
 * either one got past `bind()`'s compile-time law check, so they are already
 * somewhere the types said they would not be.
 */
export function formatStateTreeViolation(
  violation: StateTreeViolation,
): string {
  const where =
    violation.path === "" ? "the root schema" : `"${violation.path}"`
  if (violation.rule === "unrepresentable") {
    return (
      `The ephemeral substrate cannot store a ${violation.kind} at ${where}. ` +
      `It keeps one timestamped tuple per leaf and decomposes only structs ` +
      `and records, so an ordered or counted container has no shape here. ` +
      `Wrap it with .json() to carry it as one opaque value — ` +
      `Schema.list.json(...) keeps push/insert/delete and replicates whole.`
    )
  }
  return (
    `.decay() cannot be set inside a sum variant or a .json() blob, at ` +
    `${where}. The whole value is stored as one register with a single ` +
    `timestamp, so a field inside it has nothing of its own to age out. ` +
    `Move .decay() onto the sum or .json() node itself if the whole value ` +
    `should decay together.`
  )
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
 * Serialize a tree for a peer, without our install ordinals.
 *
 * Dropping slot 2 shifts the tombstone marker down to index 2, which is the
 * encoding peers already speak — so the wire format is unchanged by the
 * ordinal's existence.
 *
 * This walks the tree rather than passing a replacer to `JSON.stringify`,
 * which would have been free. A replacer descends into *every* array,
 * including a leaf's value — and a register value may itself be an array,
 * which the tuple test cannot distinguish from a tuple. Walking explicitly
 * descends only through container keys and stops at a leaf, which is the same
 * rule `deepClone` follows and the only one that is safe here.
 */
export function encodeTree(tree: StateTree): string {
  return JSON.stringify(stripInstalledAt(tree))
}

function stripInstalledAt(node: StateTree): unknown {
  if (isStateTuple(node)) {
    return node[3] === true ? [node[0], node[1], true] : [node[0], node[1]]
  }
  const stripped: Record<string, unknown> = {}
  for (const key of Object.keys(node)) {
    stripped[key] = stripInstalledAt((node as Record<string, StateTree>)[key])
  }
  return stripped
}

/**
 * Parse a tree from a peer, leaving install ordinals unset.
 *
 * The merge stamps what it adopts, so filling them here would stamp leaves
 * that go on to lose the join — and "the counter moved" would stop meaning
 * "our state changed".
 */
export function decodeTree(data: string): StateTree {
  return restoreInstalledAt(JSON.parse(data))
}

function restoreInstalledAt(node: unknown): StateTree {
  // The wire tuple is `[value, timestamp, deleted?]`, so the marker sits where
  // the install ordinal will. Same reason as `stripInstalledAt` for walking
  // rather than reviving: a reviver cannot tell a register value that happens
  // to be an array from the tuple containing it.
  if (Array.isArray(node)) {
    const wire = node as [unknown, number, boolean?]
    return wire[2] === true
      ? [wire[0], wire[1], 0, true]
      : [wire[0], wire[1], 0]
  }
  const restored: Record<string, StateTree> = {}
  for (const key of Object.keys(node as Record<string, unknown>)) {
    restored[key] = restoreInstalledAt((node as Record<string, unknown>)[key])
  }
  return restored
}

/**
 * The leaves this replica took in after `installedAt`, as a partial tree, or
 * `undefined` when there are none.
 *
 * Containers are kept only when something beneath them survives, so the
 * result carries the paths of the changed leaves and nothing else. A key the
 * result omits is a key it makes no claim about, which is what lets the
 * receiver merge a delta with the same join it uses for an entirety.
 */
export function leavesInstalledAfter(
  node: StateTree,
  installedAt: number,
): StateTree | undefined {
  if (isStateTuple(node)) {
    return node[2] > installedAt ? node : undefined
  }
  let kept: Record<string, StateTree> | undefined
  for (const key of Object.keys(node)) {
    const child = leavesInstalledAfter(
      (node as Record<string, StateTree>)[key],
      installedAt,
    )
    if (child === undefined) continue
    kept ??= {}
    kept[key] = child
  }
  return kept
}

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

// ---------------------------------------------------------------------------
// Tree construction — plain value / change → StateTree
// ---------------------------------------------------------------------------
// These build (or mutate) a StateTree from a plain value or a Change. They
// live here alongside the merge/extract algebra so the whole StateTree
// transform layer is one functional core; the `ephemeral` substrate (the
// imperative shell) just calls them.
//
// The one decision they share is `stateTreeRole`. Storing a register whole is
// what stops `mergeStateTree` from blending fields across variants: a sum is
// opaque to the CRDT, exactly like a scalar (variant fields are not
// independently addressable, and a variant switch is a single whole-value
// `.set()`).

/**
 * Should `value` be decomposed into per-field tuples, or stored as one atomic
 * tuple? Only a plain (non-array) object can be decomposed. A missing schema
 * falls back to the historical "decompose any object" behavior.
 *
 * Asks `stateTreeRole`, not `needsContainer`. The two differ on `sequence`,
 * `text`, `set`, `tree`, `movable` and `richtext`: every one is a container to
 * `storageClass` and none has a representation here. `needsContainer` gave the
 * right answer for them only because none carries a plain-object value, so the
 * check above reached `false` first.
 */
function isDecomposedContainer(
  value: unknown,
  nodeSchema: SchemaNode | undefined,
): boolean {
  const isPlainObject =
    typeof value === "object" && value !== null && !Array.isArray(value)
  if (!isPlainObject) return false
  if (nodeSchema === undefined) return true
  return stateTreeRole(nodeSchema) === "decompose"
}

// ---------------------------------------------------------------------------
// Digest — an order-independent fingerprint of the tree
// ---------------------------------------------------------------------------

/**
 * A fingerprint of everything that replicates, and nothing that does not.
 *
 * Two peers holding the same tree hold the same digest, whatever order they
 * got there in. That is what lets a version comparison answer "do we hold the
 * same state?", which a wall clock cannot — see `StateVersion.compare`.
 *
 * Covers each leaf's path, value, timestamp and tombstone flag. It must not
 * cover anything local: `.decay()` is a read-time projection that never
 * touches the tree, so two peers configured with different `decayMs` hold
 * identical trees and must agree.
 *
 * The path is encoded structurally rather than built as a string. Four lanes
 * of the path prefix travel down the recursion as plain numbers, and each key
 * is folded into them on the way. That keeps the walk allocation-free apart
 * from the leaf's own value, which is the difference between 3.8 ms and 30 ms
 * over 5000 leaves.
 *
 * Folding the whole tree, rather than updating a running digest as leaves are
 * written. Updating per write needs each leaf's full path, and the four sites
 * that write leaves hold only a container and a key, so supplying one means
 * threading a path string through every recursion — and a digest maintained in
 * several places can drift, which would make two divergent peers agree to stop
 * talking. Encoding the path structurally costs a walk and removes both
 * problems. Memoize per flush: at 5000 leaves this is 3.8 ms against the 1.7 ms
 * `JSON.stringify` already spends once per offer per peer.
 */
export function stateTreeDigest(tree: StateTree): Digest {
  const lanes: [number, number, number, number] = [0, 0, 0, 0]

  const walk = (
    node: StateTree,
    a: number,
    b: number,
    c: number,
    d: number,
  ) => {
    if (isStateTuple(node)) {
      const value = node[0]
      const encoded =
        typeof value === "object" && value !== null
          ? JSON.stringify(value)
          : String(value)
      const stamp = String(node[1])
      // A tombstone and a live `null` are different states, and `String(null)`
      // cannot tell them apart.
      const dead = node[3] === true ? "\u0001" : ""
      lanes[0] ^= digestFold(digestFold(digestFold(a, encoded), stamp), dead)
      lanes[1] ^= digestFold(digestFold(digestFold(b, encoded), stamp), dead)
      lanes[2] ^= digestFold(digestFold(digestFold(c, encoded), stamp), dead)
      lanes[3] ^= digestFold(digestFold(digestFold(d, encoded), stamp), dead)
      return
    }
    const container = node as Record<string, StateTree>
    for (const key of Object.keys(container)) {
      walk(
        container[key] as StateTree,
        digestFold(a, key),
        digestFold(b, key),
        digestFold(c, key),
        digestFold(d, key),
      )
    }
  }

  walk(tree, DIGEST_SEEDS[0], DIGEST_SEEDS[1], DIGEST_SEEDS[2], DIGEST_SEEDS[3])
  return [lanes[0] >>> 0, lanes[1] >>> 0, lanes[2] >>> 0, lanes[3] >>> 0]
}

/**
 * Wrap a leaf value in a `StateTuple`, deep-cloning objects/arrays (register
 * values) so the tree never aliases the caller's live value.
 */
function leafTuple(value: unknown, stamp: WriteStamp): StateTuple {
  const stored =
    typeof value === "object" && value !== null ? deepClonePlain(value) : value
  return [stored, stamp.timestamp, stamp.installedAt]
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
 *
 * Total over the builtin change vocabulary: a change this tree has no way to
 * record throws (`refuseUnstorableChange`) rather than returning. The tree is
 * the only half of the substrate that replicates, so a change dropped here
 * leaves the writing peer reading back correctly and every other peer wrong.
 */
export function applyChangeToStateTree(
  tree: StateTree,
  path: Path,
  change: ChangeBase,
  stamp: WriteStamp,
  schema: SchemaNode | undefined,
): void {
  refuseUnstorableChange(change)

  if (path.length === 0) {
    if (isReplaceChange(change)) {
      const val = change.value
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        // Deep replace of the whole root (always a product). Decompose so
        // nested registers still land atomically (schema threaded through).
        // Sync in place for the same reason as the keyed case below: the root
        // is a product, so a field the value omits is not a removal.
        syncStateTreeToShadow(tree, val, schema, stamp)
      } else {
        throw new Error("Cannot replace root with a scalar")
      }
    } else {
      applyMapChange(
        tree as Record<string, StateTree>,
        change as MapChange,
        schema,
        stamp,
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

  if (isReplaceChange(change)) {
    const val = change.value
    if (isDecomposedContainer(val, targetSchema)) {
      // Sync into the existing subtree rather than building a fresh one and
      // assigning over it. A fresh subtree makes every omitted key vanish,
      // which is right for neither key space: a dynamic key should tombstone
      // so the removal replicates, and a declared field should survive
      // untouched. Both follow from reusing the subtree, because
      // `syncStateTreeToShadow` then sees what was there.
      if (!target[key] || isStateTuple(target[key])) target[key] = {}
      syncStateTreeToShadow(target[key], val, targetSchema, stamp)
    } else {
      target[key] = leafTuple(val, stamp)
    }
  } else {
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
    // tuple check covers the case where there is no schema opinion. An
    // unrepresentable node refuses here too, for the same reason: building a
    // container under it would give the tree a shape the schema never
    // declared.
    const schemaRefusesDecomposition =
      targetSchema !== undefined && stateTreeRole(targetSchema) !== "decompose"
    if (schemaRefusesDecomposition || isStateTuple(child)) {
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
      stamp,
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
  stamp: WriteStamp,
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
        ? tombstone(stamp)
        : tombstoneSubtree(existing, stamp)
  }

  for (const [key, value] of Object.entries(change.set ?? {})) {
    // The container's item schema decides whether an entry decomposes into a
    // subtree or lands as one leaf tuple (a register, or an ordinary scalar).
    const itemSchema = containerSchema
      ? childSchemaForKey(containerSchema, key)
      : undefined
    if (isDecomposedContainer(value, itemSchema)) {
      const subtree: Record<string, StateTree> = {}
      syncStateTreeToShadow(subtree, value, itemSchema, stamp)
      target[key] = subtree
    } else {
      target[key] = leafTuple(value, stamp)
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
  stamp: WriteStamp,
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
      syncStateTreeToShadow(target[key], val, childSchema, stamp)
    } else {
      // Scalar or register (sum / .json()): one atomic tuple.
      target[key] = leafTuple(val, stamp)
    }
  }

  // A *dynamic* key in the tree but absent from the plain value has been
  // deleted, so it tombstones exactly as an explicit `delete` does — otherwise
  // which call a writer happened to use would decide whether the removal
  // survives a merge.
  //
  // A declared field is left alone. Its key set comes from the schema, so an
  // omission is a caller writing a partial value, not a removal. Tombstoning
  // it would drop a field the schema says exists, and the field would then
  // resurrect from the next peer that still held it.
  //
  // An existing tombstone is left alone rather than re-stamped: refreshing it
  // on every unrelated whole-value write would let an old delete keep beating
  // a newer remote re-add.
  if (schema !== undefined && keySpace(schema) === "declared") return

  for (const key of Object.keys(target)) {
    if (key in plain) continue
    if (isTombstone(target[key])) continue
    target[key] = tombstoneSubtree(target[key], stamp)
  }
}

/**
 * Seed structural-zero defaults (stamp 0 = genesis, lineage ⊥) for keys
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
        t[key] = leafTuple(defaultVal, STRUCTURAL_ZERO)
      }
    } else if (isDecomposedContainer(defaultVal, childSchema)) {
      // Present container: fill any nested gaps.
      insertStructuralZeros(t[key], defaultVal, childSchema)
    }
  }
}
