// state-tree — CvRDT field-level LWW state space.
//
// The name is deliberate, though it reads like a leftover: the binding target
// this serves is `ephemeral`, and its substrate lives in `ephemeral.ts`.
// "State" here means *state-based CRDT* — the family whose peers exchange
// whole states and reconcile them with a join, rather than shipping an op log
// — which is precisely what this file implements. So `StateTree` and
// `mergeStateTree` keep the term rather than following the target's name.
//
// Defines the core data structure and merge algebra for the `ephemeral`
// substrate. A StateTree follows the document schema, with every scalar leaf
// replaced by a `Live` tuple `[value, timestamp]`, and every deleted or
// wholly replaced key marked by a `Horizon` (see TECHNICAL.md §"Deletion").
//
// Because the target supports only LWW laws (`"lww" | "lww-per-key"`),
// containers are limited to structs and maps. So any array in a StateTree is
// one of ours, a `Live` or a `Horizon`, never a sequence container.
//
// An *atomic register* — a `sum` variant or a `.json()` blob — is likewise
// stored as ONE `Live` tuple whose value is the whole object, rather than
// being decomposed into per-field tuples. Atomicity is therefore encoded in
// the tree's *shape*: because a register is a single tuple, the schema-blind
// merge treats it atomically for free.
//
// This is what lets `mergeStateTree` be completely schema-blind, fulfilling
// the requirement that headless replicas (relays, stores) can merge entirety
// payloads without schema knowledge.

import type { BuiltinChange, ChangeBase, MapChange } from "../change.js"
import { isReplaceChange, mapChangeEffects } from "../change.js"
import { deepClonePlain } from "../clone.js"
import { walkPath } from "../fold-path.js"
import { isNonNullObject } from "../guards.js"
import { DIGEST_SEEDS, type Digest, digestFold } from "../hash.js"
import { type Interpreter, interpret, type Path } from "../interpret.js"
import {
  createMaterializeInterpreter,
  type MaterializeContext,
  type MaterializeResolver,
  materializeContextFromResolver,
  plainResolution,
} from "../interpreters/materialize.js"
import { withDecay } from "../interpreters/with-decay.js"
import { RawPath } from "../path.js"
import type { PlainState } from "../reader.js"
import {
  isJsonBoundary,
  isOpaqueBoundary,
  KIND,
  type Schema as SchemaNode,
  storageClass,
} from "../schema.js"

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

/**
 * A written value: `[value, timestamp, installedAt]`.
 *
 * `timestamp` is when the value was written, never earlier than the wall
 * clock at the write and later than anything the write replaced (see
 * `stampOver`). It orders the join and is what decay measures.
 *
 * `installedAt` is the local install ordinal: which batch *this* replica took
 * the value in. It answers a different question from the timestamp. A peer
 * returning from an hour offline sends leaves written an hour ago and
 * installed just now, and filtering an outgoing delta by write time would drop
 * exactly those. It is local, so it is stripped on the way out and re-stamped
 * on the way in, and nothing that decides agreement may read it: two peers
 * holding identical data stamp it differently.
 */
export type Live = [value: unknown, timestamp: number, installedAt: number]

/**
 * A key deleted or replaced whole: `[content, horizon, installedAt, deleted]`.
 *
 * Everything written under the key before `horizon` is gone, and `content`
 * holds what has been written under it since. `deleted` says which of the two
 * happened at the horizon: a deletion, or a replacement, which also says the
 * key exists. `(horizon, deleted)` is itself a last-writer-wins value (see
 * `compareExistence`).
 *
 * A deletion with nothing written since has `content: null`. A replacement
 * always has a container, even an empty one: that is how an empty entry
 * exists.
 *
 * The horizon lives in a tuple rather than under a reserved key of the
 * container because any string is a valid record key, while arrays are a
 * channel user data cannot reach: containers are objects.
 */
export type Horizon = [
  content: Container | null,
  horizon: number,
  installedAt: number,
  deleted: boolean,
]

/** A struct or a map: one node per key. */
export type Container = { [key: string]: StateTree }

/** A node of the tree. The root is always a `Container`. */
export type StateTree = Live | Horizon | Container

export function isLive(node: unknown): node is Live {
  return Array.isArray(node) && node.length === 3 && typeof node[1] === "number"
}

export function isHorizon(node: unknown): node is Horizon {
  return (
    Array.isArray(node) && node.length === 4 && typeof node[3] === "boolean"
  )
}

function isContainer(node: unknown): node is Container {
  return isNonNullObject(node) && !Array.isArray(node)
}

type NodeKind = "live" | "horizon" | "container"

/**
 * Which of the three a node is. Throws on anything else: a malformed node
 * treated as a container would have its slots walked as keys, and the
 * characters of a string value after them.
 */
function nodeKind(node: StateTree): NodeKind {
  if (isLive(node)) return "live"
  if (isHorizon(node)) return "horizon"
  if (isContainer(node)) return "container"
  throw new Error(`Not a state tree node: ${JSON.stringify(node)}`)
}

/** Closes a `switch` over `nodeKind`, so a fourth kind is a compile error. */
function unreachableKind(kind: never): never {
  throw new Error(`unreachable node kind: ${String(kind)}`)
}

/** A deletion with nothing written since: the key reads as absent. */
function isBareDeletion(node: StateTree): boolean {
  return isHorizon(node) && node[3] && node[0] === null
}

// ---------------------------------------------------------------------------
// Merge algebra (join semilattice)
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
 * Order two existence claims, `[timestamp, present]`: `1` when `a` wins, `-1`
 * when `b` does, `0` when they are the same claim.
 *
 * The later timestamp wins. On a tie, present beats absent: a tie carries no
 * reason to prefer the deletion, and that direction discards less. A live leaf
 * claims presence at its timestamp; a horizon claims `!deleted` at its
 * horizon. Every tie in the join resolves through here.
 *
 * Only different writers can tie. A writer's own writes are ordered by
 * construction, because each one is stamped past what it replaces.
 */
