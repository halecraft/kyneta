// tracking — read-dependency capture for reactive scopes.
//
// A *tracking scope* records which nodes a computation reads, and at what
// granularity (`Aspect`), so the reactive runtime (jj:kpywvkpr) can subscribe
// to precisely those nodes (Fork A — handle dispatch). This module is the
// **functional core** of read-tracking: a pure scope stack plus a single
// mutation point (`reportRead`). A ref's members call `reportRead` themselves
// (`ref/track.ts`); the subscription *policy* (aspect → changefeed primitive)
// lives entirely in the runtime — this module is unaware of it.
//
// Aspect vocabulary harmonizes with `@kyneta/compiler`'s `DependencyClassification`
// (`experimental/compiler/src/classify.ts`), which classifies the same
// dependencies *statically (AOT)*: `structural` is shared verbatim; `value`/
// `identity` are the runtime refinement of the compiler's `item`; `external`
// (reading another reactive source) is the runtime's plain-`HasChangefeed`
// branch, not a schema-ref read. One classification model, AOT + JIT faces.
//
// FC/IS exemplars: `@kyneta/index`'s pure `integrate` + imperative wiring, and
// `@kyneta/machine`'s pure `Program.update` + effect-interpreting runtime.

import type { HasChangefeed } from "@kyneta/changefeed"

// ---------------------------------------------------------------------------
// Aspect — the granularity of a read
// ---------------------------------------------------------------------------

/**
 * The granularity at which a node was read, by read method and node kind
 * (`ref/track.ts`):
 *
 * - `value` — a leaf's value (`scalar`/`text`/`counter`/`richtext`/`set` `()`).
 * - `deep` — a composite's whole subtree (`product`/`sequence`/`map`/`tree` `()`).
 * - `structure` — a dynamic container's cardinality/order/identity
 *   (`.length`, iteration, `.at`, `.get`, `.keys`, `.has`, `.size` on a
 *   sequence/movable/map). Products are *not* structural (fixed fields).
 *
 * Mirrors `@kyneta/compiler`'s `DependencyClassification` (`structural` shared;
 * `value`/`identity` refine `item`).
 */
export type Aspect = "value" | "deep" | "structure"

// ---------------------------------------------------------------------------
// Dependency — one captured read
// ---------------------------------------------------------------------------

/**
 * A single captured read: a stable handle plus its aspect. The runtime
 * (jj:kpywvkpr) maps `aspect` → an existing subscription primitive
 * (`subscribeNode` / `subscribeDescendants` / a plain `[CHANGEFEED]`
 * `.subscribe`) and dedups by `key`.
 *
 * - `key` — a stable dedup key (the ref's tracking id + aspect; see
 *   `dependencyKey`). The ref is the canonical one for its coordinate while
 *   held, and the scope holds it here, so the key survives structural change.
 * - `ref` — the node read, carrying `[CHANGEFEED]`.
 */
export interface Dependency {
  readonly key: string
  readonly aspect: Aspect
  readonly ref: HasChangefeed
}

// ---------------------------------------------------------------------------
// Scope stack (the single piece of mutable state)
// ---------------------------------------------------------------------------

interface Collector {
  readonly deps: Map<string, Dependency>
}

// A stack is unnecessary at the value level — we save/restore the previous
// scope around each `withReadScope`, which is exactly a stack discipline and
// handles nesting (a `computed` reading a `computed`) and reads inside
// subscriber callbacks.
let activeScope: Collector | null = null

/**
 * Whether a tracking scope is active. Every report guards on this, so with
 * no scope active a read reports nothing.
 */
export function currentScope(): boolean {
  return activeScope !== null
}

/**
 * Record a read against the active scope. No-op when no scope is active
 * (the hot-path guard) — this is the single mutation point of the module.
 * Deduped by `dep.key`; first writer wins (aspects are keyed distinctly).
 */
export function reportRead(dep: Dependency): void {
  if (activeScope === null) return
  if (!activeScope.deps.has(dep.key)) activeScope.deps.set(dep.key, dep)
}

/**
 * Run `fn` inside a fresh tracking scope and return its value plus the exact,
 * deduped set of dependencies read during it. Save/restore discipline (incl.
 * on throw) keeps nested scopes and subscriber-callback reads correct.
 */
export function withReadScope<T>(fn: () => T): {
  value: T
  deps: Dependency[]
} {
  const prevScope = activeScope
  const collector: Collector = { deps: new Map() }
  activeScope = collector
  try {
    const value = fn()
    return { value, deps: [...collector.deps.values()] }
  } finally {
    activeScope = prevScope
  }
}

// ---------------------------------------------------------------------------
// dependencyKey — stable dedup key
// ---------------------------------------------------------------------------

/**
 * Build a stable dependency key from a node's key and an aspect. `node`
 * must not change while the node is held, so the key is invariant under
 * structural change (an insert before a tracked element does not change its
 * key): `ref/track.ts` passes the ref's tracking id.
 */
export function dependencyKey(node: string, aspect: Aspect): string {
  return `${node}\0${aspect}`
}
