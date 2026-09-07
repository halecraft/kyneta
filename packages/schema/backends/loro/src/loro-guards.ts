// loro-guards — shared Loro runtime type guards.
//
// Centralizes the container/document type discrimination used throughout
// @kyneta/loro-schema. Three guards:
//
// - hasKind — base guard for any object with a .kind() method (Loro containers)
// - isLoroContainer — wider guard that additionally guarantees .id (ContainerID)
// - isLoroDoc — discriminates LoroDoc from Loro containers

import type { ContainerID, LoroDoc } from "loro-crdt"

// ---------------------------------------------------------------------------
// hasKind — base container guard
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` has a `.kind()` method — the stable contract
 * for Loro container type discrimination.
 *
 * Loro container objects are opaque handles, not class instances from
 * the JS perspective. `instanceof` checks are unreliable across module
 * boundaries and bundler configurations; `.kind()` is the stable contract.
 */
export function hasKind(value: unknown): value is { kind(): string } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "kind" in value &&
    typeof value.kind === "function"
  )
}

// ---------------------------------------------------------------------------
// isLoroContainer — wider guard with ContainerID
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` is a Loro container with both `.kind()` and `.id`.
 *
 * Sound type guard — checks for `"id" in value` in the body, unlike the
 * previous `change-mapping.ts` version which declared `.id` in the return
 * type without verifying it at runtime.
 *
 * Use this guard at call sites that access `.id` (e.g. `changeToDiff`,
 * `replaceChangeToDiff`). Use `hasKind` at call sites that only need `.kind()`.
 */
export function isLoroContainer(
  value: unknown,
): value is { kind(): string; id: ContainerID } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "kind" in value &&
    typeof value.kind === "function" &&
    "id" in value
  )
}