function compareExistence(
  a: readonly [number, boolean],
  b: readonly [number, boolean],
): -1 | 0 | 1 {
  if (a[0] !== b[0]) return a[0] > b[0] ? 1 : -1
  if (a[1] !== b[1]) return a[1] ? 1 : -1
  return 0
}

function existenceOf(node: Live | Horizon): readonly [number, boolean] {
  return isLive(node) ? [node[1], true] : [node[1], !node[3]]
}

/**
 * The join of two leaves at a scalar position: two live values, or a live
 * value against a deletion.
 *
 * `compareExistence` decides first. Two live values at the same timestamp are
 * then ranked by value: both peers compare the same pair of strings, so they
 * reach the same verdict, and string comparison is a total order, which keeps
 * the join associative across three or more tied peers. TECHNICAL.md §"The
 * merge rule, in full" has the longer argument.
 *
 * Returns one of its arguments rather than a copy. **Both comparisons stay
 * strict**: `mergeStateTree` reads "the winner is not the local node" as "our
 * state changed", so returning the incoming node for one that merely ties
 * would report a change on every re-merge of state a peer already holds, and
 * in a mesh of three or more that circulates forever.
 */
export function joinTuples<T extends Live | Horizon>(local: T, remote: T): T {
  const order = compareExistence(existenceOf(local), existenceOf(remote))
  if (order !== 0) return order > 0 ? local : remote
  if (isLive(local) && isLive(remote)) {
    return valueRank(remote[0]) > valueRank(local[0]) ? remote : local
  }
  return local
}

/**
 * Drop everything stamped strictly before `floor`.
 *
 * A live leaf below the floor is removed. A horizon below it is unwrapped: the
 * floor already says everything its own horizon says, so only its content can
 * survive. A tie survives, which matches "present beats absent".
 *
 * Also brings the result into normal form: no empty plain container, and a
 * horizon's content `null` exactly when it is a deletion with nothing in it.
 * `undefined` means nothing survives.
 *
 * Safe without causal stability, because a horizon only ever rises: whatever
 * is below one now is below it for good, and a peer that sends it again has it
 * dropped again.
 */
export function prune(node: StateTree, floor: number): StateTree | undefined {
  const kind = nodeKind(node)
  switch (kind) {
    case "live":
      return (node as Live)[1] < floor ? undefined : node
    case "horizon": {
      const [content, horizon, installedAt, deleted] = node as Horizon
      if (horizon < floor) {
        return content === null ? undefined : pruneContainer(content, floor)
      }
      return horizonOf(
        content === null ? undefined : pruneContainer(content, horizon),
        horizon,
        installedAt,
        deleted,
      )
    }
    case "container":
      return pruneContainer(node as Container, floor)
    default:
      return unreachableKind(kind)
  }
}

function pruneContainer(
  container: Container,
  floor: number,
): Container | undefined {
  let kept: Container | undefined
  for (const key of Object.keys(container)) {
    const child = prune(container[key] as StateTree, floor)
    if (child === undefined) continue
    kept ??= {}
    kept[key] = child
  }
  return kept
}

/** A horizon in normal form, whatever content it was handed. */
function horizonOf(
  content: Container | undefined,
  horizon: number,
  installedAt: number,
  deleted: boolean,
): Horizon {
  const normal =
    content !== undefined && Object.keys(content).length > 0
      ? content
      : deleted
        ? null
        : {}
  return [normal, horizon, installedAt, deleted]
}

/**
 * Schema-blind join of two StateTrees: `local ⊔ remote`.
 *
 * Modifies `local` in place and returns it, along with where the join moved.
 * Both trees must be in normal form, which `decodeTree` and every local write
 * guarantee.
 *
 * `moved` holds the key path of every node where the join changed the
 * winner, raised a horizon or adopted a key; a path may sit below another.
 * The substrate re-projects σ at those paths and nowhere else.
 *
 * Whether it is empty is a lattice question, not a bookkeeping one:
 * `a ⊔ b = a` exactly when `b ≤ a`, so an empty `moved` means the incoming
 * payload was already subsumed. The caller needs it because announcing a
 * change that did not happen is not merely wasteful — in a mesh of three or
 * more peers it is a cycle, since each peer relays to everyone but the sender
 * and no peer can decline a re-import it has no way to recognise as
 * redundant.
 */
export interface MergeResult {
  readonly tree: Container
  readonly moved: readonly (readonly string[])[]
}

export function mergeStateTree(
  local: Container,
  remote: Container,
  installedAt: number,
): MergeResult {
  const moved: (readonly string[])[] = []
  joinContainers(local, remote, installedAt, moved, [])
  return { tree: local, moved }
}

/** The key paths a join moved, collected as it recurses. */
type Moved = (readonly string[])[]

/**
 * Copy an incoming node into the local tree, stamping every leaf and horizon
 * in it as installed now.
 *
 * The incoming payload carries no install ordinal — it is stripped on the
 * wire, because it is a fact about the receiver. Stamping here rather than at
 * parse time means only what actually *wins* is stamped, which is what makes
 * "the counter moved" and "the state changed" the same question.
 */
function adopt(node: StateTree, installedAt: number): StateTree {
  const kind = nodeKind(node)
  switch (kind) {
    case "live": {
      const [value, timestamp] = node as Live
      return [value, timestamp, installedAt]
    }
    case "horizon": {
      const [content, horizon, , deleted] = node as Horizon
      return [
        content === null ? null : adoptContainer(content, installedAt),
        horizon,
        installedAt,
        deleted,
      ]
    }
    case "container":
      return adoptContainer(node as Container, installedAt)
    default:
      return unreachableKind(kind)
  }
}

function adoptContainer(container: Container, installedAt: number): Container {
  const copy: Container = {}
  for (const key of Object.keys(container)) {
    copy[key] = adopt(container[key] as StateTree, installedAt)
  }
  return copy
}

/**
 * `local ⊔ remote` for two normal-form nodes at the same key.
 *
 * Both are already free of anything below the floor they sit under, so
 * pruning is needed only where the joined horizon rises above one side's own.
 */
