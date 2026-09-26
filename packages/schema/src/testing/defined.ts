// defined — narrowing without a non-null assertion.
//
// A test that reads a value it believes is there is making a claim, and the
// claim can be wrong. `!` is banned repository-wide because it states the
// claim without checking it. `?.` is worse: it moves the `undefined` into the
// assertion's argument, where `expect(undefined).not.toBe(3)` passes.
//
// `defined` checks the claim and names it, so a wrong one fails at the line
// that made it. It narrows away `null` as well as `undefined`, because the
// sync surface answers "nothing to give" with `null` (`exportSince`, and
// `Position.resolve` for a position that no longer resolves).
//
// `@kyneta/perspective` and `@kyneta/datalog` keep their own copies. They do
// not depend on this package, and should not start just for this.

export function defined<T>(value: T, what: string): NonNullable<T> {
  if (value === undefined || value === null) {
    throw new Error(`expected ${what} to be defined`)
  }
  return value
}
