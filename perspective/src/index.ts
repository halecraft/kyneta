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
	opIdFromString,
	opIdCompare,
	pathEquals,
	pathToString,
	pathFromString,
	pathStartsWith,
	pathParent,
	pathLast,
	pathChild,
	pathCompare,
} from "./core/types.js";

// Assertions
export type {
	Assertion,
	EqAssertion,
	ExistsAssertion,
	DeletedAssertion,
	SeqElementAssertion,
} from "./core/assertions.js";

export {
	eq,
	exists,
	deleted,
	seqElement,
	assertionEquals,
	assertionToString,
	isEqAssertion,
	isExistsAssertion,
	isDeletedAssertion,
	isSeqElementAssertion,
} from "./core/assertions.js";

// Constraints
export type { Constraint, ConstraintMetadata } from "./core/constraint.js";

export {
	createConstraint,
	createConstraintWithId,
	constraintEquals,
	constraintSameId,
	constraintKey,
	constraintToString,
	constraintCompareLWW,
	findLWWWinner,
	partitionByLWW,
} from "./core/constraint.js";

// Version Vector
export type {
	VersionVector,
	MutableVersionVector,
	VVCompareResult,
} from "./core/version-vector.js";

export {
	createVersionVector,
	vvFromObject,
	vvClone,
	vvGet,
	vvHasSeen,
	vvSet,
	vvExtend,
	vvCompare,
	vvIncludes,
	vvEquals,
	vvMerge,
	vvMergeInto,
	vvDiff,
	vvToObject,
	vvToString,
	vvTotalOps,
	vvPeers,
	vvIsEmpty,
} from "./core/version-vector.js";

// Constraint Store
export type {
	ConstraintStore,
	TellResult,
	ConstraintDelta,
} from "./store/constraint-store.js";

export {
	createConstraintStore,
	tell,
	tellMany,
	ask,
	askPrefix,
	getConstraintsForPath,
	getAllConstraints,
	getConstraintCount,
	hasConstraint,
	getConstraint,
	getVersionVector,
	getLamport,
	getNextLamport,
	getGeneration,
	exportDelta,
	importDelta,
	mergeStores,
	iterPaths,
	iterConstraints,
	iterByPath,
} from "./store/constraint-store.js";

// Solver
export type { Solver, SolvedValue } from "./solver/solver.js";

export {
	solvedEmpty,
	solvedFromConstraint,
	solvedDeleted,
	filterByAssertionType,
	hasConflicts,
	isDeleted,
	isEmpty,
} from "./solver/solver.js";

// Map Solver
export type { MapSolver, SolvedMap } from "./solver/map-solver.js";

export {
	createMapSolver,
	solveMapConstraints,
	solveMap,
	solvedMapToObject,
	solvedMapHasConflicts,
	solvedMapConflictKeys,
} from "./solver/map-solver.js";

// List Solver
export type { ListSolver, SolvedList } from "./solver/list-solver.js";

export {
	createListSolver,
	solveListConstraints,
	solveList,
	solvedListToArray,
	solvedListHasConflicts,
	solvedListGet,
} from "./solver/list-solver.js";

// Fugue Algorithm
export type { FugueNode, FugueResult } from "./solver/fugue.js";

export {
	buildFugueTree,
	findNode,
	getActiveIndex,
	getNodeAtIndex,
	computeInsertOrigins,
	getIdAtIndex,
} from "./solver/fugue.js";

// Views
export type {
	View,
	ViewChangeEvent,
	ViewChangeCallback,
	Unsubscribe,
} from "./views/view.js";

export { createViewChangeEvent, isActualChange } from "./views/view.js";

// Map View
export type {
	MapView,
	MapViewConfig,
	ReactiveMapView,
} from "./views/map-view.js";

export { createMapView, createReactiveMapView } from "./views/map-view.js";

// List View
export type {
	ListView,
	ListViewConfig,
	ReactiveListView,
} from "./views/list-view.js";

export { createListView, createReactiveListView } from "./views/list-view.js";

// Handles
export type { Handle } from "./handles/handle.js";

// Map Handle
export type {
	MapHandle,
	MapHandleConfig,
} from "./handles/map-handle.js";

export { createMapHandle, mergeMapHandles } from "./handles/map-handle.js";

// List Handle
export type {
	ListHandle,
	ListHandleConfig,
} from "./handles/list-handle.js";

export { createListHandle, mergeListHandles } from "./handles/list-handle.js";

// Text View
export type {
	TextView,
	TextViewConfig,
	ReactiveTextView,
} from "./views/text-view.js";

export { createTextView, createReactiveTextView } from "./views/text-view.js";

// Text Handle
export type {
	TextHandle,
	TextHandleConfig,
} from "./handles/text-handle.js";

export { createTextHandle, mergeTextHandles } from "./handles/text-handle.js";

// Subscription Manager
export type {
	ConstraintAddedEvent,
	StateChangedEvent,
	ConflictEvent,
	SubscriptionEvent,
	ConstraintCallback,
	StateChangeCallback,
	ConflictCallback,
	SubscriptionManager,
} from "./events/subscription-manager.js";

export {
	createSubscriptionManager,
	createConstraintAddedEvent,
	createStateChangedEvent,
	createConflictEvent,
} from "./events/subscription-manager.js";

// Introspection API
export type {
	Explanation,
	ConstraintInfo,
	ConflictSummary,
	ConflictReport,
	IntrospectionAPI,
	IntrospectionConfig,
} from "./introspection/explain.js";

export {
	createIntrospectionAPI,
	explainSolvedValue,
} from "./introspection/explain.js";

// Constraint Inspector
export type {
	ConstraintJSON,
	StoreSnapshot,
	StoreStatistics,
	ConstraintSummaryLine,
	ConstraintInspector,
	InspectorConfig,
} from "./introspection/inspector.js";

export {
	createConstraintInspector,
	dumpStore,
	summarizeStore,
	exportStoreJSON,
} from "./introspection/inspector.js";