function join(
  local: StateTree,
  remote: StateTree,
  installedAt: number,
  moved: Moved,
  at: readonly string[],
): StateTree {
  const localTuple = isLive(local) || isBareDeletion(local)
  const remoteTuple = isLive(remote) || isBareDeletion(remote)
  if (localTuple && remoteTuple) {
    const winner = joinTuples(local as Live | Horizon, remote as Live | Horizon)
    // Identity is the whole test: `joinTuples` returns the local node for
    // anything it cannot strictly beat.
    if (winner === local) return local
    moved.push(at)
    return adopt(winner, installedAt)
  }

  if (isHorizon(local) || isHorizon(remote)) {
    if (isLive(local) || isLive(remote)) {
      return joinMismatchedShapes(local, remote, installedAt, moved, at)
    }
    return joinHorizons(local, remote, installedAt, moved, at)
  }

  if (isLive(local) || isLive(remote)) {
    return joinMismatchedShapes(local, remote, installedAt, moved, at)
  }

  // Neither side is live or a horizon, so both are containers; `nodeKind`
  // throws if either is not a node at all.
  if (nodeKind(local) !== "container" || nodeKind(remote) !== "container") {
    throw new Error(
      "unreachable: two nodes that are neither leaves nor horizons",
    )
  }
  joinContainers(
    local as Container,
    remote as Container,
    installedAt,
    moved,
    at,
  )
  return local
}

/**
 * Join where at least one side is a horizon and neither is live. A plain
 * container is a node with no horizon of its own.
 */
function joinHorizons(
  local: Horizon | Container,
  remote: Horizon | Container,
  installedAt: number,
  moved: Moved,
  at: readonly string[],
): StateTree {
  if (isContainer(local)) {
    // The key gains a horizon it did not have: our container is content
    // written before it, and keeps only what the horizon lets through.
    const incoming = remote as Horizon
    moved.push(at)
    const content = mergeContent(
      pruneContainer(local, incoming[1]) ?? null,
      incoming[0],
      installedAt,
      moved,
      at,
    )
    return horizonOf(
      content ?? undefined,
      incoming[1],
      installedAt,
      incoming[3],
    )
  }

  if (isContainer(remote)) {
    // Our horizon stands. The incoming container is content, and only what
    // was written at or after our horizon survives it.
    const surviving = pruneContainer(remote, local[1])
    const content = mergeContent(
      local[0],
      surviving ?? null,
      installedAt,
      moved,
      at,
    )
    const normal = horizonOf(content ?? undefined, local[1], local[2], local[3])
    local[0] = normal[0]
    return local
  }

  const order = compareExistence(existenceOf(local), existenceOf(remote))
  if (order < 0) {
    // The incoming horizon wins, and is at least as high as ours. Our content
    // keeps only what was written at or after it.
    moved.push(at)
    const ours =
      local[0] === null ? null : (pruneContainer(local[0], remote[1]) ?? null)
    const content = mergeContent(ours, remote[0], installedAt, moved, at)
    const normal = horizonOf(
      content ?? undefined,
      remote[1],
      installedAt,
      remote[3],
    )
    local[0] = normal[0]
    local[1] = normal[1]
    local[2] = normal[2]
    local[3] = normal[3]
    return local
  }

  // Our horizon stands, and is at least as high as theirs.
  const theirs =
    remote[0] === null ? null : (pruneContainer(remote[0], local[1]) ?? null)
  const content = mergeContent(local[0], theirs, installedAt, moved, at)
  local[0] = horizonOf(content ?? undefined, local[1], local[2], local[3])[0]
  return local
}

/** Join two horizons' content: `null` joins as the empty container. */
function mergeContent(
  local: Container | null,
  remote: Container | null,
  installedAt: number,
  moved: Moved,
  at: readonly string[],
): Container | null {
  if (remote === null) return local
  if (local === null) {
    if (Object.keys(remote).length === 0) return null
    moved.push(at)
    return adoptContainer(remote, installedAt)
  }
  joinContainers(local, remote, installedAt, moved, at)
  return local
}

/** Union the keys, joining where both sides hold one. Mutates `local`. */
function joinContainers(
  local: Container,
  remote: Container,
  installedAt: number,
  moved: Moved,
  at: readonly string[],
): void {
  for (const key of Object.keys(remote)) {
    const theirs = remote[key] as StateTree
    const ours = local[key]
    if (ours === undefined) {
      // A key we have never seen. Absence carries no information under a
      // key-unioning merge, so this is always new state.
      moved.push([...at, key])
      local[key] = adopt(theirs, installedAt)
    } else {
      local[key] = join(ours, theirs, installedAt, moved, [...at, key])
    }
  }
}

/**
 * One side is a live leaf where the other is a container or a horizon with
 * content: the peers disagree about this node's SHAPE. Shape comes from the
 * schema, so only a malformed or mismatched-schema payload reaches here. A
 * deletion of a key never seen is a horizon, which joins a container by
 * pruning it, so it never reaches here.
 *
 * Containers carry no timestamp of their own, hence the comparison on the
 * newest timestamp within. Simply taking `remote` would be shorter and is
 * wrong: deterministic is not commutative, so two peers merging in opposite
 * directions would disagree permanently.
 *
 * Not associative, and not claimed to be: the loser's contents are discarded,
 * so no later merge can recover them. The guarantee lives upstream, in keeping
 * shapes stable.
 */
function joinMismatchedShapes(
  local: StateTree,
  remote: StateTree,
  installedAt: number,
  moved: Moved,
  at: readonly string[],
): StateTree {
  const localTimestamp = newestTimestamp(local)
  const remoteTimestamp = newestTimestamp(remote)
  if (localTimestamp > remoteTimestamp) return local
  if (
    remoteTimestamp === localTimestamp &&
    valueRank(remote) <= valueRank(local)
  ) {
    return local
  }
  moved.push(at)
  return adopt(remote, installedAt)
}

