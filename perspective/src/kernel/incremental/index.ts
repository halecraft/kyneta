// === Incremental Pipeline Public API ===
// Barrel export for the incremental kernel pipeline (Plan 005).

// --- Types ---
export type {
  NodeDelta,
  NodeDeltaKind,
  RealityDelta,
} from './types.js';

// --- Constructors ---
export {
  realityDeltaEmpty,
  realityDeltaFrom,
} from './types.js';

// --- Incremental Retraction (Phase 3) ---
export type { IncrementalRetraction } from './retraction.js';
export { createIncrementalRetraction } from './retraction.js';