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
  TargetBlockNode,
  TemplateHole,
  TemplateHoleKind,
  TemplateNode,
} from "./ir.js"

// =============================================================================
// IR Factory Functions
// =============================================================================

export {
  createBuilder,
  createConditional,
  createConditionalBranch,
  createContent,
  createElement,
  createLiteral,
  createLoop,
  createSpan,
  createStatement,
  createTargetBlock,
} from "./ir.js"

// =============================================================================
// IR Type Guards
// =============================================================================

export {
  isConditionalNode,
  isContentNode,
  isElementNode,
  isInputTextRegionAttribute,
  isLiteralContent,
  isLoopNode,
  isReactiveContent,
  isStatementNode,
  isTargetBlockNode,
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