// ---------------------------------------------------------------------------
// Projection: StateTree to PlainState, through the schema fold
// ---------------------------------------------------------------------------

/**
 * The newest timestamp anywhere in a node, horizons included.
 *
 * Containers carry no timestamp of their own, so a container's age is its
 * newest leaf's. Decay measures a container by it, a write is stamped past it
 * (`stampOver`), and the merge compares a leaf with a container by it when
 * two peers disagree about a node's shape. `0` for a node nothing has been
 * written to.
 */
export function newestTimestamp(node: StateTree): number {
  const kind = nodeKind(node)
  switch (kind) {
    case "live":
      return (node as Live)[1]
    case "horizon": {
      const [content, horizon] = node as Horizon
      return content === null
        ? horizon
        : Math.max(horizon, newestTimestamp(content))
    }
    case "container": {
      const container = node as Container
      let newest = 0
      for (const key of Object.keys(container)) {
        newest = Math.max(newest, newestTimestamp(container[key] as StateTree))
      }
      return newest
    }
    default:
      return unreachableKind(kind)
  }
}

/** One step down the tree: the child at `key`, through a horizon's content. */
function childOf(node: StateTree, key: string): StateTree | undefined {
  const kind = nodeKind(node)
  switch (kind) {
    case "live":
      return undefined
    case "horizon":
      return (node as Horizon)[0]?.[key]
    case "container":
      return (node as Container)[key]
    default:
      return unreachableKind(kind)
  }
}

/** What a path reaches: a tree node, a plain value inside a register, or nothing. */
export type StateTreeAt =
  | { readonly kind: "node"; readonly node: StateTree }
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "absent" }

const ABSENT: StateTreeAt = { kind: "absent" }

/**
 * Resolve `path` against the tree.
 *
 * A path may run past a leaf. A register's fields are addressable through the
 * schema, but the register is one tuple, so the rest of the path is read from
 * inside the tuple's value. A bare deletion reads as nothing: the key has no
 * value to read.
 */
export function stateTreeAt(tree: StateTree, path: Path): StateTreeAt {
  let node = tree
  for (const [i, segment] of path.segments.entries()) {
    if (isLive(node)) return valueAt(node[0], path.segments.slice(i))
    const child = childOf(node, String(segment.resolve()))
    if (child === undefined) return ABSENT
    node = child
  }
  return isBareDeletion(node) ? ABSENT : { kind: "node", node }
}

/** Read the rest of a path from inside a plain value. */
function valueAt(value: unknown, segments: Path["segments"]): StateTreeAt {
  let current = value
  for (const segment of segments) {
    if (!isNonNullObject(current)) return ABSENT
    current = (current as Record<string, unknown>)[String(segment.resolve())]
    if (current === undefined) return ABSENT
  }
  return { kind: "value", value: current }
}

/**
 * Whether a node reads as present when it sits at a dynamic key.
 *
 * A live leaf and a replacement are present; a replacement is how an empty
 * entry exists. Anything else is present only if something beneath it is:
 * something written after a deletion brings the entry back, and a container
 * whose every entry was deleted reads as deleted.
 */
function isPresent(node: StateTree): boolean {
  const kind = nodeKind(node)
  switch (kind) {
    case "live":
      return true
    case "horizon": {
      const [content, , , deleted] = node as Horizon
      return !deleted || (content !== null && hasPresentChild(content))
    }
    case "container":
      return hasPresentChild(node as Container)
    default:
      return unreachableKind(kind)
  }
}

function hasPresentChild(container: Container): boolean {
  for (const key of Object.keys(container)) {
    if (isPresent(container[key] as StateTree)) return true
  }
  return false
}

/** The keys of a container, or of a horizon's content, that read as present. */
function presentKeys(node: Container | Horizon): string[] {
  const container = isHorizon(node) ? node[0] : node
  if (container === null) return []
  return Object.keys(container).filter(key => hasPresentKey(node, key))
}

/** Whether `key` reads as present in a container or a horizon's content. */
function hasPresentKey(node: Container | Horizon, key: string): boolean {
  const container = isHorizon(node) ? node[0] : node
  const child = container === null ? undefined : container[key]
  return child !== undefined && isPresent(child)
}

/**
 * A `MaterializeResolver` over the tree, so that the tree projects through
 * the same fold the CRDT backends use.
 *
 * Schema-blind, as theirs are: the fold holds the schema, supplies every zero,
 * and applies decay through `withDecay`. A leaf's value is returned by
 * reference, so a projection shares register values with the tree.
 */
export function createStateTreeResolver(tree: StateTree): MaterializeResolver {
  function plainAt(path: Path): unknown {
    const at = stateTreeAt(tree, path)
    if (at.kind === "value") return at.value
    if (at.kind === "node" && isLive(at.node)) return at.node[0]
    return undefined
  }

  return {
    resolveValue: plainAt,
    resolveText: path => plainResolution.text(plainAt(path)),
    resolveCounter: path => plainResolution.counter(plainAt(path)),
    resolveRichText: path => plainResolution.richText(plainAt(path)),
    resolveLength: path => plainResolution.length(plainAt(path)),
    resolveKeys(path) {
      const at = stateTreeAt(tree, path)
      if (at.kind === "absent") return []
      if (at.kind === "value") return plainResolution.keys(at.value)
      if (isLive(at.node)) return plainResolution.keys(at.node[0])
      return presentKeys(at.node)
    },
    resolveHasKey(path, key) {
      const at = stateTreeAt(tree, path)
      if (at.kind === "absent") return false
      if (at.kind === "value") return plainResolution.hasKey(at.value, key)
      if (isLive(at.node)) return plainResolution.hasKey(at.node[0], key)
      return hasPresentKey(at.node, key)
    },
    // A tree schema has no representation here; `stateTreeViolation` refuses
    // it before a substrate exists.
    resolveForest: () => [],
  }
}

/**
 * The document as of `now`.
 *
 * Shares register values with the tree (see `createStateTreeResolver`), so a
 * caller that keeps or hands out part of it must copy that part first.
 */
