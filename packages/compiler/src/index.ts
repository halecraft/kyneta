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
  FilterMetadata,
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
// Expression IR Types
// =============================================================================

export type {
  ExpressionIR,
  RefReadNode,
  SnapshotNode,
  BindingRefNode,
  MethodCallNode,
  PropertyAccessNode,
  CallNode,
  BinaryNode,
  UnaryNode,
  TemplateNode as ExprTemplateNode,
  LiteralNode,
  IdentifierNode,
  RawNode,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Factory Functions
// =============================================================================

export {
  refRead,
  snapshot,
  bindingRef,
  methodCall,
  propertyAccess,
  call,
  binary,
  unary,
  template as exprTemplate,
  literal,
  identifier,
  raw,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Type Guards
// =============================================================================

export {
  isRefRead,
  isSnapshot,
  isBindingRef,
  isMethodCall,
  isPropertyAccess,
  isCall,
  isBinary,
  isUnary,
  isTemplate as isExprTemplate,
  isLiteral,
  isIdentifier,
  isRaw,
} from "./expression-ir.js"

// =============================================================================
// Expression IR Rendering
// =============================================================================

export { renderExpression, type RenderContext } from "./expression-ir.js"

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

export { buildExpressionIR } from "./expression-build.js"
export type { ExpressionScope } from "./expression-build.js"

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

// =============================================================================
// Dependency Classification
// =============================================================================

export {
  classifyDependencies,
  type ClassifiedDependency,
  type DependencyClassification,
} from "./classify.js"

// =============================================================================
// Pattern Recognition
// =============================================================================

export { detectFilterPattern } from "./patterns.js"