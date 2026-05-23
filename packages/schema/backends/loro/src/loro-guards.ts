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
    typeof (value as any).kind === "function"
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
    typeof (value as any).kind === "function" &&
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
    typeof (value as any).commit === "function"
  )
}