export function projectStateTree(
  tree: StateTree,
  schema: SchemaNode,
  now: number,
): PlainState {
  const { resolver, interpreter } = stateTreeMaterializer(tree, now)
  return interpret(
    schema,
    interpreter,
    materializeContextFromResolver(resolver),
  ) as PlainState
}

/**
 * The resolver over `tree` and the fold that projects through it as of
 * `now`, decay applied: what `projectStateTree` runs over the whole schema,
 * and what a reconcile runs over the parts a merge or tick touched.
 */
export function stateTreeMaterializer(
  tree: StateTree,
  now: number,
): {
  readonly resolver: MaterializeResolver
  readonly interpreter: Interpreter<MaterializeContext, unknown>
} {
  const resolver = createStateTreeResolver(tree)
  const newestAt = (path: Path): number => {
    const at = stateTreeAt(tree, path)
    return at.kind === "node" ? newestTimestamp(at.node) : 0
  }
  return {
    resolver,
    interpreter: withDecay(
      createMaterializeInterpreter(resolver),
      newestAt,
      now,
    ),
  }
}

/**
 * The path a StateTree key path names under `root`: a declared key is a
 * field, a dynamic key an entry. Stops at a register, whose keys are inside
 * its one value, and at a key the schema does not declare. A fold over
 * `keySpace` and `childSchemaForKey`, adding no rule of its own.
 */
function keysToPath(root: SchemaNode, keys: readonly string[]): Path {
  let path: Path = RawPath.empty
  let schema = root
  for (const key of keys) {
    const space = keySpace(schema)
    const child = childSchemaForKey(schema, key)
    if (space === undefined || child === undefined) break
    path = space === "declared" ? path.field(key) : path.entry(key)
    schema = child
  }
  return path
}

/**
 * The part of σ a move at `keys` can change: the path cut after its first
 * dynamic key. An entry at a dynamic key is present only while something
 * beneath it is (`isPresent`), so a leaf deleted anywhere below can remove
 * the entry, and with it any entry above that held nothing else.
 */
export function movedScope(root: SchemaNode, keys: readonly string[]): Path {
  const path = keysToPath(root, keys)
  const entry = path.segments.findIndex(segment => segment.role === "entry")
  return entry === -1 ? path : path.slice(0, entry + 1)
}

// ---------------------------------------------------------------------------
// How a schema node is stored
// ---------------------------------------------------------------------------

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
 * (`schema.ts`) is for substrates generally. Its consumers hold no logic of
 * their own: `childSchemaForKey`, `writeNode`, `stateTreeViolation`, and the
 * map-change guard in `applyChangeToStateTree`.
 *
 * Two kinds are listed, not seven. `register` and `unrepresentable` are
 * different answers, and stating the accepted set means a schema kind added
 * later lands in `unrepresentable` rather than joining the storable set
 * silently.
 */
type StateTreeRole = "decompose" | "register" | "unrepresentable"

function stateTreeRole(node: SchemaNode): StateTreeRole {
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
 * first write to an unrepresentable field would store it in a shape the
 * schema never declared.
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

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * Serialize a tree for a peer, without our install ordinals.
 *
 * On the wire a live leaf is `[value, timestamp]` and a horizon is
 * `[content, horizon, deleted]`, so a bare deletion is `[null, horizon, true]`:
 * the tombstone shape peers have always spoken.
 *
 * This walks the tree rather than passing a replacer to `JSON.stringify`,
 * which would have been free. A replacer descends into *every* array,
 * including a leaf's value — and a register value may itself be an array,
 * which no test can tell apart from a tuple. Walking explicitly descends only
 * through container keys and horizon content, and stops at a leaf.
 */
export function encodeTree(tree: StateTree): string {
  return JSON.stringify(toWire(tree))
}

function toWire(node: StateTree): unknown {
  const kind = nodeKind(node)
  switch (kind) {
    case "live": {
      const [value, timestamp] = node as Live
      return [value, timestamp]
    }
    case "horizon": {
      const [content, horizon, , deleted] = node as Horizon
      return [
        content === null ? null : containerToWire(content),
        horizon,
        deleted,
      ]
    }
    case "container":
      return containerToWire(node as Container)
    default:
      return unreachableKind(kind)
  }
}

function containerToWire(container: Container): Record<string, unknown> {
  const wire: Record<string, unknown> = {}
  for (const key of Object.keys(container)) {
    wire[key] = toWire(container[key] as StateTree)
  }
  return wire
}

/**
 * Parse a tree from a peer: the one way peer data enters.
 *
 * Refuses the whole payload, by throwing, if any node has a shape this tree
 * does not have or a timestamp that is not a non-negative safe integer. Every
 * guarantee a local write makes rests on `timestamp + 1 > timestamp`, which
 * fails for `Infinity` (`JSON.parse("1e400")`) and above 2^53. Nothing is
 * mutated before the throw, so a refused payload leaves no trace.
 *
 * The result is in normal form, which the merge relies on. Install ordinals
 * are left at 0: the merge stamps what it adopts, and stamping here would mark
 * nodes that go on to lose the join.
 */
export function decodeTree(data: string): Container {
  const wire: unknown = JSON.parse(data)
  if (!isContainer(wire)) {
    throw new Error("A state tree payload must be an object at its root.")
  }
  return pruneContainer(decodeContainer(wire, ""), 0) ?? {}
}

function decodeNode(wire: unknown, path: string): StateTree {
  if (isContainer(wire)) return decodeContainer(wire, path)
  if (Array.isArray(wire)) {
    if (wire.length === 2) return [wire[0], timestampAt(wire[1], path), 0]
    if (wire.length === 3 && typeof wire[2] === "boolean") {
      const [content, horizon, deleted] = wire as [unknown, unknown, boolean]
      if (content !== null && !isContainer(content)) {
        throw new Error(
          `A horizon's content must be null or an object, at "${path}".`,
        )
      }
      return horizonOf(
        content === null ? undefined : decodeContainer(content, path),
        timestampAt(horizon, path),
        0,
        deleted,
      )
    }
  }
  throw new Error(`Not a state tree node, at "${path}".`)
}

function decodeContainer(
  wire: Record<string, unknown>,
  path: string,
): Container {
  const container: Container = {}
  for (const key of Object.keys(wire)) {
    container[key] = decodeNode(wire[key], path === "" ? key : `${path}.${key}`)
  }
  return container
}

function timestampAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `A state tree timestamp must be a non-negative safe integer, at "${path}": ${String(value)}.`,
    )
  }
  return value
}

