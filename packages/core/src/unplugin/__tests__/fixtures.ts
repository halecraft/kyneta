/**
 * Shared test fixtures for unplugin integration tests.
 *
 * These fixtures provide source code samples and assertion helpers
 * used across all bundler-specific integration tests (Vite, Bun, etc.).
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Source fixtures
// ---------------------------------------------------------------------------

/**
 * Source code containing a simple builder pattern.
 *
 * After compilation this should contain `document.createElement` calls
 * and should NOT contain the original `div(() =>` builder syntax.
 */
export const BUILDER_SOURCE = `
div(() => {
  h1("Hello")
  p("World")
})
`

/**
 * Source code containing multiple builder patterns.
 */
export const MULTI_BUILDER_SOURCE = `
const header = div(() => {
  h1("Header")
})

const footer = div(() => {
  p("Footer")
})
`

/**
 * Plain source code with no builder patterns.
 *
 * Should pass through the plugin unchanged (transform returns null).
 */
export const NO_BUILDER_SOURCE = `const x = 1
function greet(name: string): string {
  return "hello " + name
}
`

// ---------------------------------------------------------------------------
// Exported variants (for bundler integration tests)
//
// Bundlers like Vite tree-shake unexported code in library mode.
// These variants use `export` so the output survives tree-shaking.
// ---------------------------------------------------------------------------

/**
 * Single builder pattern, exported so bundlers preserve it.
 */
export const BUILDER_SOURCE_EXPORTED = `
export const app = div(() => {
  h1("Hello")
  p("World")
})
`

/**
 * Multiple builder patterns, exported so bundlers preserve them.
 */
export const MULTI_BUILDER_SOURCE_EXPORTED = `
export const header = div(() => {
  h1("Header")
})

export const footer = div(() => {
  p("Footer")
})
`

/**
 * No builder patterns, exported so bundlers preserve them.
 */
export const NO_BUILDER_SOURCE_EXPORTED = `
export const x = 1
export function greet(name: string): string {
  return "hello " + name
}
`

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

/**
 * Assert that compiled output looks correct for a builder transform.
 *
 * Checks that:
 * - `document.createElement` is present (DOM codegen happened)
 * - Original builder call syntax is absent
 */
export function assertBuilderCompiled(code: string): void {
  if (!code.includes("document.createElement")) {
    throw new Error(
      "Expected compiled output to contain document.createElement",
    )
  }
  if (code.includes("div(() =>")) {
    throw new Error(
      "Expected compiled output to NOT contain raw builder syntax 'div(() =>'",
    )
  }
}

/**
 * Assert that source without builders passed through unmodified.
 */
export function assertPassedThrough(code: string): void {
  if (!code.includes("const x = 1")) {
    throw new Error(
      "Expected non-builder source to pass through unchanged",
    )
  }
  if (!code.includes("function greet")) {
    throw new Error(
      "Expected non-builder source to preserve function declarations",
    )
  }
}