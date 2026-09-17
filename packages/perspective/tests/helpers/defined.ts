// === `defined` — narrowing without a non-null assertion ===
//
// `noUncheckedIndexedAccess` makes every index and every `Map.get` yield
// `T | undefined`, which is correct: a test that reads element 0 of an array
// it believes non-empty is making a claim, and the claim can be wrong.
//
// The two ways around it are both worse than this one. `!` is banned
// repository-wide, and silently reads as "trust me" at exactly the place the
// test should be checking. `?.` moves the `undefined` into the assertion's
// argument, where it is either a type error or — worse — an assertion that
// quietly passes: `expect(undefined).not.toBe(3)` is green, and so is
// `expect(undefined).toBeUndefined()` for a lookup that was supposed to hit.
//
// `defined` throws, naming what was missing, so a wrong claim reads as a
// failure at the line that made it.
//
// Not a test file: vitest only collects `*.test.ts`.

export function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`expected ${what} to be defined`)
  }
  return value
}