/**
 * What this replica installed after `installedAt`, as a partial tree.
 *
 * Containers are kept only when something beneath them survives, so the
 * result carries the paths of the changed nodes and nothing else. A horizon
 * is kept when it, or anything in its content, was installed after the
 * cursor. Its content in the delta holds only what was, and `null` there
 * makes no claim about the content. The receiver merges a delta with the same
 * join it uses for an entirety, and a key a delta omits is a key it says
 * nothing about.
 *
 * Returns an empty tree when nothing is newer, never `undefined`. "Nothing
 * changed" and "nothing to say" must not share a representation here: one
 * layer up, `exportSince` answering `null` for an empty delta made every
 * already-current peer receive a whole document.
 */
export function installedAfter(
  node: StateTree,
  installedAt: number,
): StateTree {
  return keptAfter(node, installedAt) ?? {}
}

/** `undefined` means "prune this branch" — internal to the walk only. */
function keptAfter(
  node: StateTree,
  installedAt: number,
): StateTree | undefined {
  const kind = nodeKind(node)
  switch (kind) {
    case "live":
      return (node as Live)[2] > installedAt ? node : undefined
    case "horizon": {
      const [content, horizon, installed, deleted] = node as Horizon
      const kept =
        content === null ? undefined : keptAfterContainer(content, installedAt)
      if (installed <= installedAt && kept === undefined) return undefined
      return [kept ?? null, horizon, installed, deleted]
    }
    case "container":
      return keptAfterContainer(node as Container, installedAt)
    default:
      return unreachableKind(kind)
  }
}

function keptAfterContainer(
  container: Container,
  installedAt: number,
): Container | undefined {
  let kept: Container | undefined
  for (const key of Object.keys(container)) {
    const child = keptAfter(container[key] as StateTree, installedAt)
    if (child === undefined) continue
    kept ??= {}
    kept[key] = child
  }
  return kept
}

// ---------------------------------------------------------------------------
// Writes: plain value / change to StateTree
// ---------------------------------------------------------------------------
// These build (or mutate) a StateTree from a plain value or a Change. They
// live here alongside the merge algebra so the whole StateTree transform layer
// is one functional core; the `ephemeral` substrate (the imperative shell)
// reads the clock and calls them.
//
// Every write is stamped strictly later than whatever it replaces, so the tree
// after a write is at or above the tree before it. Without that, a peer
// holding the old state would keep it through the join, and the writer would
// adopt it back. TECHNICAL.md §"A local write is later than what it
// overwrites" has the failure modes.

/**
 * When a write happened, in both senses the tree needs.
 *
 * `notBefore` is the wall clock at the write: the earliest timestamp it may
 * install. `stampOver` moves it later where the write replaces something
 * newer. `installedAt` is this replica's install ordinal: which batch *we*
 * took the value in.
 */
export interface WriteStamp {
  readonly notBefore: number
  readonly installedAt: number
}

/**
 * A stamp strictly later than everything in `replaced`, and no earlier than
 * `stamp`.
 *
 * Compares timestamps only. The write then wins the join on timestamp alone,
 * so the tie rule is never consulted and never pays for `stringify`.
 */
export function stampOver(
  stamp: WriteStamp,
  replaced: StateTree | undefined,
): WriteStamp {
  if (replaced === undefined) return stamp
  const past = newestTimestamp(replaced) + 1
  return past > stamp.notBefore
    ? { notBefore: past, installedAt: stamp.installedAt }
    : stamp
}

/**
 * `stamp`, raised to `floor`: a write beneath a horizon must not be stamped
 * before it, or the next prune removes it. A peer with a fast clock can set a
 * horizon ahead of ours.
 */
function atFloor(stamp: WriteStamp, floor: number): WriteStamp {
  return floor > stamp.notBefore
    ? { notBefore: floor, installedAt: stamp.installedAt }
    : stamp
}

/** A live leaf holding `value`, deep-cloned so the tree never aliases it. */
function writeLive(
  value: unknown,
  stamp: WriteStamp,
  replaced: StateTree | undefined,
): Live {
  const at = stampOver(stamp, replaced)
  const stored = isNonNullObject(value) ? deepClonePlain(value) : value
  return [stored, at.notBefore, at.installedAt]
}

/** A deletion of whatever the key held, seen or not. */
function writeDeletion(
  stamp: WriteStamp,
  replaced: StateTree | undefined,
): Horizon {
  const at = stampOver(stamp, replaced)
  return [null, at.notBefore, at.installedAt, true]
}

/**
 * A container written whole: a horizon past everything it replaces, with the
 * value written as content at the horizon. Keys the writer never saw are
 * below the horizon, so the join drops them.
 */
function writeReplacement(
  value: Record<string, unknown>,
  schema: SchemaNode,
  stamp: WriteStamp,
  replaced: StateTree | undefined,
): Horizon {
  const at = stampOver(stamp, replaced)
  const position = keySpaceOf(schema)
  const content: Container = {}
  for (const [key, child] of Object.entries(value)) {
    content[key] = writeNode(
      child,
      childSchemaFor(schema, key),
      at,
      undefined,
      position,
    )
  }
  return horizonOf(content, at.notBefore, at.installedAt, false)
}

/**
 * Write a product's fields into an existing container, one by one.
 *
 * The one writer that mutates in place: it writes into the container already
 * there, at O(fields written). An authored value arrives complete, so every
 * declared field is written. A field a value omits would be left alone, since
 * a product's fields exist because the schema declares them, and an omission
 * is a partial value rather than a removal.
 */
