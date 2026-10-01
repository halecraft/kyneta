// frozen-invariant — a check of the invariant copy-on-write rests on.
//
// A frozen node's descendants are all frozen, or are byte arrays (`clone.ts`).
// A read freezes σ in place and a write copies only frozen nodes, so a mutable
// node below a frozen one would be changed in place under a reader. The
// invariant holds because everything entering σ is owned or new; this turns
// that into a property a suite can test on every substrate.

/**
 * The paths of every node in `value` that breaks the frozen invariant: an
 * unfrozen object below a frozen one. Byte arrays are exempt. Empty when the
 * invariant holds.
 */
export function frozenInvariantViolations(value: unknown): string[] {
  const violations: string[] = []
  walk(value, "root", false, violations)
  return violations
}

function walk(
  value: unknown,
  at: string,
  underFrozen: boolean,
  violations: string[],
): void {
  if (typeof value !== "object" || value === null) return
  if (ArrayBuffer.isView(value)) return
  const frozen = Object.isFrozen(value)
  if (underFrozen && !frozen) violations.push(at)
  for (const [key, child] of Object.entries(value)) {
    walk(child, `${at}.${key}`, underFrozen || frozen, violations)
  }
}
