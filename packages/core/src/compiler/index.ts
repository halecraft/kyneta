/**
 * Kyneta Compiler
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
// IR Types (re-exported from @kyneta/compiler)
// =============================================================================

export type {
  AttributeNode,
  BindingTime,
  BuilderNode,
  ChildNode,
  ConditionalBranch,
  ConditionalNode,
  ContentNode,
  ContentValue,
  DeltaKind,
  Dependency,
  ElementNode,
  EventHandlerNode,
  IRNodeBase,
  IRNodeKind,
  LoopNode,
  MergeFailureReason,
  MergeResult,
  SlotKind,
  SourceSpan,
  StatementNode,
  LabeledBlockNode,
  TemplateHole,
  TemplateHoleKind,
  TemplateNode,
} from "@kyneta/compiler"

export {
  // Slot computation
  computeHasReactiveItems,
  computeSlotKind,
  // Factory functions
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  createLabeledBlock,
  // Type guards
  isConditionalNode,
  isContentNode,
  isElementNode,
  isInputTextRegionAttribute,
  isLiteralContent,
  isLoopNode,
  isReactiveContent,
  isStatementNode,
  isLabeledBlockNode,
  isTextRegionContent,
  // Tree merge
  mergeConditionalBodies,
  mergeContentValue,
  mergeNode,
} from "@kyneta/compiler"

// =============================================================================
// HTML Constants (re-exported from @kyneta/compiler)
// =============================================================================

export {
  escapeHtml,
  generateMarkerId,
  generateRegionMarkers,
  isVoidElement,
  VOID_ELEMENTS,
} from "@kyneta/compiler"

export type { RegionMarkerType, RegionMarkers } from "@kyneta/compiler"

// =============================================================================
// IR Transforms (consumer-side pipeline transforms)
// =============================================================================

export {
  dissolveConditionals,
  filterTargetBlocks,
} from "./ir-transforms.js"

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
  isChangefeedType,
} from "@kyneta/compiler"

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
  resetProject,
  // Import handling
  collectRequiredImports,
  // CompileTarget type (web-specific narrowing)
  type CompileTarget,
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
 * import { compile } from "@kyneta/core/compiler"
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