export function writeProduct(
  target: Container,
  value: Record<string, unknown>,
  schema: SchemaNode,
  stamp: WriteStamp,
): void {
  for (const [key, child] of Object.entries(value)) {
    target[key] = writeNode(
      child,
      childSchemaFor(schema, key),
      stamp,
      target[key],
      "declared",
    )
  }
}

/**
 * The node `value` becomes when written at a key whose key space is
 * `position`, replacing `replaced`.
 *
 * A scalar or register is one live leaf. A map written whole is a replacement
 * wherever it sits, because its keys are dynamic and the writer may not have
 * seen them all. So is a product at a dynamic key, whose existence is itself
 * last-writer-wins. A product at a declared key is written field by field
 * into the container already there.
 *
 * So a horizon is raised exactly where `planSubtreeEffect` says a change
 * rewrote a subtree at a dynamic position, and nowhere else;
 * `ephemeral-subtree-effect.test.ts` pins that law.
 */
function writeNode(
  value: unknown,
  schema: SchemaNode,
  stamp: WriteStamp,
  replaced: StateTree | undefined,
  position: KeySpace,
): StateTree {
  if (stateTreeRole(schema) !== "decompose" || !isContainer(value)) {
    return writeLive(value, stamp, replaced)
  }
  if (schema[KIND] === "map" || position === "dynamic") {
    return writeReplacement(value, schema, stamp, replaced)
  }
  if (isContainer(replaced)) {
    writeProduct(replaced, value, schema, stamp)
    return replaced
  }
  const created: Container = {}
  writeProduct(created, value, schema, stampOver(stamp, replaced))
  return created
}

/** The key space of a container schema, which every write target has. */
function keySpaceOf(schema: SchemaNode): KeySpace {
  const space = keySpace(schema)
  if (space === undefined) {
    throw new Error(
      `A ${String(schema[KIND])} node has no keys to write into. Only structs and records decompose in the ephemeral substrate.`,
    )
  }
  return space
}

/**
 * The schema of a named child, which a write target must declare. Completion
 * drops an undeclared key from a value before it reaches the tree, so this
 * throws only for a change whose path or keys the schema does not fit.
 */
function childSchemaFor(schema: SchemaNode, key: string): SchemaNode {
  const child = childSchemaForKey(schema, key)
  if (child === undefined) {
    throw new Error(`The schema has no field "${key}" to write.`)
  }
  return child
}

/**
 * The schema node at `path`.
 *
 * A path into a sum is not malformed; it needs the stored value to resolve,
 * because a sum picks its variant by inspecting what is stored. `walkPath`
 * reports that as a `boundary` and yields the register's own schema, which is
 * the answer the write needs. A path that does not fit the schema at all is a
 * caller's error, and throws rather than guessing a shape for the tree.
 */
function schemaAtPath(root: SchemaNode, path: Path): SchemaNode {
  const walk = walkPath(undefined, root, path)
  if (walk.stop === "mismatch") {
    throw new Error(
      `A write's path does not fit the document schema: ${walk.reason}`,
    )
  }
  return walk.schema
}

/**
 * The container at `parent[key]` for a write to land in, creating it if there
 * is none, and the floor beneath it.
 *
 * Beneath a horizon the container is its content, which a deletion with
 * nothing written since does not have yet. A live leaf where the schema says
 * container means a malformed tree; the new container is stamped past it so
 * the join keeps it.
 */
function containerAt(
  parent: Container,
  key: string,
  floor: number,
): { readonly container: Container; readonly floor: number } {
  const node = parent[key]
  if (isContainer(node)) return { container: node, floor }
  if (isHorizon(node)) {
    node[0] ??= {}
    return { container: node[0], floor: floorBeneath(node, floor) }
  }
  const created: Container = {}
  parent[key] = created
  return {
    container: created,
    floor:
      node === undefined ? floor : Math.max(floor, newestTimestamp(node) + 1),
  }
}

/**
 * The floor that holds beneath `node`, given the floor it sits under: the
 * highest horizon passed on the way down.
 *
 * Reading needs no floor, because a tree in normal form holds nothing below
 * one. A write does: it has to be stamped at or above the floor, or the next
 * prune removes it.
 */
function floorBeneath(node: StateTree, floor: number): number {
  return isHorizon(node) ? Math.max(floor, node[1]) : floor
}

/**
 * Apply a change to the tree, stamping each node it writes past what that
 * node replaces. `schema` is the document root schema.
 *
 * Total over the builtin change vocabulary: a change this tree has no way to
 * record throws (`refuseUnstorableChange`) rather than returning. The tree is
 * the only half of the substrate that replicates, so a change dropped here
 * leaves the writing peer reading back correctly and every other peer wrong.
 */
