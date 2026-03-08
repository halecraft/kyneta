// Action types — the universal currency of change.
//
// An action describes a change to a schema node. The same action structure
// flows in both directions:
//   - Going in (developer → backend): the action describes intent
//   - Coming out (backend → observer): the action describes what happened
//   - Pure computation (step): (State, Action) → State
//
// Actions are an open protocol identified by a string discriminant.
// They are interpretation-level — the schema says "sequence," the backend
// picks the action vocabulary. Built-in actions cover the common cases.
// Third-party backends extend ActionBase with their own types.

// ---------------------------------------------------------------------------
// Base protocol
// ---------------------------------------------------------------------------

/**
 * All actions carry a string `type` discriminant. Built-in action types
 * use well-known strings ("text", "sequence", "map", "replace", "tree").
 * Third-party backends extend this with their own types.
 */
export interface ActionBase {
  readonly type: string
}

// ---------------------------------------------------------------------------
// Text actions — cursor-based retain/insert/delete over characters
// ---------------------------------------------------------------------------

export type TextActionOp =
  | { readonly retain: number }
  | { readonly insert: string }
  | { readonly delete: number }

export interface TextAction extends ActionBase {
  readonly type: "text"
  readonly ops: readonly TextActionOp[]
}

// ---------------------------------------------------------------------------
// Sequence actions — cursor-based retain/insert/delete over items
// ---------------------------------------------------------------------------

export type SequenceActionOp<T = unknown> =
  | { readonly retain: number }
  | { readonly insert: readonly T[] }
  | { readonly delete: number }

export interface SequenceAction<T = unknown> extends ActionBase {
  readonly type: "sequence"
  readonly ops: readonly SequenceActionOp<T>[]
}

// ---------------------------------------------------------------------------
// Map actions — key-level set/delete for products and maps
// ---------------------------------------------------------------------------

export interface MapAction extends ActionBase {
  readonly type: "map"
  readonly set?: Readonly<Record<string, unknown>>
  readonly delete?: readonly string[]
}

// ---------------------------------------------------------------------------
// Scalar replacement — wholesale value swap
// ---------------------------------------------------------------------------

export interface ReplaceAction<T = unknown> extends ActionBase {
  readonly type: "replace"
  readonly value: T
}

// ---------------------------------------------------------------------------
// Tree actions — structural operations on hierarchical trees
// ---------------------------------------------------------------------------

export type TreeActionOp =
  | { readonly action: "create"; readonly index: number }
  | { readonly action: "delete"; readonly index: number }
  | {
      readonly action: "move"
      readonly fromIndex: number
      readonly toIndex: number
    }

export interface TreeAction extends ActionBase {
  readonly type: "tree"
  readonly ops: readonly TreeActionOp[]
}

// ---------------------------------------------------------------------------
// Counter actions — increment/decrement
// ---------------------------------------------------------------------------

export interface IncrementAction extends ActionBase {
  readonly type: "increment"
  readonly amount: number
}

// ---------------------------------------------------------------------------
// Union of all built-in action types
// ---------------------------------------------------------------------------

export type BuiltinAction =
  | TextAction
  | SequenceAction
  | MapAction
  | ReplaceAction
  | TreeAction
  | IncrementAction

/**
 * Any action — built-in or third-party. Use this as a general constraint
 * when writing code that is generic over all possible actions.
 */
export type Action = ActionBase

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTextAction(action: ActionBase): action is TextAction {
  return action.type === "text"
}

export function isSequenceAction(
  action: ActionBase,
): action is SequenceAction {
  return action.type === "sequence"
}

export function isMapAction(action: ActionBase): action is MapAction {
  return action.type === "map"
}

export function isReplaceAction(action: ActionBase): action is ReplaceAction {
  return action.type === "replace"
}

export function isTreeAction(action: ActionBase): action is TreeAction {
  return action.type === "tree"
}

export function isIncrementAction(
  action: ActionBase,
): action is IncrementAction {
  return action.type === "increment"
}

// ---------------------------------------------------------------------------
// Action constructors — convenience factories
// ---------------------------------------------------------------------------

export function textAction(ops: readonly TextActionOp[]): TextAction {
  return { type: "text", ops }
}

export function sequenceAction<T>(
  ops: readonly SequenceActionOp<T>[],
): SequenceAction<T> {
  return { type: "sequence", ops }
}

export function mapAction(
  set?: Record<string, unknown>,
  del?: string[],
): MapAction {
  return { type: "map", set, delete: del }
}

export function replaceAction<T>(value: T): ReplaceAction<T> {
  return { type: "replace", value }
}

export function treeAction(ops: readonly TreeActionOp[]): TreeAction {
  return { type: "tree", ops }
}

export function incrementAction(amount: number): IncrementAction {
  return { type: "increment", amount }
}