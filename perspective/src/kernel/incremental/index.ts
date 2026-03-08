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