export function applyChangeToStateTree(
  tree: Container,
  path: Path,
  change: ChangeBase,
  stamp: WriteStamp,
  schema: SchemaNode,
): void {
  refuseUnstorableChange(change)

  if (path.length === 0) {
    if (isReplaceChange(change)) {
      if (!isContainer(change.value)) {
        throw new Error("Cannot replace the root with anything but an object.")
      }
      writeProduct(tree, change.value, schema, stamp)
    } else {
      applyMapChange(tree, change as MapChange, schema, stamp)
    }
    return
  }

  let parent = tree
  let floor = 0
  for (const segment of path.segments.slice(0, -1)) {
    const step = containerAt(parent, String(segment.resolve()), floor)
    parent = step.container
    floor = step.floor
  }

  const last = path.segments[path.segments.length - 1]
  if (last === undefined) throw new Error("unreachable: a non-empty path")
  const key = String(last.resolve())
  const targetSchema = schemaAtPath(schema, path)
  const at = atFloor(stamp, floor)

  if (isReplaceChange(change)) {
    const position = keySpaceOf(schemaAtPath(schema, path.slice(0, -1)))
    parent[key] = writeNode(
      change.value,
      targetSchema,
      at,
      parent[key],
      position,
    )
    return
  }

  // A map change is only meaningful at a container. An atomic register — a
  // sum or `.json()` node, stored as ONE tuple so a variant switch resolves
  // whole — never legitimately receives one, because the substrate's
  // `prepare` (`ephemeral.ts`) widens such writes into a whole-value replace
  // first. Getting here means that widening was bypassed.
  //
  // Throwing is the point. Quietly building a container instead would
  // decompose the register into blendable per-field tuples and drop every
  // sibling field the change did not mention — and since local reads are
  // served from a separate shadow, the damage would only ever appear on some
  // other peer.
  if (stateTreeRole(targetSchema) !== "decompose" || isLive(parent[key])) {
    throw new Error(
      `Cannot apply a map change at "${key}": it is an atomic register ` +
        `(a sum or .json() node). Such writes must be widened to a ` +
        `whole-value replace before reaching the state tree.`,
    )
  }

  const mapChange = change as MapChange
  if (mapChange.clear) {
    if (targetSchema[KIND] !== "map") {
      throw new Error(`Cannot clear "${key}": only a record has keys to clear.`)
    }
    // A clear is the map written whole with nothing in it, plus whatever the
    // change sets: every key before it goes, seen or not.
    parent[key] = writeReplacement(
      { ...mapChange.set },
      targetSchema,
      at,
      parent[key],
    )
    return
  }

  const target = containerAt(parent, key, floor)
  applyMapChange(
    target.container,
    mapChange,
    targetSchema,
    atFloor(stamp, target.floor),
  )
}

/**
 * Apply a map change without `clear` to one container, key by key.
 *
 * `mapChangeEffects` decides what is removed and what is written, so a key
 * named in both lists is written once, as a set. A removal is a deletion, not
 * an absent key: the join unions keys, so a key taken out of the tree is
 * indistinguishable from one never seen, and the next merge with anyone still
 * holding it brings it back.
 *
 * Concurrent add and remove resolve BY TIMESTAMP — LWW-Element-Set, and
 * deliberately not an observed-remove set where a concurrent add always wins
 * regardless of clock. TECHNICAL.md §"Deletion" covers why.
 */
function applyMapChange(
  target: Container,
  change: MapChange,
  schema: SchemaNode,
  stamp: WriteStamp,
): void {
  if (change.clear) {
    throw new Error("Only a record can be cleared, and only by its parent.")
  }
  const { set, remove } = mapChangeEffects(change, () => [])
  const position = keySpaceOf(schema)
  for (const key of remove) {
    target[key] = writeDeletion(stamp, target[key])
  }
  for (const [key, value] of Object.entries(set)) {
    target[key] = writeNode(
      value,
      childSchemaFor(schema, key),
      stamp,
      target[key],
      position,
    )
  }
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
 * Covers each live leaf's path, value and timestamp, and each horizon's path,
 * horizon and `deleted` flag, with its content beneath the same path. A
 * horizon folds a marker a live leaf cannot produce, so the two never collide
 * at one path. It must not cover anything local: `.decay()` is a read-time
 * projection that never touches the tree, so two peers configured with
 * different `decayMs` hold identical trees and must agree.
 *
 * The path is encoded structurally rather than built as a string. Four lanes
 * of the path prefix travel down the recursion as plain numbers, and each key
 * is folded into them on the way. That keeps the walk allocation-free apart
 * from the leaf's own value, which is the difference between 3.8 ms and 30 ms
 * over 5000 leaves.
 *
 * Folding the whole tree, rather than updating a running digest as leaves are
 * written. Updating per write needs each leaf's full path, and the sites that
 * write leaves hold only a container and a key, so supplying one means
 * threading a path string through every recursion — and a digest maintained in
 * several places can drift, which would make two divergent peers agree to stop
 * talking. Encoding the path structurally costs a walk and removes both
 * problems. Memoize per flush: at 5000 leaves this is 3.8 ms against the 1.7 ms
 * `JSON.stringify` already spends once per offer per peer.
 */
export function stateTreeDigest(tree: StateTree): Digest {
  const lanes: [number, number, number, number] = [0, 0, 0, 0]

  const fold = (
    a: number,
    b: number,
    c: number,
    d: number,
    first: string,
    stamp: string,
    kind: string,
  ): void => {
    lanes[0] ^= digestFold(digestFold(digestFold(a, first), stamp), kind)
    lanes[1] ^= digestFold(digestFold(digestFold(b, first), stamp), kind)
    lanes[2] ^= digestFold(digestFold(digestFold(c, first), stamp), kind)
    lanes[3] ^= digestFold(digestFold(digestFold(d, first), stamp), kind)
  }

  const walkContainer = (
    container: Container,
    a: number,
    b: number,
    c: number,
    d: number,
  ): void => {
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

  const walk = (
    node: StateTree,
    a: number,
    b: number,
    c: number,
    d: number,
  ): void => {
    const kind = nodeKind(node)
    switch (kind) {
      case "live": {
        const [value, timestamp] = node as Live
        const encoded =
          typeof value === "object" && value !== null
            ? JSON.stringify(value)
            : String(value)
        fold(a, b, c, d, encoded, String(timestamp), "")
        return
      }
      case "horizon": {
        // A deletion and a replacement at one horizon are different states,
        // and both differ from any live value, whose kind folds as "".
        const [content, horizon, , deleted] = node as Horizon
        fold(a, b, c, d, "", String(horizon), deleted ? "\u0001" : "\u0002")
        if (content !== null) walkContainer(content, a, b, c, d)
        return
      }
      case "container":
        walkContainer(node as Container, a, b, c, d)
        return
      default:
        unreachableKind(kind)
    }
  }

  walk(tree, DIGEST_SEEDS[0], DIGEST_SEEDS[1], DIGEST_SEEDS[2], DIGEST_SEEDS[3])
  return [lanes[0] >>> 0, lanes[1] >>> 0, lanes[2] >>> 0, lanes[3] >>> 0]
}