// ---------------------------------------------------------------------------
// isLoroDoc — document guard
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` is a `LoroDoc` instance.
 *
 * Uses structural checks rather than `instanceof` for reliability across
 * module boundaries. Checks for `getMap`, `getText`, `getList`, `getCounter`,
 * `commit`, and `peerIdStr` — the wider set from the `create.ts` version.
 */
export function isLoroDoc(value: unknown): value is LoroDoc {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "peerIdStr" in value &&
    "commit" in value &&
    typeof value.commit === "function"
  )
}

// ---------------------------------------------------------------------------
// isPlainProjectable — container with a plain-value projection
// ---------------------------------------------------------------------------

/**
 * Returns true if `value` is a Loro container that can project itself to a
 * plain JS value via `.toJSON()`.
 *
 * Narrower than `hasKind`, and deliberately separate from it. `hasKind` answers
 * "is this a Loro container?" and several call sites only ever ask that, so
 * widening it would make them assert a method they never call. This one is for
 * the sites that go on to serialize, and it checks the method it promises —
 * `loro-crdt` types container values loosely enough that nothing upstream
 * guarantees `toJSON` is there.
 */
export function isPlainProjectable(
  value: unknown,
): value is { kind(): string; toJSON(): unknown } {
  return (
    hasKind(value) && "toJSON" in value && typeof value.toJSON === "function"
  )
}

// ---------------------------------------------------------------------------
// Per-kind container shapes — the boundary with `loro-crdt`'s types
// ---------------------------------------------------------------------------

// `resolveContainer` hands back `unknown`, because what a path resolves to
// depends on the schema at that path and is not knowable statically. Every
// consumer therefore has to ask "which container kind is this?" before using
// it, and `loro-crdt` does not export a discriminated union that answers.
//
// The shapes below are what this backend actually calls on each kind — not
// the library's full surface, deliberately, so a reader can see exactly what
// the integration depends on. The guards below them are the single place that
// assertion lives. Their bodies check `kind()`, which is Loro's stable
// discriminator (container objects are opaque handles, so `instanceof` is
// unreliable across bundler boundaries); the member list is asserted on the
// strength of that check.
//
// If a call site needs a member not listed here, add it here rather than
// casting at the call site. That keeps the count of things we assume about
// `loro-crdt` readable in one place.

/** What this backend calls on a `LoroText`. */
export interface LoroTextLike {
  kind(): string
  toString(): string
  toDelta(): unknown[]
  getCursor(index: number, side: number): unknown
}

/** What this backend calls on a `LoroCounter`. */
export interface LoroCounterLike {
  kind(): string
  value: number
}

/** What this backend calls on a `LoroList` or `LoroMovableList`. */
export interface LoroListLike {
  kind(): string
  length: number
  toJSON(): unknown
}

/** What this backend calls on a `LoroMap`. */
export interface LoroMapLike {
  kind(): string
  keys(): string[]
  toJSON(): unknown
}

/** What this backend calls on a `LoroTree`. */
export interface LoroTreeLike {
  kind(): string
  toArray(): unknown[]
  createNode(parent?: string, index?: number): { id: string }
  getNodeByID(id: string): { data: unknown } | undefined
}

/** A root `LoroDoc` reached where a container was expected. */
export interface LoroDocLike {
  getMap(key: string): { id: ContainerID }
}

export function isLoroText(value: unknown): value is LoroTextLike {
  return hasKind(value) && value.kind() === "Text"
}

export function isLoroCounter(value: unknown): value is LoroCounterLike {
  return hasKind(value) && value.kind() === "Counter"
}

/** True for both `List` and `MovableList` — they share every member used here. */
export function isLoroList(value: unknown): value is LoroListLike {
  const kind = hasKind(value) ? value.kind() : undefined
  return kind === "List" || kind === "MovableList"
}

export function isLoroMap(value: unknown): value is LoroMapLike {
  return hasKind(value) && value.kind() === "Map"
}

export function isLoroTree(value: unknown): value is LoroTreeLike {
  return hasKind(value) && value.kind() === "Tree"
}

// ---------------------------------------------------------------------------
// Diff shapes — the other half of the `loro-crdt` boundary
// ---------------------------------------------------------------------------

// `Diff | JsonDiff` is a union in `loro-crdt`'s types, but the members are not
// discriminated in a way TypeScript can narrow through here: the payload
// fields (`updated` on a map diff, `diff` on a list diff) are not reachable
// from the union, and `applyDiff` takes a shape narrower than what the
// substrate legitimately hands it.
//
// These accessors are where that gap is absorbed. They take the union and
// return the payload if it is there, so callers ask a question and get a typed
// answer rather than reaching through an assertion.

/** A map diff's per-key payload, or `undefined` if this is not a map diff. */
export function mapDiffUpdated(
  diff: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (diff === null || typeof diff !== "object") return undefined
  const updated = (diff as { updated?: unknown }).updated
  return updated !== null && typeof updated === "object"
    ? (updated as Readonly<Record<string, unknown>>)
    : undefined
}

/** A list diff's delta array, or `undefined` if this is not a list diff. */
export function listDiffDeltas(
  diff: unknown,
): ReadonlyArray<Record<string, unknown>> | undefined {
  if (diff === null || typeof diff !== "object") return undefined
  const deltas = (diff as { diff?: unknown }).diff
  return Array.isArray(deltas)
    ? (deltas as ReadonlyArray<Record<string, unknown>>)
    : undefined
}

// ---------------------------------------------------------------------------
// applyDiffGroup — the one place `applyDiff`'s parameter type is asserted
// ---------------------------------------------------------------------------

/**
 * Apply a group of container diffs to the document.
 *
 * `loro-crdt` types `applyDiff`'s parameter more narrowly than the shapes this
 * substrate legitimately builds — a `{ type: "map", updated }` or
 * `{ type: "list", diff }` tuple assembled here does not match the exported
 * `Diff` union, even though the runtime accepts it. That mismatch used to be
 * absorbed by an assertion at each of the three call sites, once on the tuple
 * and once on the array.
 *
 * It lives here now, so the number of places this integration disagrees with
 * its library's types is one rather than three, and a future `loro-crdt`
 * release that fixes the typing has a single site to update.
 */
export function applyDiffGroup(
  doc: { applyDiff(diff: never): void },
  group: readonly (readonly [ContainerID, unknown])[],
): void {
  ;(doc.applyDiff as (diff: unknown) => void)(group)
}
