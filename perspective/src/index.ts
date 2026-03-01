/**
 * Prism - Convergent Constraint Systems
 *
 * A constraint-based approach to CRDTs where constraints are truth
 * and state is derived through deterministic solving.
 *
 * @packageDocumentation
 */

// Core types
export type {
	PeerID,
	Counter,
	Lamport,
	OpId,
	PathSegment,
	Path,
} from "./core/types.js";

export {
	createOpId,
	opIdEquals,
	opIdToString,
	pathEquals,
	pathToString,
	pathStartsWith,
} from "./core/types.js";

// Assertions
export type {
	Assertion,
	EqAssertion,
	ExistsAssertion,
	DeletedAssertion,
	BeforeAssertion,
	AfterAssertion,
} from "./core/assertions.js";

export {
	eq,
	exists,
	deleted,
	before,
	after,
	assertionEquals,
} from "./core/assertions.js";

// Constraints
export type { Constraint, ConstraintMetadata } from "./core/constraint.js";

export { createConstraint } from "./core/constraint.js";

// Version Vector
export type { VersionVector } from "./core/version-vector.js";

export {
	createVersionVector,
	vvGet,
	vvSet,
	vvMerge,
	vvCompare,
	vvIncludes,
	vvClone,
} from "./core/version-vector.js";

// Constraint Store
export type { ConstraintStore } from "./store/constraint-store.js";

export {
	createConstraintStore,
	tell,
	ask,
	getConstraintsForPath,
	exportDelta,
	importDelta,
	mergeStores,
} from "./store/constraint-store.js";

// Solver
export type { Solver, SolvedValue } from "./solver/solver.js";

export { createMapSolver } from "./solver/map-solver.js";
