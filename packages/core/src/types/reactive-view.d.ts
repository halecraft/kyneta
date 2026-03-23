/**
 * Reactive View Type Augmentations
 *
 * Module augmentations that widen schema ref types so they expose
 * the methods of their underlying value types. This enables the
 * "bare ref" developer experience:
 *
 *   recipe.name.toLowerCase()   // TextRef gains String methods
 *   doc.favorites.toFixed(2)    // CounterRef gains Number methods
 *
 * At runtime, the ref object does NOT have these methods — but the
 * Kyneta compiler transforms the code before it runs, inserting `()`
 * reads at the ref/value boundary. The type-level illusion is invisible
 * to the developer.
 *
 * These augmentations live in `@kyneta/core`, not `@kyneta/schema`,
 * so the schema package is unaware of and unaffected by this. The
 * augmentation is opt-in via a triple-slash reference directive:
 *
 *   /// <reference types="@kyneta/core/types/reactive-view" />
 *
 * This follows the same pattern as the existing element factory types
 * (`@kyneta/core/types/elements`).
 *
 * ## Design Rationale
 *
 * - `TextRef extends String` gives `.toLowerCase()`, `.includes()`,
 *   `.slice()`, `.trim()`, `.startsWith()`, etc.
 * - `CounterRef extends Number` gives `.toFixed()`, `.toString()`,
 *   `.toLocaleString()`, etc.
 * - `ScalarRef<T>` is generic and TypeScript module augmentation cannot
 *   conditionally add `extends Boolean` only when `T` is `boolean`.
 *   JavaScript operators (`!`, `&&`, `||`) already coerce any value,
 *   so no augmentation is needed for boolean scalars. For other scalar
 *   types, the compiler handles auto-read insertion without type-level
 *   widening.
 *
 * @see packages/compiler/ideas/auto-read-insertion.md — Section 4.1
 * @packageDocumentation
 */

// We augment the `@kyneta/schema` module, where TextRef and CounterRef
// are declared as interfaces. TypeScript interface merging allows us to
// add `extends` clauses via declaration merging in a `declare module` block.
//
// Note: `extends` in a merged interface declaration doesn't literally add
// an extends clause — instead, the merged interface must be structurally
// compatible with the base. Since we're only using this for type checking
// (the compiler transforms the code), the structural mismatch at runtime
// is intentional and handled by the compilation step.

// This export turns the file into a module, which is required for
// `declare module` to be a module augmentation (merging with the real
// module) rather than an ambient module declaration (shadowing it).
export {}

declare module "@kyneta/schema" {
  /**
   * Widen `TextRef` to expose `String` instance methods.
   *
   * This lets developers write `recipe.name.toLowerCase()` where
   * `recipe.name` is a `TextRef`. The compiler inserts the `()` read:
   * `recipe.name().toLowerCase()`.
   */
  interface TextRef extends string {}

  /**
   * Widen `CounterRef` to expose `Number` instance methods.
   *
   * This lets developers write `doc.favorites.toFixed(2)` where
   * `doc.favorites` is a `CounterRef`. The compiler inserts the `()` read:
   * `doc.favorites().toFixed(2)`.
   */
  interface CounterRef extends number {}
}
