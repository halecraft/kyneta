/**
 * Kinetic Compiler
 *
 * Transforms natural TypeScript into delta-driven DOM code.
 *
 * The compiler uses ts-morph for AST analysis and transformation,
 * following a Functional Core / Imperative Shell architecture:
 *
 * - analyze.ts: AST → IR (pure functions)
 * - codegen/dom.ts: IR → DOM code (pure functions)
 * - codegen/html.ts: IR → HTML code (pure functions)
 * - transform.ts: Orchestration (imperative shell)
 *
 * @packageDocumentation
 */

// =============================================================================
// IR Types (to be implemented in Phase 3)
// =============================================================================

// export type { BuilderNode, StaticElementNode, ReactiveElementNode } from "./ir.js"
// export type { ListRegionNode, ConditionalRegionNode, BindingNode } from "./ir.js"

// =============================================================================
// Analysis (to be implemented in Phase 3)
// =============================================================================

// export { analyzeBuilder, isReactiveType, expressionIsReactive } from "./analyze.js"

// =============================================================================
// Code Generation (to be implemented in Phase 3)
// =============================================================================

// export { generateDOM } from "./codegen/dom.js"
// export { generateHTML } from "./codegen/html.js"

// =============================================================================
// Transform (to be implemented in Phase 3)
// =============================================================================

// export { transformFile, transformSource } from "./transform.js"

// =============================================================================
// Placeholder export to satisfy build
// =============================================================================

/**
 * Compiler version. Used for cache invalidation.
 */
export const COMPILER_VERSION = "0.0.1"

/**
 * Compile a source file.
 * @param source - TypeScript source code
 * @param options - Compilation options
 * @returns Compiled output
 *
 * @remarks
 * This is a placeholder. Implementation comes in Phase 3.
 */
export function compile(
  _source: string,
  _options?: CompileOptions,
): CompileResult {
  throw new Error("Compiler not yet implemented. See Phase 3 of the plan.")
}

/**
 * Options for compilation.
 */
export interface CompileOptions {
  /**
   * Target output mode.
   * - "dom": Generate DOM manipulation code (for client)
   * - "html": Generate HTML string code (for SSR)
   */
  target?: "dom" | "html"

  /**
   * Path to the source file (for source maps and error reporting).
   */
  filename?: string

  /**
   * Enable source map generation.
   */
  sourcemap?: boolean
}

/**
 * Result of compilation.
 */
export interface CompileResult {
  /**
   * Compiled output code.
   */
  code: string

  /**
   * Source map (if requested).
   */
  map?: string
}
