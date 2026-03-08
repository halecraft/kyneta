// === Incremental Pipeline Public API ===
// Barrel export for the incremental kernel pipeline (Plan 005).

// --- Types ---
export type {
  StructureIndexDelta,
  NodeDelta,
  NodeDeltaKind,
  RealityDelta,
} from './types.js';

// --- Constructors ---
export {
  structureIndexDeltaEmpty,
  structureIndexDeltaFrom,
  realityDeltaEmpty,
  realityDeltaFrom,
} from './types.js';

// --- Incremental Retraction (Phase 3) ---
export type { IncrementalRetraction } from './retraction.js';
export { createIncrementalRetraction } from './retraction.js';

// --- Incremental Structure Index (Phase 4) ---
export type { IncrementalStructureIndex } from './structure-index.js';
export { createIncrementalStructureIndex } from './structure-index.js';

// --- Incremental Projection (Phase 5) ---
export type { IncrementalProjection } from './projection.js';
export { createIncrementalProjection } from './projection.js';

// --- Incremental Validity (Phase 6) ---
export type { IncrementalValidity } from './validity.js';
export { createIncrementalValidity } from './validity.js';

// --- Incremental Skeleton (Phase 7) ---
export type { IncrementalSkeleton } from './skeleton.js';
export { createIncrementalSkeleton } from './skeleton.js';

// --- Incremental Pipeline (Phase 8) ---
export type { IncrementalPipeline } from './pipeline.js';
export {
  createIncrementalPipeline,
  createIncrementalPipelineFromBootstrap,
} from './pipeline.js';