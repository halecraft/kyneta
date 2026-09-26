// ephemeral-fixtures: the trees, stamps, payloads and peers the ephemeral
// suites share.
//
// One definition each, because copies drift: fixtures that wrote a live leaf
// in the wire's two slots, or compared trees without looking inside a
// horizon, once hid in some suites and not others.
//
// Not a test file: vitest only collects `*.test.ts`.

import { createRef, type Ref, type Schema as SchemaNode } from "../index.js"
import type { Substrate } from "../substrate.js"
import {
  ephemeralSubstrateFactory,
  type StateVersion,
} from "../substrates/ephemeral.js"
import {
  type Container,
  encodeTree,
  type Horizon,
  type Live,
  mergeStateTree,
  type StateTree,
  type WriteStamp,
} from "../substrates/state-tree.js"

// ---------------------------------------------------------------------------
// Trees, as a replica holds them
// ---------------------------------------------------------------------------

/**
 * A live leaf, or with `deleted` a deletion with nothing written since. The
 * install ordinal is fixed at 1: these fixtures are about the join, which
 * never reads it.
 */
export const tup = (
  value: unknown,
  timestamp: number,
  deleted?: true,
): Live | Horizon =>
  deleted ? [null, timestamp, 1, true] : [value, timestamp, 1]

/** A horizon, with the same fixed install ordinal. */
export const hz = (
  content: Container | null,
  horizon: number,
  deleted: boolean,
): Horizon => [content, horizon, 1, deleted]

/** A write's stamp. The ordinal only has to be above 0, "not installed here". */
export const stamp = (notBefore: number): WriteStamp => ({
  notBefore,
  installedAt: 1,
})

export const merge = (local: Container, remote: Container) =>
  mergeStateTree(local, remote, 1)

// ---------------------------------------------------------------------------
// Payloads, as a peer sends them
// ---------------------------------------------------------------------------

/**
 * A leaf in wire shape: no install ordinal, because that is a fact about the
 * receiver and a sender has no business asserting it.
 */
export const wire = (value: unknown, timestamp: number, deleted?: true) =>
  deleted ? [value, timestamp, true] : [value, timestamp]

/** An entirety payload holding `data`. */
export const payload = (data: unknown) => ({
  kind: "entirety" as const,
  encoding: "json" as const,
  data: JSON.stringify(data),
})

// ---------------------------------------------------------------------------
// Comparing what replicates
// ---------------------------------------------------------------------------

/**
 * Drop key order everywhere, inside arrays too: a horizon is an array holding
 * a container, and two peers that met keys in different orders hold the same
 * state.
 */
export const canonical = (node: unknown): unknown => {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(canonical)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(node as Record<string, unknown>).sort()) {
    sorted[key] = canonical((node as Record<string, unknown>)[key])
  }
  return sorted
}

/**
 * What replicates, not what a replica holds: `encodeTree` drops the install
 * ordinals, which are each replica's own bookkeeping, and `canonical` drops
 * key order.
 */
export const replicated = (tree: StateTree): unknown =>
  canonical(JSON.parse(encodeTree(tree)))

export const sameState = (a: StateTree, b: StateTree): boolean =>
  JSON.stringify(replicated(a)) === JSON.stringify(replicated(b))

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

export interface Peer<S extends SchemaNode = SchemaNode> {
  readonly substrate: Substrate<StateVersion>
  readonly doc: Ref<S>
}

/**
 * What `ship`, `link` and `digestOf` need of a peer. Naming only the substrate
 * keeps them from comparing two peers' ref types, which for a deeply nested
 * schema is deeper than the compiler will go.
 */
type Replicating = Pick<Peer, "substrate">

export function peerOf<S extends SchemaNode>(schema: S): Peer<S> {
  const substrate = ephemeralSubstrateFactory.create(schema)
  return { substrate, doc: createRef(schema, substrate) as Ref<S> }
}

/** Anti-entropy by entirety: `to` joins everything `from` holds. */
export function ship(from: Replicating, to: Replicating): void {
  to.substrate.merge(from.substrate.exportEntirety())
}

/**
 * A one-way delta link, as the exchange runs it: each call ships whatever
 * `from` has installed since the previous call.
 */
export function link(from: Replicating, to: Replicating): () => void {
  let cursor = from.substrate.baseVersion()
  return () => {
    const delta = from.substrate.exportSince(cursor)
    if (delta === null) throw new Error("same incarnation; must be served")
    cursor = from.substrate.version()
    to.substrate.merge(delta)
  }
}

/**
 * The fingerprint the exchange compares to decide two peers agree. Optional on
 * `Substrate`, so absence is refused rather than letting two `undefined`s
 * compare equal.
 */
export function digestOf(p: Replicating): string {
  const digest = p.substrate.digest?.()
  if (digest === undefined) throw new Error("ephemeral must digest")
  return digest
}
