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
  FilterMetadata,
  IRNodeBase,
  IRNodeKind,
  LabeledBlockNode,
  LoopNode,
  MergeFailureReason,
  MergeResult,
  SlotKind,
  SourceSpan,
  StatementNode,
  TemplateHole,
  TemplateHoleKind,
  TemplateNode,
} from "./ir.js"

// =============================================================================
// Expression IR Types
// =============================================================================

export type {
  BinaryNode,
  BindingRefNode,
  CallNode,
  ExpressionIR,
  IdentifierNode,
  LiteralNode,
  MethodCallNode,
  PropertyAccessNode,
  RawNode,
  RefReadNode,
  SnapshotNode,
  TemplateNode as ExprTemplateNode,
  UnaryNode,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Factory Functions
// =============================================================================

export {
  binary,
  bindingRef,
  call,
  identifier,
  literal,
  methodCall,
  propertyAccess,
  raw,
  refRead,
  snapshot,
  template as exprTemplate,
  unary,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Type Guards
// =============================================================================

export {
  isBinary,
  isBindingRef,
  isCall,
  isIdentifier,
  isLiteral,
  isMethodCall,
  isPropertyAccess,
  isRaw,
  isRefRead,
  isSnapshot,
  isTemplate as isExprTemplate,
  isUnary,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Rendering
// =============================================================================

export { type RenderContext, renderExpression } from "./expression-ir.js"

// =============================================================================
// Expression IR Derived Properties
// =============================================================================

export {
  extractDeps,
  isReactive,
  renderRefSource,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Builder
// =============================================================================

export type { ExpressionScope } from "./expression-build.js"
export { buildExpressionIR } from "./expression-build.js"

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
  createLabeledBlock,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
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
  isLabeledBlockNode,
  isLiteralContent,
  isLoopNode,
  isReactiveContent,
  isStatementNode,
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

export type { RegionMarkers, RegionMarkerType } from "./html-constants.js"
export {
  escapeHtml,
  generateMarkerId,
  generateRegionMarkers,
  isVoidElement,
  VOID_ELEMENTS,
} from "./html-constants.js"

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
  findBuilderCalls,
  getSpan,
} from "./analyze.js"

// =============================================================================
// IR Walker
// =============================================================================

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
export {
  collectEvents,
  countEventTypes,
  eventsWithPaths,
  walkBranchBody,
  walkIR,
  walkLoopBody,
} from "./walk.js"

// =============================================================================
// Template Extraction
// =============================================================================

export type { NavOp } from "./template.js"
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

export { type BindingScope, createBindingScope } from "./binding-scope.js"

// =============================================================================
// Dependency Classification
// =============================================================================

export {
  type ClassifiedDependency,
  classifyDependencies,
  type DependencyClassification,
} from "./classify.js"

// =============================================================================
// Pattern Recognition
// =============================================================================

export { detectFilterPattern } from "./patterns.js"
