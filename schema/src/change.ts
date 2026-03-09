// Change types — the universal currency of change.
//
// A change describes a delta to a schema node. The same change structure
// flows in both directions:
//   - Going in (developer → backend): the change describes intent
//   - Coming out (backend → observer): the change describes what happened
//   - Pure computation (step): (State, Change) → State
//
// Changes are an open protocol identified by a string discriminant.
// They are interpretation-level — the schema says "sequence," the backend
// picks the change vocabulary. Built-in changes cover the common cases.
// Third-party backends extend ChangeBase with their own types.

// ---------------------------------------------------------------------------
// Base protocol
// ---------------------------------------------------------------------------

/**
 * All actions carry a string `type` discriminant. Built-in action types
 * use well-known strings ("text", "sequence", "map", "replace", "tree").
 * Third-party backends extend this with their own types.
 */
export interface ChangeBase {
  readonly type: string
}

// ---------------------------------------------------------------------------
// Text actions — cursor-based retain/insert/delete over characters
// ---------------------------------------------------------------------------

export type TextChangeOp =
  | { readonly retain: number }
  | { readonly insert: string }
  | { readonly delete: number }

export interface TextChange extends ChangeBase {
  readonly type: "text"
  readonly ops: readonly TextChangeOp[]
}

// ---------------------------------------------------------------------------
// Sequence actions — cursor-based retain/insert/delete over items
// ---------------------------------------------------------------------------

export type SequenceChangeOp<T = unknown> =
  | { readonly retain: number }
  | { readonly insert: readonly T[] }
  | { readonly delete: number }

export interface SequenceChange<T = unknown> extends ChangeBase {
  readonly type: "sequence"
  readonly ops: readonly SequenceChangeOp<T>[]
}

// ---------------------------------------------------------------------------
// Map actions — key-level set/delete for products and maps
// ---------------------------------------------------------------------------

export interface MapChange extends ChangeBase {
  readonly type: "map"
  readonly set?: Readonly<Record<string, unknown>>
  readonly delete?: readonly string[]
}

// ---------------------------------------------------------------------------
// Scalar replacement — wholesale value swap
// ---------------------------------------------------------------------------

export interface ReplaceChange<T = unknown> extends ChangeBase {
  readonly type: "replace"
  readonly value: T
}

// ---------------------------------------------------------------------------
// Tree actions — structural operations on hierarchical trees
// ---------------------------------------------------------------------------

export type TreeChangeOp =
  | { readonly action: "create"; readonly index: number }
  | { readonly action: "delete"; readonly index: number }
  | {
      readonly action: "move"
      readonly fromIndex: number
      readonly toIndex: number
    }

export interface TreeChange extends ChangeBase {
  readonly type: "tree"
  readonly ops: readonly TreeChangeOp[]
}

// ---------------------------------------------------------------------------
// Counter actions — increment/decrement
// ---------------------------------------------------------------------------

export interface IncrementChange extends ChangeBase {
  readonly type: "increment"
  readonly amount: number
}

// ---------------------------------------------------------------------------
// Union of all built-in action types
// ---------------------------------------------------------------------------

export type BuiltinChange =
  | TextChange
  | SequenceChange
  | MapChange
  | ReplaceChange
  | TreeChange
  | IncrementChange

/**
 * Any action — built-in or third-party. Use this as a general constraint
 * when writing code that is generic over all possible actions.
 */
export type Change = ChangeBase

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTextChange(action: ChangeBase): action is TextChange {
  return action.type === "text"
}

export function isSequenceChange(
  action: ChangeBase,
): action is SequenceChange {
  return action.type === "sequence"
}

export function isMapChange(action: ChangeBase): action is MapChange {
  return action.type === "map"
}

export function isReplaceChange(action: ChangeBase): action is ReplaceChange {
  return action.type === "replace"
}

export function isTreeChange(action: ChangeBase): action is TreeChange {
  return action.type === "tree"
}

export function isIncrementChange(
  action: ChangeBase,
): action is IncrementChange {
  return action.type === "increment"
}

// ---------------------------------------------------------------------------
// Action constructors — convenience factories
// ---------------------------------------------------------------------------

export function textChange(ops: readonly TextChangeOp[]): TextChange {
  return { type: "text", ops }
}

export function sequenceChange<T>(
  ops: readonly SequenceChangeOp<T>[],
): SequenceChange<T> {
  return { type: "sequence", ops }
}

export function mapChange(
  set?: Record<string, unknown>,
  del?: string[],
): MapChange {
  return { type: "map", set, delete: del }
}

export function replaceChange<T>(value: T): ReplaceChange<T> {
  return { type: "replace", value }
}

export function treeChange(ops: readonly TreeChangeOp[]): TreeChange {
  return { type: "tree", ops }
}

export function incrementChange(amount: number): IncrementChange {
  return { type: "increment", amount }
}
