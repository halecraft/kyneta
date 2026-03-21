/**
 * @kyneta/compiler
 *
 * Incremental view maintenance compiler for structured deltas.
 *
 * Takes TypeScript source with builder patterns over Changefeed-emitting
 * state and produces a classified IR annotated with incremental strategies.
 *
 * Target-agnostic: does not generate JavaScript code or reference DOM APIs.
 * Rendering targets (@kyneta/web, etc.) consume the IR and produce
 * target-specific output.
 *
 * @packageDocumentation
 */

// =============================================================================
// IR Types
// =============================================================================

export type {
  AttributeNode,
  BindingNode,
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
} from "./ir.js"

// =============================================================================
// IR Factory Functions
// =============================================================================

export {
  createBinding,
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
} from "./ir.js"

// =============================================================================
// IR Type Guards
// =============================================================================

export {
  isBindingNode,
  isConditionalNode,
  isContentNode,
  isDOMProducing,
  isElementNode,
  isInputTextRegionAttribute,
  isLiteralContent,
  isLoopNode,
  isReactiveContent,
  isStatementNode,
  isLabeledBlockNode,
  isTextRegionContent,
} from "./ir.js"

// =============================================================================
// IR Compute Functions
// =============================================================================

export { computeHasReactiveItems, computeSlotKind } from "./ir.js"

// =============================================================================
// IR Merge Algebra
// =============================================================================

export {
  mergeConditionalBodies,
  mergeContentValue,
  mergeNode,
} from "./ir.js"

// =============================================================================
// HTML Constants & Utilities
// =============================================================================

export {
  escapeHtml,
  generateMarkerId,
  generateRegionMarkers,
  isVoidElement,
  VOID_ELEMENTS,
} from "./html-constants.js"

export type { RegionMarkerType, RegionMarkers } from "./html-constants.js"

// =============================================================================
// Reactive Detection
// =============================================================================

export {
  getDeltaKind,
  isChangefeedType,
  isComponentFactoryType,
  resolveAndAddModule,
  resolveReactiveImports,
} from "./reactive-detection.js"

// =============================================================================
// Analysis
// =============================================================================

export {
  analyzeBuilder,
  analyzeBuilderFunction,
  analyzeElementCall,
  analyzeExpression,
  analyzeForOfStatement,
  analyzeIfStatement,
  analyzeProps,
  analyzeSourceFile,
  analyzeStatement,
  analyzeStatementBody,
  detectDirectRead,
  detectImplicitRead,
  ELEMENT_FACTORIES,
  expressionIsReactive,
  extractDependencies,
  findBuilderCalls,
  getSpan,
} from "./analyze.js"

// =============================================================================
// IR Walker
// =============================================================================

export {
  collectEvents,
  countEventTypes,
  eventsWithPaths,
  walkBranchBody,
  walkIR,
  walkLoopBody,
} from "./walk.js"

export type {
  ComponentPlaceholderEvent,
  DynamicAttributeEvent,
  DynamicContentEvent,
  ElementEndEvent,
  ElementStartEvent,
  EventHandlerEvent,
  RegionPlaceholderEvent,
  StaticAttributeEvent,
  StaticTextEvent,
  WalkEvent,
} from "./walk.js"

// =============================================================================
// Template Extraction
// =============================================================================

export {
  countHolesByKind,
  extractTemplate,
  generateTemplateDeclaration,
  generateWalkCode,
  getHolesByKind,
  hasHoles,
  isStatic,
  planWalk,
  simpleHash,
} from "./template.js"

export type { NavOp } from "./template.js"

// =============================================================================
// Project Management & Pipeline
// =============================================================================

export {
  analyzeAllBuilders,
  hasBuilderCalls,
  parseSource,
  resetProject,
} from "./project.js"

// =============================================================================
// Binding Scope
// =============================================================================

export { createBindingScope, type BindingScope } from "./binding-scope.js"