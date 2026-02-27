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
// IR Types
// =============================================================================

export type {
  AttributeNode,
  BindingNode,
  BuilderNode,
  ChildNode,
  ConditionalBranch,
  ConditionalRegionNode,
  ContentNode,
  ElementNode,
  EventHandlerNode,
  ExpressionKind,
  ExpressionNode,
  IRNodeBase,
  IRNodeKind,
  ListRegionNode,
  SourceSpan,
  TextNode,
} from "./ir.js"

export {
  // Factory functions
  createBuilder,
  createConditionalRegion,
  createElement,
  createListRegion,
  createReactiveExpression,
  createSpan,
  createStaticExpression,
  createTextNode,
  // Type guards
  isBindingNode,
  isConditionalRegionNode,
  isElementNode,
  isExpressionNode,
  isListRegionNode,
  isReactiveContent,
  isReactiveExpression,
  isTextNode,
} from "./ir.js"

// =============================================================================
// Analysis
// =============================================================================

export {
  analyzeBuilder,
  analyzeBuilderFunction,
  // Element analysis
  analyzeElementCall,
  // Expression analysis
  analyzeExpression,
  // Statement analysis
  analyzeForOfStatement,
  analyzeIfStatement,
  // Props analysis
  analyzeProps,
  analyzeSourceFile,
  analyzeStatement,
  analyzeStatementBody,
  // Constants
  ELEMENT_FACTORIES,
  expressionIsReactive,
  extractDependencies,
  // Main entry points
  findBuilderCalls,
  // Source span helpers
  getSpan,
  // Type analysis
  isReactiveType,
} from "./analyze.js"

// =============================================================================
// Code Generation - DOM
// =============================================================================

export {
  type DOMCodegenOptions,
  generateDOM,
  generateElementFactory,
} from "./codegen/dom.js"

// =============================================================================
// Code Generation - HTML (SSR)
// =============================================================================

export {
  generateEscapeHelper,
  generateHTML,
  generateRenderFunction,
  type HTMLCodegenOptions,
} from "./codegen/html.js"

// =============================================================================
// Transform (Orchestration)
// =============================================================================

export {
  // Testing utilities
  __resetProject,
  // Types
  type CompileTarget,
  // Import handling
  collectRequiredImports,
  // Functions
  hasBuilderCalls,
  mergeImports,
  type TransformInPlaceResult,
  type TransformOptions,
  type TransformResult,
  transformFile,
  transformSource,
  transformSourceInPlace,
} from "./transform.js"

// =============================================================================
// Compiler Version
// =============================================================================

/**
 * Compiler version. Used for cache invalidation.
 */
export const COMPILER_VERSION = "0.1.0"

// =============================================================================
// Convenience Function
// =============================================================================

/**
 * Compile source code to the target output.
 *
 * This is the main entry point for the compiler.
 *
 * @param source - TypeScript source code
 * @param options - Compilation options
 * @returns Compiled output with code and IR
 *
 * @example
 * ```ts
 * import { compile } from "@loro-extended/kinetic/compiler"
 *
 * const result = compile(`
 *   div(() => {
 *     h1("Hello, World!")
 *   })
 * `)
 *
 * console.log(result.code)
 * ```
 */
export { transformSource as compile } from "./transform.js"
